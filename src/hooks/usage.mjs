// hooks/usage.mjs 额度卡片。
//
// # 两种凭据，两种能力（这是本插件的核心事实）
//
//	llmToken  → 能调模型（OpenAI 兼容）。**但读不到积分**（§3.4 末注：两个 token 用途分离）
//	token     → 能读积分（`/api/user/self`）与续期。**不能调模型**
//
// 所以：
//
//	· 有 token   → 打 `/api/user/self`，把积分映射成额度窗（aside，不参与路由）
//	· 只有 llmToken → 给一条 aside 说明窗「只能调模型，读不到积分」
//
// # 三条硬规则（magpie 契约）
//
//	① 成功时**只返回 windows**，绝不顺手塞 `error` —— `error` 会**替代**整个窗口显示
//	② 绝不伪造 `used: 100` 的额度窗（那是「把号判死」，我们没有任何依据）
//	③ 说明性窗口一律 `aside: true`（不参与路由排序）

import { PLATFORM_BASE_URL, SELF_PATH, ENV_HEADERS, PLATFORM_TIMEOUT_MS } from "../constants.mjs"

/**
 * 从 `/api/user/self` 的响应里取积分。
 *
 * # 为什么这么宽容
 *
 * 该接口的响应体**没有实测样本**（文档只标了 ✅ 401，说明需要鉴权）。字段名可能
 * 是 `points` / `quota` / `balance` / `score` 之一，也可能嵌一层 `data`。
 * 认不出来就返回 null —— 调用方据此报「读不到积分」，**不猜数字**。
 *
 * @param {any} body
 * @returns {number|null} 积分（非负整数）或 null
 */
export function pointsOf(body) {
  const d = body?.data ?? body ?? {}
  const candidates = [d?.points, d?.point, d?.quota, d?.balance, d?.score, d?.remain_points, d?.remaining_points]
  for (const c of candidates) {
    const n = Number(c)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  }
  return null
}

/**
 * 造 usage 钩子。
 *
 * @param {{platformBaseUrl?: string, log?: any, fetchImpl?: typeof fetch}} [opts]
 * @returns {(getAuth: () => Promise<any>) => Promise<{windows: object[]}>}
 */
export function makeUsageHook(opts = {}) {
  const base = String(opts.platformBaseUrl ?? "").trim().replace(/\/+$/, "") || PLATFORM_BASE_URL
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console

  return async function usage(getAuth) {
    const auth = await getAuth()
    // 平台 token：`token`（落盘）或 `refresh`（magpie 存的那个）都认
    const token = String(auth?.token ?? auth?.refresh ?? "").trim()
    const llmToken = String(auth?.llmToken ?? auth?.access ?? "").trim()
    // 账号名：accountId → metadata.nickname/phone → 「该账号」
    // （只配 llmToken 的号必须有名字，否则卡片上分不清是哪个号）
    const account =
      String(auth?.accountId ?? "").trim() ||
      String(auth?.metadata?.nickname ?? "").trim() ||
      String(auth?.metadata?.phone ?? "").trim() ||
      "该账号"

    // 连模型 token 都没有：这个账号根本没配好
    if (!llmToken) {
      return { windows: [{ name: "未配置", aside: true, display: "缺少 llmToken，无法调用模型" }] }
    }

    // 只有 llmToken：能调模型，但读不到积分
    if (!token) {
      return {
        windows: [
          {
            name: "额度未知",
            aside: true,
            display: `${account}只配置了模型 token，读不到平台积分（补一个平台 token 即可显示）`,
          },
        ],
      }
    }

    try {
      const headers = new Headers(ENV_HEADERS)
      headers.set("Authorization", `Bearer ${token}`)
      const resp = await doFetch(`${base}${SELF_PATH}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      })

      if (!resp.ok) {
        log?.warn?.(`quwork: /api/user/self 返回 HTTP ${resp.status}`)
        return {
          windows: [
            {
              name: resp.status === 401 || resp.status === 403 ? "平台 token 已失效" : "积分读取失败",
              aside: true,
              display:
                resp.status === 401 || resp.status === 403
                  ? "平台 token 被拒（模型 token 仍可用），续期或重新填写平台 token"
                  : `平台接口返回 HTTP ${resp.status}`,
            },
          ],
        }
      }

      /** @type {any} */
      const body = await resp.json().catch(() => null)
      const points = pointsOf(body)
      if (points === null) {
        log?.warn?.("quwork: /api/user/self 响应里没认出积分字段")
        return { windows: [{ name: "积分未知", aside: true, display: "平台响应里没有可识别的积分字段" }] }
      }

      // ⚠ aside：只用于显示，**不参与路由**（我们不知道总配额，不能算百分比）
      return {
        windows: [{ name: "平台积分", aside: true, display: `${points.toLocaleString("zh-CN")} 积分`, amount: points, unit: "积分" }],
      }
    } catch (e) {
      log?.warn?.(`quwork: 读积分异常: ${String(e?.message ?? e).slice(0, 160)}`)
      return { windows: [{ name: "积分读取失败", aside: true, display: "网络异常，稍后再看" }] }
    }
  }
}
