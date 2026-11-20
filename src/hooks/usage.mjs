// hooks/usage.mjs 额度卡片（**每次真实读 `/api/user/self`**；这里没有缓存）。
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
// # T-39 的界限：只有 `provider.models` 做缓存
//
// 曾把额度也改成"只读缓存、没有缓存就回 `说明 · 额度未读`"，用户驳回
// （「usage 这些也不要改」）⇒ 已恢复原语义：每次被问就真读一次。
//
// # 三条硬规则（magpie 契约）
//
//	① 成功时**只返回 windows**，绝不顺手塞 `error` —— `error` 会**替代**整个窗口显示
//	② 绝不伪造 `used: 100` 的额度窗（那是「把号判死」，我们没有任何依据）
//	③ 说明性窗口一律 `aside: true`（不参与路由排序）

import { PLATFORM_BASE_URL, SELF_PATH, PLATFORM_TIMEOUT_MS } from "../constants.mjs"
import { USAGE_CACHE_FILE, cacheDirOf, writeCacheEntry } from "../cache.mjs"

// ── 窗口命名的三个前缀（T-31：跨插件统一）────────────────────────────────
//
// 规范见 `magpie-plugins/UNIFIED-PLAN.md` §1.1，全部窗口名只能以这三者之一开头：
//
//	额度 · <名称>   正常参与路由的额度（有 `used`，或 `balance`+`unit`）
//	停用 · <原因>   `used: 100` —— **让路由跳过该号**的唯一手段（规范 §4.4）
//	说明 · <主题>   `aside: true` —— 只解释，不参与路由
//
// ⚠ quwork **没有任何 `停用 · ` 窗口**：积分是预付费钱包（只有 `balance`），
//   本插件没有任何依据说「这个号不能用了」——伪造 `used:100` 会把健康的号判死（规范 §4.3 第 2 条）。
// ⚠ 名字里**不写数值**（`剩 N` 之类），magpie 自己会按 amount/limit/balance 渲染。
export const QUOTA_PREFIX = "额度 · "
export const STOP_PREFIX = "停用 · "
export const NOTE_PREFIX = "说明 · "

/**
 * 把一个「可能是字符串的数字」转成 number；转不成就 `undefined`。
 *
 * @param {any} v
 * @returns {number|undefined}
 */
export function num(v) {
  if (v === undefined || v === null || v === "") return undefined
  const n = typeof v === "string" ? Number(v.trim()) : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 两位小数的积分文案（`1099.6` → `"1099.60"`）。
 *
 * @param {number} n
 * @returns {string}
 */
export function fmtPoints(n) {
  return Number(n).toFixed(2)
}

/**
 * 从 `/api/user/self` 的响应里取积分结构。
 *
 * # 真机实测（这是本函数被重写的原因）
 *
 * ```json
 * {"data":{"amount":0,"quota":0,"used_quota":0,
 *          "points_entitlement":{"total_points":"1099.60",
 *                                "permanent_points":"1099.60",
 *                                "limited_points":"0.00",
 *                                "active_subscription":null}}}
 * ```
 *
 * **真实可用积分在 `points_entitlement.total_points`**；`amount` / `quota`
 * 在 qurvis 这套里**恒为 0**（早期直接读它们，卡片永远是「0 积分」）。
 *
 * # 解析优先级
 *
 *	total     = points_entitlement.total_points ?? data.points ?? data.amount
 *	permanent = points_entitlement.permanent_points
 *	limited   = points_entitlement.limited_points
 *	used      = data.used_quota
 *
 * @param {any} body
 * @returns {{total: number|undefined, permanent: number|undefined,
 *   limited: number|undefined, used: number|undefined, subscription: any}}
 */
export function entitlementOf(body) {
  const d = body?.data ?? body ?? {}
  const p = d?.points_entitlement ?? {}
  return {
    total: num(p.total_points) ?? num(d.points) ?? num(d.amount),
    permanent: num(p.permanent_points),
    limited: num(p.limited_points),
    used: num(d.used_quota),
    subscription: p.active_subscription ?? null,
  }
}

/**
 * 旧版宽松取数（保留给 `pointsOf` 的调用方/测试）。新代码请用 `entitlementOf`。
 *
 * @param {any} body
 * @returns {number|null}
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
 * 把 `/api/user/self` 的响应渲染成 magpie 的 `windows`。
 *
 * # 为什么用 `balance` 而不是 `used`/`limit`
 *
 * magpie 的渲染（`host-*.js`）：
 *
 *	used/limit 都有 ⇒ 算 `used / limit` 百分比（**已用**语义）
 *	balance    有  ⇒ 直接当「还剩多少」（注释原文：*how much is left, of a prepaid
 *	                  wallet with no total*）
 *
 * quwork 的积分**就是**「预付费钱包、没有总量」——发 `used=limit=total` 会被算成
 * 「已用 100% / 剩余 0%」（真机截图：872.04 的号显示剩余 0%，0 分的号显示剩余 100%）。
 * 所以这里**只发 `balance`**，`used`/`limit` 一律不出现（不是 0，是 undefined）。
 *
 * ⚠ `balance` 必须是 **number**：magpie 的路由会按它排序（剩得最多的排前面）。
 *
 * @param {any} body
 * @returns {{windows: object[]}|null} null = 认不出额度
 */
export function windowsFromSelf(body) {
  const e = entitlementOf(body)
  if (e.total === undefined) return null

  /** @type {object[]} */
  const windows = [
    {
      name: `${QUOTA_PREFIX}平台积分`,
      balance: Number(e.total),
      unit: "积分",
      display: `${fmtPoints(e.total)} 积分`,
    },
  ]
  // 「永久积分 / 受限积分」是**同一份额度的拆分**，各自没有总量 ⇒ aside（不参与路由）。
  // ⚠ 字段一个不动（T-31 只改名字）：仍是 `aside:true` + `display`，不补 amount/limit ——
  //   补了就等于替 magpie 编一个分母，那属于 P1「额度窗语义」的活，不混进纯改名。
  if (e.permanent !== undefined) {
    windows.push({ name: `${QUOTA_PREFIX}永久积分`, aside: true, display: fmtPoints(e.permanent) })
  }
  if (e.limited !== undefined) {
    windows.push({ name: `${QUOTA_PREFIX}受限积分`, aside: true, display: fmtPoints(e.limited) })
  }

  const sub = e.subscription
  if (sub) {
    const label =
      typeof sub === "string"
        ? sub
        : String(sub?.name ?? sub?.title ?? sub?.plan_name ?? sub?.display_name ?? "有")
    windows.push({ name: `${NOTE_PREFIX}订阅 ${label}`, aside: true, display: label })
  }
  return { windows }
}

/**
 * 造「实时读额度」的函数（**打上游**）。
 *
 * ⚠ 它**就是** `auth.usage` 的实现 —— 额度钩子每次被问都真读一次上游。
 *   （T-39 曾把它拆出来让钩子只读缓存，用户驳回了：usage 不动。）
 *
 * @param {{platformBaseUrl?: string, log?: any, fetchImpl?: typeof fetch}} [opts]
 * @returns {(getAuth: () => Promise<any>) => Promise<{windows: object[]}>}
 */
export function makeUsageReader(opts = {}) {
  const base = String(opts.platformBaseUrl ?? "").trim().replace(/\/+$/, "") || PLATFORM_BASE_URL
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console

  return async function readUsage(getAuth) {
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
      return { windows: [{ name: `${NOTE_PREFIX}额度不可读（缺少 llmToken）`, aside: true, display: "缺少 llmToken，无法调用模型" }] }
    }

    // 只有 llmToken：能调模型，但读不到积分
    if (!token) {
      return {
        windows: [
          {
            name: `${NOTE_PREFIX}额度不可读（没有平台 token）`,
            aside: true,
            display: `${account}只配置了模型 token，读不到平台积分（补一个平台 token 即可显示）`,
          },
        ],
      }
    }

    try {
      // ⚠ 平台接口**不带** X-QurWork-Env / X-QurWork-Version（真机实测：带了会被
      //    当成桌面客户端，走另一条风控路径）。那两个头只留给模型平面（chat/models）。
      const headers = new Headers({ Accept: "application/json" })
      headers.set("Authorization", `Bearer ${token}`)
      const resp = await doFetch(`${base}${SELF_PATH}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      })

      if (!resp.ok) {
        log?.warn?.(`quwork: /api/user/self 返回 HTTP ${resp.status}`)
        // ⚠ **不写顶层 error**：那会让 magpie 把账号判失效。只给一条 aside 说明。
        // ⚠ 三种「读不到」共用同一个窗名，**原因写进 name 的括号 + display**
        //   （名字带原因＝卡片上看得见为什么；不建三条同义窗＝不刷屏）。
        return {
          windows: [
            {
              name: `${NOTE_PREFIX}额度不可读（HTTP ${resp.status}）`,
              aside: true,
              display: "平台 token 可能已过期，请重新登录",
            },
          ],
        }
      }

      /** @type {any} */
      const body = await resp.json().catch(() => null)
      // 业务失败（HTTP 200 + success:false）同样只给说明窗
      if (body && typeof body === "object" && body.success === false) {
        log?.warn?.(`quwork: /api/user/self 业务失败: ${String(body.message ?? "").slice(0, 80)}`)
        return {
          windows: [
            { name: `${NOTE_PREFIX}额度不可读（业务失败）`, aside: true, display: "平台 token 可能已过期，请重新登录" },
          ],
        }
      }

      const rendered = windowsFromSelf(body)
      if (!rendered) {
        log?.warn?.("quwork: /api/user/self 响应里没认出 points_entitlement / points / amount")
        return {
          windows: [
            { name: `${NOTE_PREFIX}额度不可读（响应里没有积分字段）`, aside: true, display: "平台响应里没有可识别的积分字段" },
          ],
        }
      }
      return rendered
    } catch (e) {
      log?.warn?.(`quwork: 读积分异常: ${String(e?.message ?? e).slice(0, 160)}`)
      return {
        windows: [{ name: `${NOTE_PREFIX}额度不可读（网络）`, aside: true, display: "读取平台积分失败（网络）" }],
      }
    }
  }
}

/**
 * 「额度未读」说明窗（**备用**导出）。
 *
 * ⚠ 当前 `auth.usage` **不返回**它：额度钩子每次都真读上游（用户驳回缓存化）。
 *   这里保留导出只是为了让别的调用方（如将来的面板产物）能复用同一条命名。
 *
 * @param {string} [display] 告诉用户怎么读（各入口不同）
 * @returns {{name: string, aside: true, display: string}}
 */
export function unreadUsageWindow(display = "点面板「刷新」读取") {
  return { name: `${NOTE_PREFIX}额度未读`, aside: true, display: String(display) }
}

/**
 * 造 usage 钩子（**每次真实读 `/api/user/self`**）。
 *
 * # 这里没有缓存（用户明确要求）
 *
 * T-39 一度让它只读 `quwork-usage-cache.json`，没有缓存就回「额度未读」。
 * 用户驳回：「usage 这些也不要改」。所以恢复原语义：每次被问就真读一次
 * （`makeUsageReader` 就是它）。
 *
 * ⚠ `configDir` 仍然被接受但**不参与读取** —— 只有 `server.mjs` 的「刷新」按钮
 *   会顺手写一份 `quwork-usage-cache.json`（零额外请求的副产品），这个钩子不读它。
 *
 * @param {{platformBaseUrl?: string, configDir?: string, log?: any, fetchImpl?: typeof fetch}} [opts]
 * @returns {(getAuth: () => Promise<any>) => Promise<{windows: object[]}>}
 */
export function makeUsageHook(opts = {}) {
  return makeUsageReader(opts)
}

/**
 * 面板刷新用：把一次 `/api/user/self` 的响应写进额度缓存。
 *
 * ⚠ 这是**面板副产品**（`server.mjs` 的 `/api/accounts/refresh` 复用同一份响应写），
 *   `auth.usage` 不读它 —— 它只是给以后可能出现的面板/排障用途留的一份快照。
 *
 * @param {{configDir?: string, accountKey?: any, windows?: object[], plan?: string, user?: string}} input
 * @returns {boolean}
 */
export function rememberUsage(input = {}) {
  const configDir = cacheDirOf(input.configDir)
  const key = String(input.accountKey ?? "").trim()
  if (!configDir || !key) return false
  const windows = Array.isArray(input.windows) ? input.windows : []
  if (windows.length === 0) return false
  return writeCacheEntry(configDir, USAGE_CACHE_FILE, key, {
    at: Date.now(),
    windows,
    ...(input.plan ? { plan: String(input.plan) } : {}),
    ...(input.user ? { user: String(input.user) } : {}),
  })
}
