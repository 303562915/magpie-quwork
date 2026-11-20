// body-shape.mjs 把请求体补成 **QuWork 客户端形态**（docs/CLIENT-REVERSE.md §1.4）。
//
// # 只补三样东西（其余一个字不动）
//
//	stream         客户端写死 true（§1.5：没有非流式分支）
//	stream_options 缺省 { include_usage: true }（§1.4）
//	thinking + reasoning_effort   **仅 deepseek 系**（§1.4 末条：最容易漏的字段）
//
// 为什么 `thinking` 必须补：
//
//	deepseek-flash 默认 → { "thinking": {"type":"enabled"}, "reasoning_effort":"high" }
//	用户关思考         → { "thinking": {"type":"disabled"} }（**无** reasoning_effort）
//
// 只按「OpenAI 标准参数」写 body 会漏掉 `thinking`，请求于是不像客户端。
//
// # 三条自律
//
//	① `messages` / `tools` / `tool_choice` / `max_tokens` **绝不改写**
//	   （`max_tokens` 不裁剪、也不会因为缺省而补 —— 客户端是「给多少发多少」）
//	② 调用方已经给了的字段一律尊重（`thinking`、`reasoning_effort`、`stream_options`）
//	③ 纯函数：不改入参；非对象入参原样返回

/** deepseek 系判定：客户端只对这两个模型声明了 `compat.thinkingFormat = "deepseek"`。 */
export function isDeepseekModel(model) {
  const m = String(model ?? "").trim().toLowerCase()
  return m.startsWith("deepseek-") || m.startsWith("deepseek/")
}

/**
 * 把 body 补成客户端形态。
 *
 * @param {{model?: string, stream?: boolean, stream_options?: any, thinking?: any,
 *   reasoning_effort?: string, [k: string]: any}} body 调用方原始 body（不会被修改）
 * @returns {any} 新的 body 对象（浅拷贝 + 补字段）
 */
export function shapeBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body

  /** @type {any} */
  const out = { ...body }

  // ① 恒流式
  out.stream = true

  // ② usage 帧（缺省才补；显式给的形态尊重）
  if (out.stream_options === undefined || out.stream_options === null) {
    out.stream_options = { include_usage: true }
  }

  // ③ deepseek 系的思考字段
  if (isDeepseekModel(out.model)) {
    const effort = out.reasoning_effort === undefined ? "high" : out.reasoning_effort
    out.reasoning_effort = effort
    if (out.thinking === undefined || out.thinking === null) {
      // `off` 是「关思考」：那时客户端只发 thinking.disabled（reasoning_effort 也照发 off，
      // 因为调用方明确给了值 —— 我们只负责补缺省，不负责删字段）
      out.thinking = { type: String(effort).toLowerCase() === "off" ? "disabled" : "enabled" }
    }
  }

  return out
}