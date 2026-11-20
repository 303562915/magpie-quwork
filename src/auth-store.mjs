// auth-store.mjs 读写 `plugin-auth.json` 里的 quwork 条目。
//
// # 文件形态（magpie 自己的约定，别自己发明）
//
//	{ "quwork": {type, access, ...}, "quwork#1": {…}, "quwork#2": {…} }
//
// magpie 的**账号键**就是顶层 key；多账号靠 `quwork#<n>` 区分（与 loomy 插件
// 完全一致，见 magpie-loomy `src/importer.mjs`）。
//
// # 条目字段（本插件契约）
//
//	llmToken  必需 —— 模型 token（OpenAI 兼容），真正能调模型的凭据
//	access    必需 —— magpie 自己读的鉴权字段，恒等于 llmToken
//	token     可选 —— 平台 token，只影响「积分显示」与「续期」
//	expire    可选 —— 平台 token 的秒级过期时间（缺失按 2 小时算）
//	uid/phone 可选 —— 展示与去重用
//
// # 为什么 access 要镜像 llmToken
//
// magpie 的 loader/models 钩子只看 `auth.access`。让 access = llmToken 之后，
// 即使某个钩子没读 llmToken 也能正常工作。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { AUTH_KEY } from "./constants.mjs"
import { accountIdOf } from "./identity.mjs"

/**
 * `plugin-auth.json` 的绝对路径。
 * @param {string} configDir magpie 配置目录
 * @returns {string}
 */
export function authPath(configDir) {
  return join(String(configDir ?? ""), "plugin-auth.json")
}

/**
 * 读整份 auth 表（读不到 / 损坏 → 空对象，**不抛**）。
 * @param {string} configDir
 * @returns {Record<string, any>}
 */
export function readAll(configDir) {
  const file = authPath(configDir)
  if (!String(configDir ?? "").trim() || !existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 原子写回整份 auth 表（先写临时文件再 rename，避免半截文件）。
 * @param {string} configDir
 * @param {Record<string, any>} all
 */
function writeAll(configDir, all) {
  const file = authPath(configDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-quwork`
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, file)
}

/** 这个顶层 key 是不是本插件的账号（`quwork` / `quwork#n`）。 */
export function isMine(key) {
  return key === AUTH_KEY || String(key).startsWith(`${AUTH_KEY}#`)
}

/**
 * 列出本插件的全部账号。
 * @param {string} configDir
 * @returns {Array<{key: string, entry: any}>}
 */
export function listAccounts(configDir) {
  const all = readAll(configDir)
  return Object.entries(all)
    .filter(([key]) => isMine(key))
    .map(([key, entry]) => ({ key, entry }))
}

/**
 * 挑一个没被占用的账号键：`quwork` → `quwork#1` → `quwork#2` …
 * @param {Record<string, any>} all
 * @returns {string}
 */
export function nextKey(all) {
  if (!all[AUTH_KEY]) return AUTH_KEY
  for (let i = 1; i < 10_000; i += 1) {
    const key = `${AUTH_KEY}#${i}`
    if (!all[key]) return key
  }
  return `${AUTH_KEY}#${Date.now()}`
}

/**
 * 写入（或更新）一个账号。
 *
 * # 去重规则（幂等）
 *
 *	① 已有同 `uid` 的条目 → 覆盖它
 *	② 已有同 `llmToken` 的条目 → 覆盖它（**不新增**）
 *	③ 都没有 → 用下一个空闲键
 *
 * @param {string} configDir
 * @param {{llmToken: string, token?: string, expire?: number, uid?: string, phone?: string}} input
 * @returns {{key: string, created: boolean}}
 */
export function upsertAccount(configDir, input) {
  const llmToken = String(input?.llmToken ?? "").trim()
  if (!llmToken) throw new Error("缺少 llmToken")

  const all = readAll(configDir)
  const uid = String(input?.uid ?? "").trim()

  /** @type {string|null} */
  let hit = null
  for (const [key, value] of Object.entries(all)) {
    if (!isMine(key)) continue
    const v = /** @type {any} */ (value)
    if (uid && String(v?.uid ?? "").trim() === uid) {
      hit = key
      break
    }
    if (String(v?.llmToken ?? v?.access ?? "").trim() === llmToken) {
      hit = key
      break
    }
  }

  const key = hit ?? nextKey(all)
  const prev = /** @type {any} */ (all[key] ?? {})

  // ── 合并语义：**新值空、旧值非空 ⇒ 保留旧值** ──
  //
  // 真机踩过：重复登录（只贴 llm_token 的那一项）带进来 `token:""`、`phone:""`，
  // 直接把上一次登录存下的平台 token 和手机号冲掉了，卡片于是变成「额度未知」。
  const keepIfEmpty = (nextValue, prevValue) => {
    const next = String(nextValue ?? "").trim()
    if (next) return nextValue
    const prevStr = String(prevValue ?? "").trim()
    return prevStr ? prevValue : undefined
  }

  /** @type {any} */
  const entry = {
    ...prev,
    type: "oauth",
    access: llmToken,
    llmToken,
  }

  const token = keepIfEmpty(input?.token, prev.token)
  if (token !== undefined) entry.token = token
  else delete entry.token

  const expire = Number(input?.expire) > 0 ? Number(input.expire) : Number(prev.expire) > 0 ? Number(prev.expire) : 0
  if (expire > 0) entry.expire = expire
  else delete entry.expire

  const keepUid = keepIfEmpty(uid, prev.uid)
  if (keepUid !== undefined) entry.uid = keepUid
  else delete entry.uid

  const keepPhone = keepIfEmpty(input?.phone, prev.phone)
  if (keepPhone !== undefined) entry.phone = keepPhone
  else delete entry.phone

  // accountId 同理：旧的**是兜底值**（llm_token: 前缀）而新值有更强来源 ⇒ 升级；
  // 旧的是真人给的名字（手机号 / uid）就保留，别被覆盖。
  const prevAccountId = String(prev.accountId ?? "").trim()
  const prevIsFallback = !prevAccountId || prevAccountId.startsWith("llm_token:")
  const fresh = accountIdOf({ phone: entry.phone, uid: entry.uid, llmToken })
  entry.accountId = prevIsFallback ? fresh : prevAccountId

  // 顺手把历史脏数据里的空串键清掉（只清空串，不动有效值）
  for (const k of Object.keys(entry)) {
    const v = entry[k]
    if (v === undefined || v === null || v === "") delete entry[k]
  }

  all[key] = entry
  writeAll(configDir, all)
  return { key, created: hit === null }
}

/**
 * 按 llmToken 找到条目并**只**覆盖 `token` / `expire`（`llmToken` 绝不动）。
 *
 * 续期的正确姿势：这个函数只碰平台 token 两个字段，其余（含用户手工加的
 * metadata）原样保留。
 *
 * @param {string} configDir
 * @param {string} llmToken
 * @param {{token: string, expire?: number}} next
 * @returns {{ok: boolean, key?: string, reason?: string}}
 */
export function updatePlatformToken(configDir, llmToken, next) {
  const want = String(llmToken ?? "").trim()
  if (!want) return { ok: false, reason: "missing-llmToken" }
  const token = String(next?.token ?? "").trim()
  if (!token) return { ok: false, reason: "missing-token" }

  const all = readAll(configDir)
  for (const [key, value] of Object.entries(all)) {
    if (!isMine(key)) continue
    const v = /** @type {any} */ (value)
    if (String(v?.llmToken ?? v?.access ?? "").trim() !== want) continue
    all[key] = {
      ...v,
      token,
      ...(next?.expire !== undefined ? { expire: Number(next.expire) } : {}),
    }
    writeAll(configDir, all)
    return { ok: true, key }
  }
  return { ok: false, reason: "not-found" }
}
