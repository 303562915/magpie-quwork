// open-url.mjs 在系统默认浏览器里打开一个 URL。
//
// # 为什么不用第三方包
//
// 只用 `node:child_process`。三个平台的命令：
//
//	Windows  cmd /c start "" <url>      （第一个 "" 是窗口标题占位，不能省 ——
//	                                     否则 `start` 会把带引号的 URL 当成标题）
//	macOS    open <url>
//	Linux    xdg-open <url>
//
// # 三条自律
//
//	① **永不抛**：打不开浏览器不是业务失败（用户可以自己复制 URL 打开）
//	② `detached` + `stdio: "ignore"`：不留子进程句柄，magpie 不会被它拖住
//	③ `unref()`：进程可以正常退出
//
// ⚠ 参数一律走数组传给 `spawn`（不拼 shell 字符串）：URL 里出现 `&`/`;` 也不会
//   被解释成 shell 语法。

import { spawn } from "node:child_process"

/**
 * 造一个「打开 URL」函数。
 *
 * @param {{platform?: string, spawnImpl?: typeof spawn, log?: any}} [opts]
 * @returns {(url: string) => Promise<boolean>} true = 已交给系统；false = 失败（已 warn）
 */
export function makeOpenExternal(opts = {}) {
  const platform = String(opts.platform ?? globalThis.process?.platform ?? "win32")
  const doSpawn = typeof opts.spawnImpl === "function" ? opts.spawnImpl : spawn
  const log = opts.log ?? console

  return function openExternal(url) {
    const target = String(url ?? "").trim()
    if (!target) return Promise.resolve(false)

    /** @type {[string, string[]]} */
    let cmd
    let argv
    if (platform === "win32") {
      cmd = "cmd"
      argv = ["/c", "start", "", target]
    } else if (platform === "darwin") {
      cmd = "open"
      argv = [target]
    } else {
      cmd = "xdg-open"
      argv = [target]
    }

    return new Promise((resolve) => {
      try {
        const child = doSpawn(cmd, argv, { detached: true, stdio: "ignore" })
        // 子进程的错误绝不能变成未捕获异常（否则 magpie 会看到一次崩溃）
        child?.on?.("error", (e) => {
          try {
            log?.warn?.(`quwork: 打开浏览器失败（${String(e?.message ?? e).slice(0, 120)}），请手动打开 ${target}`)
          } catch {
            /* 日志失败不是业务失败 */
          }
          resolve(false)
        })
        child?.unref?.()
        resolve(true)
      } catch (e) {
        try {
          log?.warn?.(`quwork: 打开浏览器失败（${String(e?.message ?? e).slice(0, 120)}），请手动打开 ${target}`)
        } catch {
          /* 同上 */
        }
        resolve(false)
      }
    })
  }
}

/** 默认导出（生产用）：系统平台 + 真 spawn。 */
export const defaultOpenExternal = makeOpenExternal()