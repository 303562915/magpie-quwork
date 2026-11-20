// hooks/loader.mjs 请求代理：把 magpie 发往上游的 chat 请求改写成 QuWork 模型平面。
//
// # 为什么必须改写 URL
//
// magpie / OpenCode 里的 provider 配置留的是占位 base（插件加载前不知道真地址），
// 真实地址由**插件**决定。本 hook 拿到任何以 `/chat/completions` 结尾的 URL，
// 一律改写为 `MODEL_BASE_URL + /chat/completions`（`docs/quwork/README.md §3.4`）。
//
// # 三条自律
//
//	① body 只在 `client-shape` 模式下**补形态字段**（`shapeBody`：stream /
//	   stream_options / deepseek 的 thinking），其余字段一个字不动；
//	   `passthrough` 模式下**逐字节原样发**
//	② 鉴权只用一个 `llmToken`；即使账号里还存着平台 `token`，chat 也**只**用它
//	   ——两个 token 用途严格分离（§3.4 末注）
//	③ 响应原样交回宿主：不重试、不合成、不改状态码
//
// 续期与额度都是**旁路**（`void`，不阻塞、不失败）。
//
// # 头（§1.3，客户端实测那一套）
//
//	Authorization: Bearer <llmToken>
//	X-QurWork-Env / X-QurWork-Version / Accept: application/json
//	User-Agent: pi/1.5.0 (win32; node/vXX; x64)
//
// ⚠ **不发** traceparent / x-request-id / session_id 类（客户端对这些模型平面
//   请求是 `sendSessionAffinityHeaders: "withhold"`，§1.3）。多带一个头反而更像
//   「不是客户端」。

import { CHAT_PATH, DEFAULT_BODY_MODE, ENV_HEADERS, MODEL_BASE_URL, clientUserAgent } from "../constants.mjs"
import { shapeBody } from "../body-shape.mjs"

/** 判断一个 URL 是不是对话请求（只看路径，不看 host —— 占位 host 会变）。 */
function isChatUrl(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/chat/completions")
  } catch {
    return String(url).includes("/chat/completions")
  }
}

/** 拼接 base + 路径（base 末尾斜杠会被吃掉）。 */
function joinUrl(base, path) {
  return `${String(base ?? "").trim().replace(/\/+$/, "")}${path}`
}

/**
 * 造 loader 钩子。
 *
 * # 返回形状（magpie 契约，照 magpie-loomy）
 *
 *	loader(getAuth) => { baseURL, apiKey, headers, fetch }
 *
 * 宿主读的是**这个对象**：它自己用 `baseURL`/`apiKey`/`headers` 组请求，遇到
 * 需要插件介入的请求就调 `fetch`。所以不能只返回一个裸函数。
 *
 * @param {{modelBaseUrl?: string, log?: any, fetchImpl?: typeof fetch,
 *   refresh?: (auth: any) => Promise<any>}} [opts]
 * @returns {(getAuth: () => Promise<any>) => Promise<{baseURL: string, apiKey: string,
 *   headers: Record<string, string>, fetch: (input: any, init?: RequestInit) => Promise<Response>}>}
 */
export function makeLoaderHook(opts = {}) {
  const modelBaseUrl = String(opts.modelBaseUrl ?? "").trim().replace(/\/+$/, "") || MODEL_BASE_URL
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const log = opts.log ?? console
  const refresh = typeof opts.refresh === "function" ? opts.refresh : null
  /** body 形态：client-shape（默认，补字段）/ passthrough（逐字节原样）。 */
  const bodyMode = String(opts.bodyMode ?? "").trim() || DEFAULT_BODY_MODE
  /** 出站 UA：默认按 pi-ai 规则拼，可注入覆盖（测试/排障）。 */
  const userAgent = String(opts.userAgent ?? "").trim() || clientUserAgent()

  const warn = (m) => {
    try {
      log?.warn?.(m)
    } catch {
      /* 日志失败不是业务失败 */
    }
  }

  /**
   * 把请求体字符串补成客户端形态。
   *
   * ⚠ 解析失败就**原样返回**：body 不是 JSON 时，把它弄坏比不改更糟。
   *
   * @param {string} raw
   * @returns {string}
   */
  function shapeBodyString(raw) {
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return raw
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw
    try {
      return JSON.stringify(shapeBody(parsed))
    } catch {
      return raw
    }
  }

  return async function loader(getAuth) {
    const auth = await getAuth()
    if (!auth?.access && !auth?.llmToken) {
      // 未登录：返回空对象，宿主会用自己的默认（请求自然失败）
      return {}
    }

    // chat 专用凭据：llmToken 优先，`access` 是它的镜像（见 auth-store）
    const llmToken = String(auth?.llmToken ?? auth?.access ?? "").trim()

    /** 真正发请求的那一层：改写 URL / 鉴权 / 补客户端形态头，按 bodyMode 处理 body。 */
    async function fetch(input, init = {}) {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : String(input)

      /** @type {RequestInit} */
      const next = { ...init }
      const headers = new Headers(init.headers)

      let target = rawUrl
      if (isChatUrl(rawUrl)) {
        // ① 改写 URL 到模型平面
        target = joinUrl(modelBaseUrl, CHAT_PATH)
        // ② 鉴权：只发 llmToken（平台 token 在这里**不出现**）
        headers.set("Authorization", `Bearer ${llmToken}`)
        headers.set("Content-Type", headers.get("Content-Type") || "application/json")
        for (const [k, v] of Object.entries(ENV_HEADERS)) {
          if (!headers.has(k)) headers.set(k, v)
        }
        // 客户端 UA（pi-ai 拼的那串）；调用方设了就尊重
        if (!headers.has("User-Agent")) headers.set("User-Agent", userAgent)
        // ⚠ 这里**不**加 traceparent / x-request-id（§1.3 withhold）
        // ③ body 形态
        if (bodyMode !== "passthrough" && typeof init.body === "string" && init.body) {
          next.body = shapeBodyString(init.body)
        }
      }
      next.headers = headers

      const resp = await doFetch(target, next)

      // 旁路续期：只在对话请求之后看一眼（失败/节流都不影响响应）
      if (refresh && isChatUrl(rawUrl)) {
        void Promise.resolve(refresh(auth)).catch(() => {})
      }

      return resp
    }

    return {
      // 宿主用 baseURL + provider.api 自己拼路径；这里给模型平面的根
      baseURL: modelBaseUrl,
      apiKey: llmToken,
      headers: { ...ENV_HEADERS },
      fetch,
    }
  }
}

export { isChatUrl, joinUrl }
