// login.mjs QuWork 登录链路：手机号 + 短信验证码（真登录）。
//
// # 协议（**真机实测已推翻旧报告**，2026-11-20）
//
//	① 发码  POST https://llm.rrzu.com/api/sendVerifyCode
//	        content-type: application/x-www-form-urlencoded
//	        body: phone=<手机号>&type=login
//	        → {"data":null,"message":"验证码发送成功","success":true}
//
//	② 登录  POST https://llm.rrzu.com/api/user/client/login     （**登录即注册**）
//	        content-type: application/json
//	        {phone, verification_code, platform:"qurvis", device_identifier, device_uuid:""}
//	        → {data:{token, llm_token, expire, user}, success:true}
//
// # 三条踩过的坑（都来自真机，不是推断）
//
//	· **`aliyun_captcha` 不是必需的**：客户端那套滑块是前端 UX，服务端**没强校验**。
//	  旧报告拿 JSON 去打所以失败，误判成「滑块是硬门槛」。
//	· **必须 form-urlencoded**：发码端点读的是 form（`phone`/`type`），JSON 会被拒。
//	· **有频率限制**：连发会回 `{"message":"验证码发送过于频繁，请稍后再试"}` ——
//	  这不是错误码而是正常业务回执，必须如实传回给用户，不能吞。
//
// # 成功判定
//
// 响应统一是 `{data, message, success}` 包装 ⇒ 判 `success === true`（不是看 HTTP 状态）。

import { createHash } from "node:crypto"

import { PLATFORM_BASE_URL, PLATFORM_TIMEOUT_MS } from "./constants.mjs"

/** 发码路径（form 提交，`aliyun_captcha` 不需要）。§1 ✅ 实测 */
export const SEND_CODE_PATH = "/api/sendVerifyCode"

/** 登录路径（登录即注册）。§3.1 */
export const LOGIN_PATH = "/api/user/client/login"

/** 平台标识（客户端固定 `qurvis`）。§3.1 */
export const QUWORK_PLATFORM = "qurvis"

/** 手机号校验：中国大陆 11 位。 */
export const PHONE_RE = /^1[3-9]\d{9}$/

/** 验证码格式（4~8 位数字）。 */
export const CODE_RE = /^\d{4,8}$/

/**
 * 判断一条错误文案是不是「发码太频繁」。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isRateLimited(text) {
  return /过于频繁|太频繁|稍后再试|too many/i.test(String(text ?? ""))
}

/**
 * 判断一条错误文案是不是「验证码错 / 过期」。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isCodeError(text) {
  return /验证码错误|验证码.*过期|code.*invalid/i.test(String(text ?? ""))
}

/**
 * 从 `{data, message, success}` 包装里取文案（取不到给兜底）。
 *
 * @param {any} body
 * @param {number} status
 * @returns {string}
 */
export function errorOf(body, status = 0) {
  const msgs = [body?.message, body?.msg, body?.desc, body?.error, body?.data?.message, body?.data?.msg]
  for (const m of msgs) {
    const s = String(m ?? "").trim()
    if (s) return s
  }
  return status ? `HTTP ${status}` : "未知错误"
}

/** 一个设备来源是否有效（非空，且不是全 0 / 全 F ⇒ 厂商未写入）。 */
export function usableSource(value) {
  const s = String(value ?? "").trim()
  if (!s) return false
  const hex = s.replace(/[-{}\s]/g, "").toLowerCase()
  if (!hex) return false
  return !/^0+$/.test(hex) && !/^f+$/.test(hex)
}

/**
 * 由设备来源算出 `device_identifier`：`sha256("quwork-sha256-v1:" + s)`。
 *
 * # 算法（源码 `IDENTITY_ALGORITHM = "sha256-v1"`，`quwork-client.mjs:109`）
 *
 *	序列号不可用时，把 SMBIOS UUID 与 MachineGuid **一起**纳入哈希
 *	（单一来源在批量装机 / VDI 模板上会整批同值）；
 *	全 0 / 全 F 视为厂商未写入 ⇒ **跳过该来源**。
 *
 * @param {{machineGuid?: string, smbiosUuid?: string, fallbackSeed?: string}} [sources]
 * @returns {string} 64 hex
 */
export function deviceIdentifierFrom(sources = {}) {
  const parts = []
  if (usableSource(sources.smbiosUuid)) parts.push(String(sources.smbiosUuid).trim().toLowerCase())
  if (usableSource(sources.machineGuid)) parts.push(String(sources.machineGuid).trim().toLowerCase())
  const joined = parts.length > 0 ? parts.join("|") : String(sources.fallbackSeed ?? "no-source")
  return createHash("sha256").update(`quwork-sha256-v1:${joined}`).digest("hex")
}

/**
 * 发短信验证码（**form-urlencoded**，不带 `aliyun_captcha`）。
 *
 * @param {{platformBaseUrl?: string, phone: string, fetchImpl?: typeof fetch,
 *   signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, error?: string, rateLimited?: boolean}>}
 */
export async function sendVerifyCode(opts) {
  const base = String(opts.platformBaseUrl ?? "").trim().replace(/\/+$/, "") || PLATFORM_BASE_URL
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))

  // ⚠ 只发 content-type + accept。**不要** X-QurWork-Env / X-QurWork-Version /
  //    pi UA —— 真机实测：带上客户端头，服务端会要求阿里云滑块
  //    （同一请求不带就是「验证码发送成功」）。
  const headers = new Headers({ Accept: "application/json" })
  headers.set("Content-Type", "application/x-www-form-urlencoded")

  let resp
  try {
    resp = await doFetch(`${base}${SEND_CODE_PATH}`, {
      method: "POST",
      headers,
      // ⚠ form，不是 JSON；**不带** aliyun_captcha
      body: new URLSearchParams({ phone: String(opts.phone ?? ""), type: "login" }).toString(),
      signal: opts.signal ?? AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, error: `发送验证码失败：${String(e?.message ?? e).slice(0, 120)}` }
  }

  const body = await resp.json().catch(() => null)
  // 成功判定看 `success === true`（HTTP 200 也可能是业务失败）
  if (body?.success === true) return { ok: true }

  const msg = errorOf(body, resp.ok ? 0 : resp.status)
  return { ok: false, error: msg, rateLimited: isRateLimited(msg) }
}

/**
 * 用验证码登录（**登录即注册**）。
 *
 * @param {{platformBaseUrl?: string, phone: string, code: string, deviceIdentifier: string,
 *   fetchImpl?: typeof fetch, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: true, token: string, llmToken: string, expire: number, user: any}
 *   | {ok: false, error: string}>}
 */
export async function loginWithCode(opts) {
  const base = String(opts.platformBaseUrl ?? "").trim().replace(/\/+$/, "") || PLATFORM_BASE_URL
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))

  // ⚠ 同 sendVerifyCode：平台接口不带 X-QurWork-*（带上会触发滑块校验）
  const headers = new Headers({ Accept: "application/json" })
  headers.set("Content-Type", "application/json")

  let resp
  try {
    resp = await doFetch(`${base}${LOGIN_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        phone: String(opts.phone ?? ""),
        verification_code: String(opts.code ?? ""),
        platform: QUWORK_PLATFORM,
        // ⚠ 客户端**总是**带 device_identifier（源码注释说缺省跳过，但抓到的请求都带）
        device_identifier: String(opts.deviceIdentifier ?? ""),
        device_uuid: "",
      }),
      signal: opts.signal ?? AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, error: `登录失败：${String(e?.message ?? e).slice(0, 120)}` }
  }

  const body = await resp.json().catch(() => null)
  if (body?.success !== true) return { ok: false, error: errorOf(body, resp.ok ? 0 : resp.status) }

  const d = body?.data ?? {}
  return {
    ok: true,
    token: String(d?.token ?? "").trim(),
    llmToken: String(d?.llm_token ?? "").trim(),
    expire: Number(d?.expire) || 0,
    user: d?.user && typeof d.user === "object" ? d.user : {},
  }
}