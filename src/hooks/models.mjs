// hooks/models.mjs 模型目录：live `/v1/models` → 失败回落静态表。
//
// # 契约形状（与 magpie-loomy 一致）
//
//	provider.models = async (provider, ctx) => Record<id, model>
//
// 返回的是**按 id 索引的对象**，不是数组 —— magpie 的 provider.models 就是这个形状
// （照抄 magpie-loomy 的 `toMagpieModels`）。
//
// # 失败回落不是「兜底偷懒」
//
// `/v1/models` 的存在性**未验证**（§3.4 只列了 chat，client 里对 404 的处置是
// 「不判定」）。所以：401/403/404/5xx/网络错 → 一律回 `DEFAULT_MODELS`（客户端
// 缓存里的权威 10 个）。目录拉不到绝不能让供应商在界面上变成空。

import { DEFAULT_MODELS, ENV_HEADERS, MODELS_PATH, MODEL_BASE_URL, CATALOG_TIMEOUT_MS } from "../constants.mjs"

/**
 * 上游能力声明 → magpie 的两组模态字段（**唯一一处映射**）。
 *
 * # 只认上游说的话，不猜
 *
 *	vision          `capabilities.vision === true`
 *	                ∪ `capabilities.input_modalities` 含 `image`
 *	                ∪ 顶层 `supportsImage === true` / `vision === true`
 *	模态数组         上游没给（或给了空数组）→ 回落 `["text"]`
 *	toolcall        `capabilities.function_calling !== false`（及顶层同名字段）
 *	reasoning       `capabilities.reasoning === true`
 *
 * # 为什么 vision 与模态数组要互相补齐
 *
 * 上游说 `vision: true` 但没在 `input_modalities` 里写 `image` 时，两组声明会
 * 自相矛盾：magpie 的「识图模型」判据看的是 `modalities.input`，而其它地方看
 * `capabilities.input.image` —— 一份声明两个答案。这里补进 `image`，方向只有一个：
 * vision 为真则 image 进列表。
 *
 * @param {{capabilities?: any, supportsImage?: boolean, vision?: boolean}} [entry]
 * @returns {{vision: boolean, toolcall: boolean, reasoning: boolean,
 *   inputModalities: string[], outputModalities: string[],
 *   input: {text: boolean, image: boolean, audio: boolean, video: boolean, pdf: boolean},
 *   output: {text: boolean, image: boolean, audio: boolean, video: boolean, pdf: boolean}}}
 */
export function mapUpstreamCapabilities(entry) {
  const raw = entry?.capabilities
  const up = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}

  const declaredIn = stringList(up.input_modalities)
  const declaredOut = stringList(up.output_modalities)

  // 上游一个字都没说 → 纯文本。**不按模型名猜。**
  const input = declaredIn.length > 0 ? declaredIn : ["text"]
  const output = declaredOut.length > 0 ? declaredOut : ["text"]

  const vision =
    up.vision === true ||
    entry?.vision === true ||
    entry?.supportsImage === true ||
    input.includes("image")
  if (vision && !input.includes("image")) input.push("image")

  return {
    vision,
    toolcall: up.function_calling !== false && entry?.function_calling !== false,
    reasoning: up.reasoning === true,
    inputModalities: input,
    outputModalities: output,
    input: modalityFlags(input),
    output: modalityFlags(output),
  }
}

/**
 * 把模态字符串数组摊成 magpie 要的布尔对象。
 *
 * ⚠ 必须**显式写全**五个布尔值：省掉不等于「按 text 处理」——
 * magpie 只认 `typeof input.image === "boolean"`，没写会退到 models.dev 按裸
 * 模型 id 投票，同名模型在别家标过 image 就会被当成能收图。
 */
function modalityFlags(mods) {
  const has = (m) => mods.includes(m)
  return { text: has("text"), image: has("image"), audio: has("audio"), video: has("video"), pdf: has("pdf") }
}

/** 只留非空字符串并去重。 */
function stringList(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  for (const v of value) {
    if (typeof v !== "string") continue
    const s = v.trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 把一个模型条目转成 magpie 的 model 形状。
 *
 * ⚠ 能力**全部来自上游**（`mapUpstreamCapabilities`），本函数不写死任何一项：
 * `supportsImage` 来自客户端的 `qurvis-model-config.json`（那就是上游自己的声明），
 * 实时目录里若带 `capabilities` 则以它为准。
 *
 * @param {any} provider
 * @param {{id: string, name?: string, contextWindow?: number, maxTokens?: number,
 *   supportsImage?: boolean, vision?: boolean, capabilities?: any, function_calling?: boolean}} e
 */
function toModel(provider, e) {
  const prior = provider?.models?.[e.id] ?? {}
  const up = mapUpstreamCapabilities(e)
  return {
    ...prior,
    id: e.id,
    name: e.name || prior.name || e.id,
    limit: {
      context: e.contextWindow || prior?.limit?.context || 0,
      output: e.maxTokens || prior?.limit?.output || 0,
    },
    capabilities: {
      ...(prior.capabilities ?? {}),
      toolcall: up.toolcall,
      // 上游没声明 reasoning 时沿用客户端 compat 表的结论（这一族都带推理链）；
      // 上游一旦声明（true / false 都算）就照抄 —— 这是「从上游读」而不是「一直为真」。
      reasoning:
        typeof e?.capabilities?.reasoning === "boolean" ? e.capabilities.reasoning : true,
      input: up.input,
      output: up.output,
    },
    modalities: { input: up.inputModalities, output: up.outputModalities },
    attachment: up.vision,
    supportsImage: up.vision,
  }
}

/**
 * 把一组条目整理成 `provider.models` 的返回值。
 *
 * @param {any} provider
 * @param {Array<any>} entries
 * @returns {Record<string, object>}
 */
export function toMagpieModels(provider, entries) {
  /** @type {Record<string, object>} */
  const out = {}
  for (const e of entries) out[e.id] = toModel(provider, e)
  return out
}

/**
 * 拉 live 模型目录。
 *
 * @param {{modelBaseUrl?: string, llmToken: string, fetchImpl?: typeof fetch,
 *   signal?: AbortSignal, log?: any}} opts
 * @returns {Promise<Array<{id: string, name?: string}> | null>} null = 拿不到（调用方回落）
 */
export async function fetchCatalog(opts) {
  const base = String(opts.modelBaseUrl ?? "").trim().replace(/\/+$/, "") || MODEL_BASE_URL
  const doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const headers = new Headers(ENV_HEADERS)
  headers.set("Authorization", `Bearer ${opts.llmToken}`)

  /** @type {RequestInit} */
  const init = { method: "GET", headers }
  init.signal = opts.signal ?? AbortSignal.timeout(CATALOG_TIMEOUT_MS)

  const resp = await doFetch(`${base}${MODELS_PATH}`, init)
  if (!resp.ok) {
    opts.log?.warn?.(`quwork: /v1/models 返回 HTTP ${resp.status}，回退静态模型表`)
    return null
  }

  /** @type {any} */
  const body = await resp.json().catch(() => null)
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  const ids = list.map((m) => String(m?.id ?? "").trim()).filter(Boolean)
  if (ids.length === 0) return null
  return ids.map((id) => {
    const src = list.find((m) => String(m?.id ?? "").trim() === id) ?? {}
    return {
      id,
      name: String(src?.name ?? "") || id,
      contextWindow: Number(src?.context_window ?? src?.contextWindow) || 0,
      maxTokens: Number(src?.max_tokens ?? src?.maxTokens) || 0,
      // ── 能力：上游说了就带走，没说就**什么都不留**（映射处回落 text）──
      //
      // 这里曾经写死 `supportsImage: false`：于是哪怕上游明说这个模型收图，
      // magpie 的「识图模型」里也永远没有它（同一个 bug 在 loomy 上就是发图卡死）。
      capabilities: src?.capabilities,
      supportsImage: typeof src?.supportsImage === "boolean" ? src.supportsImage : undefined,
      vision: typeof src?.vision === "boolean" ? src.vision : undefined,
    }
  })
}

/**
 * 造 models 钩子。
 *
 * @param {{modelBaseUrl?: string, log?: any, fetchImpl?: typeof fetch}} [opts]
 * @returns {(provider: any, ctx?: {auth?: any}) => Promise<Record<string, object>>}
 */
export function makeModelsHook(opts = {}) {
  const log = opts.log ?? console

  return async function models(provider, ctx = {}) {
    const auth = ctx?.auth
    const llmToken = String(auth?.llmToken ?? auth?.access ?? "").trim()

    // 未登录：给静态表（否则界面上这个供应商一个模型都没有）
    if (!llmToken) return toMagpieModels(provider, DEFAULT_MODELS)

    try {
      const live = await fetchCatalog({
        modelBaseUrl: opts.modelBaseUrl,
        llmToken,
        fetchImpl: opts.fetchImpl,
        log,
      })
      if (!live || live.length === 0) return toMagpieModels(provider, DEFAULT_MODELS)
      return toMagpieModels(provider, live)
    } catch (e) {
      // 不抛：抛了宿主只会保留旧列表，日志里反而没线索
      log?.warn?.(`quwork: 拉取实时模型目录失败，回退静态表: ${String(e?.message ?? e).slice(0, 160)}`)
      return toMagpieModels(provider, DEFAULT_MODELS)
    }
  }
}
