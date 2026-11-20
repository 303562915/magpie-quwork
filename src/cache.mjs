// cache.mjs 磁盘缓存的**唯一**读写入口（T-39）。
//
// # 为什么需要它（用户原话）
//
//	「所有的东西都需要缓存。更新缓存是我们来控制的，不要自动更新缓存」
//	「重启项目的时候，我不希望它就会自动去发送什么请求」
//
// 改造前：`provider.models` 每次被 magpie 问都打一次 `/v1/models`；magpie 一重启
// 就会对**每个账号**问一次 —— N 个账号 = N 次上游请求（与 loomy 的
// `auth.models` 每账号一次是同一个坑）。
//
// 改造后：钩子**只读缓存**；缓存由用户点面板「刷新」写。没有缓存就返回一句
// 「额度未读」，绝不在后台偷偷补数据。
//
// # 文件（都在 `configDir`，即 magpie 的配置目录）
//
//	quwork-models-cache.json   { [baseUrl]:        { at, list } }
//	quwork-usage-cache.json    { [accountKey]:     { at, windows } }
//
// ⚠ 结构就是上面这两层，**没有** `version` / `updatedAt` 之类的旁支键 ——
//   缓存文件是给人看、给人删的（删掉 = 下次重新读），多一层包装只会让「谁负责
//   更新」变得模糊。
//
// # 三条自律
//
//	① 读失败/文件损坏 → 当作**没有缓存**（`null`），从不抛
//	② 写失败 → 返回 false，从不抛（缓存写不进去不该让钩子失败）
//	③ 写是原子的（临时文件 + rename），半截文件不会把缓存读坏

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** 模型目录缓存（按 baseUrl 分键）。 */
export const MODELS_CACHE_FILE = "quwork-models-cache.json"

/** 额度缓存（按账号分键）。 */
export const USAGE_CACHE_FILE = "quwork-usage-cache.json"

/**
 * 规范化缓存目录：空/非字符串 → `""`（= 关闭缓存）。
 *
 * ⚠ 关闭缓存时钩子退回「实时读」而不是永远显示「未读」—— 没有可写的目录就
 *   无处缓存，这时让它读一次比让用户永远看不到数据更诚实。生产环境 magpie
 *   一定给 `input.directory`，所以正常安装永远走缓存路径。
 *
 * @param {any} dir
 * @returns {string}
 */
export function cacheDirOf(dir) {
  return String(dir ?? "").trim()
}

/**
 * 缓存的绝对路径（目录为空时返回空串）。
 * @param {string} dir
 * @param {string} file
 * @returns {string}
 */
export function cacheFilePath(dir, file) {
  const base = cacheDirOf(dir)
  return base ? join(base, file) : ""
}

/**
 * 读一整份缓存表。
 *
 * @param {string} dir
 * @param {string} file
 * @returns {Record<string, any>} 读不到 / 坏了 / 不是对象 → 空对象
 */
export function readCacheTable(dir, file) {
  const path = cacheFilePath(dir, file)
  if (!path) return {}
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return parsed
}

/**
 * 读一条缓存。
 *
 * @param {string} dir
 * @param {string} file
 * @param {string} key
 * @returns {any|null}
 */
export function readCacheEntry(dir, file, key) {
  const table = readCacheTable(dir, file)
  const hit = table[String(key ?? "")]
  return hit && typeof hit === "object" && !Array.isArray(hit) ? hit : null
}

/**
 * 写一整份缓存表（原子）。
 *
 * @param {string} dir
 * @param {string} file
 * @param {Record<string, any>} table
 * @returns {boolean} 成功 true；目录为空 / 写失败 false
 */
export function writeCacheTable(dir, file, table) {
  const path = cacheFilePath(dir, file)
  if (!path) return false
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, "utf8")
    renameSync(tmp, path)
    return true
  } catch {
    // 缓存写失败不是业务失败：下次读不到就是「没有缓存」，钩子照常工作
    try {
      if (tmp) writeFileSync(tmp, "") // 收拾残局（失败也无所谓）
    } catch {
      /* 忽略 */
    }
    return false
  }
}

/**
 * 写一条缓存（其余条目原样保留）。
 *
 * @param {string} dir
 * @param {string} file
 * @param {string} key
 * @param {Record<string, any>} value 必须是可 JSON 序列化的普通对象
 * @returns {boolean}
 */
export function writeCacheEntry(dir, file, key, value) {
  const k = String(key ?? "").trim()
  if (!k || !value || typeof value !== "object") return false
  const table = readCacheTable(dir, file)
  table[k] = value
  return writeCacheTable(dir, file, table)
}

/**
 * 账号在缓存里的键。
 *
 * 优先 `accountId`（magpie 的账号名，面板与钩子两边都拿得到），其次手机号，
 * 最后才对 llmToken 做一次散列 —— 键里**绝不出现 token 原文**（缓存文件是
 * 明文 JSON，写进去等于把凭据抄了一遍）。
 *
 * @param {{accountId?: any, phone?: any, metadata?: any, llmToken?: any, access?: any}} [input]
 * @returns {string}
 */
export function accountCacheKey(input = {}) {
  const meta = input?.metadata && typeof input.metadata === "object" ? input.metadata : {}
  const id = String(input?.accountId ?? "").trim()
  if (id) return id
  const phone = String(input?.phone ?? meta.phone ?? meta.nickname ?? "").trim()
  if (phone) return phone
  const token = String(input?.llmToken ?? input?.access ?? "").trim()
  if (token) return `llm:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`
  return "default"
}
