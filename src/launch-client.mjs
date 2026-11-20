// launch-client.mjs 「打开登录入口」：优先启动 **QuWork 桌面客户端**，退化为浏览器。
//
// # 为什么必须启动客户端（真机复核过）
//
// `llm_token` 只有 **QuWork 桌面客户端**会写进：
//
//	%APPDATA%\qurwork-desktop\qurwork-desktop.sqlite         → auth_session.session_json
//	%USERPROFILE%\.qurwork-desktop-dsh\.dsh\.credentials.yaml → QURIVS_LLM_API_KEY
//
// 用系统浏览器打开网页**不会**写这两处 ⇒ 轮询永远抓不到。所以「浏览器登录」这个名字
// 其实是「启动能产生凭据的那个东西」：客户端优先，网页只是最后的退路（用户可能装的是
// 网页版账号体系）。
//
// # 查找顺序（取第一个存在的）
//
//	① `options.clientPath`（用户显式指定，最高优先）
//	② `%LOCALAPPDATA%\Programs\QuWork\QuWork.exe`
//	③ `%PROGRAMFILES%\QuWork\QuWork.exe`
//	④ `D:\software\QuWork-1.7.5-win-x64\QuWork-1.7.5-win-x64.exe`（本机实测存在的已知位置）
//	⑤ 注册表卸载项里 DisplayName 含 QuWork 的 DisplayIcon
//
// # 三条自律
//
//	① **永不抛**：启动失败只 warn，仍然返回一个可用的 `{kind:"browser", target}`
//	② `detached` + `stdio:"ignore"` + `unref()`：不留句柄，magpie 不被拖住
//	③ 全部依赖可注入（`exists` / `spawn` / `openExternal` / `readRegistry`）——
//	   测试绝不真的启动客户端

import { spawn, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** 网页版登录页（客户端找不到时的退路）。 */
export const WEB_LOGIN_URL = "https://quwork.cn/"

/** 本机实测存在的已知安装位置（允许硬编码：这是「已知位置」清单的最后一档）。 */
export const KNOWN_CLIENT_PATHS = Object.freeze(["D:\\software\\QuWork-1.7.5-win-x64\\QuWork-1.7.5-win-x64.exe"])

/**
 * 列出候选 exe 路径（按优先级）。
 *
 * @param {{clientPath?: string, env?: Record<string, string|undefined>, home?: string}} [opts]
 * @returns {string[]}
 */
export function clientCandidates(opts = {}) {
  const env = opts.env ?? globalThis.process?.env ?? {}
  const localAppData = String(env.LOCALAPPDATA ?? "")
  const programFiles = String(env.PROGRAMFILES ?? "")
  const programFilesX86 = String(env["PROGRAMFILES(X86)"] ?? "")

  /** @type {string[]} */
  const list = []
  const explicit = String(opts.clientPath ?? "").trim()
  if (explicit) list.push(explicit)
  if (localAppData) list.push(join(localAppData, "Programs", "QuWork", "QuWork.exe"))
  if (programFiles) list.push(join(programFiles, "QuWork", "QuWork.exe"))
  if (programFilesX86) list.push(join(programFilesX86, "QuWork", "QuWork.exe"))
  list.push(...KNOWN_CLIENT_PATHS)
  return [...new Set(list.filter(Boolean))]
}

/**
 * 从注册表卸载项里找 QuWork 的 DisplayIcon（best-effort，永不抛）。
 *
 * @param {(args: string[]) => string} [readRegistry] 默认用 `reg query`
 * @returns {string} exe 路径（取不到返回空串）
 */
export function clientFromRegistry(readRegistry) {
  const query =
    readRegistry ??
    ((args) => {
      try {
        return String(
          execFileSync("reg", args, { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }),
        )
      } catch {
        return ""
      }
    })

  const keys = ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"]
  for (const root of keys) {
    let out = ""
    try {
      out = String(query(["query", root, "/s", "/f", "QuWork"]))
    } catch {
      continue
    }
    // DisplayIcon 常见形态：`C:\Path\App.exe,0` 或带引号
    const m = /DisplayIcon\s+REG_[A-Z_]+\s+(.+(?:\.exe|\.EXE))/.exec(out)
    if (m?.[1]) {
      const cleaned = String(m[1]).trim().replace(/^"|"$/g, "").replace(/,\s*\d+$/, "")
      if (cleaned) return cleaned
    }
  }
  return ""
}

/**
 * 造一个「打开登录入口」函数。
 *
 * @param {{clientPath?: string, exists?: (p: string) => boolean, spawnImpl?: typeof spawn,
 *   openExternal?: (url: string) => Promise<any>, readRegistry?: (args: string[]) => string,
 *   log?: any, env?: Record<string, string|undefined>}} [opts]
 * @returns {() => Promise<{kind: "client"|"browser", target: string}>}
 */
export function makeLaunchLoginSource(opts = {}) {
  const log = opts.log ?? console
  const exists = typeof opts.exists === "function" ? opts.exists : (p) => existsSync(p)
  const doSpawn = typeof opts.spawnImpl === "function" ? opts.spawnImpl : spawn
  /** @type {((url: string) => Promise<any>) | null} */
  const openExternal = typeof opts.openExternal === "function" ? opts.openExternal : null

  const warn = (m) => {
    try {
      log?.warn?.(m)
    } catch {
      /* 日志失败不是业务失败 */
    }
  }

  const launchExe = (exe) => {
    try {
      const child = doSpawn(exe, [], { detached: true, stdio: "ignore" })
      child?.on?.("error", (e) => warn(`quwork: 启动客户端失败（${String(e?.message ?? e).slice(0, 120)}）`))
      child?.unref?.()
      return true
    } catch (e) {
      warn(`quwork: 启动客户端失败（${String(e?.message ?? e).slice(0, 120)}）`)
      return false
    }
  }

  return async function launchLoginSource() {
    const candidates = clientCandidates({ clientPath: opts.clientPath, env: opts.env })
    const reg = clientFromRegistry(opts.readRegistry)
    if (reg) candidates.push(reg)

    for (const exe of candidates) {
      let ok = false
      try {
        ok = exists(exe)
      } catch {
        ok = false
      }
      if (!ok) continue
      if (launchExe(exe)) return { kind: "client", target: exe }
      break // 找到了但启动失败：不再瞎试别的路径，直接退化到网页
    }

    // 退路：网页登录页（用户可能用网页版账号体系）
    warn(`quwork: 没找到 QuWork 客户端，改用浏览器打开 ${WEB_LOGIN_URL}`)
    if (openExternal) {
      try {
        await openExternal(WEB_LOGIN_URL)
      } catch {
        /* 打开失败也不影响返回值：url 会交给 magpie */
      }
    }
    return { kind: "browser", target: WEB_LOGIN_URL }
  }
}