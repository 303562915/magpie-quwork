// src/wechat-bind.mjs 微信绑定门户：一个**固定二维码** → 分一个未绑定账号 → 出该账号的授权码 → 轮询到绑定成功。
//
// # 为什么要「服务端签发的 state」
//
// 授权页 URL 里唯一的变量是 `state`：
//
//	https://open.weixin.qq.com/connect/qrconnect
//	  ?appid=wxac3315fe86ebb901        常量
//	  &redirect_uri=https://llm.rrzu.com/oauth/wechat   常量（已备案，改不了）
//	  &response_type=code&scope=snsapi_login            常量
//	  &state=<★ 由平台按**这个账号的 Bearer token** 签发 ★>
//
// 扫码后微信把 code 送到 `llm.rrzu.com/oauth/wechat?code=…&state=…`，
// 平台用 state 反查账号、自己完成绑定 —— 我们全程不碰 code。
//
// ⚠ 所以 `src/wechat.mjs` 的 `newState()`（自己 randomBytes 造 state）在这里**不能用**：
//   那套只适合「把 code 粘回来由我们绑」，不适合「绑到指定账号」。
//   必须走 `GET /api/oauth/wechat/url` 拿平台签发的 state。
//
// # 三个角色
//
//	账号池    plugin-auth.json 里的 quwork* 条目（token 在 `refresh` 字段！）
//	门户会话  一次「扫码 → 出码 → 等确认」= sessionId + 该账号的占位锁
//	状态判据  `GET /api/user/self` 的 `wechat_bound`（唯一依据）
//
// # 落盘
//
//	<configDir>/quwork-bind-pool.json   账号池快照（wechatBound / quota / 检查时间）
//	session 只放内存：重启即失效，扫码的人重新扫一次即可 —— 不需要持久化。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

import { PLATFORM_BASE_URL, PLATFORM_TIMEOUT_MS } from "./constants.mjs"
import { activateInvite, callPlatform } from "./invite.mjs"
import { readAll } from "./auth-store.mjs"
import { qrPng } from "./qr.mjs"
import { confirmUrlOf, fetchQrImage, openAuthorizePage, readScanOnce } from "./wechat-watch.mjs"
import { bindWechat, exchangeCode } from "./wechat.mjs"

/** 账号池落盘文件名（与面板其它缓存同级）。 */
export const BIND_POOL_FILE = "quwork-bind-pool.json"

/** 一次扫码会话的有效期（= 占位锁的持有时间）。 */
export const SESSION_TTL_MS = 10 * 60 * 1000

/** 账号池快照多久算旧（超过就在「没有可用账号」时才去重读一次上游）。 */
export const POOL_TTL_MS = 5 * 60 * 1000

/** 平台端点（相对 platformBaseUrl）。
 *
 * ⚠ 别叫 `PATHS`：`src/invite.mjs` 已经有一个同名的、形状不同的导出，
 *   同名不同形最容易在 import 时改错文件。
 */
export const BIND_PATHS = Object.freeze({
  self: "/api/user/self",
  authorizeUrl: "/api/oauth/wechat/url",
})

const MAX_PICK_ATTEMPTS = 8 // 一次分配最多试几个账号：每次尝试打两次上游，8 个够覆盖一轮坏号

/** 单个账号自己上传的并发上限（门户刷新池子时用）。 */
const DEFAULT_CONCURRENCY = 3

// ── 文件读写（读坏当没有，写失败不抛）──────────────────────────────────

/**
 * 读账号池快照。
 *
 * @param {string} configDir
 * @returns {{updatedAt: number, accounts: Record<string, any>}}
 */
export function readPool(configDir) {
  const file = join(String(configDir ?? ""), BIND_POOL_FILE)
  if (!String(configDir ?? "").trim() || !existsSync(file)) return { updatedAt: 0, accounts: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object") return { updatedAt: 0, accounts: {} }
    return {
      updatedAt: Number(parsed.updatedAt) || 0,
      accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {},
    }
  } catch {
    return { updatedAt: 0, accounts: {} }
  }
}

/**
 * 原子写账号池快照（临时文件 + rename）。
 *
 * @param {string} configDir
 * @param {{updatedAt: number, accounts: Record<string, any>}} pool
 * @returns {boolean}
 */
export function writePool(configDir, pool) {
  if (!String(configDir ?? "").trim()) return false
  try {
    const file = join(configDir, BIND_POOL_FILE)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-quwork`
    writeFileSync(tmp, JSON.stringify(pool, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

// ── 平台调用 ────────────────────────────────────────────────────────────

/**
 * 平台那些「标志位」字段的宽松真假判定。
 *
 * # 为什么要宽松
 *
 * `wechat_bound` 是本功能的**唯一**判据，两个方向都会出事：
 *   · 判成 false（明明已绑）→ 把已绑的号发给陌生人，页面秒变「绑定成功」；
 *   · 判成 true（明明没绑）→ 这个号永远不参与分配，等于丢号。
 * 平台不同版本回 `true` / `1` / `"true"` 都见过，所以三种都算真。
 *
 * @param {any} v
 * @returns {boolean}
 */
export function isTruthyFlag(v) {
  if (v === true || v === 1) return true
  const s = String(v ?? "").trim().toLowerCase()
  return s === "true" || s === "1" || s === "yes"
}

/**
 * 账号状态（`wechat_bound` 是「要不要绑」的唯一判据）。
 *
 * @param {{platformBaseUrl?: string, token: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: boolean, wechatBound: boolean, wechatId: string, inviteCode: string,
 *   quota: number, phone: string, message?: string}>}
 */
export async function fetchSelf(opts) {
  const token = String(opts?.token ?? "").trim()
  if (!token) return { ok: false, status: 0, wechatBound: false, wechatId: "", inviteCode: "", quota: 0, phone: "", message: "没有平台 token" }

  const r = await callPlatform({
    platformBaseUrl: opts.platformBaseUrl,
    token,
    path: BIND_PATHS.self,
    method: "GET",
    fetchImpl: opts.fetchImpl,
  })
  if (!r.ok) return { ok: false, status: r.status ?? 0, wechatBound: false, wechatId: "", inviteCode: "", quota: 0, phone: "", message: r.message }

  const d = r.data ?? {}
  return {
    ok: true,
    status: r.status ?? 200,
    wechatBound: isTruthyFlag(d.wechat_bound),
    wechatId: String(d.wechat_id ?? ""),
    inviteCode: String(d.aff_code ?? ""),
    quota: Number(d.quota) || 0,
    // 真实「积分」在 points_entitlement.total_points；quota 是额度（原始单位），两回事
    points: Number(d?.points_entitlement?.total_points ?? d.points ?? d.amount) || 0,
    phone: String(d.phone ?? d.display_name ?? ""),
    createdTime: Number(d.created_time) || 0,
    // `inviter_id` 非 0 = 这个号已经被别人（或自己的另一个号）邀请过了，即「邀请码已绑」
    inviterId: Number(d.inviter_id) || 0,
  }
}

/**
 * 取这个账号**专属**的微信授权地址（state 由平台签发，与账号绑定）。
 *
 * @param {{platformBaseUrl?: string, token: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: boolean, url?: string, state?: string, message?: string}>}
 */
export async function fetchAuthorizeUrl(opts) {
  const token = String(opts?.token ?? "").trim()
  if (!token) return { ok: false, message: "没有平台 token" }

  const r = await callPlatform({
    platformBaseUrl: opts.platformBaseUrl,
    token,
    path: BIND_PATHS.authorizeUrl,
    method: "GET",
    fetchImpl: opts.fetchImpl,
  })
  if (!r.ok) return { ok: false, message: r.message }

  const url = String(r.data?.url ?? "").trim()
  if (!url) return { ok: false, message: "平台没有返回授权地址" }

  // ⚠ 必须是**合法 http(s) URL**。真机踩过：平台限流时可能回一个残缺值，
  //   而 `qrPng(undefined)` 会把字符串 "undefined" 编成一张**扫不出内容**的二维码 ——
  //   外层以为出码成功，人扫了却什么都没发生。宁可这里判失败，让调用方跳过这个号。
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, message: `平台返回的授权地址不合法：${url.slice(0, 40)}` }
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: `平台返回的授权地址协议异常：${parsed.protocol}` }
  }

  const state = parsed.searchParams.get("state") ?? ""
  if (!state) return { ok: false, message: "授权地址里没有 state（这张码绑不到号）" }
  return { ok: true, url, state }
}

// ── 账号池 ──────────────────────────────────────────────────────────────

/** `plugin-auth.json` 里所有 quwork 条目（token 在 `refresh` 字段）。 */
export function listPoolTokens(configDir) {
  const all = readAll(configDir)
  return Object.keys(all)
    .filter((k) => k === "quwork" || k.startsWith("quwork#"))
    .map((key) => {
      const v = all[key] ?? {}
      return {
        key,
        token: String(v.refresh ?? v.token ?? "").trim(),
        phone: String(v.phone ?? v.metadata?.phone ?? ""),
        accountId: String(v.accountId ?? v.phone ?? ""),
      }
    })
}

/**
 * 池子里第几个账号（对外只显示编号，**绝不显示手机号 / key**）。
 *
 * @param {string[]} keys 池子里的全部 key（顺序即文件顺序）
 * @param {string} key
 * @returns {string} 形如 `#3`
 */
export function labelOf(keys, key) {
  const i = keys.indexOf(String(key))
  return i < 0 ? "#?" : `#${i + 1}`
}

/**
 * 重读全部账号的平台状态，写回快照。
 *
 * @param {{configDir: string, platformBaseUrl?: string, fetchImpl?: typeof fetch,
 *   now?: () => number, concurrency?: number}} opts
 * @returns {Promise<{ok: boolean, updated: number, failed: number, total: number,
 *   accounts: Record<string, any>, updatedAt: number}>}
 */
export async function refreshPool(opts) {
  const now = typeof opts?.now === "function" ? opts.now : () => Date.now()
  const entries = listPoolTokens(opts?.configDir)
  const limit = Math.max(1, Math.floor(Number(opts?.concurrency) || DEFAULT_CONCURRENCY))
  /** 旧快照：失败时**保留**旧字段，别把「已绑」洗成「未知」（那会让可分配数虚高）。 */
  const prev = readPool(opts?.configDir).accounts

  /** @type {Record<string, any>} */
  const accounts = {}
  let updated = 0
  let failed = 0

  const queue = [...entries]
  const workers = Array.from({ length: Math.min(limit, Math.max(1, queue.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      if (!item) break
      if (!item.token) {
        accounts[item.key] = { ...(prev[item.key] ?? {}), tokenInvalid: true, error: "没有平台 token", checkedAt: now() }
        failed += 1
        continue
      }
      const self = await fetchSelf({ platformBaseUrl: opts?.platformBaseUrl, token: item.token, fetchImpl: opts?.fetchImpl })
      // 记下平台给的注册时间（秒）：面板要据此区分「今天注册的号」
      const selfCreatedTime = Number(self.createdTime) > 0 ? Number(self.createdTime) : 0
      if (!self.ok) {
        // 只有「凭据被拒」才算 token 失效；超时 / 5xx 只是这次没读到，别把它永久踢出池子
        const authFailed = self.status === 401 || self.status === 403
        accounts[item.key] = {
          ...(prev[item.key] ?? {}),
          error: String(self.message ?? "读取失败").slice(0, 160),
          checkedAt: now(),
          ...(authFailed ? { tokenInvalid: true } : {}),
        }
        failed += 1
        continue
      }
      /** @type {Record<string, any>} */
      const next = {
        ...(prev[item.key] ?? {}),
        wechatBound: self.wechatBound,
        wechatId: self.wechatId,
        quota: self.quota,
        points: self.points,
        createdTime: self.createdTime,
        // 邀请码是否已绑：inviter_id 非 0 即「已被邀请」
        inviterId: self.inviterId,
        checkedAt: now(),
        tokenInvalid: false,
      }
      delete next.error
      accounts[item.key] = next
      updated += 1
    }
  })
  await Promise.all(workers)

  const stamp = now()
  // ⚠ 重新读一次再合并：中间隔着 N 次上游 await，`check()` / `markBound()` 可能已经写过
  //   「已绑」；直接用函数开头读到的 prev 会把这些更新洗掉，同一个号就被再发一次。
  const fresh = readPool(opts?.configDir).accounts
  writePool(opts?.configDir, { updatedAt: stamp, accounts: { ...fresh, ...accounts } })
  return { ok: true, updated, failed, total: entries.length, accounts, updatedAt: stamp }
}

/**
 * 池子概览（**只读文件**，不打上游）。
 *
 * 对外字段里**没有**手机号、没有 token、没有原始 key —— 门户要能被陌生人打开。
 *
 * @param {{configDir: string}} opts
 */
/** 这个时间戳（秒）是不是**本机今天**。 */
function isToday(seconds) {
  const t = Number(seconds) || 0
  if (t <= 0) return false
  const d = new Date(t * 1000)
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

/** 这个时间戳（秒）是否还在注册后 24 小时内（邀请码只认这个窗口）。 */
function isWithin24h(seconds) {
  const t = Number(seconds) || 0
  if (t <= 0) return false
  return Date.now() - t * 1000 <= 24 * 60 * 60 * 1000
}

export function poolOverview(opts) {
  const entries = listPoolTokens(opts?.configDir)
  const keys = entries.map((a) => a.key)
  const phoneOf = new Map(entries.map((a) => [a.key, String(a.phone ?? "")]))
  const pool = readPool(opts?.configDir)
  const list = keys.map((key) => {
    const a = pool.accounts[key] ?? {}
    return {
      key,
      label: labelOf(keys, key),
      // 面板是本机管理界面，显示手机号方便对上「这是谁的号」；
      // 对外门户（/bind/*）仍然只给编号，不泄露手机号。
      phone: phoneOf.get(key) ?? "",
      wechatBound: a.wechatBound === true,
      tokenInvalid: a.tokenInvalid === true,
      quota: Number.isFinite(a.quota) ? a.quota : null,
      points: Number.isFinite(a.points) ? a.points : null,
      checkedAt: Number(a.checkedAt) || 0,
      createdTime: Number(a.createdTime) || 0,
      registeredToday: isToday(a.createdTime),
      // 邀请码绑定状态：inviter_id 非 0 = 已经被邀请过（和「绑微信」是两件事）
      inviterId: Number(a.inviterId) || 0,
      inviteBound: (Number(a.inviterId) || 0) !== 0,
      // 邀请码只认「注册 24 小时内」，所以这两个标记要分开给
      inviteEligible: isWithin24h(a.createdTime),
      error: a.error ? String(a.error) : undefined,
    }
  })

  const bound = list.filter((a) => a.wechatBound).length
  const broken = list.filter((a) => a.tokenInvalid).length
  const available = list.filter((a) => !a.wechatBound && !a.tokenInvalid).length
  const todayCount = list.filter((a) => a.registeredToday).length
  // 「还能赶上 24h 窗口」的号 = 24h 内注册且还没绑微信（绑完就能补邀请）
  const inviteEligible = list.filter((a) => a.inviteEligible && !a.wechatBound).length
  // 「现在就该去补邀请」的号 = 24h 内注册且已经绑了微信（平台要求先绑微信）
  const readyToInvite = list.filter((a) => a.inviteEligible && a.wechatBound && !a.inviteBound).length

  return {
    ok: true,
    updatedAt: pool.updatedAt,
    stale: pool.updatedAt === 0 || Date.now() - pool.updatedAt > POOL_TTL_MS,
    total: list.length,
    bound,
    broken,
    available,
    todayCount,
    inviteEligible,
    readyToInvite,
    accounts: list,
  }
}

// ── 门户（分配 + 轮询）──────────────────────────────────────────────────

/**
 * 分配时占位预留的时长（毫秒）。
 *
 * 必须 ≥ 分配路径上**两次串行上游**的超时之和，否则慢平台时预留会中途失效、
 * 两个人拿到同一个号。测试直接断言这条不等式，别再写死魔数。
 *
 * @returns {number}
 */
export function reserveWindowMs() {
  return PLATFORM_TIMEOUT_MS * 2 + 10_000
}

/**
 * 造一个绑定门户（纯内存会话 + 占位锁；不 listen，方便测试）。
 *
 * @param {{configDir: string, platformBaseUrl?: string, fetchImpl?: typeof fetch,
 *   now?: () => number, sessionTtlMs?: number, poolTtlMs?: number,
 *   adminToken?: string, maxSessions?: number, maxRenewals?: number,
 *   qrPngImpl?: (text: string, opts?: any) => Buffer}} opts
 *   `maxRenewals`：同一个会话最多自动续几次码（默认 6 ≈ 9 分钟）。
 *   续码后页面上那张「专属二维码」会**原地换新**，用户不需要重扫固定码。
 *   `qrPngImpl`：续码时要现画一张 PNG（默认用本仓库的编码器；测试可注入假实现）。
 */
export function createBindPortal(opts) {
  const configDir = String(opts?.configDir ?? "").trim()
  const platformBaseUrl = String(opts?.platformBaseUrl ?? "").trim() || PLATFORM_BASE_URL
  const fetchImpl = opts?.fetchImpl
  const now = typeof opts?.now === "function" ? opts.now : () => Date.now()
  const sessionTtlMs = Number(opts?.sessionTtlMs) > 0 ? Number(opts.sessionTtlMs) : SESSION_TTL_MS
  const poolTtlMs = Number(opts?.poolTtlMs) > 0 ? Number(opts.poolTtlMs) : POOL_TTL_MS
  const maxSessions = Number(opts?.maxSessions) > 0 ? Number(opts.maxSessions) : 500
  const maxRenewals = Number.isInteger(opts?.maxRenewals) && opts.maxRenewals >= 0 ? opts.maxRenewals : 0
  /** 续码时现画二维码（注入点：测试给假实现，生产用默认编码器）。 */
  const qrPngImpl = opts?.qrPngImpl === null ? null : (typeof opts?.qrPngImpl === "function" ? opts.qrPngImpl : qrPng)

  /**
   * 扫码事件（最近 100 条，内存里）。
   *
   * 用来回答「我发了码给人，为什么没反应」：一看就知道是没扫到（只有 alloc），
   * 还是扫了没确认（scanned），还是确认了但换 token / 绑定失败（confirmed + fail）。
   */
  const bindEvents = []
  /**
   * 自动补邀请：**微信绑定成功之后**，按设置里的邀请码轮换去激活。
   *
   * 为什么放在绑定成功之后：平台要求先绑微信才认邀请码（否则回「请先绑定微信」），
   * 而且邀请码只在注册 24 小时内有效 —— 这两件事天然是「绑完立刻做」。
   *
   * 设置从面板来（`opts.autoInvite()`），邀请码可以有多个，按顺序轮换使用。
   * 每次尝试都写一条日志（成功/失败 + 平台原始文案），面板上能直接看到。
   */
  const autoInviteLog = []
  const autoInviteLogFile = () => join(configDir, "quwork-auto-invite.jsonl")
  let autoInviteTurn = 0

  const autoInviteSettings = () => {
    const cfg = typeof opts?.autoInvite === "function" ? opts.autoInvite() : null
    const enabled = cfg?.enabled === true
    const codes = (Array.isArray(cfg?.codes) ? cfg.codes : [])
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
    return { enabled, codes }
  }

  const pushAutoInviteLog = (entry) => {
    autoInviteLog.push(entry)
    while (autoInviteLog.length > 200) autoInviteLog.shift()
    try {
      const f = autoInviteLogFile()
      mkdirSync(dirname(f), { recursive: true })
      appendFileSync(f, JSON.stringify(entry) + "\n", "utf8")
    } catch {
      /* 日志写不进去不影响绑定 */
    }
  }

  /** 绑完微信后自动补邀请码。失败只记日志，不抛。 */
  const runAutoInvite = async (key, token) => {
    const { enabled, codes } = autoInviteSettings()
    if (!enabled || codes.length === 0) return { ok: false, skipped: true }
    const label = labelOf(listPoolTokens(configDir).map((a) => a.key), key)
    const phone = listPoolTokens(configDir).find((a) => a.key === key)?.phone ?? ""
    const inviteCode = codes[autoInviteTurn % codes.length]
    autoInviteTurn += 1

    let res
    try {
      res = await activateInvite({ platformBaseUrl, token, inviteCode, fetchImpl })
    } catch (e) {
      res = { ok: false, message: String(e?.message ?? e) }
    }
    const message = String(res?.message ?? (res?.ok ? "绑定成功" : "绑定失败"))

    // 成功后回读一次，把 inviterId / quota 落盘（否则面板还显示未绑）
    if (res?.ok) {
      try {
        const self = await fetchSelf({ platformBaseUrl, token, fetchImpl })
        if (self.ok) {
          markBound(key, { wechatId: self.wechatId, quota: self.quota, createdTime: self.createdTime })
          const pool = readPool(configDir)
          if (pool.accounts[key]) {
            pool.accounts[key] = { ...pool.accounts[key], inviterId: self.inviterId, quota: self.quota }
            writePool(configDir, pool)
          }
        }
      } catch {
        /* 回读失败不影响结论 */
      }
    }

    pushAutoInviteLog({ at: now(), key, label, phone, inviteCode, ok: res?.ok === true, message })
    return { ok: res?.ok === true, message }
  }

  const pushEvent = (type, data = {}) => {
  bindEvents.push({ at: now(), type, ...data })
  while (bindEvents.length > 100) bindEvents.shift()
  }

  const adminToken = String(opts?.adminToken ?? "").trim()

  /** sessionId → 会话 */
  const sessions = new Map()
  /** accountKey → sessionId（占位锁） */
  const locks = new Map()
  /**
   * accountKey → 预留到期时间。
   *
   * ⚠ 必须跟 `locks` 分开：`allocate()` 里「挑号 → 打上游拿授权地址」中间有 `await`，
   * 两个人同时扫同一个固定码时，第二个人会在第一个人拿到锁之前就挑到同一个号。
   * 所以挑中的那一刻先**预留**，成功后再换成正式占位锁。
   */
  const reserved = new Map()

  /**
   * 预留多久（见 `reserveWindowMs`：要覆盖两次上游超时）。
   */
  const RESERVE_MS = reserveWindowMs()

  const dropSession = (id) => {
    const s = sessions.get(String(id ?? ""))
    if (!s) return null
    sessions.delete(s.sessionId)
    if (locks.get(s.key) === s.sessionId) locks.delete(s.key)
    return s
  }

  /**
   * 清掉过期会话（表很小，全扫一遍即可）。
   *
   * ⚠ **这里不能把 pending 会话标成 expired**：过期只是「这张码不能再用」，
   *   会话本身还能原地续一张新码（见 `check()`）。真正的作废只发生在：
   *   续码次数用完、或号已经被绑掉 —— 两处都在 `check()` 里显式落 `expired`。
   */
  /**
   * 后台监听一个扫码会话：微信长轮询 → 一旦确认就自己换 token 并绑定。
   *
   * # 为什么放在后台
   *
   * `lp.open.weixin.qq.com/connect/l/qrconnect` 是**长轮询**（服务端会 hold 20+ 秒）。
   * 如果让页面每 3 秒来打一次，会把连接堆满；所以这里起一条独立循环，
   * 页面只读 `session.scanState` / `session.status` 这类即时状态。
   *
   * # 成功路径
   *
   *	waiting → scanned(403，已扫码未确认) → confirmed(405 + wx_code)
   *	→ exchangeCode(code) 换 wechat_token → bindWechat(该号 token) → 落 bound
   *
   * 失败也写进 `session.scanError`，面板/页面能直接看到原因（不会只是一句"绑定失败"）。
   *
   * @param {any} session `prepareScan()` 建出来的会话
   */
  async function watchScan(session) {
    const deadline = Math.min(session.expiresAt, now() + 10 * 60 * 1000)
    let last = ""

    /**
     * 两次轮询之间至少歇这么久。
     *
     * ⚠ 这个不能省：微信长轮询在「没人扫」时可能**立刻**返回 408（真机与测试都会），
     *   不歇就是一条死循环，把对方接口打爆、也让进程永远退不出去。
     */
    const minGapMs = Math.max(200, Number(opts?.scanPollGapMs) || 1200)
    const sleep = (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms)
        // 测试/短命进程里不要因为这个定时器吊住事件循环
        if (typeof t?.unref === "function") t.unref()
      })

    while (now() < deadline) {
      if (session.status !== "pending") return
      const r = await readScanOnce({ uuid: session.uuid, last: last || undefined, fetchImpl })
      if (r.errcode) last = r.errcode
      session.attempts = (session.attempts ?? 0) + 1
      session.lastSeenAt = now()

      if (r.state === "scanned") {
        if (session.scanState !== "scanned") pushEvent("scanned", { key: session.key, sessionId: session.sessionId })
        session.scanState = "scanned" // 已扫码，等他点「确认登录」
        await sleep(minGapMs)
        continue
      }
      if (r.state === "expired") {
        session.scanState = "expired"
        session.status = "expired"
        session.settledAt = now()
        session.scanError = "二维码已过期（微信侧）"
        if (locks.get(session.key) === session.sessionId) locks.delete(session.key)
        return
      }
      if (r.state !== "confirmed") {
        session.scanState = r.state === "waiting" ? "waiting" : (session.scanState ?? "waiting")
        await sleep(minGapMs)
        continue
      }

      // ── 已确认：拿到 code，开始真正的绑定 ──
      pushEvent("confirmed", { key: session.key, sessionId: session.sessionId })
      session.scanState = "confirmed"
      session.binding = true
      const token = String(listPoolTokens(configDir).find((a) => a.key === session.key)?.token ?? "").trim()
      if (!token) {
        session.scanError = "这个账号没有平台 token"
        session.status = "expired"
        session.settledAt = now()
        return
      }

      const ex = await exchangeCode({ code: r.code, state: session.state, platformBaseUrl, fetchImpl })
      session.exchangeDebug = { attempts: ex.attempts, raws: ex.raws, via: ex.via }
      if (!ex.ok) {
        // 平台判定「这个微信已经绑过账号」——这是**结论**，不是失败：
        // 微信 OAuth 只允许一个微信绑一个账号，平台会直接登录而不是再签发绑定凭证。
        session.status = "expired"
        session.settledAt = now()
        session.scanState = "already-bound"
        session.alreadyBound = ex.kind === "already-bound"
        session.boundAccount = ex.boundAccount ?? ""
        session.scanError = ex.message
        if (locks.get(session.key) === session.sessionId) locks.delete(session.key)
        return
      }
      if (ex.alreadyBoundOk) {
        // 平台自己回 bind_type=bind：绑定完成
        session.status = "bound"
        session.settledAt = now()
        session.scanState = "bound"
        session.verified = true
        markBound(session.key, { wechatId: "" })
        if (locks.get(session.key) === session.sessionId) locks.delete(session.key)
        return
      }

      const bound = await bindWechat({ platformBaseUrl, token, wechatToken: ex.wechatToken, fetchImpl })
      if (!bound.ok) {
        session.scanError = `绑定时平台拒绝：${bound.message}`
        session.status = "expired"
        session.settledAt = now()
        if (locks.get(session.key) === session.sessionId) locks.delete(session.key)
        return
      }

      // 绑定成功：再用 /api/user/self 复核一次（平台说绑上了才算）
      const after = await fetchSelf({ platformBaseUrl, token, fetchImpl })
      session.status = "bound"
      session.settledAt = now()
      session.scanState = "bound"
      pushEvent("bound", { key: session.key, label: labelOf(listPoolTokens(configDir).map((a) => a.key), session.key) })
      session.wechatId = after.ok ? after.wechatId : ""
      session.verified = Boolean(after.ok && after.wechatBound)
      markBound(session.key, {
        wechatId: session.wechatId,
        // 复核时顺手把积分/注册时间落盘：否则刚绑的号在面板上一直是「积分 0」，
        // 要等下一次「刷新全部账号状态」才对上（用户会以为数字是假的）。
        ...(after.ok ? { quota: after.quota, points: after.points, createdTime: after.createdTime } : {}),
      })
      if (locks.get(session.key) === session.sessionId) locks.delete(session.key)
      // 绑完立刻自动补邀请码（不 await：别拖慢扫码反馈；结果进日志）
      void runAutoInvite(session.key, token)
      return
    }

    // 超时
    if (session.status === "pending") {
      session.status = "expired"
      session.settledAt = now()
      session.scanError = "10 分钟没人扫，已放回池子"
      if (locks.get(session.key) === session.sessionId) locks.delete(session.key)
    }
  }

  const sweep = () => {
    const t = now()
    for (const [k, until] of [...reserved.entries()]) if (t > until) reserved.delete(k)
    for (const s of [...sessions.values()]) {
      if (s.status !== "pending" && t - (s.settledAt ?? s.issuedAt) > 60_000) {
        dropSession(s.sessionId) // bound / expired 的会话留 60 秒供前端读最后一眼
      }
    }
    // 极端情况下（有人狂刷 /go）也别让内存无限涨。
    // ⚠ 只淘汰**已经落定**的会话：淘汰一个 pending 会话会把它占着的号放回池子，
    //   而扫码的人手上那张码还能用 —— 于是两个人能拿到同一个号。
    while (sessions.size > maxSessions) {
      const victim = [...sessions.values()]
        .filter((s) => s.status !== "pending")
        .sort((a, b) => a.issuedAt - b.issuedAt)[0]
      if (!victim) break
      dropSession(victim.sessionId)
    }
  }

  /** 池子里「还能分」的账号（未绑、未失效、没被别人占着）。 */
  const candidates = () => {
    const keys = listPoolTokens(configDir).map((a) => a.key)
    const pool = readPool(configDir)
    return keys
      .map((key) => ({ key, state: pool.accounts[key] ?? {} }))
      .filter(({ key, state }) => {
        if (state.wechatBound === true) return false
        if (state.tokenInvalid === true) return false
        const until = reserved.get(key)
        if (until !== undefined) {
          if (now() <= until) return false
          reserved.delete(key)
        }
        const held = locks.get(key)
        if (held) {
          const s = sessions.get(held)
          if (s && s.status === "pending" && now() <= s.expiresAt) return false
          locks.delete(key)
        }
        return true
      })
      .map(({ key }) => key)
  }

  /** 把某个账号在快照里标成已绑（不影响别的字段）。 */
  const markBound = (key, extra = {}) => {
    const pool = readPool(configDir)
    pool.accounts[key] = { ...(pool.accounts[key] ?? {}), wechatBound: true, checkedAt: now(), ...extra }
    writePool(configDir, pool)
  }

  return {
    /** 池子概览（只读）。 */
    overview() {
      return poolOverview({ configDir })
    },

    /**
     * 释放占位，把号还回池子。
     *
     * # 参数
     *
     *	`idleMs` 只释放「这么久没被轮询过」的会话（默认 0 = 全放）。
     *	传 `idleMs: 60_000` 就只清那些真没人管的，**正在被扫码人盯着的会话保留** ——
     *	这是修掉「管理员一点释放，别人正在扫的码当场作废」那个坑的关键。
     *
     * # 为什么要区分
     *
     * `state` 由平台签发、与账号绑定，但**一旦我们把这个会话丢掉，就再也查不到它属于哪个号**；
     * 扫码人此时点「确认登录」，平台找不到映射 → 他那边看起来"确认了"，我们这边永远 pending。
     * 所以「清占用」不能一刀切，默认先清空闲的，真要全清再显式传 0。
     *
     * @param {{idleMs?: number}} [opts]
     * @returns {{ok: true, releasedSessions: number, releasedLocks: number, releasedReserved: number,
     *   keptActive: number}} `keptActive` = 因为还在被轮询而保留的会话数
     */
    releaseAll(opts = {}) {
      const idleMs = Number.isFinite(Number(opts?.idleMs)) ? Math.max(0, Number(opts.idleMs)) : 0
      const t = now()
      let releasedSessions = 0
      let keptActive = 0
      /** 先记下总数：循环里按会话删锁，事后读 `locks.size` 就只剩留下的了。 */
      const locksBefore = locks.size

      for (const s of [...sessions.values()]) {
        const idle = t - Number(s.lastSeenAt ?? s.issuedAt ?? 0)
        if (idleMs > 0 && s.status === "pending" && idle < idleMs) {
          keptActive += 1
          continue
        }
        sessions.delete(s.sessionId)
        if (locks.get(s.key) === s.sessionId) locks.delete(s.key) // ⚠ 只删自己的锁，别碰保留会话的
        releasedSessions += 1
      }

      const releasedLocks = locksBefore - locks.size
      const releasedReserved = reserved.size
      reserved.clear()
      return { ok: true, releasedSessions, releasedLocks, releasedReserved, keptActive, overview: poolOverview({ configDir }) }
    },

    /** 自动补邀请：当前设置 + 最近日志（新的在前）。 */
    autoInvite() {
      const cfg = autoInviteSettings()
      return { enabled: cfg.enabled, codes: cfg.codes, log: [...autoInviteLog].reverse() }
    },

    /** 手动给某个号补一次邀请码（面板「立即补」用）。 */
    async autoInviteRun(key) {
      const token = String(listPoolTokens(configDir).find((a) => a.key === key)?.token ?? "").trim()
      if (!token) return { ok: false, message: "这个号没有平台 token" }
      return runAutoInvite(key, token)
    },

  /** 排查用：当前所有会话 + 最近扫码事件（回答「监测到了什么、卡在哪一步」）。 */
    sessionsSnapshot() {
      const keys = listPoolTokens(configDir).map((a) => a.key)
      return {
        sessions: [...sessions.values()].map((x) => ({
          sessionId: x.sessionId,
          key: x.key,
          label: labelOf(keys, x.key),
          status: x.status,
          scanState: x.scanState ?? "",
          attempts: x.attempts ?? 0,
          issuedAt: x.issuedAt,
          expiresAt: x.expiresAt,
          error: x.scanError ?? "",
        })),
        events: [...bindEvents],
      }
    },

  /** 当前占位状态（不含任何账号信息，只给数字）。 */
    occupancy() {
      return { sessions: sessions.size, locks: locks.size, reserved: reserved.size }
    },

    /** 手动刷新池子（面板按钮 / 运维用）。 */
    async sync(input) {
      const r = await refreshPool({ configDir, platformBaseUrl, fetchImpl, now, concurrency: input?.concurrency })
      return { ...r, overview: poolOverview({ configDir }) }
    },

    /**
     * **全自动**扫码绑定：出正确的码 + 后台监听扫码 + 收到 code 就自己绑。
     *
     * # 为什么和 `allocateOne` 不同
     *
     * `allocateOne` 还是老路子：把平台签发的 `qrconnect` 地址编成二维码让人扫。
     * 那条路**走不通**——`qrconnect` 是个页面，谁打开它都会现场生成新 uuid，
     * 扫码的人等于只是「用微信打开了登录页」，平台只会让他登录。
     *
     * 正确机制（`wechat-watch.mjs` 头部有完整说明）：
     *	打开授权页 → 取 uuid → 真正的码是 `confirm?uuid=<UUID>` →
     *	后台轮询 `lp.open.weixin.qq.com/connect/l/qrconnect?uuid=<UUID>` →
     *	`wx_errcode=405` 时 `wx_code` 就是授权码 → 换 wechat_token → POST bind。
     *
     * 这一路**不需要扫码人回传任何东西**。
     *
     * @param {string} key 账号 key
     * @returns {Promise<{ok: boolean, reason?: string, message?: string, key?: string, label?: string,
     *   sessionId?: string, uuid?: string, confirmUrl?: string, qr?: string, ttlMs?: number}>}
     */
    async prepareScan(key, scanOpts) {
      sweep()
      const entries = listPoolTokens(configDir)
      /**
       * 自动挑号时的筛选：`24h`（默认，邀请码只认注册后 24 小时）/ `today` / `all`。
       * 显式指定 key 时这个参数不生效。
       */
      const scanFilter = String(scanOpts?.filter ?? "24h").trim() || "24h"
      /** 已经拿到过的号（阵列一次要好几格时用，避免复用分支反复返回同一个）。 */
      const scanExclude = new Set((Array.isArray(scanOpts?.exclude) ? scanOpts.exclude : []).map(String))
      /** 这个时间戳（秒）是否还在注册后 24 小时内。 */
      const within24h = (sec) => {
        const t = Number(sec) || 0
        return t > 0 && Date.now() - t * 1000 <= 24 * 60 * 60 * 1000
      }
      /** 这个时间戳（秒）是不是本机今天。 */
      const todayOf = (sec) => {
        const t = Number(sec) || 0
        if (t <= 0) return false
        const d = new Date(t * 1000)
        const n = new Date()
        return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
      }

      /**
       * 不传 key 时自动挑一个号（阵列页 / `/bind/go` 用）。
       *
       * 挑选规则与 `allocate()` 一致：跳过已绑、token 失效、正被占着的号。
       * 区别只在**出码方式** —— 这里走的是修复后的正确链路（uuid → confirm?uuid=），
       * 而不是把 `qrconnect` 页面地址编成二维码。
       */
      let want = String(key ?? "").trim()
      if (!want) {
        const snap = readPool(configDir).accounts
        const taken = new Set([...locks.keys(), ...reserved.keys()])
        // 快照里一条 createdTime 都没有（还没 sync 过）→ 时间筛选无意义，退化为不筛，
        // 否则会把「还没同步」误判成「没有 24 小时内的号」，整个门户直接空掉。
        const hasTimeInfo = entries.some((a) => Number(snap[a.key]?.createdTime) > 0)

        const free = entries
          .map((a) => a.key)
          .filter((k) => snap[k]?.wechatBound !== true && snap[k]?.tokenInvalid !== true && !taken.has(k))
          .filter((k) => {
            if (scanExclude.has(k)) return false
            if (scanFilter === "all" || !hasTimeInfo) return true
            const created = Number(snap[k]?.createdTime) || 0
            if (scanFilter === "today") return todayOf(created)
            return within24h(created)
          })
        want = free[0] ?? ""
        if (!want) {
          /**
           * 复用：同一个号已经有「还在等待扫码」的会话（码没过期）时直接拿它出来。
           *
           * 为什么必须有这一步：24 小时窗口内的号本来就少（当时只有 5 个），
           * 而每个会话会把号占住 10 分钟 —— 谁刷新几次页面，阵列就只剩 1 格甚至 0 格。
           * 复用不会产生新的授权码，只是把**同一张还在等的码**再显示一次，扫码行为完全一样。
           */
          for (const cand of scanOpts?.allowReuse === true ? sessions.values() : [].values()) {
            if (cand.status !== "pending") continue
            if (scanExclude.has(cand.key)) continue
            if (now() > cand.expiresAt) continue
            if (!cand.qr || !cand.confirmUrl) continue
            if (scanFilter !== "all" && hasTimeInfo) {
              const created = Number(snap[cand.key]?.createdTime) || 0
              const okTime = scanFilter === "today" ? todayOf(created) : within24h(created)
              if (!okTime) continue
            }
            return {
              ok: true,
              reused: true,
              key: cand.key,
              label: labelOf(entries.map((a) => a.key), cand.key),
              sessionId: cand.sessionId,
              uuid: cand.uuid,
              confirmUrl: cand.confirmUrl,
              state: cand.state,
              qr: cand.qr,
              ttlMs: Math.max(0, cand.expiresAt - now()),
            }
          }

          return {
            ok: false,
            reason: "no-account",
            message:
              scanFilter === "24h"
                ? "没有「注册 24 小时内」且未绑的号（邀请码只认这个窗口；给老号绑只做签到的话，把筛选切到全部）"
                : scanFilter === "today"
                  ? "今天没有新注册的未绑账号"
                  : "池子里暂时没有可分配的账号",
          }
        }
        // ⚠ 必须在 await 之前就占住：两次并发进来会看到同一批空闲号，
        //   不预留就会把同一个号发两次（§17b 踩过）。成功后由 locks 接管，
        //   失败路径靠 TTL 过期自动回收。
        reserved.set(want, now() + RESERVE_MS)
      }

      const token = String(entries.find((a) => a.key === want)?.token ?? "").trim()
      if (!token) return { ok: false, reason: "no-token", message: `池子里没有这个账号或它没有平台 token：${want}` }

      const self = await fetchSelf({ platformBaseUrl, token, fetchImpl })
      if (!self.ok) return { ok: false, reason: "upstream", message: self.message ?? "读账号状态失败" }
      if (self.wechatBound) {
        markBound(want, { wechatId: self.wechatId, ...(self.ok ? { quota: self.quota, points: self.points, createdTime: self.createdTime } : {}) })
        return { ok: false, reason: "already-bound", message: "这个号已经绑过微信了" }
      }

      const got = await fetchAuthorizeUrl({ platformBaseUrl, token, fetchImpl })
      if (!got.ok || !got.state) return { ok: false, reason: "upstream", message: got.message ?? "取授权地址失败" }

      // ── 用客户端同样的配方：state 自己生成 32 位 hex ──
      //
      // HAR（2026-11-27）里能让平台回 need_bind + wechat_token 的那次，state 是
      // d58432920e9f80154120080b9f829ef1（32 hex，客户端自己造的），并且换取时带了
      // channelId=desktop_client。平台签发的 16 位 state 反而被当成「登录」。
      const clientState = randomUUID().replace(/-/g, "")
      const authorizeUrl = String(got.url).replace(/state=[^&#]+/, `state=${clientState}`)

      // 打开授权页取 uuid —— 这一步是关键，qrconnect 本身不能当二维码内容
      const opened = await openAuthorizePage({ authorizeUrl, fetchImpl })
      if (!opened.ok || !opened.uuid) {
        return { ok: false, reason: "no-uuid", message: opened.message ?? "授权页没给 uuid" }
      }

      const confirmUrl = confirmUrlOf(opened.uuid)
      const sessionId = randomUUID().replace(/-/g, "").slice(0, 12)
      const session = {
        sessionId,
        key: want,
        state: clientState,
        authorizeUrl,
        uuid: opened.uuid,
        confirmUrl,
        issuedAt: now(),
        expiresAt: now() + sessionTtlMs,
        status: "pending",
        lastSeenAt: now(),
        scanState: "waiting",
        attempts: 0,
        binding: false,
      }
      sessions.set(sessionId, session)
      locks.set(want, sessionId)
      // 锁已经拿到，预留可以撤了（否则那个号在本轮同步里还会被当成"忙"）
      reserved.delete(want)

      // 码：优先用微信官方那张图；取不到就用我们自己的编码器编 confirmUrl
      let qr = ""
      const img = await fetchQrImage({ uuid: opened.uuid, fetchImpl })
      if (img.ok && img.bytes) {
        qr = `data:${img.contentType ?? "image/jpeg"};base64,${Buffer.from(img.bytes).toString("base64")}`
      } else if (qrPngImpl) {
        try {
          qr = `data:image/png;base64,${qrPngImpl(confirmUrl, { ecl: "M", scale: 8, border: 4 }).toString("base64")}`
        } catch {
          qr = ""
        }
      }

      // 存下这张图：阵列重复刷新时直接复用同一张，不重复出码
      session.qr = qr
      pushEvent("alloc", { key: want, label: labelOf(entries.map((a) => a.key), want), sessionId })

      // 后台监听（不 await）：一来 code 就自己换 token 并绑定
      void watchScan(session)

      return {
        ok: true,
        key: want,
        label: labelOf(entries.map((a) => a.key), want),
        sessionId,
        uuid: opened.uuid,
        confirmUrl,
        state: clientState,
        qr,
        ttlMs: sessionTtlMs,
      }
    },

    /**
     * **指定账号**出码（面板里点某个号 → 直接拿它的绑定二维码）。
     *
     * # 和 `allocate()` 的区别
     *
     *	· `allocate()` 是「随便给我一个未绑的号」——门户用；
     *	· `allocateOne(key)` 是「我就要这个号」——面板用，操作者自己知道要绑哪个。
     *
     * 共同点：都先**实测** `/api/user/self`，已绑的直接拒绝（别让人白扫）；
     * 都会登记会话，所以页面能轮询到「已绑定」，并且这个号在占位期间别人抢不到。
     *
     * @param {string} key 账号 key（如 `quwork#3`）
     * @returns {Promise<{ok: boolean, reason?: string, message?: string, key?: string, label?: string,
     *   sessionId?: string, authorizeUrl?: string, state?: string, qr?: string, ttlMs?: number}>}
     */
    async allocateOne(key) {
      sweep()
      const want = String(key ?? "").trim()
      if (!want) return { ok: false, reason: "missing-key", message: "没有指定账号" }

      const entries = listPoolTokens(configDir)
      const idx = entries.findIndex((a) => a.key === want)
      if (idx < 0) return { ok: false, reason: "unknown-key", message: `池子里没有这个账号：${want}` }
      const target = entries[idx]
      const token = String(target.token ?? "").trim()
      if (!token) return { ok: false, reason: "no-token", message: "这个账号没有平台 token" }

      // 这个号正在被别人（门户里的某个会话）扫着？别抢
      const held = locks.get(want)
      if (held) {
        const s = sessions.get(held)
        if (s && s.status === "pending" && now() <= s.expiresAt) {
          return { ok: false, reason: "locked", message: "这个号正被别的扫码页面占着，稍等或先清占用" }
        }
        locks.delete(want)
      }

      // 先实测：已经绑过就不要出码（否则扫了也白扫）
      const self = await fetchSelf({ platformBaseUrl, token, fetchImpl })
      if (!self.ok) return { ok: false, reason: "upstream", message: self.message ?? "读账号状态失败" }
      if (self.wechatBound) {
        markBound(want, { wechatId: self.wechatId, ...(self.ok ? { quota: self.quota, points: self.points, createdTime: self.createdTime } : {}) })
        return {
          ok: false,
          reason: "already-bound",
          message: `这个号已经绑过微信（${self.wechatId ? "id " + String(self.wechatId).slice(0, 8) + "…" : "wechat_bound=true"}）`,
        }
      }

      const got = await fetchAuthorizeUrl({ platformBaseUrl, token, fetchImpl })
      if (!got.ok || !got.state) return { ok: false, reason: "upstream", message: got.message ?? "取授权地址失败" }

      const sessionId = randomUUID().replace(/-/g, "").slice(0, 12)
      /** @type {{sessionId: string, key: string, state: string, authorizeUrl: string,
       *   issuedAt: number, expiresAt: number, status: "pending"|"bound"|"expired", lastSeenAt: number}} */
      const session = {
        sessionId,
        key: want,
        state: got.state,
        authorizeUrl: String(got.url),
        issuedAt: now(),
        expiresAt: now() + sessionTtlMs,
        status: "pending",
        lastSeenAt: now(),
      }
      sessions.set(sessionId, session)
      locks.set(want, sessionId)

      let qr = ""
      if (qrPngImpl) {
        try {
          qr = `data:image/png;base64,${qrPngImpl(session.authorizeUrl, { ecl: "L", scale: 8, border: 4 }).toString("base64")}`
        } catch {
          qr = ""
        }
      }

      return {
        ok: true,
        key: want,
        label: labelOf(entries.map((a) => a.key), want),
        sessionId,
        authorizeUrl: session.authorizeUrl,
        state: session.state,
        qr,
        ttlMs: sessionTtlMs,
      }
    },

    /**
     * 分配一个账号并给出它的授权码。
     *
     * 分配顺序：快照里未绑 → 没被占位 → **实测**未绑（`/api/user/self`）→ 拿得到授权地址。
     * 任何一个环节不成立就换下一个（最多 3 个）。
     *
     * # 两条不能省的保险
     *
     *	① 预留（`reserved`）从「挑中」一直持有到出码成功，覆盖两次串行上游的超时；
     *	   不然两个人同时扫会拿到同一个号。
     *	② 实测（`fetchSelf`）**读不到就换号**：状态不明时宁可这一个号这轮不发，
     *	   也不能把「可能早就绑过」的号发出去（那会让页面秒变「绑定成功」）。
     *
     * @returns {Promise<{ok: boolean, reason?: "no-account"|"upstream",
     *   sessionId?: string, label?: string, key?: string, authorizeUrl?: string,
     *   expiresAt?: number, ttlMs?: number, message?: string, overview?: any}>}
     */
    async allocate() {
      sweep()

      const pick = () => candidates()[0] ?? ""

      let key = pick()
      // 池子空：可能是快照过期（全都「unknown」）或真的都绑完了 —— 只有前者值得再打一次上游
      if (!key) {
        const pool = readPool(configDir)
        const stale = pool.updatedAt === 0 || now() - pool.updatedAt > poolTtlMs
        if (stale) {
          await refreshPool({ configDir, platformBaseUrl, fetchImpl, now })
          key = pick()
        }
        if (!key) return { ok: false, reason: "no-account", overview: poolOverview({ configDir }) }
      }

      const entries = listPoolTokens(configDir)
      const tokens = new Map(entries.map((a) => [a.key, a.token]))
      const keys = entries.map((a) => a.key)
      /** @type {string[]} */
      const tried = []

      for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS && key; attempt += 1) {
        // ⚠ 固定住这一轮要操作的 key：`finally` 里必须删**它**，
        //   而不是循环里已经被重指向的 `key`（否则旧预留会残留，新 key 被误删）。
        const cur = key
        tried.push(cur)
        reserved.set(cur, now() + RESERVE_MS)
        try {
          const token = String(tokens.get(cur) ?? "").trim()
          if (!token) {
            const pool = readPool(configDir)
            pool.accounts[cur] = { ...(pool.accounts[cur] ?? {}), tokenInvalid: true, error: "没有平台 token", checkedAt: now() }
            writePool(configDir, pool)
            key = candidates().find((k) => !tried.includes(k)) ?? ""
            continue
          }

          // 出码前**先实测一次这个号到底绑没绑**。
          //
          // 为什么不能只看快照：快照可能是空的或过期的，那时 candidates() 会把「其实早就绑过」的号
          // 也当成可分配 —— 真机复现过：扫进来立刻显示「绑定成功」，对方其实什么都没做。
          const self = await fetchSelf({ platformBaseUrl, token, fetchImpl })
          if (self.ok && self.wechatBound) {
            markBound(cur, { wechatId: self.wechatId, ...(self.ok ? { quota: self.quota, points: self.points, createdTime: self.createdTime } : {}) })
            key = candidates().find((k) => !tried.includes(k)) ?? ""
            continue
          }
          if (!self.ok) {
            // 状态不明（超时 / 401 / 5xx）：这一轮不发它，换下一个
            const pool = readPool(configDir)
            const authFailed = self.status === 401 || self.status === 403
            pool.accounts[cur] = {
              ...(pool.accounts[cur] ?? {}),
              error: String(self.message ?? "读取账号状态失败").slice(0, 160),
              checkedAt: now(),
              ...(authFailed ? { tokenInvalid: true } : {}),
            }
            writePool(configDir, pool)
            key = candidates().find((k) => !tried.includes(k)) ?? ""
            continue
          }

          // 上游慢的时候把预留续上（最坏两次超时 + 余量）
          reserved.set(cur, now() + RESERVE_MS)
          const got = await fetchAuthorizeUrl({ platformBaseUrl, token, fetchImpl })
          if (!got.ok || !got.state) {
            const pool = readPool(configDir)
            pool.accounts[cur] = {
              ...(pool.accounts[cur] ?? {}),
              error: String(got.message ?? "取授权地址失败").slice(0, 160),
              checkedAt: now(),
            }
            writePool(configDir, pool)
            key = candidates().find((k) => !tried.includes(k)) ?? ""
            continue
          }

          const sessionId = randomUUID().replace(/-/g, "").slice(0, 12)
          /** @type {{sessionId: string, key: string, state: string, authorizeUrl: string,
           *   issuedAt: number, expiresAt: number, status: "pending"|"bound"|"expired", settledAt?: number}} */
          const session = {
            sessionId,
            key: cur,
            state: got.state,
            authorizeUrl: String(got.url),
            issuedAt: now(),
            expiresAt: now() + sessionTtlMs,
            status: "pending",
          }
          sessions.set(sessionId, session)
          locks.set(cur, sessionId)
          return {
            ok: true,
            sessionId,
            label: labelOf(keys, cur),
            key: cur,
            authorizeUrl: session.authorizeUrl,
            expiresAt: session.expiresAt,
            ttlMs: sessionTtlMs,
          }
        } finally {
          reserved.delete(cur)
        }
      }

      // 走到这里说明试过的号都不能用。区分两种原因：
      //   · 候选号都被判成「已绑 / 没有 token」→ 池子真的空了（no-account）
      //   · 还有号在池子里，只是取授权地址失败 → 上游问题（upstream）
      if (tried.length > 0 && candidates().length === 0) {
        return { ok: false, reason: "no-account", overview: poolOverview({ configDir }) }
      }
      return { ok: false, reason: "upstream", message: "账号授权码都取不到，请稍后重试", overview: poolOverview({ configDir }) }
    },

    /**
     * 轮询一次会话状态。
     *
     * 判据只有一个：`GET /api/user/self` 的 `wechat_bound`（扫码的人不需要做任何事）。
     *
     * # 过期不废会话：**原地续码**
     *
     * 占位只有 1 分半（防扫描器白占号），但真人扫完固定码、读提示、再找第二台设备来扫，
     * 很容易超过。所以会话过期后不直接作废，而是：
     *
     *	① 这个号**还没绑** → 用它的 token 重新签发一条授权 URL（新 state），
     *	   回 `pending` + `qr`（base64 PNG）+ `ttlMs`，页面**原地换图**，用户不用重扫固定码；
     *	② 已经绑了 → 直接回 `bound`；
     *	③ 连续续码到 `maxRenewals` 次就真的作废（防止一个僵尸页面永远占着号）。
     *
     * ⚠ 返回体**不带账号 key**：这个接口对陌生人开放，只给编号 `#3`。
     *
     * @param {string} sessionId
     * @returns {Promise<{status: "pending"|"bound"|"expired", label?: string, key?: string,
     *   remainingMs?: number, message?: string, qr?: string, qrUrl?: string, ttlMs?: number, renewed?: boolean}>}
     */
    async check(sessionId) {
      sweep()
      const s = sessions.get(String(sessionId ?? ""))
      if (!s) return { status: "expired", message: "会话不存在或已过期" }

      const entries = listPoolTokens(configDir)
      const label = labelOf(entries.map((a) => a.key), s.key)
      const token = String(entries.find((a) => a.key === s.key)?.token ?? "").trim()
      // 记录「最后一次有人在轮询」—— releaseAll(idleMs) 靠它区分「有人盯着」与「僵尸会话」
      s.lastSeenAt = now()

      if (s.status === "bound") return { status: "bound", label, scanState: "bound", verified: s.verified }
      if (s.status === "expired") {
        return {
          status: "expired",
          released: true,
          scanState: s.scanState ?? "expired",
          ...(s.alreadyBound ? { alreadyBound: true, boundAccount: s.boundAccount ?? "" } : {}),
          message: s.scanError || "这次的码已失效，请重新扫码",
          ...(s.exchangeDebug ? { debug: s.exchangeDebug } : {}),
        }
      }

      // 新链路（prepareScan）：把微信侧实时状态透出去，页面能区分
      // 「还没人扫 / 已扫码待确认 / 已确认正在绑定」。
      //
      // ⚠ **只在「已确认 / 正在绑定」时提前返回**：那时后台正在换 token + 绑定，
      //   不必再打一次上游。而 waiting / scanned 阶段要继续往下走 —— 下面会实测
      //   `/api/user/self`，这样即便后台监听漏了（网络抖动、页面早关），
      //   平台真绑上了也能立刻被认出来（以前就是在这里提前 return 导致永远 pending）。
      const scanHint = s.scanState ?? ""
      if (scanHint === "confirmed") {
        return {
          status: "pending",
          label,
          scanState: scanHint,
          attempts: s.attempts ?? 0,
          remainingMs: Math.max(0, s.expiresAt - now()),
          ...(s.scanError ? { message: s.scanError } : {}),
          ...(s.uuid ? { confirmUrl: s.confirmUrl } : {}),
        }
      }

      const expired = now() > s.expiresAt

      // ① 过期了：先实测一次，还能不能救
      if (expired) {
        if (!token) return { status: "expired", message: "这个账号没有平台 token" }
        const self = await fetchSelf({ platformBaseUrl, token, fetchImpl })
        if (self.ok && self.wechatBound) {
          s.status = "bound"
          s.settledAt = now()
          if (locks.get(s.key) === s.sessionId) locks.delete(s.key)
          markBound(s.key, { wechatId: self.wechatId, ...(self.ok ? { quota: self.quota, points: self.points, createdTime: self.createdTime } : {}) })
          return { status: "bound", label }
        }

        const renewals = Number(s.renewals ?? 0)
        if (renewals >= maxRenewals) {
          // 这个号被冷落太久：**立刻释放**，让下一次分配能把它分给别人
          s.status = "expired"
          s.settledAt = now()
          if (locks.get(s.key) === s.sessionId) locks.delete(s.key)
          return { status: "expired", released: true, message: `这个号 ${Math.round((maxRenewals * sessionTtlMs) / 60000)} 分钟没人扫，已放回池子，请刷新本页` }
        }

        const got = await fetchAuthorizeUrl({ platformBaseUrl, token, fetchImpl })
        if (!got.ok || !got.state) {
          // 续码失败：这次先不判死，等下一轮再试
          return {
            status: "pending",
            remainingMs: 0,
            message: `平台暂时取不到新码（${got.message ?? "未知"}）`,
          }
        }

        s.state = got.state
        s.authorizeUrl = String(got.url)
        s.renewals = renewals + 1
        s.issuedAt = now()
        s.expiresAt = now() + sessionTtlMs
        locks.set(s.key, s.sessionId)
        if (qrPngImpl) {
          try {
            s.lastQr = `data:image/png;base64,${qrPngImpl(s.authorizeUrl, { ecl: "L", scale: 8, border: 4 }).toString("base64")}`
          } catch {
            s.lastQr = undefined
          }
        }
        return {
          status: "pending",
          label,
          key: s.key,
          renewed: true,
          qr: s.lastQr,
          qrUrl: s.authorizeUrl,
          ttlMs: sessionTtlMs,
          remainingMs: sessionTtlMs,
        }
      }

      if (!token) return { status: "pending", remainingMs: Math.max(0, s.expiresAt - now()), message: "没有平台 token" }

      const self = await fetchSelf({ platformBaseUrl, token, fetchImpl })
      if (self.ok && self.wechatBound) {
        s.status = "bound"
        s.settledAt = now()
        if (locks.get(s.key) === s.sessionId) locks.delete(s.key)
        markBound(s.key, { wechatId: self.wechatId, ...(self.ok ? { quota: self.quota, points: self.points, createdTime: self.createdTime } : {}) })
        return { status: "bound", label }
      }
      if (!self.ok) {
        return {
          status: "pending",
          remainingMs: Math.max(0, s.expiresAt - now()),
          message: `平台暂时读不到状态（${self.message ?? "未知"}）`,
        }
      }
      return {
        status: "pending",
        label,
        remainingMs: Math.max(0, s.expiresAt - now()),
        ...(s.scanState ? { scanState: s.scanState, attempts: s.attempts ?? 0 } : {}),
      }
    },

    /**
     * 管理接口的鉴权（`/bind/api/pool`、`/bind/api/sync`）。
     *
     * # 规则（顺序即优先级）
     *
     *	① 配了 `adminToken` → **必须**带 `Authorization: Bearer <adminToken>`；
     *	② 没配 → 只允许「真的在本机直连」：回环 `remoteAddress` + 回环 `Host`
     *	   + **没有任何转发类请求头**。
     *
     * # 为什么要看三个东西
     *
     *	· 光看 `remoteAddress`：README 推荐的反代形态是 `proxy_pass http://127.0.0.1:4392`，
     *	  此时**所有外网请求**的 `remoteAddress` 都是 127.0.0.1 —— 等于把 pool/sync 全放开，
     *	  而 sync 会拿你的 token 挨个打平台（可当放大攻击用）。
     *	· 光看转发头黑名单：能漏（`x-forwarded-proto`、`cf-connecting-ip`、
     *	  `x-client-ip`、`true-client-ip`、`via` …），所以按 `x-forwarded-` **前缀**判定，
     *	  再补几个已知的别名。
     *	· 光看 Host：反代默认透传原始 Host，所以非回环 Host 一律当外网。
     *
     * ⚠ 浏览器直连本机时不会带这些头（脚本也被禁止设置 Forwarded 系），所以面板可用。
     *
     * @param {import("node:http").IncomingMessage} req
     * @returns {boolean}
     */
    authorize(req) {
      const h = req?.headers ?? {}
      const bearer = String(h.authorization ?? "").replace(/^Bearer\s+/i, "").trim()
      if (adminToken) return bearer === adminToken

      // ① 有任何转发类请求头 = 从反代/隧道进来的
      const FORWARD_HEADERS = ["forwarded", "x-real-ip", "via", "cf-connecting-ip", "x-client-ip", "true-client-ip"]
      for (const name of Object.keys(h)) {
        const n = name.toLowerCase()
        if (n.startsWith("x-forwarded-") || FORWARD_HEADERS.includes(n)) return false
      }

      // ② 客户端地址必须是回环
      const ra = String(req?.socket?.remoteAddress ?? "")
      const loopbackAddr = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1" || ra.startsWith("127.")
      if (!loopbackAddr) return false

      // ③ Host 也必须是回环（反代会把原始 Host 透传进来）
      const host = String(h.host ?? "").toLowerCase().replace(/:\d+$/, "")
      return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1"
    },
  }
}
