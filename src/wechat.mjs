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
  const platformBaseUrl = opts.platformBaseUrl
  const code = String(opts.code ?? "")
  const state = String(opts.state ?? "")

  /**
   * 先在**多个候选接口**里找 `wechat_token`。
   *
   * ⚠ 顺序很关键：`code` 是**一次性**的，第一个吃下它的接口就把它用掉了。
   *   真机上 `/api/oauth/wechat` 返回的是**登录**载荷（token/user，没有 wechat_token），
   *   所以不能把它排第一 —— 一旦它吃掉 code，后面就再也换不出绑定凭证。
   *
   *   候选（按「更像绑定」优先）：
   *	① `/api/oauth/web-wechat?code&state` —— 平台网页端用的那条，按 state 找账号
   *	② `/api/oauth/wechat?code&platform=qurvis&state` —— 经典登录/换取接口
   *
   * 两条都试过仍没有 `wechat_token` 时，把**两边的原始返回**都带回去，
   * 这样日志里能直接看出平台到底给了什么（不用再猜）。
   */
  const attempts = []
  const raws = {}

  /**
   * 分类一次换取结果。
   *
   * 平台前端（`assets/WeChatOAuth-*.js`）的实现是这样的：
   *
   *	GET /api/oauth/web-wechat?code&state
   *	  · data.bind_type === "bind"                → 微信绑定成功
   *	  · data.bind_type === "need_bind" 且有 token → 这个微信**还没绑任何账号**，
   *	                                                给 wechat_token，再去 login_bind/绑定
   *	  · 其它（返回 token + user）                 → **直接登录**，说明这个微信
   *	                                                已经绑定了某个账号
   *
   * 所以「扫码后平台把我登录进去」本身就是平台给的判定：
   * **该微信已被绑定**。这种情况不是我们的 bug，也不该再去找 wechat_token。
   */
  const classify = (d) => {
    if (!d || typeof d !== "object") return { kind: "unknown" }
    const bindType = String(d.bind_type ?? d.bindType ?? "").trim()

    if (bindType === "bind") return { kind: "bound-ok" }

    const wechatToken = String(d.wechat_token ?? d.wechatToken ?? "").trim()
    if (bindType === "need_bind" && wechatToken) return { kind: "need-bind", wechatToken }
    if (wechatToken) return { kind: "need-bind", wechatToken }

    // 登录载荷：平台认出了这个微信属于某个账号
    const user = d.user && typeof d.user === "object" ? d.user : null
    if (user) {
      return {
        kind: "already-bound",
        boundAccount: String(user.username || user.display_name || user.phone || "").trim(),
        boundUserId: user.id,
        isNew: Boolean(d.is_new ?? d.isNew),
      }
    }
    return { kind: "unknown" }
  }

  const tryOne = async (label, path, qs) => {
    const r = await callPlatform({
      platformBaseUrl,
      token: "",
      path: `${path}?${qs.toString()}`,
      method: "GET",
      fetchImpl: opts.fetchImpl,
    })
    const d = r.data?.data ?? r.data ?? {}
    const cls = classify(d)
    raws[label] = {
      ok: r.ok,
      message: r.message ?? "",
      bindType: d?.bind_type ?? null,
      keys: Object.keys(d ?? {}).slice(0, 20),
      ...(cls.boundAccount ? { boundAccount: cls.boundAccount } : {}),
    }
    attempts.push({ label, ok: r.ok, kind: cls.kind, message: r.message ?? "" })
    return { r, d, cls }
  }

  // ① 网页端那条（平台前端自己用的就是它，能区分 bind / need_bind / 登录）
  const web = new URLSearchParams({ code, state })
  const webR = await tryOne("web-wechat", WECHAT_PATHS.web, web)
  if (webR.cls.kind === "need-bind") {
    return { ok: true, wechatToken: webR.cls.wechatToken, via: "web-wechat", attempts, raws }
  }
  if (webR.cls.kind === "bound-ok") {
    return { ok: true, alreadyBoundOk: true, via: "web-wechat", attempts, raws }
  }
  if (webR.cls.kind === "already-bound") {
    // 平台已经把「这个微信属于哪个账号」告诉我们了 —— 这就是结论，不用再试别的接口
    return {
      ok: false,
      kind: "already-bound",
      boundAccount: webR.cls.boundAccount,
      boundUserId: webR.cls.boundUserId,
      message: `这个微信已经绑定过平台账号${webR.cls.boundAccount ? "（" + webR.cls.boundAccount + "）" : ""}，平台直接登录了，不会签发绑定凭证`,
      attempts,
      raws,
    }
  }

  // ② 经典换取接口（平台桌面端用；可能给登录，也可能给 need_bind）
  const qs = new URLSearchParams({ code, platform: "qurvis", state })
  const oauthR = await tryOne("oauth/wechat", WECHAT_PATHS.oauth, qs)
  if (oauthR.cls.kind === "need-bind") {
    return { ok: true, wechatToken: oauthR.cls.wechatToken, via: "oauth/wechat", attempts, raws }
  }
  if (oauthR.cls.kind === "bound-ok") {
    return { ok: true, alreadyBoundOk: true, via: "oauth/wechat", attempts, raws }
  }
  if (oauthR.cls.kind === "already-bound") {
    return {
      ok: false,
      kind: "already-bound",
      boundAccount: oauthR.cls.boundAccount,
      boundUserId: oauthR.cls.boundUserId,
      message: `这个微信已经绑定过平台账号${oauthR.cls.boundAccount ? "（" + oauthR.cls.boundAccount + "）" : ""}，平台直接登录了，不会签发绑定凭证`,
      attempts,
      raws,
    }
  }

  const msg = oauthR.r?.message || webR.r?.message || "平台没给 wechat_token，也没说已绑定"
  return { ok: false, kind: "unknown", message: msg, attempts, raws }
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