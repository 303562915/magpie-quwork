// models.test.mjs 模型目录：live `/v1/models` → 失败回落 DEFAULT_MODELS。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeModelsHook } from "../src/hooks/models.mjs"
import { DEFAULT_MODELS, MODEL_BASE_URL } from "../src/constants.mjs"

const LLM = "llm-token-abc123"

function hookWith(fetchImpl) {
  return makeModelsHook({ log: { warn() {} }, fetchImpl })
}

test("live 200 → 用 live 列表（并带上 context/output 限制）", async () => {
  /** @type {string[]} */
  const urls = []
  const models = hookWith(async (url, init) => {
    urls.push(String(url))
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${LLM}`, "目录也用 llmToken")
    return Response.json({
      object: "list",
      data: [
        { id: "deepseek-flash", name: "DeepSeek", context_window: 1000000, max_tokens: 384000 },
        { id: "glm-5.2" },
      ],
    })
  })

  const out = await models({}, { auth: { llmToken: LLM } })

  assert.equal(urls[0], `${MODEL_BASE_URL}/models`)
  assert.deepEqual(Object.keys(out).sort(), ["deepseek-flash", "glm-5.2"])
  assert.equal(out["deepseek-flash"].name, "DeepSeek")
  assert.equal(out["deepseek-flash"].limit.context, 1000000)
  assert.equal(out["deepseek-flash"].limit.output, 384000)
  assert.equal(out["glm-5.2"].name, "glm-5.2", "缺 name 时用 id")
})

test("401 / 500 / 网络错误 → 一律回落 DEFAULT_MODELS（10 个）", async () => {
  const cases = [
    async () => new Response("no", { status: 401 }),
    async () => new Response("no", { status: 500 }),
    async () => {
      throw new Error("ECONNRESET")
    },
  ]

  for (const fetchImpl of cases) {
    const out = await hookWith(fetchImpl)({}, { auth: { llmToken: LLM } })
    assert.deepEqual(Object.keys(out).sort(), DEFAULT_MODELS.map((m) => m.id).sort())
    assert.equal(out["deepseek-flash"].limit.output, 384000)
    assert.equal(out["kimi-k2.6"].limit.output, 262144)
  }
})

test("live 返回空列表 → 回落静态表（不能给宿主一个空目录）", async () => {
  const out = await hookWith(async () => Response.json({ object: "list", data: [] }))({}, { auth: { llmToken: LLM } })
  assert.equal(Object.keys(out).length, DEFAULT_MODELS.length)
})

test("未登录（没有 llmToken）→ 静态表，且**不发请求**", async () => {
  let called = 0
  const out = await hookWith(async () => {
    called += 1
    return Response.json({ data: [] })
  })({}, {})
  assert.equal(called, 0)
  assert.equal(Object.keys(out).length, DEFAULT_MODELS.length)
})

test("capabilities：supportsImage 映射到 input.image", async () => {
  const out = await hookWith(async () => new Response("no", { status: 500 }))({}, { auth: { llmToken: LLM } })
  assert.equal(out["qwen3.7-plus"].capabilities.input.image, true)
  assert.equal(out["glm-5.2"].capabilities.input.image, false)
  assert.equal(out["glm-5.2"].capabilities.input.text, true)
})
