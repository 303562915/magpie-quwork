// multimodal-passthrough.test.mjs 多模态 content **原样透传**（不裁剪 image_url）。
//
// # 为什么这条必须钉住
//
// magpie 把一条消息的 `content` 作为**数组**交给我们（OpenAI 多模态形状）：
//
//	[{"type":"text","text":"hi"},
//	 {"type":"image_url","image_url":{"url":"data:image/png;base64,...."}}]
//
// loader 是唯一碰请求体的地方。它一旦把数组「整理」成字符串（或只留 text 段），
// 图就静默消失：上游收到纯文本，用户看到「模型不认图 / 卡住」。
//
// ⚠ 全部注入 fetchImpl：本测试**不允许**打真上游。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeLoaderHook } from "../src/hooks/loader.mjs"

const LLM = "llm-token-abc123"
const CHAT_URL = "https://placeholder.example/v1/chat/completions"

/** 一条真正会被发出去的多模态消息。 */
const PARTS = [
  { type: "text", text: "hi" },
  { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
]

function capture() {
  /** @type {any[]} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
  }
  return { calls, fetchImpl }
}

async function loaderWith(opts) {
  const hook = makeLoaderHook({ log: { warn() {} }, ...opts })
  return hook(async () => ({ type: "oauth", access: LLM, llmToken: LLM }))
}

for (const bodyMode of ["client-shape", "passthrough"]) {
  test(`bodyMode:${bodyMode} → messages[].content 数组原样透传`, async () => {
    const { calls, fetchImpl } = capture()
    const loader = await loaderWith({ fetchImpl, bodyMode })

    await loader.fetch(CHAT_URL, {
      method: "POST",
      body: JSON.stringify({ model: "qwen3.8-flash", messages: [{ role: "user", content: PARTS }] }),
    })

    assert.equal(calls.length, 1)
    const sent = JSON.parse(calls[0].init.body)
    assert.deepEqual(sent.messages[0].content, PARTS, "image_url 段必须逐字段还在（顺序也不能变）")
    if (bodyMode === "client-shape") {
      assert.equal(sent.stream, true, "补形态字段不等于动内容")
    }
  })
}

test("历史里的多段 content 也不被合并/裁剪", async () => {
  const { calls, fetchImpl } = capture()
  const loader = await loaderWith({ fetchImpl })

  const messages = [
    { role: "user", content: PARTS },
    { role: "assistant", content: [{ type: "text", text: "看到了" }] },
  ]
  await loader.fetch(CHAT_URL, { method: "POST", body: JSON.stringify({ model: "qwen3.8-flash", messages }) })

  const sent = JSON.parse(calls[0].init.body)
  assert.deepEqual(sent.messages, messages)
})
