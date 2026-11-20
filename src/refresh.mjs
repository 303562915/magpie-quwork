// refresh.mjs 平台 token 续期（`GET /api/user/refresh`）。
//
// # 协议（docs/quwork/README.md §4.2）
//
//	GET /api/user/refresh   Authorization: Bearer <token>
//	→ { token: <新 token>, expire: <新过期时间> }
//
//	· 没有独立 refresh token —— `token` 自己打自己
//	· `expire` 缺失时客户端按 **2 小时**算（`DEFAULT_ACCESS_TOKEN_TTL_MS`）
//	· 剩余 **< 1 小时** 就该续（`ACCESS_TOKEN_REFRESH_WINDOW_MS`）
//
// # 三条自律
//
//	① 60 秒内最多一次（并发请求不该各续一次，否则可能互相把 token 换废）
//	② 失败只 `log.warn`，**不动**存盘（续期失败不代表凭据坏了）
//	③ 只覆盖 `token` / `expire`；`llmToken` 绝不动（那是能调模型的凭据）

import { PLATFORM_BASE_URL, REFRESH_PATH, REFRESH_THROTTLE_MS, REFRESH_WINDOW_MS, PLATFORM_TIMEOUT_MS, TOKEN_TTL_MS } from "./constants.mjs"
import { updatePlatformToken } from "./auth-store.mjs"

/**
 * 算出 token 的过期时间（秒级时间戳）。
 *
 * `expire` 缺失（0 / null / 非法）→ `issuedAt + 2h`。这是**客户端口径**，不是我们编的。
 *
 * @param {{expire?: number, issuedAt?: number}} [input]
 * @returns {number} 秒级时间戳
 */
export function expiresAtOf({ expire = 0, issuedAt = Date.now() } = {}) {
  const exp = Number(expire) || 0
  if (exp > 0) return exp
  return Math.round((Number(issuedAt) + TOKEN_TTL_MS) / 1000)
}

/**
 * 现在是否该续期（与客户端 `isRefreshDue` 同口径）。
 *
 * @param {number} expiresAtSec 秒级过期时间
 * @param {{nowMs?: number, windowMs?: number}} [opts]
 * @returns {boolean} true = 剩余不足 windowMs（或已过期）
 */
export function needsRefresh(expiresAtSec, { nowMs = Date.now(), windowMs = REFRESH_WINDOW_MS } = {}) {
  const expMs = (Number(expiresAtSec) || 0) * 1000
  return expMs <= nowMs + windowMs
}

/**
 * 造一个「按需续期」的函数。
 *
 * @param {{configDir?: string, log?: any, fetchImpl?: typeof fetch, now?: () => number,
 *   platformBaseUrl?: string, throttleMs?: number}} [opts]
 * @returns {(auth: any) => Promise<{refreshed: boolean, reason?: string, expire?: number}>}
 */
export function makeRefresher(opts = {}) {
  const configDir = String(opts.configDir ?? "").trim()
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console
  const now = typeof opts.now === "function" ? opts.now : () => Date.now()
  const base = String(opts.platformBaseUrl ?? "").trim().replace(/\/+$/, "") || PLATFORM_BASE_URL
  const throttleMs = Number.isFinite(opts.throttleMs) ? Number(opts.throttleMs) : REFRESH_THROTTLE_MS

  /** 每个账号上次尝试续期的时间（内存，进程生命周期内有效）。 */
  const lastTry = new Map()

  /**
   * 需要时续一次。
   *
   * ⚠ 永不抛：续期是旁路，不能让对话请求失败。
   *
   * @param {any} auth magpie 的 auth（含 token / expire / llmToken）
   */
  return async function refreshIfNeeded(auth) {
    const token = String(auth?.token ?? "").trim()
    const llmToken = String(auth?.llmToken ?? auth?.access ?? "").trim()
    if (!token || !llmToken) return { refreshed: false, reason: "no-platform-token" }

    const expiresAt = expiresAtOf({ expire: auth?.expire, issuedAt: now() })
    if (!needsRefresh(expiresAt, { nowMs: now() })) return { refreshed: false, reason: "not-due" }

    const stamp = lastTry.get(llmToken) ?? 0
    if (now() - stamp < throttleMs) return { refreshed: false, reason: "throttled" }
    lastTry.set(llmToken, now())

    try {
      const headers = new Headers({ Accept: "application/json" })
      headers.set("Authorization", `Bearer ${token}`)
      const resp = await doFetch(`${base}${REFRESH_PATH}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      })
      if (!resp.ok) {
        log?.warn?.(`quwork: 续期失败（HTTP ${resp.status}），保持原 token`)
        return { refreshed: false, reason: `http-${resp.status}` }
      }
      /** @type {any} */
      const body = await resp.json().catch(() => null)
      const data = body?.data ?? body ?? {}
      const nextToken = String(data?.token ?? "").trim()
      if (!nextToken) {
        log?.warn?.("quwork: 续期响应里没有 token，保持原 token")
        return { refreshed: false, reason: "no-token-in-response" }
      }
      const expire = Number(data?.expire) || expiresAtOf({ issuedAt: now() })

      if (!configDir) {
        // 没有配置目录就没法落盘；仍然如实报告成功（调用方自己决定怎么办）
        return { refreshed: true, expire, persisted: false }
      }
      const written = updatePlatformToken(configDir, llmToken, { token: nextToken, expire })
      if (!written.ok) {
        log?.warn?.(`quwork: 续期成功但落盘失败（${written.reason}）`)
        return { refreshed: true, expire, persisted: false }
      }
      return { refreshed: true, expire, persisted: true, key: written.key }
    } catch (e) {
      log?.warn?.(`quwork: 续期异常（不影响请求）: ${String(e?.message ?? e).slice(0, 160)}`)
      return { refreshed: false, reason: "exception" }
    }
  }
}
