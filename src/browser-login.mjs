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

import { readFileSync, readdirSync } from "node:fs"
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
 * @returns {{llmToken: string, accessToken: string, expiresAt: number}}
 */
export function parseSessionFromSqlite(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "")
  const empty = { llmToken: "", accessToken: "", expiresAt: 0 }

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
    }
  } catch {
    return empty
  }
}

/**
 * 从本机客户端读凭据（只读，不写）。
 *
 * @param {{paths?: {sqlite: string, credentialsYaml: string}, readFile?: (p: string) => Buffer|string}} [opts]
 * @returns {{ok: true, llmToken: string, token: string, expire: number, source: string}
 *   | {ok: false, error: string}}
 */
export function readLocalCredential(opts = {}) {
  const paths = opts.paths ?? defaultPaths()
  const readFile = opts.readFile ?? ((p) => readFileSync(p))

  // ① sqlite（客户端登录过后这里一定有 session_json）
  try {
    const raw = readFile(paths.sqlite)
    const s = parseSessionFromSqlite(raw)
    if (s.llmToken) {
      return {
        ok: true,
        llmToken: s.llmToken,
        token: s.accessToken,
        expire: s.expiresAt ? Math.round(s.expiresAt / 1000) : 0, // ms → 秒
        source: "sqlite",
      }
    }
  } catch {
    /* 文件不存在 / 读不动：试下一个源 */
  }

  // ② DSH 凭据 yaml（宿主把 llm_token 写进 QURIVS_LLM_API_KEY）
  try {
    const text = String(readFile(paths.credentialsYaml) ?? "")
    const llmToken = yamlValue(text, "QURIVS_LLM_API_KEY") || yamlValue(text, "DEEPSEEK_API_KEY")
    if (llmToken) return { ok: true, llmToken, token: "", expire: 0, source: "credentials-yaml" }
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
      .concat(names.some((n) => n.includes("/") || n.includes("\\")) ? [] : [])

    for (const file of ordered) {
      try {
        const raw = readFile(file)
        const s = parseSessionFromSqlite(raw)
        if (s.llmToken) {
          return {
            ok: true,
            llmToken: s.llmToken,
            token: s.accessToken,
            expire: s.expiresAt ? Math.round(s.expiresAt / 1000) : 0,
            source: "leveldb",
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

/** 默认 sleep（`unref`：轮询不该拖住进程退出）。 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer?.unref?.()
  })
}

/**
 * 轮询本机凭据，直到读到**与基准不同**的新值。
 *
 * # 为什么要比基准（这是最容易做错的一点）
 *
 * 用户点「浏览器登录」时，本机很可能**已经**有旧凭据（上次登录留下的）。如果不比对，
 * 第一次读就会「成功」，用户看到的其实是旧账号 —— 而且他会以为新登录生效了。
 * 所以：进入时先快照一份旧值，轮询只接受 ≠ 旧值；旧值本来为空则任意非空都算。
 *
 * @param {{readLocal: () => any, baseline?: string, pollMs?: number, pollIntervalMs?: number,
 *   sleep?: (ms: number) => Promise<void>, signal?: AbortSignal}} opts
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
  const baseline = String(opts.baseline ?? "").trim()

  while (now() < deadline) {
    if (opts.signal?.aborted) return { ok: false, error: "登录已取消" }

    const got = opts.readLocal()
    const token = String(got?.llmToken ?? "").trim()
    if (got?.ok && token && (baseline === "" || token !== baseline)) {
      return { ok: true, cred: got }
    }

    if (opts.signal?.aborted) return { ok: false, error: "登录已取消" }
    await sleep(interval)
  }

  return {
    ok: false,
    error: `3 分钟内没检测到登录完成，请确认已在 QuWork 客户端完成登录后重试`,
  }
}