// loader.test.mjs 请求代理：改写 URL、只发 llmToken、body 逐字节透传。
//
// ⚠ 全部注入 fetchImpl：本测试**不允许**打真上游（没有网络、也不该扣费）。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeLoaderHook } from "../src/hooks/loader.mjs"
import { MODEL_BASE_URL, PLATFORM_BASE_URL } from "../src/constants.mjs"

const LLM = "llm-token-abc123"
const PLATFORM_TOKEN = "platform-token-zzz999"

/** 抓出站请求。 */
function capture() {
  /** @type {Array<{url: string, init: any}>} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  return { calls, fetchImpl }
}

async function loaderWith(opts = {}) {
  const hook = makeLoaderHook({ log: { warn() {} }, ...opts })
  return hook(async () => ({ type: "oauth", access: LLM, llmToken: LLM, token: PLATFORM_TOKEN }))
}

test("把占位 URL 改写为 MODEL_BASE_URL 的 /v1/chat/completions，并换成 llmToken", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl })

  await loader.fetch("https://placeholder.example/v1/chat/completions", {
    method: "POST",
    body: "{}",
    headers: { Authorization: "Bearer stale" },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${MODEL_BASE_URL}/chat/completions`)
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${LLM}`)
})

// ⚠ T-06 起默认 bodyMode = "client-shape"（会补 stream/thinking），所以「逐字节
// 透传」这条要用 passthrough 来验；形态补字段由 body-shape.test / 下面的用例钉。
test("bodyMode:\"passthrough\" → body 逐字节透传（不 parse、不补字段、不裁剪）", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl, bodyMode: "passthrough" })

  const body = '{\n  "model": "deepseek-flash",\n  "messages": [{"role":"user","content":"hi"}],\n  "max_tokens": 999999\n}'
  await loader.fetch("https://placeholder.example/v1/chat/completions", { method: "POST", body })

  assert.equal(calls[0].init.body, body, "passthrough 下连 stream 都不补")
})

test("默认 client-shape：补 stream/thinking，但 max_tokens 等业务字段不被改动", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl })

  await loader.fetch("https://placeholder.example/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 999999 }),
  })

  const body = JSON.parse(String(calls[0].init.body))
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(body.thinking, { type: "enabled" })
  assert.equal(body.reasoning_effort, "high")
  assert.equal(body.max_tokens, 999999, "max_tokens 不裁剪")
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }])
})

test("两个 token 都在时，chat **只用** llmToken（平台 token 不出现）", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl })

  await loader.fetch("https://placeholder.example/v1/chat/completions", { method: "POST", body: "{}" })

  const h = new Headers(calls[0].init.headers)
  assert.equal(h.get("authorization"), `Bearer ${LLM}`)
  assert.ok(!String(calls[0].init.headers && h.get("authorization")).includes(PLATFORM_TOKEN))
})

test("带上客户端公共头（X-QurWork-*）；不覆盖调用方已有的值", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl })

  await loader.fetch("https://placeholder.example/v1/chat/completions", {
    method: "POST",
    body: "{}",
    headers: { "X-QurWork-Env": "dev" },
  })

  const h = new Headers(calls[0].init.headers)
  assert.equal(h.get("x-qurwork-env"), "dev", "调用方优先")
  assert.equal(h.get("x-qurwork-version"), "1.7.5")
  assert.equal(h.get("accept"), "application/json")
})

test("客户端 UA：pi/1.5.0 (win32; node/…) 形态；**不带** traceparent / x-request-id", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl })

  await loader.fetch("https://placeholder.example/v1/chat/completions", { method: "POST", body: "{}" })

  const h = new Headers(calls[0].init.headers)
  const ua = String(h.get("user-agent"))
  assert.match(ua, /^pi\/1\.5\.0 \(win32; node\//, `UA 形态不对: ${ua}`)
  // 运行时真实版本，不硬编码
  assert.ok(ua.includes(`node/v${process.versions.node}`), `UA 里的 node 版本应是运行时真实版本: ${ua}`)

  // §1.3：客户端对这些请求 withhold 会话亲和头 —— 我们也不许发
  assert.equal(h.get("traceparent"), null)
  assert.equal(h.get("x-request-id"), null)
})

test("调用方已设 UA / X-QurWork-Version → 不被覆盖", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl })

  await loader.fetch("https://placeholder.example/v1/chat/completions", {
    method: "POST",
    body: "{}",
    headers: { "User-Agent": "caller/9.9", "X-QurWork-Version": "9.9.9" },
  })

  const h = new Headers(calls[0].init.headers)
  assert.equal(h.get("user-agent"), "caller/9.9")
  assert.equal(h.get("x-qurwork-version"), "9.9.9")
})

test("非 chat 请求不改 URL、不改鉴权（只透传）", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl })

  await loader.fetch(`${PLATFORM_BASE_URL}/api/user/self`, { method: "GET", headers: { Authorization: `Bearer ${PLATFORM_TOKEN}` } })

  assert.equal(calls[0].url, `${PLATFORM_BASE_URL}/api/user/self`)
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${PLATFORM_TOKEN}`)
})

test("响应原样返回：不改状态码、不重试", async () => {
  /** @type {string[]} */
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(String(url))
    return new Response('{"error":"boom"}', { status: 429 })
  }
  const loader = await loaderWith({ fetchImpl })

  const resp = await loader.fetch("https://placeholder.example/v1/chat/completions", { method: "POST", body: "{}" })

  assert.equal(resp.status, 429)
  assert.equal(seen.length, 1, "429 不重试（重试只会让限流更糟）")
})

test("未登录（没有 llmToken）→ 返回空对象，不抛", async () => {
  const hook = makeLoaderHook({ log: { warn() {} }, fetchImpl: async () => new Response("{}") })
  const loader = await hook(async () => ({}))
  assert.deepEqual(loader, {})
})
