// src/wechat-watch.mjs 微信扫码的**全自动**绑定链路。
//
// # 为什么需要这个模块（真机踩出来的）
//
// 之前门户是这么做的：拿平台签发的 `qrconnect` 地址 → 把它编成二维码 → 让人扫。
// **这是错的**：`qrconnect` 是个「页面」，谁打开它都会现场生成一个新的 uuid，
// 所以扫它等于「用微信打开一个登录页」——平台只会让你登录，不会绑号。
//
// 微信网页登录真正的机制（HAR 里可见）：
//
//	① 打开 https://open.weixin.qq.com/connect/qrconnect?appid=..&state=..
//	   → 页面里生成 uuid=<UUID>
//	② 真正要扫的二维码，内容是 https://open.weixin.qq.com/connect/confirm?uuid=<UUID>
//	③ 打开端轮询 https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=<UUID>
//	   → window.wx_errcode=408  还在等
//	   → window.wx_errcode=403  已扫码、还没点确认
//	   → window.wx_errcode=405;window.wx_code='...'  已确认，code 到手
//	④ 拿到 code 后：GET /api/oauth/wechat?code=..&platform=qurvis&state=..
//	   → data.wechat_token
//	⑤ POST /api/user/wechat/bind { wechat_token }（Bearer = 目标号的 token）
//
// 也就是说：**我们自己就能当「打开端」**，既出正确的码，又能收 code，
// 于是整条绑定链可以全自动，不需要扫码人回传任何东西。

const WECHAT_CONFIRM_BASE = "https://open.weixin.qq.com/connect/confirm?uuid="
const WECHAT_QRCODE_BASE = "https://open.weixin.qq.com/connect/qrcode/"
const WECHAT_LONGPOLL_BASE = "https://lp.open.weixin.qq.com/connect/l/qrconnect"

/** 微信长轮询的错误码语义。 */
export const WX_ERRCODE = Object.freeze({
  WAITING: "408", // 还没人扫
  WAITING_ALT: "404", // 另一版本的空闲码
  SCANNED: "403", // 扫了、还没点确认
  CONFIRMED: "405", // 确认了，wx_code 就是授权码
  EXPIRED: "402", // 二维码过期
  INVALID: "400", // uuid 无效
})

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/**
 * 打开平台签发的授权页，把页面里的 uuid 取出来。
 *
 * @param {{authorizeUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, uuid?: string, message?: string}>}
 */
export async function openAuthorizePage(opts) {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const url = String(opts?.authorizeUrl ?? "").trim()
  if (!url) return { ok: false, message: "没有授权地址" }

  let res
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(Math.max(5000, Number(opts?.timeoutMs) || 25000)),
    })
  } catch (e) {
    return { ok: false, message: `打开授权页失败：${String(e?.message ?? e)}` }
  }
  if (!res.ok) return { ok: false, message: `授权页 HTTP ${res.status}` }

  const html = await res.text()
  // 页面里 uuid 出现在多处（脚本变量、图片地址），取第一个 16 位左右的
  const hits = [
    ...html.matchAll(/uuid[=:"'\s]+([A-Za-z0-9_-]{15,20})/g),
    ...html.matchAll(/connect\/qrcode\/([A-Za-z0-9_-]{15,20})/g),
  ]
  const uuid = hits.length > 0 ? hits[0][1] : ""
  if (!uuid) return { ok: false, message: "授权页里没有 uuid（页面结构可能变了）" }
  return { ok: true, uuid }
}

/**
 * 拉 uuid 对应的**官方二维码图片**（`GET /connect/qrcode/<uuid>`）。
 *
 * 拿不到也不致命：`confirmUrl` 自己编成二维码，扫出来效果一样。
 *
 * @param {{uuid: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, bytes?: Uint8Array, contentType?: string, message?: string}>}
 */
export async function fetchQrImage(opts) {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const uuid = String(opts?.uuid ?? "").trim()
  if (!uuid) return { ok: false, message: "没有 uuid" }
  try {
    const res = await fetchImpl(WECHAT_QRCODE_BASE + encodeURIComponent(uuid), {
      headers: { "User-Agent": BROWSER_UA, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(Math.max(5000, Number(opts?.timeoutMs) || 25000)),
    })
    if (!res.ok) return { ok: false, message: `二维码图片 HTTP ${res.status}` }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length < 100) return { ok: false, message: "二维码图片太小，可能不是有效图片" }
    return { ok: true, bytes, contentType: res.headers.get("content-type") ?? "image/jpeg" }
  } catch (e) {
    return { ok: false, message: `取二维码图片失败：${String(e?.message ?? e)}` }
  }
}

/** 真正要扫码的内容（`confirm?uuid=<UUID>`）。 */
export function confirmUrlOf(uuid) {
  return WECHAT_CONFIRM_BASE + encodeURIComponent(String(uuid ?? ""))
}

/**
 * 轮询一次扫码状态。
 *
 * 这个接口是**长轮询**：服务端会 hold 住最多 ~25 秒才返回，所以不要高频调用。
 *
 * @param {{uuid: string, last?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, errcode?: string, code?: string, raw?: string, message?: string}>}
 */
export async function pollScanState(opts) {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const uuid = String(opts?.uuid ?? "").trim()
  if (!uuid) return { ok: false, message: "没有 uuid" }

  const qs = new URLSearchParams({ uuid })
  if (opts?.last) qs.set("last", String(opts.last))

  let res
  try {
    res = await fetchImpl(`${WECHAT_LONGPOLL_BASE}?${qs.toString()}`, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/javascript, */*; q=0.01",
        Referer: "https://open.weixin.qq.com/",
      },
      signal: AbortSignal.timeout(Math.max(5000, Number(opts?.timeoutMs) || 32000)),
    })
  } catch (e) {
    // 长轮询超时是正常的（服务端 hold 住后断开），交给调用方再轮一次
    return { ok: false, retryable: true, message: `轮询超时：${String(e?.message ?? e)}` }
  }

  const raw = (await res.text()).trim()
  const errcode = /wx_errcode\s*=\s*(\d+)/.exec(raw)?.[1] ?? ""
  const code = /wx_code\s*=\s*'([^']*)'/.exec(raw)?.[1] ?? ""
  return { ok: true, errcode, code: code || undefined, raw: raw.slice(0, 300) }
}

/**
 * 一次完整轮询 → 若已确认则返回 code。
 *
 * @param {{uuid: string, last?: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{state: "waiting"|"scanned"|"confirmed"|"expired"|"unknown",
 *   code?: string, errcode?: string, message?: string}>}
 */
export async function readScanOnce(opts) {
  const r = await pollScanState(opts)
  if (!r.ok) return { state: "waiting", message: r.message }
  const e = String(r.errcode ?? "")
  if (e === WX_ERRCODE.CONFIRMED) {
    if (!r.code) return { state: "unknown", errcode: e, message: "已确认但没拿到 code" }
    return { state: "confirmed", code: r.code, errcode: e }
  }
  if (e === WX_ERRCODE.SCANNED) return { state: "scanned", errcode: e }
  if (e === WX_ERRCODE.EXPIRED || e === WX_ERRCODE.INVALID) return { state: "expired", errcode: e }
  if (e === WX_ERRCODE.WAITING || e === WX_ERRCODE.WAITING_ALT) return { state: "waiting", errcode: e }
  return { state: "unknown", errcode: e, message: r.raw }
}