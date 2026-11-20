// browser-login.mjs 浏览器登录：打开登录页 + 轮询抓取本机凭据。
//
// # 用户要求（这就是本模块的规格）
//
//	「点一下就打开登录页，登录完成后自动抓取」
//
// 所以分两段：
//
//	① `openLoginPage()` —— 用系统默认浏览器打开登录页（失败只 warn，不阻断）
//	② `pollForNewCredential()` —— **轮询**本机凭据，直到读到与基准不同的新值
//
// # 三个读取源（都不改客户端文件，只读）
//
//	① `%APPDATA%\qurwork-desktop\qurwork-desktop.sqlite`
//	   → 表 `auth_session` 的 `session_json`（明文 JSON：{accessToken, llmToken, expiresAt…}）
//	② `%USERPROFILE%\.qurwork-desktop-dsh\.dsh\.credentials.yaml`
//	   → `QURIVS_LLM_API_KEY: <llm_token>`
//	③ `%APPDATA%\qurwork-desktop\Local Storage\leveldb`
//	   → leveldb 的日志/表文件里找含 `llmToken` 的 JSON 对象
//
// ⚠ 顺序固定 sqlite → yaml → leveldb；某个源读不动（文件被占用/不存在）就跳过，
//   绝不让「读不到」变成「登录失败」。
//
// # 实现取舍
//
// 不引入 sqlite/leveldb 依赖（插件必须零第三方依赖）。两处都是**明文**存的，
// 所以直接在字节里找那段 JSON（花括号配平后 JSON.parse），比解析页结构简单得多。

import { readFileSync, readdirSync, statSync } from "node:fs"
import { readFromBrowserProfiles } from "./browser-profile.mjs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 默认读取路径（测试可整体替换）。 */
export function defaultPaths(env = {}) {
  const home = String(env.home ?? homedir())
  const appData = String(env.appData ?? globalThis.process?.env?.APPDATA ?? join(home, "AppData", "Roaming"))
  const appDir = join(appData, "qurwork-desktop")
  return {
    sqlite: join(appDir, "qurwork-desktop.sqlite"),
    credentialsYaml: join(home, ".qurwork-desktop-dsh", ".dsh", ".credentials.yaml"),
    leveldb: join(appDir, "Local Storage", "leveldb"),
    appData,
    appDir,
  }
}

/**
 * 从 YAML 文本里取一个 key 的值（只认单行 `KEY: value` / `KEY: "value"`）。
 *
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
export function yamlValue(text, key) {
  const re = new RegExp(`^\\s*["']?${key}["']?\\s*:\\s*(.+)$`, "m")
  const m = re.exec(String(text ?? ""))
  if (!m) return ""
  return String(m[1] ?? "").trim().replace(/^["']|["']$/g, "")
}

/**
 * 在 sqlite 的字节里找 `session_json` 里的 llmToken / accessToken。
 *
 * ⚠ 找不到就返回空串 —— 调用方据此报「没找到已登录会话」，**绝不猜**。
 *
 * @param {Buffer|string} raw
 * @returns {{llmToken: string, accessToken: string, expiresAt: number, updatedAt: number}}
 */
export function parseSessionFromSqlite(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "")
  const empty = { llmToken: "", accessToken: "", expiresAt: 0, updatedAt: 0 }

  // 取第一段含 llmToken 的 JSON 对象（`session_json` 是明文存的）
  const idx = text.indexOf('"llmToken"')
  const alt = text.indexOf('"accessToken"')
  const at = idx >= 0 ? idx : alt
  if (at < 0) return empty

  const start = text.lastIndexOf("{", at)
  if (start < 0) return empty
  // 花括号配平（字符串内的括号会干扰，但 session_json 里基本没有；配平失败就退化为固定窗口）
  let depth = 0
  let end = -1
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) return empty

  try {
    const obj = JSON.parse(text.slice(start, end))
    return {
      llmToken: String(obj?.llmToken ?? "").trim(),
      accessToken: String(obj?.accessToken ?? "").trim(),
      expiresAt: Number(obj?.expiresAt) || 0,
      updatedAt: toMillis(obj?.updatedAt ?? obj?.updated_at ?? obj?.lastUpdatedAt),
    }
  } catch {
    return empty
  }
}

/**
 * 把「毫秒数 / 秒数 / ISO 字符串」统一成毫秒（拿不到给 0）。
 *
 * @param {any} value
 * @returns {number}
 */
export function toMillis(value) {
  if (value === undefined || value === null || value === "") return 0
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n // 秒 → 毫秒
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? t : 0
}

/**
 * 从本机客户端读凭据（只读，不写）。
 *
 * # 为什么还要返回文件元信息（`sessionUpdatedAt` / `fileMtime` / `hasPlatformToken`）
 *
 * 真机实测：用户在客户端登录后，**`llmToken` 可能与登录前完全相同**（服务端复用同一个
 * sk- token）。只比 token 字符串会把「真的登录成功了」判成「没变化」⇒ 永远超时。
 * 所以额外给三个「变化」信号，供 `isNewCredential()` 多判据使用。
 *
 * @param {{paths?: any, readFile?: (p: string) => Buffer|string, readDir?: (d: string) => string[],
 *   stat?: (p: string) => {mtimeMs?: number}}} [opts]
 * @returns {{ok: true, llmToken: string, token: string, phone: string, uid: string, expire: number,
 *   source: string, sessionUpdatedAt: number, fileMtime: number, hasPlatformToken: boolean}
 *   | {ok: false, error: string}}
 */
export function readLocalCredential(opts = {}) {
  const paths = opts.paths ?? defaultPaths()
  const readFile = opts.readFile ?? ((p) => readFileSync(p))
  // 文件 mtime 也要可注入（测试不依赖真实文件系统时间）
  const stat = typeof opts.stat === "function" ? opts.stat : undefined

  // ⓪ 浏览器 profile（**网页登录**的主来源；用户不装客户端）
  //    测试注入 `readBrowser`；生产用 `readFromBrowserProfiles()`。
  try {
    const readBrowser =
      typeof opts.readBrowser === "function"
        ? opts.readBrowser
        : (o) => readFromBrowserProfiles({ ...o, readFile, stat })
    const fromBrowser = readBrowser({ ...opts })
    // 允许同步返回（测试桩）与 Promise 两种形态：这里用同步优先的写法
    if (fromBrowser && typeof fromBrowser.then !== "function" && fromBrowser.ok) return fromBrowser
  } catch {
    /* 浏览器目录读不动：继续后面的来源 */
  }

  // ① sqlite（客户端登录过后这里一定有 session_json）
  try {
    const raw = readFile(paths.sqlite)
    const s = parseSessionFromSqlite(raw)
    if (s.llmToken) {
      return {
        ok: true,
        llmToken: s.llmToken,
        token: s.accessToken,
        phone: "",
        uid: "",
        expire: s.expiresAt ? Math.round(s.expiresAt / 1000) : 0, // ms → 秒
        source: "sqlite",
        sessionUpdatedAt: s.updatedAt,
        fileMtime: mtimeOf(paths.sqlite, { stat }),
        hasPlatformToken: Boolean(String(s.accessToken ?? "").trim()),
      }
    }
  } catch {
    /* 文件不存在 / 读不动：试下一个源 */
  }

  // ② DSH 凭据 yaml（宿主把 llm_token 写进 QURIVS_LLM_API_KEY）
  try {
    const text = String(readFile(paths.credentialsYaml) ?? "")
    const llmToken = yamlValue(text, "QURIVS_LLM_API_KEY") || yamlValue(text, "DEEPSEEK_API_KEY")
    if (llmToken) {
      return {
        ok: true,
        llmToken,
        token: "",
        phone: "",
        uid: "",
        expire: 0,
        source: "credentials-yaml",
        sessionUpdatedAt: 0,
        fileMtime: mtimeOf(paths.credentialsYaml, { stat }),
        hasPlatformToken: false,
      }
    }
  } catch {
    /* 同上 */
  }

  // ③ leveldb（Local Storage）：字节里找含 llmToken 的 JSON 对象
  try {
    const dir = paths.leveldb
    const readDir = typeof opts.readDir === "function" ? opts.readDir : (d) => readdirSync(d)
    const files = readDir(dir) ?? []
    const names = files.map((f) => String(f))
    const ordered = names
      .filter((n) => /\.(log|ldb)$/.test(n))
      .sort()
      .map((n) => (n.includes("/") || n.includes("\\") ? n : join(dir, n)))

    for (const file of ordered) {
      try {
        const raw = readFile(file)
        const s = parseSessionFromSqlite(raw)
        if (s.llmToken) {
          return {
            ok: true,
            llmToken: s.llmToken,
            token: s.accessToken,
            phone: "",
            uid: "",
            expire: s.expiresAt ? Math.round(s.expiresAt / 1000) : 0,
            source: "leveldb",
            sessionUpdatedAt: s.updatedAt,
            fileMtime: mtimeOf(file, { stat }),
            hasPlatformToken: Boolean(String(s.accessToken ?? "").trim()),
          }
        }
      } catch {
        // 文件被占用 / 读不动：跳过
      }
    }
  } catch {
    /* 目录不存在：跳过 */
  }

  return {
    ok: false,
    error: "没在本机找到已登录的 QuWork 会话：请在 QuWork 客户端里登录一次，或改用「粘贴 llm_token」",
  }
}

/**
 * 取文件 mtime（毫秒）；读不到给 0。
 *
 * @param {string} file
 * @param {{stat?: (p: string) => any}} [opts]
 * @returns {number}
 */
function mtimeOf(file, opts = {}) {
  const stat = typeof opts.stat === "function" ? opts.stat : (p) => statSync(p)
  try {
    const s = stat(file)
    return Number(s?.mtimeMs) || 0
  } catch {
    return 0
  }
}

/** 默认 sleep（`unref`：轮询不该拖住进程退出）。 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer?.unref?.()
  })
}

/**
 * 「这次读到的凭据算不算**新登录**」—— **四个判据，任一成立即为新**。
 *
 * # 为什么不能只比 token 字符串（真机实测）
 *
 * 用户在 QuWork 客户端完成登录后，sqlite 从 4 KB 涨到 45 KB、`session_json` 里出现
 * `llmToken` —— 但 **token 与登录前完全相同**（服务端复用了同一个 sk- token）。
 * 只比字符串 ⇒ 永远判「没变化」⇒ 3 分钟后超时 ⇒ magpie 里这个入口永远失败。
 *
 * 所以四个信号任一成立即算新：
 *
 *	① `llmToken` 变了
 *	② `sessionUpdatedAt` 变新（sqlite 里 session_json 的 updatedAt）
 *	③ `fileMtime` 变新（真正被读的那个来源文件）
 *	④ **首次**出现平台 token（`hasPlatformToken` false → true）
 *
 * `baseline` 可以是 `readLocalCredential()` 的完整快照，也可以是旧版传的字符串。
 *
 * @param {any} got 本次读到的凭据
 * @param {any} baseline 快照（对象或字符串）
 * @returns {boolean}
 */
export function isNewCredential(got, baseline) {
  const token = String(got?.llmToken ?? "").trim()
  if (!got?.ok || !token) return false

  const base = typeof baseline === "string" ? { llmToken: baseline } : (baseline ?? {})
  const baseToken = String(base?.llmToken ?? "").trim()

  // ① token 变了（旧值本来为空 ⇒ 任意非空都算）
  if (token !== baseToken) return true
  // ② 会话更新时间变新
  if (Number(got?.sessionUpdatedAt ?? 0) > Number(base?.sessionUpdatedAt ?? 0)) return true
  // ③ 来源文件 mtime 变新
  if (Number(got?.fileMtime ?? 0) > Number(base?.fileMtime ?? 0)) return true
  // ④ 首次出现平台 token
  if (got?.hasPlatformToken === true && base?.hasPlatformToken !== true) return true

  return false
}

/**
 * 轮询本机凭据，直到读到**新登录**（判据见 `isNewCredential`）。
 *
 * # 为什么要比基准（最容易做错的一点）
 *
 * 用户点「打开客户端登录」时，本机很可能**已经**有旧凭据。不比对的话第一次读就
 * 「成功」，用户拿到的其实是旧账号。所以进入时快照完整凭据对象，轮询只接受
 * 「四个判据任一成立」的结果。
 *
 * @param {{readLocal: () => any, baseline?: any, pollMs?: number, pollIntervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: true, cred: any} | {ok: false, error: string}>}
 */
export async function pollForNewCredential(opts) {
  const DEFAULT_POLL_MS = 180_000
  const pollMs = Number.isFinite(opts.pollMs) ? Number(opts.pollMs) : DEFAULT_POLL_MS
  const interval = Number.isFinite(opts.pollIntervalMs) ? Number(opts.pollIntervalMs) : 3000
  const sleep = typeof opts.sleep === "function" ? opts.sleep : defaultSleep
  // ⚠ 时间也要可注入：只注入 `sleep`（立刻返回）而用真实 `Date.now()` 的话，
  //    测试会真的等满 pollMs —— 这正是把测试挂住 3 分钟的原因。
  const now = typeof opts.now === "function" ? opts.now : () => Date.now()
  const deadline = now() + pollMs
  const baseline = opts.baseline

  while (now() < deadline) {
    if (opts.signal?.aborted) return { ok: false, error: "登录已取消" }

    const got = opts.readLocal()
    if (isNewCredential(got, baseline)) return { ok: true, cred: got }

    if (opts.signal?.aborted) return { ok: false, error: "登录已取消" }
    await sleep(interval)
  }

  return {
    ok: false,
    error: "3 分钟内没检测到新的登录状态，请确认已在客户端完成登录后重试",
  }
}