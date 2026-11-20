// constants.mjs QuWork（qurvis）插件的全部常量。
//
// # 两个 base 必须分开（踩过的坑）
//
//	模型平面  MODEL_BASE_URL     https://llm.quwork.cn/v1   ← /v1/chat/completions、/v1/models
//	平台 API  PLATFORM_BASE_URL  https://llm.rrzu.com       ← /api/user/self、/api/user/refresh
//
// 早期把两者当成同一个 host（`llm.rrzu.com`），结果是 chat 打到平台 API 上。
// 真源：客户端缓存 `qurwork-model-config-cache.json` 里 provider.baseURL
// = `https://llm.quwork.cn/v1`；`docs/quwork/README.md §3.1` 的平台接口在
// `https://llm.rrzu.com`。
//
// # 出处标注约定
//
//	§x.y = docs/quwork/README.md 的对应小节（协议真源，不在这里复述全文）

/** 插件 id / 供应商 id（magpie 用它区分账号键：`quwork`、`quwork#1`…）。 */
export const PROVIDER = "quwork"

/** 模型平面（OpenAI 兼容）。§3.4 */
export const MODEL_BASE_URL = "https://llm.quwork.cn/v1"

/** 平台 API（积分 / 续期 / 签到…）。§3.1 */
export const PLATFORM_BASE_URL = "https://llm.rrzu.com"

/** 测试环境（§0 头部：生产 llm.rrzu.com / 测试 dev-llm.rrzuji.com）。 */
export const MODEL_BASE_URL_DEV = "https://dev-llm.rrzuji.com/v1"
export const PLATFORM_BASE_URL_DEV = "https://dev-llm.rrzuji.com"

/** 路径（相对上面的 base）。 */
export const CHAT_PATH = "/chat/completions"
export const MODELS_PATH = "/models"
export const SELF_PATH = "/api/user/self"
export const REFRESH_PATH = "/api/user/refresh"

/** 客户端版本（§2.2：`X-QurWork-Version`）。 */
export const CLIENT_VERSION = "1.7.5"

/** 客户端公共头（§2.2）。服务端不强制，但带上更像客户端。 */
export const ENV_HEADERS = Object.freeze({
  "X-QurWork-Env": "prod",
  "X-QurWork-Version": CLIENT_VERSION,
  Accept: "application/json",
})

/** pi-ai 版本（客户端 UA 里那一段）。§1.3：`pi/1.5.0 (win32; node/vXX; x64)` */
export const PI_AI_VERSION = "1.5.0"

/**
 * 客户端出站 UA —— pi-ai 的 `formatUserAgent()` 拼出来的那串（§1.3）。
 *
 * ⚠ 中间那段用**运行时真实的** node 版本，不硬编码：客户端随内嵌运行时走，
 * 我们随宿主 node 走，写死一个版本号反而更容易露馅。
 *
 * @param {{nodeVersion?: string, platform?: string, arch?: string}} [env]
 * @returns {string} 形如 `pi/1.5.0 (win32; node/v24.15.0; x64)`
 */
export function clientUserAgent(env = {}) {
  const nodeVersion = String(env.nodeVersion ?? globalThis.process?.versions?.node ?? "0.0.0").replace(/^v/, "")
  const platform = String(env.platform ?? globalThis.process?.platform ?? "win32")
  const arch = String(env.arch ?? globalThis.process?.arch ?? "x64")
  return `pi/${PI_AI_VERSION} (${platform}; node/v${nodeVersion}; ${arch})`
}

/**
 * 默认 body 改写模式。
 *
 *	"client-shape"  `shapeBody()`：补 stream / stream_options / deepseek 的 thinking
 *	"passthrough"   **完全不动** body（逐字节原样发）
 */
export const DEFAULT_BODY_MODE = "client-shape"

/** 默认模型（客户端缓存 `qurwork-model-config-cache.json` 的权威列表，10 个）。 */
export const DEFAULT_MODELS = Object.freeze([
  { id: "kimi-k2.7-code", name: "Kimi-K2.7-Code", contextWindow: 1000000, maxTokens: 128000, supportsImage: false },
  { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 128000, supportsImage: false },
  { id: "qwen3.7-plus", name: "Qwen3.7-Plus", contextWindow: 1000000, maxTokens: 128000, supportsImage: true },
  { id: "MiniMax-M2.5", name: "MiniMax-M2.5", contextWindow: 1000000, maxTokens: 32768, supportsImage: false },
  { id: "kimi-k2.6", name: "Kimi-K2.6", contextWindow: 1000000, maxTokens: 262144, supportsImage: true },
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 1000000, maxTokens: 128000, supportsImage: true },
  { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1000000, maxTokens: 384000, supportsImage: true },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro 正式版", contextWindow: 1000000, maxTokens: 384000, supportsImage: false },
  { id: "qwen3.8-max", name: "Qwen3.8-Max", contextWindow: 1000000, maxTokens: 128000, supportsImage: false },
  { id: "qwen3.8-flash", name: "Qwen3.8-Flash", contextWindow: 1000000, maxTokens: 128000, supportsImage: true },
])

/**
 * 客户端默认模型（缓存里 `defaultModel = deepseek-official/deepseek-flash`）。
 *
 * ⚠ 只用于 README 与排障提示 —— 插件不替用户选模型（magpie 自己按 provider
 * 配置与用户选择派活）。
 */
export const DEFAULT_MODEL_ID = "deepseek-flash"

/** token 兜底有效期：`expire` 缺失时客户端按 2 小时算。§4.2 / client `DEFAULT_ACCESS_TOKEN_TTL_MS` */
export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000

/** 剩余不足 1 小时就续期。§4.2 / client `ACCESS_TOKEN_REFRESH_WINDOW_MS` */
export const REFRESH_WINDOW_MS = 60 * 60 * 1000

/** 续期节流：60 秒内最多一次（本插件自加，防止并发请求各续一次）。 */
export const REFRESH_THROTTLE_MS = 60 * 1000

/** 拉目录 / 探活的超时。 */
export const CATALOG_TIMEOUT_MS = 10_000

/** 平台接口超时。 */
export const PLATFORM_TIMEOUT_MS = 10_000

/** `plugin-auth.json` 里的键前缀（magpie 多账号命名规则）。 */
export const AUTH_KEY = PROVIDER
