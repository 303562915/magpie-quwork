// usage.test.mjs 额度卡片：有平台 token → 积分；只有 llmToken → aside 说明窗。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeUsageHook, pointsOf } from "../src/hooks/usage.mjs"
import { PLATFORM_BASE_URL } from "../src/constants.mjs"

const LLM = "llm-token-abc123"
const TOKEN = "platform-token-zzz999"

function usageWith(fetchImpl) {
  return makeUsageHook({ log: { warn() {} }, fetchImpl })
}

// ⚠ T-23 起：主窗用 **balance**（预付费钱包语义），不再发 used/limit。
test("有平台 token → 打 PLATFORM_BASE_URL 的 /api/user/self，余额渲染成主窗", async () => {
  /** @type {string[]} */
  const urls = []
  const u = await usageWith(async (url, init) => {
    urls.push(String(url))
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`, "积分用平台 token")
    return Response.json({ data: { points: 26434 } })
  })(async () => ({ llmToken: LLM, token: TOKEN }))

  assert.equal(urls[0], `${PLATFORM_BASE_URL}/api/user/self`)
  assert.equal(u.error, undefined, "成功时绝不能带 error（它会替代整个窗口显示）")
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].name, "平台积分")
  assert.equal(u.windows[0].balance, 26434, "余额语义：balance 就是还剩多少")
  assert.equal(u.windows[0].used, undefined, "不许发 used（会被算成已用 100%）")
  assert.equal(u.windows[0].limit, undefined)
  assert.equal(u.windows[0].aside, undefined, "主窗参与显示")
})

test("只有 llmToken → 一条 aside 说明窗：无 used:100、无 error", async () => {
  const u = await usageWith(async () => {
    throw new Error("不该发请求")
  })(async () => ({ llmToken: LLM }))

  assert.equal(u.error, undefined)
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].aside, true)
  assert.equal(u.windows[0].used, undefined)
  assert.match(String(u.windows[0].display), /积分/)
})

test("平台 token 401 → 说明窗（不判死、不写 error）", async () => {
  const u = await usageWith(async () => new Response("no", { status: 401 }))(async () => ({ llmToken: LLM, token: TOKEN }))
  assert.equal(u.error, undefined)
  assert.equal(u.windows[0].aside, true)
  assert.match(String(u.windows[0].display), /过期|重新登录/)
  assert.equal(u.windows[0].used, undefined)
})

test("平台 500 / 网络错 → 说明窗，不抛", async () => {
  const a = await usageWith(async () => new Response("no", { status: 500 }))(async () => ({ llmToken: LLM, token: TOKEN }))
  assert.equal(a.windows[0].aside, true)

  const b = await usageWith(async () => {
    throw new Error("ETIMEDOUT")
  })(async () => ({ llmToken: LLM, token: TOKEN }))
  assert.equal(b.windows[0].aside, true)
})

test("响应里认不出积分字段 → 明确说认不出，不猜数字", async () => {
  const u = await usageWith(async () => Response.json({ data: { somethingElse: true } }))(async () => ({
    llmToken: LLM,
    token: TOKEN,
  }))
  assert.equal(u.windows[0].aside, true)
  assert.equal(u.windows[0].amount, undefined)
})

test("pointsOf 认得多种字段名（points / quota / balance，含 data 包裹）", () => {
  assert.equal(pointsOf({ data: { points: 10 } }), 10)
  assert.equal(pointsOf({ quota: 20 }), 20)
  assert.equal(pointsOf({ data: { balance: 30 } }), 30)
  assert.equal(pointsOf({ data: {} }), null)
  assert.equal(pointsOf(null), null)
})

test("没有 llmToken → 提示未配置（不装作正常）", async () => {
  const u = await usageWith(async () => {
    throw new Error("不该发请求")
  })(async () => ({}))
  assert.equal(u.windows[0].aside, true)
  assert.match(String(u.windows[0].display), /llmToken/)
})

// ── T-18 积分解析：真实额度在 points_entitlement（quota/amount 恒 0）────

const REAL_SELF = {
  data: {
    id: 6415,
    phone: "15083583411",
    display_name: "15083583411",
    activated: 1,
    amount: 0,
    quota: 0,
    used_quota: 0,
    points_entitlement: {
      total_points: "1099.60",
      limited_points: "0.00",
      permanent_points: "1099.60",
      active_subscription: null,
    },
  },
}

test("15) 真实响应 → 「平台积分」窗 1099.60，balance===1099.6（无 used/limit）", async () => {
  const u = await usageWith(async () => Response.json(REAL_SELF))(async () => ({ llmToken: LLM, token: TOKEN }))

  const main = u.windows.find((w) => String(w.name) === "平台积分")
  assert.ok(main, `缺「平台积分」窗: ${JSON.stringify(u.windows)}`)
  assert.equal(main.display, "1099.60 积分")
  assert.equal(main.balance, 1099.6)
  assert.equal(main.used, undefined)
  assert.equal(main.limit, undefined)
  assert.equal(main.aside, undefined, "主窗要参与显示（不作为 aside 跳过）")
  assert.equal(u.error, undefined)
})

test("16) 同时给出「永久积分」「受限积分」两条 aside 说明窗", async () => {
  const u = await usageWith(async () => Response.json(REAL_SELF))(async () => ({ llmToken: LLM, token: TOKEN }))

  const perm = u.windows.find((w) => String(w.name) === "永久积分")
  const limited = u.windows.find((w) => String(w.name) === "受限积分")
  assert.ok(perm && limited, `缺说明窗: ${JSON.stringify(u.windows)}`)
  assert.equal(perm.aside, true)
  assert.equal(limited.aside, true)
  assert.equal(perm.display, "1099.60")
  assert.equal(limited.display, "0.00")
})

test("17) total_points 是数字（非字符串）也认", async () => {
  const body = { data: { points_entitlement: { total_points: 88.5, permanent_points: 88.5, limited_points: 0 } } }
  const u = await usageWith(async () => Response.json(body))(async () => ({ llmToken: LLM, token: TOKEN }))

  const main = u.windows.find((w) => String(w.name) === "平台积分")
  assert.equal(main.balance, 88.5)
  assert.equal(main.display, "88.50 积分")
})

test("18) points_entitlement 缺失 → 回落 data.amount", async () => {
  const u = await usageWith(async () => Response.json({ data: { amount: 50 } }))(async () => ({
    llmToken: LLM,
    token: TOKEN,
  }))

  const main = u.windows.find((w) => String(w.name) === "平台积分")
  assert.ok(main, `回落失败: ${JSON.stringify(u.windows)}`)
  assert.equal(main.balance, 50)
  assert.equal(main.display, "50.00 积分")
})

test("19) 401 / success:false → 只有 aside 窗、**无** error 字段", async () => {
  const a = await usageWith(async () => new Response("no", { status: 401 }))(async () => ({ llmToken: LLM, token: TOKEN }))
  assert.equal(a.error, undefined)
  assert.equal(a.windows.length, 1)
  assert.equal(a.windows[0].aside, true)
  assert.match(String(a.windows[0].display), /过期|重新登录/)

  const b = await usageWith(async () => Response.json({ success: false, message: "token invalid" }))(async () => ({
    llmToken: LLM,
    token: TOKEN,
  }))
  assert.equal(b.error, undefined)
  assert.equal(b.windows[0].aside, true)
})

test("20) 无平台 token → 仍是「额度未知」说明窗（回归）", async () => {
  const u = await usageWith(async () => {
    throw new Error("不该发请求")
  })(async () => ({ llmToken: LLM, accountId: "13800000000" }))

  assert.equal(u.error, undefined)
  assert.equal(u.windows[0].name, "额度未知")
  assert.equal(u.windows[0].aside, true)
  assert.match(String(u.windows[0].display), /13800000000/)
})

// ── T-23 积分窗改 **balance** 语义（magpie 的「预付费钱包」字段）────────
//
// 真机症状：872.04 的号显示「剩余 0%」，0 分的号显示「剩余 100%」。
// 根因：我们发 `used=limit=total` ⇒ magpie 算 used/limit = 100% 已用。
// magpie 另有 `balance`（"how much is left of a prepaid wallet with no total"），
// quwork 的积分正是这种语义 ⇒ 只发 balance，不发 used/limit。

test("21) windowsFromSelf：主窗只发 balance（数值），不发 used / limit", async () => {
  const { windowsFromSelf } = await import("../src/hooks/usage.mjs")
  const r = windowsFromSelf({
    data: { points_entitlement: { total_points: "872.04", permanent_points: "872.04", limited_points: "0.00" } },
  })
  const main = r.windows.find((w) => w.name === "平台积分")

  assert.equal(main.balance, 872.04)
  assert.equal(typeof main.balance, "number", "balance 必须是 number（路由按它排序）")
  assert.equal(main.unit, "积分")
  assert.equal(main.display, "872.04 积分")
  assert.equal(main.used, undefined, "不许再发 used（会算成 100% 已用）")
  assert.equal(main.limit, undefined, "不许再发 limit")
})

test("22) total=0（第三行那个号）→ balance===0，used/limit 仍为 undefined", async () => {
  const { windowsFromSelf } = await import("../src/hooks/usage.mjs")
  const r = windowsFromSelf({ data: { points_entitlement: { total_points: "0.00" } } })
  const main = r.windows.find((w) => w.name === "平台积分")

  assert.equal(main.balance, 0)
  assert.equal(main.used, undefined)
  assert.equal(main.limit, undefined)
  assert.equal(main.display, "0.00 积分")
})
