// login-headers.test.mjs 平台接口**不带** X-QurWork-*（真机实测：带了就要求滑块）。
//
// # 真机实证
//
//	A：form，无客户端头        → {"message":"验证码发送成功","success":true}   ✅
//	B：JSON，无客户端头        → 同上 ✅
//	C：form + x-qurwork-env/
//	   x-qurwork-version       → {"message":"阿里云验证码校验未完成，请重试"} ❌
//
// 所以：**X-QurWork-Env / Version 只在模型平面**（chat / models）；
// 登录（sendVerifyCode / login）与平台接口（/api/user/self）一律不带。

import { test } from "node:test"
import assert from "node:assert/strict"

import { sendVerifyCode, loginWithCode } from "../src/login.mjs"
import { makeUsageHook } from "../src/hooks/usage.mjs"
import { makeLoaderHook } from "../src/hooks/loader.mjs"

const LLM = "sk-llm"
const TOKEN = "pt-platform"

function headerProbe() {
  /** @type {Array<{url: string, headers: Headers}>} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) })
    return Response.json({ success: true, data: { token: TOKEN, llm_token: LLM, points: 5 } })
  }
  return { calls, fetchImpl }
}

const CLIENT_HEADERS = ["x-qurwork-env", "x-qurwork-version"]

test("1) sendVerifyCode：不带 x-qurwork-*，content-type 是 form-urlencoded", async () => {
  const { calls, fetchImpl } = headerProbe()
  const r = await sendVerifyCode({ phone: "13800000000", fetchImpl })

  assert.equal(r.ok, true)
  const h = calls[0].headers
  for (const name of CLIENT_HEADERS) assert.equal(h.get(name), null, `不许带 ${name}`)
  assert.match(String(h.get("content-type")), /application\/x-www-form-urlencoded/)
  assert.equal(h.get("accept"), "application/json")
})

test("2) loginWithCode：不带 x-qurwork-*，content-type 是 json", async () => {
  const { calls, fetchImpl } = headerProbe()
  await loginWithCode({ phone: "13800000000", code: "123456", deviceIdentifier: "d".repeat(64), fetchImpl })

  const h = calls[0].headers
  for (const name of CLIENT_HEADERS) assert.equal(h.get(name), null, `不许带 ${name}`)
  assert.match(String(h.get("content-type")), /application\/json/)
})

test("3) usage 的 /api/user/self：不带 x-qurwork-*（平台接口同例）", async () => {
  const { calls, fetchImpl } = headerProbe()
  const usage = makeUsageHook({ log: { warn() {} }, fetchImpl })
  await usage(async () => ({ llmToken: LLM, token: TOKEN }))

  assert.match(String(calls[0].url), /\/api\/user\/self/)
  for (const name of CLIENT_HEADERS) assert.equal(calls[0].headers.get(name), null, `不许带 ${name}`)
  assert.match(String(calls[0].headers.get("authorization")), /^Bearer /)
})

test("4) loader 的 chat 请求**仍含**这两个头（回归：它们属于模型平面）", async () => {
  const { calls, fetchImpl } = headerProbe()
  const loader = await makeLoaderHook({ fetchImpl, log: { warn() {} } })(async () => ({
    llmToken: LLM,
    access: LLM,
  }))

  await loader.fetch("https://placeholder.example/v1/chat/completions", { method: "POST", body: "{}" })

  assert.equal(calls[0].headers.get("x-qurwork-env"), "prod")
  assert.equal(calls[0].headers.get("x-qurwork-version"), "1.7.5")
})