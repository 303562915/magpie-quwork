// invite.mjs 邀请码 / 签到 / 权益（平台 API 封装）。
//
// # 端点（全部 `Authorization: Bearer <平台 token>`，**不带** X-QurWork-*）
//
//	GET  /api/user/invite/summary          → {invite_code, invited_count, points, quota}
//	POST /api/user/activate   {invite_code, device_identifier, device_uuid:""}
//	GET  /api/user/invite/records?page=&page_size=
//	GET  /api/user/daily-reward/status
//	POST /api/user/daily-reward/claim
//	GET  /api/user/benefit/monthly-gifts
//	POST /api/user/benefit/redeem   {order_id: <int64>}   ← 不是 code！
//
// ⚠ 平台接口一律不带 `x-qurwork-env` / `x-qurwork-version`：真机实测带上会触发
//   阿里云滑块/风控（同一请求不带就正常）。那两个头只属于**模型平面**。

import { ENV_HEADERS, PLATFORM_BASE_URL, PLATFORM_TIMEOUT_MS } from "./constants.mjs"

/** 这些常量只是路径，别在调用点硬编码。 */
export const PATHS = Object.freeze({
  inviteSummary: "/api/user/invite/summary",
  activate: "/api/user/activate",
  inviteRecords: "/api/user/invite/records",
  rewardStatus: "/api/user/daily-reward/status",
  rewardClaim: "/api/user/daily-reward/claim",
  monthlyGifts: "/api/user/benefit/monthly-gifts",
  redeem: "/api/user/benefit/redeem",
})

/**
 * 平台请求头：`Accept` + 鉴权 + **客户端版本头**。
 *
 * # 为什么这里必须带 `X-QurWork-Env` / `X-QurWork-Version`
 *
 * T-15 当时把这两个头从**所有**平台接口去掉了 —— 那是**修过头**了。真机对照：
 *
 *	不带版本头 → /api/user/activate 回
 *	  {"data":{"client_version_too_low":true,"min_client_version":"1.6.5"},
 *	   "message":"客户端版本过低：无法识别当前版本，需版本 ≥ 1.6.5"}    ← 假故障
 *	带 1.7.5  → {"data":{"error_code":"wechat_bind_required"},
 *	              "message":"请先绑定微信"}                              ← 真实原因
 *
 * 真正会被阿里云滑块拦的是**发码**（`sendVerifyCode` / `loginWithCode`），
 * 那些接口在 `src/login.mjs` 里**仍然不带**这两个头（见那边的注释）。
 *
 * @param {string} [token]
 * @returns {Headers}
 */
function platformHeaders(token) {
  const headers = new Headers({ Accept: "application/json" })
  for (const [k, v] of Object.entries(ENV_HEADERS)) headers.set(k, v)
  if (token) headers.set("Authorization", `Bearer ${token}`)
  return headers
}

/**
 * 平台 JSON 调用（统一错误处理：HTTP 错误 + `success:false` 都归一成 `{ok:false, message}`）。
 *
 * @param {{platformBaseUrl?: string, token: string, path: string, method?: string,
 *   body?: any, fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, data?: any, message?: string, status?: number}>}
 */
async function callPlatform(opts) {
  const base = String(opts.platformBaseUrl ?? "").trim().replace(/\/+$/, "") || PLATFORM_BASE_URL
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))

  const headers = platformHeaders(opts.token)
  if (opts.body !== undefined) headers.set("Content-Type", "application/json")

  /** @type {RequestInit} */
  const init = {
    method: opts.method ?? "GET",
    headers,
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? PLATFORM_TIMEOUT_MS),
  }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)

  let resp
  try {
    resp = await doFetch(`${base}${opts.path}`, init)
  } catch (e) {
    return { ok: false, message: `网络错误：${String(e?.message ?? e).slice(0, 120)}`, status: 0 }
  }

  /** @type {any} */
  const body = await resp.json().catch(() => null)
  if (!resp.ok) {
    return { ok: false, message: String(body?.message ?? `HTTP ${resp.status}`), status: resp.status }
  }
  if (body && typeof body === "object" && body.success === false) {
    return { ok: false, message: String(body.message ?? "平台拒绝了这次请求"), status: resp.status }
  }
  return { ok: true, data: body?.data ?? body ?? {}, status: resp.status }
}

/**
 * 自己的邀请码信息。
 *
 * @param {{platformBaseUrl?: string, token: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: true, inviteCode: string, invitedCount: number, points: number, quota: number}
 *   | {ok: false, message: string}>}
 */
export async function fetchInviteSummary(opts) {
  const r = await callPlatform({ ...opts, path: PATHS.inviteSummary })
  if (!r.ok) return { ok: false, message: r.message ?? "读取邀请码失败" }
  const d = r.data ?? {}
  return {
    ok: true,
    inviteCode: String(d.invite_code ?? "").trim(),
    invitedCount: Number(d.invited_count) || 0,
    points: Number(d.points) || 0,
    quota: Number(d.quota) || 0,
  }
}

/**
 * 绑定邀请码（登录即注册的号可补绑）。
 *
 * ⚠ 失败时把服务端 `message` **原样**回传：真机上「不能使用自己的邀请码」
 * 这类文案本身就把原因说清了，改写成「绑定失败」反而丢信息。
 *
 * @param {{platformBaseUrl?: string, token: string, inviteCode: string,
 *   deviceIdentifier: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: boolean, code: string, message: string}>}
 */
export async function activateInvite(opts) {
  const code = String(opts.inviteCode ?? "").trim()
  if (!code) return { ok: false, code, message: "请输入邀请码" }

  const r = await callPlatform({
    platformBaseUrl: opts.platformBaseUrl,
    token: opts.token,
    fetchImpl: opts.fetchImpl,
    path: PATHS.activate,
    method: "POST",
    body: {
      invite_code: code,
      device_identifier: String(opts.deviceIdentifier ?? ""),
      device_uuid: "",
    },
  })

  if (!r.ok) return { ok: false, code, message: r.message ?? "绑定失败" }
  return { ok: true, code, message: String(r.data?.message ?? "绑定成功") }
}

/**
 * 邀请记录（分页）。
 *
 * @param {{platformBaseUrl?: string, token: string, page?: number, pageSize?: number,
 *   fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: true, list: any[], page: number, pageSize: number, total: number}
 *   | {ok: false, message: string}>}
 */
export async function fetchInviteRecords(opts) {
  const page = Number(opts.page) > 0 ? Math.floor(Number(opts.page)) : 1
  const pageSize = Number(opts.pageSize) > 0 ? Math.floor(Number(opts.pageSize)) : 10
  const q = `?page=${page}&page_size=${pageSize}`

  const r = await callPlatform({ ...opts, path: `${PATHS.inviteRecords}${q}` })
  if (!r.ok) return { ok: false, message: r.message ?? "读取邀请记录失败" }

  const d = r.data ?? {}
  return {
    ok: true,
    list: Array.isArray(d.list) ? d.list : [],
    page: Number(d.page) || page,
    pageSize: Number(d.page_size) || pageSize,
    total: Number(d.total) || 0,
  }
}

/**
 * 签到状态。
 *
 * @param {{platformBaseUrl?: string, token: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: true, canClaim: boolean, claimed: boolean, points: number,
 *   consecutiveDays: number, nextRefreshAt: number, wechatRequired: boolean}
 *   | {ok: false, message: string}>}
 */
export async function fetchDailyRewardStatus(opts) {
  const r = await callPlatform({ ...opts, path: PATHS.rewardStatus })
  if (!r.ok) return { ok: false, message: r.message ?? "读取签到状态失败" }

  const d = r.data ?? {}
  return {
    ok: true,
    canClaim: d.can_claim === true,
    claimed: d.claimed === true,
    points: Number(d.points) || 0,
    consecutiveDays: Number(d.consecutive_days) || 0,
    nextRefreshAt: Number(d.next_refresh_at) || 0,
    wechatRequired: d.wechat_required === true,
  }
}

/**
 * 签到（领今天的积分）。
 *
 * @param {{platformBaseUrl?: string, token: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: true, granted: number, points: number, consecutiveDays: number}
 *   | {ok: false, message: string}>}
 */
export async function claimDailyReward(opts) {
  const r = await callPlatform({ ...opts, path: PATHS.rewardClaim, method: "POST", body: {} })
  if (!r.ok) return { ok: false, message: r.message ?? "签到失败" }

  const d = r.data ?? {}
  return {
    ok: true,
    granted: Number(d.granted) || 0,
    points: Number(d.points) || 0,
    consecutiveDays: Number(d.consecutive_days) || 0,
  }
}

/** 月月送列表。 */
export async function fetchMonthlyGifts(opts) {
  const r = await callPlatform({ ...opts, path: PATHS.monthlyGifts })
  if (!r.ok) return { ok: false, message: r.message ?? "读取月月送失败" }
  const d = r.data ?? {}
  return { ok: true, list: Array.isArray(d.list) ? d.list : [] }
}

/**
 * 权益兑换。
 *
 * ⚠ 服务端要的是 **`order_id`（int64）**，不是 `code`：
 *
 *	空 / 0   → "Key: 'RedeemBenefitRequest.OrderId' Error:Field validation ... required"
 *	字符串   → "json: cannot unmarshal string into Go struct field ... of type int64"
 *
 * 所以这里强制转整数；不是整数就直接报错，不去打一次注定失败的请求。
 */
export async function redeemBenefit(opts) {
  const raw = opts?.orderId
  const n = typeof raw === "string" ? Number(raw.trim()) : Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, message: "请填写订单号（纯数字，int64）；服务端不接受兑换码字符串" }
  }
  const r = await callPlatform({ ...opts, path: PATHS.redeem, method: "POST", body: { order_id: n } })
  if (!r.ok) return { ok: false, message: r.message ?? "兑换失败" }
  return { ok: true, message: String(r.data?.message ?? "兑换成功") }
}

export { platformHeaders, callPlatform, ENV_HEADERS }