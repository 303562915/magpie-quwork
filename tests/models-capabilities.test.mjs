// models-capabilities.test.mjs 模型能力**从上游读**（不再写死「纯文本」）。
//
// # 背景
//
// 用户原话：「每个模型它能支持什么，全部从上游获取就行了。」
//
// 上一版：`modalities` 写死 `{input:["text"],output:["text"]}`，实时目录还写死
// `supportsImage:false` —— 于是：
//
//	① magpie 的「识图模型」下拉框里永远没有 quwork 的模型（路由组选它发图就卡）
//	② 上游明说收图的模型也被当成纯文本
//
// 现在的能力来源有两处，**都是上游自己的**：
//
//	客户端 qurvis-model-config.json（`DEFAULT_MODELS[].supportsImage`）
//	实时 `/v1/models` 的 `capabilities` / `vision` / `supportsImage`
//
// ⚠ 全部注入 fetchImpl：本测试**不允许**打真上游。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeModelsHook, mapUpstreamCapabilities } from "../src/hooks/models.mjs"

const LLM = "llm-token-abc123"

function hookWith(fetchImpl) {
  return makeModelsHook({ log: { warn() {} }, fetchImpl })
}

/** 静态表路径（没有 token ⇒ 不发请求）。 */
const staticHook = () => hookWith(async () => new Response("never", { status: 500 }))

test("静态表 supportsImage:true → input.image / modalities.input / attachment 全部为真", async () => {
  const out = await staticHook()({}, {})
  const m = out["qwen3.7-plus"]

  assert.equal(m.capabilities.input.image, true, "客户端配置说它收图")
  assert.ok(m.modalities.input.includes("image"), "识图下拉框只认 modalities.input")
  assert.equal(m.attachment, true)
  assert.equal(m.supportsImage, true)
  assert.equal(m.capabilities.input.text, true)
})

test("静态表 supportsImage:false → 不含 image", async () => {
  const out = await staticHook()({}, {})
  const m = out["glm-5.2"]

  assert.equal(m.capabilities.input.image, false)
  assert.deepEqual(m.modalities, { input: ["text"], output: ["text"] })
  assert.equal(m.attachment, false)
  assert.equal(m.supportsImage, false)
})

test("实时目录带 capabilities.vision → 覆盖静态表的判断", async () => {
  const out = await hookWith(async () =>
    Response.json({
      data: [
        {
          id: "some-vl",
          capabilities: {
            vision: true,
            reasoning: false,
            function_calling: false,
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
        },
      ],
    }),
  )({}, { auth: { llmToken: LLM } })

  const m = out["some-vl"]
  assert.equal(m.capabilities.input.image, true)
  assert.deepEqual(m.modalities, { input: ["text", "image"], output: ["text"] })
  assert.equal(m.attachment, true)
  assert.equal(m.capabilities.toolcall, false, "上游说 function_calling:false 就不调工具")
  assert.equal(m.capabilities.reasoning, false, "上游显式否认推理链就照抄 false")
})

test("实时目录没有能力字段 → 回落 text，且不夺走工具/推理（回归）", async () => {
  const out = await hookWith(async () => Response.json({ data: [{ id: "bare", name: "Bare" }] }))(
    {},
    { auth: { llmToken: LLM } },
  )

  const m = out["bare"]
  assert.deepEqual(m.modalities, { input: ["text"], output: ["text"] })
  assert.equal(m.capabilities.input.image, false)
  assert.equal(m.attachment, false)
  assert.equal(m.capabilities.toolcall, true, "上游没说话 ⇒ 保持原判")
  assert.equal(m.capabilities.reasoning, true, "上游没说话 ⇒ 沿用客户端 compat 表")
})

test("实时目录的顶层 vision / supportsImage 也认", async () => {
  const out = await hookWith(async () =>
    Response.json({ data: [{ id: "top-level", vision: true }, { id: "flag", supportsImage: true }] }),
  )({}, { auth: { llmToken: LLM } })

  assert.equal(out["top-level"].capabilities.input.image, true)
  assert.deepEqual(out["top-level"].modalities.input, ["text", "image"])
  assert.equal(out["flag"].capabilities.input.image, true)
})

test("mapUpstreamCapabilities 是纯函数：缺字段回落 text，vision 与模态数组互相补齐", () => {
  const none = mapUpstreamCapabilities({})
  assert.deepEqual(none.inputModalities, ["text"])
  assert.deepEqual(none.outputModalities, ["text"])
  assert.equal(none.vision, false)
  assert.equal(none.toolcall, true)

  const half = mapUpstreamCapabilities({ capabilities: { vision: true } })
  assert.equal(half.vision, true)
  assert.deepEqual(half.inputModalities, ["text", "image"])

  const video = mapUpstreamCapabilities({ capabilities: { input_modalities: ["text", "video"] } })
  assert.equal(video.input.video, true)
  assert.equal(video.input.image, false)
})
