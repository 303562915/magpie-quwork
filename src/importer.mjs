// importer.mjs `auth.import` —— 「从文件导入」批量导入 QuWork 账号（T-33）。
//
// # 这是 magpie 自己的钩子（OpenCode 会忽略）
//
// 用户点了供应商编辑页里的「从文件导入账号…」，magpie 弹文件选择器，把每个文件的
// **文本内容**交给这个钩子：
//
//	auth.import(texts, { signal }) → 一组登录结果
//
// 每个结果与一次正常登录的产出**同形**：
//
//	成功 → { type:"success", access, refresh, expires, accountId, metadata }
//	失败 → { type:"failed", error:"文件 N 第 M 条：<原因>" }
//
// magpie 按登录的方式保存成功项（新增账号或覆盖同一个账号），所以插件这边**不写**
// `plugin-auth.json`；只读它做去重（见 `existingIndex()`）。
//
// # 界面上的症状（这个模块存在的直接原因）
//
// 缺 `auth.import` 时，「添加提供商」里**根本没有**「从文件导入」这一行 ——
// 真机核对过 loomy / officeace / codearts 都有，只有 quwork 没有。
//
// # 为什么宽容解析
//
// 用户的账号 JSON 来自不同工具，形状至少有三种（都认）：
//
//	{ "llmToken": "sk-...", "token": "eyJ...", "phone": "150...", "uid": "6415", "expire": 1797702136 }
//	{ "access": "sk-...", "refresh": "eyJ...", "accountId": "150...", "expires": 1797702136000 }
//	{ "platform": "quwork", "llmToken": "sk-..." }
//
// 外层容器还可能是数组、`{provider, version:1, accounts:[…]}`，或每行一个对象的
// NDJSON（中间坏一行只丢那一行，不连坐整份文件）。
//
// # 硬约束（踩过的形状问题，别再犯）
//
//	① `access` 必须是 **llmToken**（loader 拿它调模型）
//	② `accountId` **绝不为空**（空串 ⇒ 卡片退化成 `Signed in (pjcsg3)`）
//	③ `metadata` 只放非空值（空串等于没写）
//	④ `expires` 是**毫秒**；上游 `expire` 是秒，小量级自动 ×1000
//	⑤ 单次最多 `IMPORT_MOST` 条，超出必须**明说还剩几条**，不许静默截断

import { isMine, readAll } from "./auth-store.mjs"
import { PROVIDER } from "./constants.mjs"
import { accountIdOf, compact } from "./identity.mjs"

/** magpie 单次最多收 100 条（`IMPORT_MOST`，见其 host.js）。 */
export const IMPORT_MOST = 100

/**
 * 给界面显示的一句话：要选什么文件。
 *
 * ⚠ 最多 300 字节（magpie 会截断），所以写短。
 */
export const IMPORT_FROM =
  "QuWork 账号 UTF-8 JSON（单对象、数组、version: 1 容器，或每行一个对象的 NDJSON；字段：llmToken 必需，token/phone/uid/expire 可选）"

/** 多语言版本的同一句话（magpie 的 `importFroms` 字段）。 */
export const IMPORT_FROMS = {
  zh: IMPORT_FROM,
  "zh-TW":
    "QuWork 帳號 UTF-8 JSON（單物件、陣列、version: 1 容器，或每行一個物件的 NDJSON；欄位：llmToken 必需，token/phone/uid/expire 可選）",
  en: "a QuWork account UTF-8 JSON (llmToken required; token/phone/uid/expire optional; object, array, version: 1 container, or NDJSON)",
}

/** 条目级错误（不是「文件坏了」，而是「这一条不对」）。 */
export class ImportError extends Error {
  constructor(message) {
    super(message)
    this.name = "ImportError"
  }
}

/** 字符串化 + trim（`null`/`undefined` → `""`）。 */
const pick = (value) => String(value ?? "").trim()

/** 是不是「结构化 JSON 对象」（数组 / null 都不算）。 */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * 把「整份 JSON」的解析结果摊平成条目数组。
 *
 * 认的形状：
 *
 *	[…]                                     数组
 *	{…}                                     单对象
 *	{provider, version:1, accounts:[…]}      容器
 *	"sk-..."                                裸 token（最省事的形态）
 *
 * @param {any} data 已 JSON.parse 的值
 * @returns {any[]}
 */
function rowsOf(data) {
  if (Array.isArray(data)) return data
  // 裸字符串：直接当 llmToken（一份文件里只有一行 token 的情形）
  if (typeof data === "string") return [{ llmToken: data }]
  if (!isObject(data)) throw new ImportError("需要 UTF-8 JSON（对象、数组或每行一个对象的 NDJSON）")

  // 容器：{provider, version:1, accounts:[…]}
  if (Array.isArray(data.accounts)) {
    if (data.provider !== undefined && pick(data.provider) !== PROVIDER) {
      throw new ImportError("容器的 provider 与当前供应商不匹配")
    }
    if (data.version !== undefined && data.version !== 1) {
      throw new ImportError("容器的 version 必须为 1")
    }
    return data.accounts
  }

  return [data]
}

/**
 * 解析一份文件 → 「槽位」数组。
 *
 * 槽位要么是 `{ item }`（待校验的条目），要么是 `{ error }`（坏行）。保留坏行槽位
 * 是为了**逐条报错**：只丢那一行，其余照常导入（用户不该为了导入去改文件格式）。
 *
 * 顺序：
 *
 *	① 整份 `JSON.parse`（单对象 / 数组 / 容器）
 *	② 失败 → 逐行解析（NDJSON），跳过空行、`#` 与 `//` 注释行
 *
 * @param {string} text
 * @returns {Array<{item?: any, error?: string}>}
 */
function slotsOf(text) {
  const cleaned = String(text ?? "").replace(/^\uFEFF/, "")
  if (!cleaned.trim()) throw new ImportError("文件是空的")

  try {
    const data = JSON.parse(cleaned)
    return rowsOf(data).map((item) => ({ item }))
  } catch (err) {
    // 内容层面的错（provider 不匹配 / version 不对 / 不是对象）要原样报给用户，
    // 别被下面的「再按行试一次」吃掉。
    if (err instanceof ImportError) throw err
  }

  /** @type {Array<{item?: any, error?: string}>} */
  const slots = []
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith("//")) continue
    try {
      const value = JSON.parse(line)
      if (Array.isArray(value)) {
        for (const item of value) slots.push({ item })
      } else {
        slots.push({ item: value })
      }
    } catch {
      // 这一行不是 JSON：只丢这一行（报一条 failed），不连坐整份文件
      slots.push({ error: "这一行不是合法的 JSON" })
    }
  }
  if (!slots.length) {
    throw new ImportError("需要 UTF-8 JSON（对象、数组或每行一个对象的 NDJSON）；不支持裸日志")
  }
  return slots
}

/**
 * `expire` / `expires` → **毫秒**（与 magpie 的 `expires` 同单位）。
 *
 * 上游 `expire` 是**秒**（`1797702136`），而客户端导出的 `expires` 常是毫秒。
 * 按量级归一：小于 1e12 当秒 ×1000。认不出 → 0（= 不会过期，不要续期）。
 *
 * @param {number|string|undefined|null} value
 * @returns {number}
 */
function expirationOf(value) {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/**
 * 一条原始条目 → 「登录成功」结果。
 *
 * 字段优先级（见文件头「# 为什么宽容解析」的三种形状）：
 *
 *	llmToken ← `llmToken` → `llm_token` → `access`
 *	token    ← `token`    → `refresh`（平台 token，只影响积分与续期）
 *	phone    ← `phone`    → 没 uid 时用 `accountId`（quwork 的 accountId 通常就是手机号）
 *
 * @param {any} row
 * @returns {{type: "success", access: string, refresh: string, expires: number, accountId: string, metadata: Record<string, any>}}
 */
function toResult(row) {
  if (!isObject(row)) throw new ImportError("每一条都必须是 JSON 对象")

  const llmToken = pick(row.llmToken) || pick(row.llm_token) || pick(row.access)
  if (!llmToken) throw new ImportError("缺少 llmToken")

  const token = pick(row.token) || pick(row.refresh)
  const uid = pick(row.uid)
  const hint = pick(row.accountId)
  // accountId 是手机号形态的 hint 时当 phone 用；等于 llmToken 的 hint 没有意义
  const phone = pick(row.phone) || (uid || hint === llmToken ? "" : hint)
  const expires = expirationOf(row.expire ?? row.expires)

  return {
    type: "success",
    access: llmToken,
    // 平台 token（可选）：只用于「积分显示」与「续期」，没有就空串
    refresh: token,
    expires,
    // ⚠ 绝不为空（空串 ⇒ 卡片退化成随机键后缀）
    accountId: accountIdOf({ phone, uid, llmToken }),
    // ⚠ 只放非空值（空串等于没写）
    metadata: compact({ uid, phone, nickname: phone, token }),
  }
}

/**
 * 读 `plugin-auth.json` 里已有的 quwork 账号：`llmToken → 账号键`。
 *
 * 「已导入过的不要再返回」只能从宿主侧的事实得知。格式不在插件契约里，所以读失败
 * 一律当「没有账号」，绝不因为去重把导入搞挂。
 *
 * 键只认 `quwork` / `quwork#<n>`（别的 provider 的账号不参与我们的去重）。
 *
 * @param {string} configDir
 * @returns {Map<string, string>}
 */
function existingIndex(configDir) {
  /** @type {Map<string, string>} */
  const index = new Map()
  const dir = pick(configDir)
  if (!dir) return index

  for (const [key, value] of Object.entries(readAll(dir))) {
    if (!isMine(key)) continue
    const entry = /** @type {any} */ (value ?? {})
    const token = pick(entry.llmToken) || pick(entry.access)
    if (token && !index.has(token)) index.set(token, key)
  }
  return index
}

/**
 * 把一段/几段文本变成「登录结果」列表。
 *
 * `auth.import`（文件导入）与登录弹窗里的「从文件导入（粘贴）」**共用这一条**
 * 解析/校验/去重/截断逻辑 —— 不许出现第二套解析器（两份实现迟早对不上）。
 *
 * @param {string[]} texts 每段文本（一个文件一段，或用户粘贴的一大段）
 * @param {{configDir?: string, log?: {warn?: Function}, signal?: AbortSignal}} [opts]
 * @returns {Promise<{results: object[], accepted: object[]}>}
 *   `accepted` 是其中 `type:"success"` 的那些（登录弹窗要拿它们逐个落盘）。
 */
export async function collectResults(texts, opts = {}) {
  const configDir = pick(opts.configDir)
  const log = opts.log ?? console
  const signal = opts.signal

  if (signal?.aborted) return { results: [], accepted: [] }

  const list = Array.isArray(texts) ? texts.filter((t) => typeof t === "string" && t.trim()) : []
  if (list.length === 0) return { results: [{ type: "failed", error: "没有可导入的 JSON 文件" }], accepted: [] }

  // ── ① 先把所有文件摊平成带位置标签的槽位（跨文件统一编号）──
  /** @type {Array<{where?: string, item?: any, failed?: string}>} */
  const entries = []
  for (const [fileIndex, text] of list.entries()) {
    const location = `文件 ${fileIndex + 1}`
    /** @type {Array<{item?: any, error?: string}>} */
    let slots
    try {
      slots = slotsOf(text)
    } catch (err) {
      const message = err instanceof ImportError ? err.message : "凭据校验失败"
      entries.push({ failed: `${location}：${message}` })
      continue
    }
    for (const [index, slot] of slots.entries()) {
      const where = `${location} 第 ${index + 1} 条`
      entries.push(slot.error ? { failed: `${where}：${slot.error}` } : { where, item: slot.item })
    }
  }

  // ── ② 逐条校验 + 去重（宿主里已有的 / 本批次已收下的都要拒）──
  /** @type {Map<string, string>} */
  const existing = existingIndex(configDir)
  /** @type {Map<string, number>} */
  const batch = new Map()
  /** @type {object[]} */
  const results = []
  let unprocessed = 0

  for (const [i, entry] of entries.entries()) {
    if (signal?.aborted) {
      unprocessed += entries.length - i
      break
    }
    // magpie 单次只收 IMPORT_MOST 条：超出的**不再处理**，但下面要如实报剩余数
    if (results.length >= IMPORT_MOST) {
      unprocessed += entries.length - i
      break
    }
    if (entry.failed) {
      results.push({ type: "failed", error: entry.failed })
      continue
    }
    try {
      const result = toResult(entry.item)
      const key = existing.get(result.access)
      if (key) throw new ImportError(`该 llmToken 已存在（key=${key}）`)
      const seen = batch.get(result.access)
      if (seen) throw new ImportError(`该 llmToken 已存在（本批次第 ${seen} 条已导入）`)
      batch.set(result.access, i + 1)
      results.push(result)
    } catch (err) {
      const message = err instanceof ImportError ? err.message : "凭据校验失败"
      results.push({ type: "failed", error: `${entry.where}：${message}` })
    }
  }

  const accepted = results.filter((r) => r?.type === "success")
  if (signal?.aborted) return { results, accepted }

  // ── ③ 截断必须**说清**（不许静默丢数据）──
  if (unprocessed > 0) {
    results.push({
      type: "failed",
      error:
        `本次共 ${entries.length} 条，已处理 ${results.length} 条；` +
        `还有 ${unprocessed} 条超出单次 ${IMPORT_MOST} 条上限，` +
        `请再次选择同一文件继续导入（已导入的会被自动跳过）`,
    })
  }

  // 一条都没解析出来：给一条 failed 说明原因，而不是静默返回空数组
  // （静默的空结果在界面上表现为「点了导入，什么都没发生」）。
  if (results.length === 0) {
    try {
      log?.warn?.("quwork: 导入没有认出任何账号")
    } catch {
      /* 日志失败不是业务失败 */
    }
    return { results: [{ type: "failed", error: "没从文件里认出账号（需要含 llmToken 的 JSON）" }], accepted }
  }

  return { results, accepted }
}

/**
 * 构建 `auth.import` 钩子。
 *
 * @param {{configDir?: string, log?: {warn?: Function}}} [opts]
 *   `configDir`：magpie 配置目录，用来读 `plugin-auth.json` 做去重（不传则不去重）。
 * @returns {{importFrom: string, importFroms: Record<string, string>,
 *   import: (texts: string[], ctx?: {signal?: AbortSignal}) => Promise<object[]>}}
 */
export function makeImportHook(opts = {}) {
  return {
    importFrom: IMPORT_FROM,
    importFroms: IMPORT_FROMS,

    /**
     * @param {string[]} texts 用户选中的每个文件的**文本内容**
     * @param {{signal?: AbortSignal}} [ctx]
     * @returns {Promise<object[]>} 一组登录结果（与 authorize/callback 的产出同形）
     */
    async import(texts, ctx = {}) {
      const { results } = await collectResults(texts, {
        configDir: opts.configDir,
        log: opts.log,
        signal: ctx.signal,
      })
      return results
    },
  }
}
