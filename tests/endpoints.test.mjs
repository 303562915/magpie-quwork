// endpoints.test.mjs 两个 base 不许混用 + 插件装配。
//
// 这是第十九轮补充的硬要求：模型平面走 `llm.quwork.cn/v1`，平台 API 走
// `llm.rrzu.com`。混用会让 chat 打到平台 API 上（真实踩过）。

import { test } from "node:test"
import assert from "node:assert/strict"

import { QuWorkAuthPlugin, _internal } from "../index.mjs"
import { MODEL_BASE_URL, PLATFORM_BASE_URL, DEFAULT_MODELS, DEFAULT_MODEL_ID, CLIENT_VERSION } from "../src/constants.mjs"

const LLM = "llm-token-abc123"
const TOKEN = "platform-token-zzz999"

test("常量：两个 base 分开且与客户端缓存一致", () => {
  assert.equal(MODEL_BASE_URL, "https://llm.quwork.cn/v1")
  assert.equal(PLATFORM_BASE_URL, "https://llm.rrzu.com")
  assert.notEqual(MODEL_BASE_URL, PLATFORM_BASE_URL)
  assert.equal(CLIENT_VERSION, "1.7.5")
  assert.equal(DEFAULT_MODELS.length, 10)
  assert.equal(DEFAULT_MODEL_ID, "deepseek-flash")
})

test("DEFAULT_MODELS 与权威缓存逐项一致（id / name / limits / image）", () => {
  const byId = Object.fromEntries(DEFAULT_MODELS.map((m) => [m.id, m]))
  assert.deepEqual(Object.keys(byId).sort(), [
    "MiniMax-M2.5",
    "deepseek-flash",
    "deepseek-v4-pro",
    "glm-5.2",
    "glm-5.3-flash",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "qwen3.7-plus",
    "qwen3.8-flash",
    "qwen3.8-max",
  ])
  assert.equal(byId["deepseek-flash"].maxTokens, 384000)
  assert.equal(byId["deepseek-flash"].supportsImage, true)
  assert.equal(byId["kimi-k2.6"].maxTokens, 262144)
  assert.equal(byId["MiniMax-M2.5"].maxTokens, 32768)
  assert.equal(byId["deepseek-v4-pro"].name, "DeepSeek-V4-Pro 正式版")
})

test("插件装配：导出 config / auth.{methods,loader,usage} / provider.models", async () => {
  const p = await QuWorkAuthPlugin({}, {})

  assert.equal(typeof p.config, "function")
  assert.equal(typeof p.auth.loader, "function")
  assert.equal(typeof p.auth.usage, "function")
  assert.equal(typeof p.auth.methods, "object")
  assert.equal(p.auth.provider, "quwork")
  assert.equal(typeof p.provider.models, "function")
  assert.equal(p.provider.id, "quwork")
})

test("chat 用 MODEL_BASE_URL；平台接口用 PLATFORM_BASE_URL（同一次装配里）", async () => {
  /** @type {string[]} */
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    return Response.json({ data: { points: 5 }, choices: [] })
  }

  // 用 _internal 直接装配出两个钩子，共用同一个 fetchImpl
  const loader = await _internal.makeLoaderHook({ fetchImpl, log: { warn() {} } })(async () => ({
    llmToken: LLM,
    token: TOKEN,
  }))
  await loader.fetch("https://placeholder.example/v1/chat/completions", { method: "POST", body: "{}" })

  const usage = _internal.makeUsageHook({ fetchImpl, log: { warn() {} } })
  await usage(async () => ({ llmToken: LLM, token: TOKEN }))

  assert.equal(urls[0], `${MODEL_BASE_URL}/chat/completions`)
  assert.equal(urls[1], `${PLATFORM_BASE_URL}/api/user/self`)
})

test("config 钩子把 baseURL 指向模型平面", async () => {
  const p = await QuWorkAuthPlugin({}, {})
  const cfg = p.config({})
  assert.equal(cfg.baseURL, MODEL_BASE_URL)
  assert.equal(cfg.options.baseURL, MODEL_BASE_URL)
  assert.equal(cfg.name, "QuWork")
})

test("插件选项 bodyMode 透传到 loader：passthrough 原样，默认 client-shape 补字段", async () => {
  const raw = JSON.stringify({ model: "deepseek-flash", messages: [] })
  /** @type {string[]} */
  const seen = []

  const original = globalThis.fetch
  const fetchImpl = async (_url, init) => {
    seen.push(String(init.body))
    return new Response("{}", { status: 200 })
  }
  globalThis.fetch = fetchImpl
  try {
    for (const options of [{ bodyMode: "passthrough" }, {}]) {
      const p = await QuWorkAuthPlugin({}, options)
      const loader = await p.auth.loader(async () => ({ llmToken: LLM, token: TOKEN }))
      await loader.fetch("https://placeholder.example/v1/chat/completions", { method: "POST", body: raw })
    }
  } finally {
    globalThis.fetch = original
  }

  assert.equal(seen[0], raw, "passthrough：逐字节原样")
  assert.notEqual(seen[1], raw, "默认 client-shape：会补形态字段")
  assert.deepEqual(JSON.parse(seen[1]).thinking, { type: "enabled" })
})
