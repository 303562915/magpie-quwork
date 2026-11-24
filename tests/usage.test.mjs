// usage.test.mjs 额度卡片：有平台 token → 积分；只有 llmToken → aside 说明窗。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeUsageHook, pointsOf, QUOTA_PREFIX, STOP_PREFIX, NOTE_PREFIX } from "../src/hooks/usage.mjs"
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
  assert.equal(u.windows[0].name, "额度 · 平台积分")
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

test("没有 llmToken → 提示「额度不可读（缺少 llmToken）」（不装作正常）", async () => {
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

test("15) 真实响应 → 「额度 · 平台积分」窗 1099.60，balance===1099.6（无 used/limit）", async () => {
  const u = await usageWith(async () => Response.json(REAL_SELF))(async () => ({ llmToken: LLM, token: TOKEN }))

  const main = u.windows.find((w) => String(w.name) === "额度 · 平台积分")
  assert.ok(main, `缺「平台积分」窗: ${JSON.stringify(u.windows)}`)
  assert.equal(main.display, "1099.60 积分")
  assert.equal(main.balance, 1099.6)
  assert.equal(main.used, undefined)
  assert.equal(main.limit, undefined)
  assert.equal(main.aside, undefined, "主窗要参与显示（不作为 aside 跳过）")
  assert.equal(u.error, undefined)
})

test("16) 同时给出「额度 · 永久积分」「额度 · 受限积分」两条 aside 窗", async () => {
  const u = await usageWith(async () => Response.json(REAL_SELF))(async () => ({ llmToken: LLM, token: TOKEN }))

  const perm = u.windows.find((w) => String(w.name) === "额度 · 永久积分")
  const limited = u.windows.find((w) => String(w.name) === "额度 · 受限积分")
  assert.ok(perm && limited, `缺说明窗: ${JSON.stringify(u.windows)}`)
  assert.equal(perm.aside, true)
  assert.equal(limited.aside, true)
  assert.equal(perm.display, "1099.60")
  assert.equal(limited.display, "0.00")
})

test("17) total_points 是数字（非字符串）也认", async () => {
  const body = { data: { points_entitlement: { total_points: 88.5, permanent_points: 88.5, limited_points: 0 } } }
  const u = await usageWith(async () => Response.json(body))(async () => ({ llmToken: LLM, token: TOKEN }))

  const main = u.windows.find((w) => String(w.name) === "额度 · 平台积分")
  assert.equal(main.balance, 88.5)
  assert.equal(main.display, "88.50 积分")
})

test("18) points_entitlement 缺失 → 回落 data.amount", async () => {
  const u = await usageWith(async () => Response.json({ data: { amount: 50 } }))(async () => ({
    llmToken: LLM,
    token: TOKEN,
  }))

  const main = u.windows.find((w) => String(w.name) === "额度 · 平台积分")
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

test("20) 无平台 token → 「说明 · 额度不可读（没有平台 token）」说明窗（回归）", async () => {
  const u = await usageWith(async () => {
    throw new Error("不该发请求")
  })(async () => ({ llmToken: LLM, accountId: "13800000000" }))

  assert.equal(u.error, undefined)
  assert.match(String(u.windows[0].name), /^说明 · 额度不可读（.+）$/, "T-31 命名：说明窗 + 原因")
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
  const main = r.windows.find((w) => w.name === "额度 · 平台积分")

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
  const main = r.windows.find((w) => w.name === "额度 · 平台积分")

  assert.equal(main.balance, 0)
  assert.equal(main.used, undefined)
  assert.equal(main.limit, undefined)
  assert.equal(main.display, "0.00 积分")
})

// ── T-31：窗口命名一致性（跨插件统一）────────────────────────────────────
//
// 规范 `magpie-plugins/UNIFIED-PLAN.md` §1.1：**每一个**窗口名都必须以三个前缀之一开头。
// 前缀与语义的对应：
//
//	额度 · …  参与路由（有 used，或 balance+unit）
//	停用 · …  `used:100` ⇒ 路由跳过该号（quwork 没有任何依据这么做，所以一条都不该出现）
//	说明 · …  `aside:true` ⇒ 只解释，不参与路由
//
// 一致性测试：把**每一条**返回路径都跑一遍（成功 / 只配模型 token / 什么都没配 /
// HTTP 错 / 业务错 / 认不出字段 / 网络异常 / 带订阅），把产出窗口的名字全收起来逐条查。
// 它不替代语义断言 —— 它只保证名字没有漂回旧写法。

test("T-31：所有窗口名都必须以「额度 · / 停用 · / 说明 · 」之一开头（且前缀与字段语义一致）", async () => {
  const PREFIXES = ["额度 · ", "停用 · ", "说明 · "]

  const REAL_WITH_SUB = {
    data: {
      points_entitlement: {
        total_points: "1099.60",
        permanent_points: "1099.60",
        limited_points: "0.00",
        active_subscription: { name: "标准版" },
      },
    },
  }

  /** 每一条返回路径各造一个样例 */
  const cases = [
    {
      label: "成功（带订阅）",
      auth: { llmToken: LLM, token: TOKEN },
      fetchImpl: async () => Response.json(REAL_WITH_SUB),
    },
    {
      label: "成功（无订阅）",
      auth: { llmToken: LLM, token: TOKEN },
      fetchImpl: async () => Response.json(REAL_SELF),
    },
    {
      label: "只有模型 token",
      auth: { llmToken: LLM, accountId: "13800000000" },
      fetchImpl: async () => {
        throw new Error("不该发请求")
      },
    },
    {
      label: "什么都没配",
      auth: {},
      fetchImpl: async () => {
        throw new Error("不该发请求")
      },
    },
    { label: "HTTP 401", auth: { llmToken: LLM, token: TOKEN }, fetchImpl: async () => new Response("no", { status: 401 }) },
    {
      label: "业务失败",
      auth: { llmToken: LLM, token: TOKEN },
      fetchImpl: async () => Response.json({ success: false, message: "token invalid" }),
    },
    {
      label: "认不出字段",
      auth: { llmToken: LLM, token: TOKEN },
      fetchImpl: async () => Response.json({ data: { somethingElse: true } }),
    },
    {
      label: "网络异常",
      auth: { llmToken: LLM, token: TOKEN },
      fetchImpl: async () => {
        throw new Error("ETIMEDOUT")
      },
    },
  ]

  /** @type {any[]} */
  const seen = []
  for (const c of cases) {
    const u = await usageWith(c.fetchImpl)(async () => c.auth)
    const windows = Array.isArray(u?.windows) ? u.windows : []
    assert.ok(windows.length > 0, `[${c.label}] 没有窗口可查`)
    seen.push(...windows.map((w) => ({ label: c.label, name: String(w?.name ?? ""), w })))
  }

  // ① 名字前缀
  for (const { label, name } of seen) {
    assert.ok(
      PREFIXES.some((p) => name.startsWith(p)),
      `[${label}] 窗口名「${name}」不符合 T-31 命名：必须以 ${PREFIXES.join(" / ")} 之一开头`,
    )
  }

  // ② 前缀与字段语义必须一致（名字骗人比没名字更糟）
  for (const { label, name, w } of seen) {
    if (name.startsWith("停用 · ")) {
      assert.equal(w.used, 100, `[${label}]「${name}」是停用窗 ⇒ used 必须是 100`)
      assert.equal(w.aside, undefined, `[${label}]「${name}」是停用窗 ⇒ 不能带 aside`)
    }
    if (name.startsWith("说明 · ")) {
      assert.equal(w.aside, true, `[${label}]「${name}」是说明窗 ⇒ 必须 aside:true`)
      assert.equal(w.used, undefined, `[${label}]「${name}」是说明窗 ⇒ 不许带 used`)
    }
  }

  // ③ 只允许「停用 · 额度耗尽」一种停用窗（余额 0 是真实证据）；其它停用窗不许出现
  for (const s of seen.filter((x) => x.name.startsWith(STOP_PREFIX))) {
    assert.match(s.name, /^停用 · 额度耗尽$/, "只允许「停用 · 额度耗尽」，其余停用窗等于判死无依据的号")
  }

  // ④ 三个前缀里至少要出现两个（本文件真的覆盖到了说明窗与额度窗）
  for (const p of [QUOTA_PREFIX, NOTE_PREFIX]) {
    assert.ok(seen.some((s) => s.name.startsWith(p)), `本文件没有产出过「${p}…」窗口，一致性测试名存实亡`)
  }
})

// ── 额度耗尽 → 停用窗（让路由跳过；余额 0 是真实证据，不是伪造）──────────────
test("余额为 0 且无订阅 → 补「停用 · 额度耗尽」（used:100 + 未来 resetsAt）", async () => {
  const u = await usageWith(async () =>
    Response.json({ data: { points_entitlement: { total_points: "0.00" } } }),
  )(async () => ({ llmToken: LLM, token: TOKEN }))
  const stop = u.windows.find((w) => String(w.name).startsWith(STOP_PREFIX))
  assert.ok(stop, "余额 0 必须出现停用窗，否则路由仍会派活")
  assert.equal(stop.used, 100)
  assert.equal(stop.limit, 100)
  assert.equal(stop.aside, undefined, "停用窗必须参与路由，不能 aside")
  assert.ok(Date.parse(stop.resetsAt) > Date.now(), "resetsAt 必须在未来，否则 magpie 不认")
})

test("余额 > 0 → 没有停用窗", async () => {
  const u = await usageWith(async () => Response.json({ data: { points: 100 } }))(
    async () => ({ llmToken: LLM, token: TOKEN }),
  )
  assert.equal(u.windows.filter((w) => String(w.name).startsWith(STOP_PREFIX)).length, 0)
})

test("余额 0 但仍有订阅 → 不加停用窗（避免误杀）", async () => {
  const u = await usageWith(async () =>
    Response.json({ data: { points_entitlement: { total_points: "0", active_subscription: { name: "标准版" } } } }),
  )(async () => ({ llmToken: LLM, token: TOKEN }))
  assert.equal(u.windows.filter((w) => String(w.name).startsWith(STOP_PREFIX)).length, 0)
})
