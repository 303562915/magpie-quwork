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
// # 续期不动（用户明确驳回「只有过期才续」）
//
// T-39 一度把闸门改成"已过期才续"，用户驳回：「那个续期的没有问题，不要改」。
// 所以恢复客户端口径：**临期（剩余 < 1 小时）就续** —— 这是客户端自己的行为，
// 跟着它走才不会被平台当成异类。本次只对 `provider.models` 做了缓存化。
//
// # 三条自律
//
//	① 60 秒内最多一次（并发请求不该各续一次，否则可能互相把 token 换废）
//	② 失败只 `log.warn`，**不动**存盘（续期失败不代表凭据坏了）
//	③ 只覆盖 `token` / `expire`；`llmToken` 绝不动（那是能调模型的凭据）

import { PLATFORM_BASE_URL, REFRESH_PATH, REFRESH_THROTTLE_MS, REFRESH_WINDOW_MS, PLATFORM_TIMEOUT_MS, TOKEN_TTL_MS } from "./constants.mjs"
import { updatePlatformToken } from "./auth-store.mjs"
import { pastHalfLife, readJwtClaims } from "./token-life.mjs"

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
 * 现在是否该续期 —— **T-41：走完总有效期的 50% 才续**。
 *
 *	① 给了 `iatSec`（签发时间）且 total > 0 → 严格 50%（`pastHalfLife`）
 *	② 没给 iat → 回落到 `windowMs`（老口径，默认 1 小时）作为兜底
 *
 * ⚠ 兜底只在"拿不到签发时间"时生效；有 iat 就必须按 50% 走。
 *
 * @param {number} expiresAtSec 过期时间（秒）
 * @param {{nowMs?: number, windowMs?: number, iatSec?: number}} [opts]
 * @returns {boolean} true = 该续了
 */
export function needsRefresh(expiresAtSec, { nowMs = Date.now(), windowMs = REFRESH_WINDOW_MS, iatSec } = {}) {
  const expSec = Number(expiresAtSec)
  const iat = Number(iatSec)
  if (Number.isFinite(expSec) && Number.isFinite(iat) && iat > 0 && expSec > iat) {
    // ① 有签发时间：严格按百分比（剩余 <= 总长的一半）
    return pastHalfLife(iat, expSec, Math.floor(nowMs / 1000))
  }
  // ② 没有签发时间：固定窗口兜底（不改老行为，只是它不再是主判据）
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
    // T-41：签发时间优先取 JWT 的 `iat`（平台 token 或模型 token 都可能是 JWT），
    // 取不到就交给 `needsRefresh` 的固定窗口兜底 —— 有 iat 就必须按 50% 走。
    const claims = readJwtClaims(auth?.token) ?? readJwtClaims(auth?.llmToken) ?? readJwtClaims(auth?.access)
    const iatSec = Number(auth?.iat) > 0 ? Number(auth.iat) : claims?.iat
    if (!needsRefresh(expiresAt, { nowMs: now(), iatSec })) return { refreshed: false, reason: "not-due" }

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
