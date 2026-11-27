// src/desktop-client.mjs 读取本机 QuWork 桌面客户端的登录态（免扫码导入账号）。
//
// # 为什么能做
//
// `qurwork-desktop` 是 Electron 应用，登录后的会话（JWT）会落在它的用户数据目录里：
//
//	%APPDATA%\qurwork-desktop\
//	  qurwork-desktop.sqlite                    ← auth_session / 历史行（可能已删，但页里还有残留）
//	  Cache\Cache_Data\*                        ← HTTP 响应缓存（登录、oauth 的响应体会带着 token）
//	  Local Storage\leveldb\*                   ← localStorage（user / is_login）
//	  Partitions\*\Local Storage\leveldb\*       ← 子分区
//	  Network\Cookies                           ← 会话 cookie（加密，不读）
//
// 我们**只读**、只做两件事：把看起来像 JWT / `sk-` 的串捞出来，再拿它打
// `GET /api/user/self` 验证是不是活的。验得通才算「本机登录态」。
//
// ⚠ 不读 cookie、不碰 `Local State`（那是 Electron 的加密密钥），也不写客户端任何文件。
//
// # 和 browser-profile.mjs 的关系
//
// 那个是「从浏览器 profile 里读」，这个是「从桌面客户端里读」——同一套思路，
// 换了目录和文件形态（leveldb / sqlite / Cache_Data）。

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** JWT：三段点分 base64url。 */
const JWT_RE = /eyJhbGciOi[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
/** 模型平面 token。 */
const SK_RE = /sk-[A-Za-z0-9]{40,80}/g
/** 单文件扫描上限：再大也是缓存垃圾，读了白费。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 最多下钻的目录层数（防符号链接/深层怪目录把 IO 拖死）。 */
const MAX_DEPTH = 6

/**
 * 客户端用户数据目录（按平台给默认值，可注入 env 便于测试）。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]} 存在的候选目录（去重、按顺序）
 */
export function desktopClientDirs(env = process.env) {
  const roaming = String(env.APPDATA ?? "").trim()
  const local = String(env.LOCALAPPDATA ?? "").trim()
  const home = String(env.USERPROFILE ?? env.HOME ?? "").trim()

  /** @type {string[]} */
  const candidates = []
  // Windows（Electron 默认 appData = Roaming）
  if (roaming) candidates.push(join(roaming, "qurwork-desktop"), join(roaming, "QuWork"), join(roaming, "quwork-desktop"))
  // 有的版本把 userData 放 Local
  if (local) candidates.push(join(local, "qurwork-desktop"))
  // macOS / Linux
  if (home) {
    candidates.push(join(home, "Library", "Application Support", "qurwork-desktop"))
    candidates.push(join(home, ".config", "qurwork-desktop"))
  }

  const out = []
  for (const dir of candidates) {
    if (out.includes(dir)) continue
    try {
      if (statSync(dir).isDirectory()) out.push(dir)
    } catch {
      // 不存在就跳过
    }
  }
  return out
}

/**
 * 递归收集目录下的候选文件（跳过明显的缓存大件与插件目录）。
 *
 * @param {string} root
 * @param {number} [depth]
 * @returns {string[]}
 */
export function collectFiles(root, depth = 0) {
  /** @type {string[]} */
  const files = []
  if (depth > MAX_DEPTH) return files
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) {
      // 插件目录里全是别人的前端代码，捞出来的东西基本是噪声
      if (/^(dsh-plugins|dsh-plugin-tools|dsh-profile-checkpoints|plugin-market)$/.test(e.name)) continue
      files.push(...collectFiles(p, depth + 1))
      continue
    }
    if (!e.isFile()) continue
    // 明确不碰的：加密密钥、cookie 库、日志
    if (e.name === "Local State") continue
    if (/^(Cookies|Cookies-journal)$/.test(e.name)) continue
    files.push(p)
  }
  return files
}

/**
 * 从客户端数据目录里捞出候选凭据（**只读**，不验证）。
 *
 * @param {{env?: Record<string,string|undefined>, readFileImpl?: (p: string) => Buffer,
 *   listFilesImpl?: (dir: string) => string[]}} [opts]
 * @returns {{dirs: string[], candidates: Array<{kind: "jwt"|"sk", value: string, source: string}>}}
 */
export function readFromDesktopClient(opts = {}) {
  const readFileImpl = opts.readFileImpl ?? ((p) => readFileSync(p))
  const listFilesImpl = opts.listFilesImpl ?? ((dir) => collectFiles(dir))
  const dirs = desktopClientDirs(opts.env ?? process.env)

  /** @type {Map<string, {kind: "jwt"|"sk", value: string, source: string}>} */
  const seen = new Map()

  for (const dir of dirs) {
    for (const file of listFilesImpl(dir)) {
      let bytes
      try {
        // 只有「真的去读磁盘」时才检查文件大小；注入了 readFileImpl 的测试没有真实文件
        if (!opts.readFileImpl) {
          if (statSync(file).size > MAX_FILE_BYTES) continue
        }
        bytes = readFileImpl(file)
      } catch {
        continue
      }
      // latin1 保字节一一对应：JWT 是 ASCII，二进制文件里也能安全匹配
      const text = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : String(bytes)
      const source = file.slice(dir.length + 1)

      for (const m of text.matchAll(JWT_RE)) {
        const value = m[0].replace(/[.]+$/, "")
        if (!seen.has(value)) seen.set(value, { kind: "jwt", value, source })
      }
      for (const m of text.matchAll(SK_RE)) {
        const value = m[0]
        if (!seen.has(value)) seen.set(value, { kind: "sk", value, source })
      }
    }
  }

  return { dirs, candidates: [...seen.values()] }
}

/**
 * JWT 里的载荷（只解 base64，不验签）—— 用来先判断「是不是这个平台的、过期没」。
 *
 * @param {string} token
 * @returns {{user_id?: number, username?: string, exp?: number, iat?: number}|null}
 */
export function jwtClaims(token) {
  const parts = String(token ?? "").split(".")
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const json = Buffer.from(padded, "base64").toString("utf8")
    const obj = JSON.parse(json)
    return obj && typeof obj === "object" ? obj : null
  } catch {
    return null
  }
}

/**
 * 验证候选凭据并汇总成本机登录态。
 *
 * 判据：`GET /api/user/self` 返回 `success:true`（`callPlatform` 会把这层剥掉）。
 * 只有验通的才进结果 —— 缓存里的旧 token 很多，不能直接信。
 *
 * @param {{candidates: Array<{kind: string, value: string, source: string}>,
 *   platformBaseUrl?: string, fetchImpl?: typeof fetch,
 *   selfPath?: string, concurrency?: number}} opts
 * @returns {Promise<Array<{token: string, kind: string, source: string, username: string,
 *   userId: number|undefined, wechatBound: boolean, quota: number, expires: number|undefined}>>}
 */
export async function verifyCandidates(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = String(opts.platformBaseUrl ?? "").replace(/\/+$/, "")
  const selfPath = String(opts.selfPath ?? "/api/user/self")
  const concurrency = Math.max(1, Math.min(6, Number(opts.concurrency) || 3))

  /** @type {any[]} */
  const out = []
  const queue = [...opts.candidates]
  let cursor = 0

  const worker = async () => {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= queue.length) return
      const c = queue[i]
      // sk- 是模型平面 token，读不到账号信息，直接跳过验证（也没有人拿它当登录态）
      if (c.kind === "sk") continue

      const claims = jwtClaims(c.value)
      // 不是本平台的签发者就跳过（避免把别的服务 token 打过去）
      if (claims?.iss && claims.iss !== "rrz-llm") continue
      // 已经过期的直接跳过
      if (claims?.exp && claims.exp * 1000 < Date.now()) continue

      try {
        const res = await fetchImpl(`${base}${selfPath}`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${c.value}`, "User-Agent": "quwork-panel/desktop-import" },
          signal: AbortSignal.timeout(20000),
        })
        if (!res.ok) continue
        const body = await res.json()
        if (!body || body.success === false) continue
        const d = body.data ?? body
        if (!d || typeof d !== "object") continue
        // 必须能看出是哪个账号，否则导进来也没意义
        const username = String(d.username || d.display_name || d.phone || "").trim()
        if (!username) continue
        out.push({
          token: c.value,
          kind: c.kind,
          source: c.source,
          username,
          userId: d.id ?? claims?.user_id,
          wechatBound: Boolean(d.wechat_bound),
          quota: Number(d.quota ?? 0),
          expires: claims?.exp,
          llmToken: d.access_token ? String(d.access_token) : "",
        })
      } catch {
        // 单个失败不影响其它候选
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  // 同一个账号可能被多个文件记录：按 username 去重，保留积分最高的那条
  /** @type {Map<string, any>} */
  const best = new Map()
  for (const a of out) {
    const prev = best.get(a.username)
    if (!prev || a.quota > prev.quota) best.set(a.username, a)
  }
  return [...best.values()].sort((x, y) => y.quota - x.quota)
}

/**
 * 用平台 token 取该账号的**模型 token**（`sk-…`）。
 *
 * # 为什么需要
 *
 * 客户端里存的登录态是平台 JWT，只能读积分 / 签到 / 邀请。真正调模型要 `llmToken`，
 * 它由平台的 `/api/token` 列表给出：返回的 `key` 是 48 位裸串，前面补 `sk-` 就是 llm_token
 * （与 HAR 里 `llm_token: sk-LXrq5…` 完全对得上）。
 *
 * @param {{platformBaseUrl?: string, token: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: boolean, llmToken?: string, name?: string, message?: string}>}
 */
export async function fetchModelToken(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = String(opts.platformBaseUrl ?? "").replace(/\/+$/, "")
  const token = String(opts.token ?? "").trim()
  if (!token) return { ok: false, message: "没有平台 token" }

  try {
    const res = await fetchImpl(`${base}/api/token/?p=0&size=20`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return { ok: false, message: `取模型 token 失败：HTTP ${res.status}` }
    const body = await res.json()
    if (!body || body.success === false) return { ok: false, message: String(body?.message ?? body ?? "平台拒绝了取 token 列表") }

    const list = Array.isArray(body.data) ? body.data : []
    const usable = list.filter((it) => Number(it?.status) === 1 && String(it?.key ?? "").trim())
    if (usable.length === 0) return { ok: false, message: "这个账号还没创建过 API token（模型 token）" }

    const key = String(usable[0].key).trim()
    const llmToken = key.startsWith("sk-") ? key : `sk-${key}`
    return { ok: true, llmToken, name: String(usable[0].name ?? "") }
  } catch (e) {
    return { ok: false, message: `取模型 token 失败：${String(e?.message ?? e)}` }
  }
}

/**
 * 一次完整的「本机客户端登录态」探测：捞凭据 → 验活 → 补齐模型 token。
 *
 * @param {{env?: any, platformBaseUrl?: string, fetchImpl?: typeof fetch,
 *   readFileImpl?: (p: string) => Buffer, listFilesImpl?: (dir: string) => string[],
 *   withModelToken?: boolean, concurrency?: number}} [opts]
 * @returns {Promise<{ok: boolean, dirs: string[], scanned: number, accounts: any[], message?: string}>}
 */
export async function discoverFromDesktop(opts = {}) {
  const { dirs, candidates } = readFromDesktopClient(opts)
  if (dirs.length === 0) {
    return { ok: false, dirs, scanned: 0, accounts: [], message: "没找到本机 QuWork 客户端数据目录（客户端可能没装或没登录过）" }
  }
  if (candidates.length === 0) {
    return { ok: false, dirs, scanned: 0, accounts: [], message: "客户端目录里没找到登录凭证（可能已退出登录）" }
  }

  const verified = await verifyCandidates({
    candidates,
    platformBaseUrl: opts.platformBaseUrl,
    fetchImpl: opts.fetchImpl,
    concurrency: opts.concurrency,
  })
  if (verified.length === 0) {
    return { ok: false, dirs, scanned: candidates.length, accounts: [], message: "找到的凭据都失效了（客户端可能很久没登录）" }
  }

  /** @type {any[]} */
  const accounts = []
  for (const a of verified) {
    /** @type {any} */
    const row = { ...a, llmToken: "", modelTokenError: "" }
    if (opts.withModelToken !== false) {
      const mt = await fetchModelToken({ platformBaseUrl: opts.platformBaseUrl, token: a.token, fetchImpl: opts.fetchImpl })
      if (mt.ok) row.llmToken = mt.llmToken
      else row.modelTokenError = mt.message ?? "取模型 token 失败"
    }
    accounts.push(row)
  }

  return { ok: true, dirs, scanned: candidates.length, accounts }
}
