// browser-profile.mjs 从**浏览器 profile** 里读 QuWork 网页登录后的 token。
//
// # 为什么要这条来源
//
// 用户明确要求「打开浏览器手动登录，登录后自动抓取」。网页版是纯前端 SPA，
// 登录后 token 落在浏览器存储里（Chrome/Edge 的 `Local Storage/leveldb`）。
// 所以这条来源在「不装客户端」的场景下是**首选**。
//
// # 读法（不引入依赖）
//
//	① 列候选 profile 目录（Chrome / Edge / Brave / Opera / Chromium…）
//	② 每个 profile 读 `Local Storage/leveldb/*.log|*.ldb` 的字节
//	③ 在字节里找含 `llm_token` / `llmToken` / `accessToken` 的 JSON 对象
//	   （配平花括号解析，复用 browser-login 的 `parseSessionFromSqlite` 思路）
//	④ 命中优先选 host 含 `quwork` / `rrzu` 的那条；没有 host 信息就取最近写入的
//
// ⚠ 文件被浏览器占用时读不到 —— 跳过该文件，绝不抛（浏览器一直开着是常态）。
// ⚠ 只读，不写；不改任何浏览器数据。

import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { parseSessionFromSqlite, toMillis } from "./browser-login.mjs"

/** 浏览器存储里与 QuWork 有关的键名（宽松匹配，bundle 可能压缩过）。 */
export const TOKEN_KEYS = ["llm_token", "llmToken", "accessToken", "access_token"]

/** host 线索（用来在多个 profile 里挑对的那个）。 */
export const HOST_HINTS = ["quwork", "rrzu"]

/**
 * 列出候选浏览器 profile 目录。
 *
 * @param {{env?: Record<string,string|undefined>, platform?: string, home?: string,
 *   exists?: (p: string) => boolean}} [opts]
 * @returns {string[]} profile 目录（如 `...\User Data\Default`）
 */
export function browserProfileDirs(opts = {}) {
  const env = opts.env ?? globalThis.process?.env ?? {}
  const platform = String(opts.platform ?? globalThis.process?.platform ?? "win32")
  const home = String(opts.home ?? homedir())
  const exists = typeof opts.exists === "function" ? opts.exists : (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }

  /** @type {Array<{base: string, family: string}>} */
  const roots = []

  if (platform === "win32") {
    const local = String(env.LOCALAPPDATA ?? "")
    const roaming = String(env.APPDATA ?? "")
    if (local) {
      roots.push({ base: join(local, "Google", "Chrome", "User Data"), family: "chrome" })
      roots.push({ base: join(local, "Microsoft", "Edge", "User Data"), family: "edge" })
      roots.push({ base: join(local, "BraveSoftware", "Brave-Browser", "User Data"), family: "brave" })
    }
    if (roaming) roots.push({ base: join(roaming, "Opera Software", "Opera Stable"), family: "opera" })
  } else if (platform === "darwin") {
    const appSupport = join(home, "Library", "Application Support")
    roots.push({ base: join(appSupport, "Google", "Chrome"), family: "chrome" })
    roots.push({ base: join(appSupport, "Microsoft Edge"), family: "edge" })
    roots.push({ base: join(appSupport, "BraveSoftware", "Brave-Browser"), family: "brave" })
  } else {
    const config = join(home, ".config")
    roots.push({ base: join(config, "google-chrome"), family: "chrome" })
    roots.push({ base: join(config, "microsoft-edge"), family: "edge" })
    roots.push({ base: join(config, "chromium"), family: "chromium" })
  }

  /** @type {string[]} */
  const out = []
  for (const root of roots) {
    // Opera 的 "Opera Stable" 本身就是 profile 目录
    if (root.family === "opera") {
      if (exists(root.base)) out.push(root.base)
      continue
    }
    if (!exists(root.base)) continue
    // Chrome 系：Default / Profile 1 / Profile 2 …
    let names = []
    try {
      names = readdirSync(root.base)
    } catch {
      names = []
    }
    for (const name of names) {
      if (name === "Default" || /^Profile \d+$/.test(name)) {
        const dir = join(root.base, name)
        if (exists(dir)) out.push(dir)
      }
    }
  }
  return out
}

/**
 * 这个 profile 的 leveldb 里有没有与 QuWork 相关的字样（host 线索）。
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasHostHint(text) {
  const lower = String(text ?? "").toLowerCase()
  return HOST_HINTS.some((h) => lower.includes(h))
}

/**
 * 从一组 profile 目录里读 token。
 *
 * @param {{dirs?: string[], readDir?: (d: string) => string[], readFile?: (p: string) => Buffer|string,
 *   stat?: (p: string) => {mtimeMs?: number}}} [opts]
 * @returns {Promise<{ok: true, llmToken: string, token: string, phone: string, uid: string,
 *   expire: number, source: string, sessionUpdatedAt: number, fileMtime: number,
 *   hasPlatformToken: boolean} | {ok: false, error: string}>}
 */
export async function readFromBrowserProfiles(opts = {}) {
  const dirs = opts.dirs ?? browserProfileDirs()
  const readDir = typeof opts.readDir === "function" ? opts.readDir : (d) => readdirSync(d)
  const readFile = typeof opts.readFile === "function" ? opts.readFile : (p) => readFileSync(p)
  const stat = typeof opts.stat === "function" ? opts.stat : (p) => statSync(p)

  /** @type {Array<{hit: any, hinted: boolean, mtime: number}>} */
  const found = []

  for (const profile of dirs) {
    const ldb = join(profile, "Local Storage", "leveldb")
    /** @type {string[]} */
    let names = []
    try {
      names = (readDir(ldb) ?? []).map((n) => String(n))
    } catch {
      continue // 目录不存在（该浏览器没装/没登录过）
    }
    const files = names
      .filter((n) => /\.(log|ldb)$/.test(n))
      .sort()
      .map((n) => (n.includes("/") || n.includes("\\") ? n : join(ldb, n)))

    for (const file of files) {
      /** @type {any} */
      let raw
      try {
        raw = readFile(file)
      } catch {
        continue // 被浏览器占用：跳过
      }
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "")
      const session = parseSessionFromSqlite(text)
      if (!session.llmToken) continue

      let mtime = 0
      try {
        mtime = Number(stat(file)?.mtimeMs) || 0
      } catch {
        mtime = 0
      }

      found.push({
        hinted: hasHostHint(text),
        mtime,
        hit: {
          ok: true,
          llmToken: session.llmToken,
          token: session.accessToken,
          phone: "",
          uid: "",
          expire: session.expiresAt ? Math.round(session.expiresAt / 1000) : 0,
          source: `browser:${profile.split(/[\\/]/).slice(-2).join("/")}`,
          sessionUpdatedAt: session.updatedAt,
          fileMtime: mtime,
          hasPlatformToken: Boolean(String(session.accessToken ?? "").trim()),
        },
      })
    }
  }

  if (found.length === 0) {
    return {
      ok: false,
      error: "没在浏览器里找到 QuWork 登录态：请在浏览器打开 quwork.cn 完成登录后重试",
    }
  }

  // 优先：host 线索命中 → 其次：最近写入
  found.sort((a, b) => {
    if (a.hinted !== b.hinted) return a.hinted ? -1 : 1
    return b.mtime - a.mtime
  })
  return found[0].hit
}

export { toMillis }