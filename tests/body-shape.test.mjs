// body-shape.test.mjs 请求形状态对齐 QuWork 客户端（docs/CLIENT-REVERSE.md §1.4）。
//
// # 为什么这个文件必须存在
//
// 客户端的模型平面走 `@earendil-works/pi-ai` 的 `openai-completions` 适配器，
// 它对 deepseek 系模型会**额外**发一个 `thinking` 字段（`§1.4` 末条）：
//
//	deepseek-flash 默认 → { "thinking": {"type":"enabled"}, "reasoning_effort":"high" }
//	用户关思考         → { "thinking": {"type":"disabled"} }（**无** reasoning_effort）
//
// 只按「OpenAI 标准参数」写 body 会把这个字段漏掉 —— 请求于是不像客户端。

import { test } from "node:test"
import assert from "node:assert/strict"

import { shapeBody, isDeepseekModel } from "../src/body-shape.mjs"

const BASE = {
  model: "deepseek-flash",
  messages: [{ role: "user", content: "hi" }],
}

test("deepseek 系：缺 reasoning_effort → 补 high，并注入 thinking.enabled", () => {
  const out = shapeBody(BASE)
  assert.equal(out.reasoning_effort, "high")
  assert.deepEqual(out.thinking, { type: "enabled" })
})

test("reasoning_effort: \"off\" → thinking.type === \"disabled\"", () => {
  const out = shapeBody({ ...BASE, reasoning_effort: "off" })
  assert.deepEqual(out.thinking, { type: "disabled" })
  assert.equal(out.reasoning_effort, "off", "off 由调用方给，我们不删")
})

test("已有 thinking → 不被覆盖（调用方说了算）", () => {
  const out = shapeBody({ ...BASE, thinking: { type: "disabled" } })
  assert.deepEqual(out.thinking, { type: "disabled" })
  assert.equal(out.reasoning_effort, "high", "reasoning_effort 仍缺省补 high")
})

test("非 deepseek 模型（glm-5.2）：不补 reasoning_effort、不注入 thinking", () => {
  const out = shapeBody({ model: "glm-5.2", messages: [] })
  assert.equal(out.reasoning_effort, undefined)
  assert.equal(out.thinking, undefined)
})

test("stream 强制 true；stream_options 缺省补 include_usage", () => {
  const a = shapeBody(BASE)
  assert.equal(a.stream, true)
  assert.deepEqual(a.stream_options, { include_usage: true })

  const b = shapeBody({ ...BASE, stream: false })
  assert.equal(b.stream, true, "客户端写死流式，非流式拿不到转码")

  const c = shapeBody({ ...BASE, stream_options: { include_usage: false } })
  assert.deepEqual(c.stream_options, { include_usage: false }, "显式给的尊重")
})

test("messages / tools / tool_choice / max_tokens 一个字不动", () => {
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ]
  const tools = [{ type: "function", function: { name: "f", parameters: { type: "object" } } }]
  const input = { ...BASE, messages, tools, tool_choice: "auto", max_tokens: 200000 }

  const out = shapeBody(input)

  assert.deepEqual(out.messages, messages)
  assert.deepEqual(out.tools, tools)
  assert.equal(out.tool_choice, "auto")
  assert.equal(out.max_tokens, 200000, "不裁剪、不补默认")
})

test("不修改入参（纯函数）", () => {
  const input = { ...BASE, messages: [{ role: "user", content: "hi" }] }
  const snapshot = JSON.parse(JSON.stringify(input))
  shapeBody(input)
  assert.deepEqual(input, snapshot)
})

test("isDeepseekModel：前缀判定（deepseek- / deepseek/ 都算），其它不算", () => {
  assert.equal(isDeepseekModel("deepseek-flash"), true)
  assert.equal(isDeepseekModel("deepseek-v4-pro"), true)
  assert.equal(isDeepseekModel("DEEPSEEK-v4-pro"), true)
  assert.equal(isDeepseekModel("glm-5.2"), false)
  assert.equal(isDeepseekModel("kimi-k2.6"), false)
  assert.equal(isDeepseekModel(""), false)
  assert.equal(isDeepseekModel(undefined), false)
})

test("非对象 / 非法 body 原样返回（别把调用方的东西弄坏）", () => {
  assert.equal(shapeBody(null), null)
  assert.equal(shapeBody("string"), "string")
  const arr = [1, 2]
  assert.equal(shapeBody(arr), arr)
})