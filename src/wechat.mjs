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
  const platformBaseUrl = opts.platformBaseUrl
  const qs = new URLSearchParams({
    code: String(opts.code ?? ""),
    platform: "qurvis",
    state: String(opts.state ?? ""),
  })

  const r = await callPlatform({
    platformBaseUrl,
    token: "",
    path: `${WECHAT_PATHS.oauth}?${qs.toString()}`,
    method: "GET",
    fetchImpl: opts.fetchImpl,
  })

  if (!r.ok) return { ok: false, message: r.message }
  const d = r.data?.data ?? r.data ?? {}
  const wechatToken = String(d.wechat_token ?? d.wechatToken ?? "").trim()
  if (!wechatToken) return { ok: false, message: r.data?.message || "微信未返回 wechat_token" }
  return { ok: true, wechatToken }
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