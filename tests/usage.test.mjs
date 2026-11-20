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

test("有平台 token → 打 PLATFORM_BASE_URL 的 /api/user/self，把积分映射成窗口", async () => {
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
  assert.equal(u.windows[0].amount, 26434)
  assert.equal(u.windows[0].aside, true, "只显示，不参与路由")
  assert.equal(u.windows[0].used, undefined, "绝不伪造 used")
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
  assert.match(String(u.windows[0].name), /token|失效/)
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
