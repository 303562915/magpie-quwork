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
 * 把一个模型条目转成 magpie 的 model 形状。
 *
 * @param {any} provider
 * @param {{id: string, name?: string, contextWindow?: number, maxTokens?: number, supportsImage?: boolean}} e
 */
function toModel(provider, e) {
  const prior = provider?.models?.[e.id] ?? {}
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
      toolcall: true,
      reasoning: true,
      input: { text: true, image: e.supportsImage === true, audio: false, video: false, pdf: false },
    },
    modalities: { input: ["text"], output: ["text"] },
    attachment: false,
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
      supportsImage: false,
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
