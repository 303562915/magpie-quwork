// src/wechat.mjs 微信扫码绑定链路（从客户端 `dist-electron/main/auth/` 逆向确认）。
//
// # 整条链路
//
//	① 授权页（用户扫码）
//	   https://open.weixin.qq.com/connect/qrconnect
//	     ?appid=wxac3315fe86ebb901
//	     &redirect_uri=https://llm.rrzu.com/oauth/wechat
//	     &response_type=code&scope=snsapi_login&state=<16 字节 hex>
//	② 扫码后微信回调 → https://llm.rrzu.com/oauth/wechat?code=xxx&state=xxx
//	   （客户端用 webRequest 拦这个回调；我们拦不到浏览器 ⇒ 让用户把地址粘回来）
//	③ code 换 wechat_token（10 分钟有效、用后即焚）
//	   GET /api/oauth/wechat?code=<code>&platform=qurvis&state=<state>
//	④ 绑定到已登录账号
//	   POST /api/user/wechat/bind  json { wechat_token }  Bearer <平台token>
//
// # 为什么 redirect_uri 不是 127.0.0.1
//
// 微信开放平台要求 `redirect_uri` 是**已备案域名**。本地起 80/443 监听需要改 hosts + 证书，
// 不现实。所以：redirect 仍指向官方域名，用户把落地地址整段粘回面板，我们解析 code/state。

import { randomBytes } from "node:crypto"

import { PLATFORM_BASE_URL, PLATFORM_TIMEOUT_MS } from "./constants.mjs"
import { platformHeaders, callPlatform } from "./invite.mjs"

/** 微信开放平台 AppID（客户端 `app.config.js` 里的 prod 值）。 */
export const DEFAULT_APP_ID = "wxac3315fe86ebb901"

/** 官方回调地址（微信侧已备案，必须精确匹配）。 */
export const DEFAULT_REDIRECT_URI = "https://llm.rrzu.com/oauth/wechat"

/** 微信授权页。 */
export const AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect"

/** 这些常量只是路径，别在调用点硬编码。 */
export const WECHAT_PATHS = Object.freeze({
  oauth: "/api/oauth/wechat",
  web: "/api/oauth/web-wechat",
  bind: "/api/user/wechat/bind",
})

/** 一次性 state（16 字节 → 32 hex）。 */
export function newState() {
  return randomBytes(16).toString("hex")
}

/**
 * 拼授权页 URL。
 *
 * @param {{appId?: string, state: string, redirectUri?: string}} opts
 * @returns {string}
 */
export function buildAuthorizeUrl(opts = {}) {
  const appId = String(opts.appId ?? "").trim() || DEFAULT_APP_ID
  const redirectUri = String(opts.redirectUri ?? "").trim() || DEFAULT_REDIRECT_URI
  const state = String(opts.state ?? "")

  const u = new URL(AUTHORIZE_URL)
  u.searchParams.set("appid", appId)
  u.searchParams.set("redirect_uri", redirectUri)
  u.searchParams.set("response_type", "code")
  u.searchParams.set("scope", "snsapi_login")
  u.searchParams.set("state", state)
  return u.href
}

/**
 * 从用户粘回来的回调地址里取 `code` / `state`。
 *
 * 用户可能粘整段 URL、也可能只粘 `code=...&state=...`，两种都认。
 *
 * @param {string} input
 * @returns {{code: string, state: string}}
 */
export function parseCallback(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return { code: "", state: "" }

  const queryOf = (s) => {
    const q = s.includes("?") ? s.slice(s.indexOf("?") + 1) : s
    return new URLSearchParams(q.replace(/^#/, ""))
  }

  try {
    const q = queryOf(raw)
    return { code: String(q.get("code") ?? ""), state: String(q.get("state") ?? "") }
  } catch {
    return { code: "", state: "" }
  }
}

/**
 * ③ code → wechat_token。
 *
 * @param {{code: string, state: string, platformBaseUrl?: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: boolean, wechatToken?: string, message?: string}>}
 */
export async function exchangeCode(opts) {
  const platformBaseUrl = String(opts.platformBaseUrl ?? "").replace(/\/+$/, "")
  const code = String(opts.code ?? "")
  const state = String(opts.state ?? "")
  const fetchImpl = opts.fetchImpl ?? fetch

  const attempts = []
  const raws = {}

  /**
   * 原样取一次，**不因为 success:false 就丢掉 data**。
   *
   * 真机 HAR 证据（2026-11-27）：
   *
   *	GET /api/oauth/wechat?code=…&platform=qurvis&channelId=desktop_client&state=…
   *	→ {"data":{"bind_type":"need_bind","wechat_token":"f536…"},"message":"请先绑定手机号","success":false}
   *
   * 也就是说：**绑定凭证是在 success:false 的响应里给出来的**，
   * 而 `callPlatform` 遇到 success:false 只回 message、把 data 丢了 ——
   * 这就是之前一直「换不到 wechat_token」的真正原因。
   */
  const rawCall = async (label, path, withClientHeaders) => {
    /** @type {Record<string,string>} */
    const headers = { Accept: "application/json" }
    if (withClientHeaders) {
      // 客户端（QuWork 桌面端）真实请求带这两个头；先不带，取不到再带上重试
      headers["X-QurWork-Env"] = "prod"
      headers["X-QurWork-Version"] = "1.7.5"
    }
    let res
    try {
      res = await fetchImpl(`${platformBaseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(25000),
      })
    } catch (e) {
      attempts.push({ label, ok: false, kind: "network", message: String(e?.message ?? e) })
      return { ok: false, kind: "network", message: `网络错误：${String(e?.message ?? e)}` }
    }

    const text = await res.text()
    /** @type {any} */
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    const data = body?.data ?? null
    const success = body?.success === true
    const message = String(body?.message ?? "")

    // ── 分类（优先级：有 wechat_token 就是 need_bind）──
    const wechatToken = String(data?.wechat_token ?? data?.wechatToken ?? "").trim()
    const bindType = String(data?.bind_type ?? data?.bindType ?? "").trim()

    let kind = "unknown"
    let boundAccount = ""
    if (wechatToken) kind = "need-bind"
    else if (bindType === "bind") kind = "bound-ok"
    else if (data?.user && typeof data.user === "object") {
      kind = "already-bound"
      boundAccount = String(data.user.username || data.user.display_name || data.user.phone || "").trim()
    }

    raws[label] = {
      ok: res.status >= 200 && res.status < 300,
      success,
      message,
      bindType: bindType || null,
      keys: data && typeof data === "object" ? Object.keys(data).slice(0, 20) : [],
      ...(boundAccount ? { boundAccount } : {}),
      ...(wechatToken ? { gotWechatToken: true } : {}),
      ...(data?.is_new !== undefined ? { isNew: data.is_new } : {}),
      status: res.status,
      bodyPreview: text.slice(0, 240),
    }
    attempts.push({ label, ok: res.status < 400, kind, message })
    return { ok: true, kind, wechatToken, boundAccount, message, status: res.status }
  }

  // ① 客户端走的就是这条：state 用平台签发的那个，带上 channelId
  const qs = new URLSearchParams({ code, platform: "qurvis", channelId: "desktop_client", state })
  let r = await rawCall("oauth/wechat", `${WECHAT_PATHS.oauth}?${qs.toString()}`, false)
  if (r.kind === "need-bind") {
    return { ok: true, wechatToken: r.wechatToken, via: "oauth/wechat", attempts, raws }
  }

  // ② 同一个请求带客户端标识再试一次（HAR 里客户端请求是带这两个头的）
  if (r.kind === "unknown") {
    const r2 = await rawCall("oauth/wechat+client", `${WECHAT_PATHS.oauth}?${qs.toString()}`, true)
    if (r2.kind === "need-bind") {
      return { ok: true, wechatToken: r2.wechatToken, via: "oauth/wechat+client", attempts, raws }
    }
    if (r2.kind !== "unknown") r = r2
  }

  if (r.kind === "bound-ok") return { ok: true, alreadyBoundOk: true, via: "oauth/wechat", attempts, raws }

  if (r.kind === "already-bound") {
    return {
      ok: false,
      kind: "already-bound",
      boundAccount: r.boundAccount,
      message: `这个微信已经绑定过平台账号${r.boundAccount ? "（" + r.boundAccount + "）" : ""}，平台只让它登录，不会再签发绑定凭证`,
      attempts,
      raws,
    }
  }

  return {
    ok: false,
    kind: r.kind,
    message: r.message || "平台没给 wechat_token",
    attempts,
    raws,
  }
}

/**
 * ④ 把 wechat_token 绑到已登录账号。
 *
 * @param {{platformBaseUrl?: string, token: string, wechatToken: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
export async function bindWechat(opts) {
  const r = await callPlatform({
    platformBaseUrl: opts.platformBaseUrl,
    token: opts.token,
    path: WECHAT_PATHS.bind,
    method: "POST",
    body: { wechat_token: String(opts.wechatToken ?? "") },
    fetchImpl: opts.fetchImpl,
  })

  if (!r.ok) return { ok: false, message: r.message }
  return { ok: true, message: r.data?.message || "绑定成功" }
}

export { platformHeaders, callPlatform, PLATFORM_BASE_URL, PLATFORM_TIMEOUT_MS }