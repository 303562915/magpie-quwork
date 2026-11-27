// server.mjs QuWork 面板服务（magpie 的 page service 是**模块级具名导出**，不是钩子）。
//
// # 契约（与 magpie-loomy 同构，已在真机验证过）
//
//	magpie 把入口模块的**每个具名导出函数**都当插件调用，并注入它自己解析出的
//	options（含 `port`）。服务在这个函数里自己 `listen`。
//
// # 三条硬规则
//
//	① **打开页面零上游请求**：HTML/JS 只是静态文件；所有平台调用都在用户点按钮之后
//	② 所有平台接口**不带** X-QurWork-*（实测带上会触发风控；见 T-15）
//	③ 不伪造额度、不写 `error`：拿不到就如实说拿不到
//
// 端口解析：`options.port` → `$PAGESVC_PORT` → 0（随机口）。

import { createServer } from "node:http"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { PLATFORM_BASE_URL } from "./src/constants.mjs"
import {
  claimDailyReward,
  fetchDailyRewardStatus,
  fetchInviteRecords,
  fetchInviteSummary,
  fetchMonthlyGifts,
  activateInvite,
  redeemBenefit,
} from "./src/invite.mjs"
import { deviceIdentifierFrom } from "./src/login.mjs"
import { readAll, upsertAccount } from "./src/auth-store.mjs"
import { discoverFromDesktop } from "./src/desktop-client.mjs"
import { rememberUsage, windowsFromSelf } from "./src/hooks/usage.mjs"
import { refreshCatalogCache } from "./src/hooks/models.mjs"
import { buildAuthorizeUrl, bindWechat, exchangeCode, newState, parseCallback } from "./src/wechat.mjs"
import { createBindPortal, fetchAuthorizeUrl } from "./src/wechat-bind.mjs"
import { errorPage, goPage, landingPage, noAccountPage, wallPage } from "./src/bind-pages.mjs"
import { qrPng } from "./src/qr.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_DIR = join(HERE, "page")

/**
 * 面板设置的默认值（白名单：只有这些键会被写入文件）。
 *
 * ⚠ 端口改完要重启面板才生效（HTTP 服务已经在监听了）。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  port: 4392,
  autoRefresh: false,
  accountsConcurrency: 2,
  recordsPages: 3,
  /**
   * 微信绑定门户里**固定二维码**要写进的公网地址（形如 `https://bind.example.com`）。
   *
   * 为什么要能在面板里改：`QUWORK_BIND_PUBLIC_URL` 是进程环境变量，改了必须重启 magpie
   * 才生效（而 magpie 一停，所有模型请求全断）。放进设置文件就没有这个代价。
   * 优先级：环境变量 > 这个设置 > 请求头（`x-forwarded-*` → `Host`）。
   */
  bindPublicUrl: "",
})

/** 读一个 JSON 文件（不存在/损坏 → null，不抛）。 */
function readJsonFile(file) {
  try {
    if (!existsSync(file)) return null
    const v = JSON.parse(readFileSync(file, "utf8"))
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}

/** 读一个纯文本文件（不存在/读失败 → 空串，不抛）。 */
function readTextFile(file) {
  try {
    if (!existsSync(file)) return ""
    return String(readFileSync(file, "utf8")).trim()
  } catch {
    return ""
  }
}

/** 原子写 JSON（先写临时文件再 rename）。 */
function writeJsonFile(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-quwork`
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 这个端口现在能不能 bind（默认实现：真去 listen 一次再关掉）。
 *
 * ⚠ 只用来**选端口**，不做健康检查 —— 判断「有没有人在听」在这里没意义。
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => {
      probe.close(() => resolve(true))
    })
    try {
      probe.listen(port, "127.0.0.1")
    } catch {
      resolve(false)
    }
  })
}

/**
 * 从 `start` 开始找一个能用的端口（最多试 `max` 个）。
 *
 * # 为什么必须显式回退
 *
 * 4392 被别的进程占着时，`server.listen` 会 `EADDRINUSE`，而 magpie 的面板
 * 按钮只会「打不开」—— 用户完全看不出发生了什么。所以先探测再 listen。
 *
 * @param {{start?: number, max?: number, isFree?: (p: number) => Promise<boolean>}} [opts]
 * @returns {Promise<number>} 可用端口；全被占则返回 0（调用方自己决定怎么办）
 */
export async function pickPort(opts = {}) {
  const start = Number.isInteger(opts.start) && opts.start > 0 ? opts.start : 4392
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : 3
  const free = typeof opts.isFree === "function" ? opts.isFree : isPortFree

  for (let i = 0; i < max; i += 1) {
    const port = start + i
    if (await free(port)) return port
  }
  return 0
}

/**
 * 是否允许「import 本模块就自动起面板」。
 *
 * ⚠ 默认**关**：`node --test` 会 import 到这个模块，自动 listen 会留下监听端口、
 * 甚至和被测服务抢端口。生产环境由 magpie 通过 `QuWorkPage` 显式拉起；
 * 只有用户显式设了 `QW_PANEL_AUTOSTART=1` 才自启。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function autostartEnabled(env = globalThis.process?.env ?? {}) {
  const v = String(env?.QW_PANEL_AUTOSTART ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

/** 打码一个 token（只留前 6 位与后 4 位）。 */
function maskToken(v) {  const s = String(v ?? "").trim()
  if (!s) return ""
  if (s.length <= 12) return `${s.slice(0, 3)}***`
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

/** 端口解析（与 loomy 一致的三级回退）。 */export function resolvePort(options, env, fallback = 0) {
  const pick = (v) => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
  }
  return pick(options?.port) || pick(env?.PAGESVC_PORT) || pick(fallback) || 0
}

/** 读请求体（有上限，畸形输入不该把进程内存吃掉）。 */
async function readBody(req, limit = 1 << 20) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error("body too large")
    chunks.push(chunk)
  }
  if (chunks.length === 0) return ""
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * 发 JSON（**带 CORS**，HEAD 时只发头）。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {any} obj
 * @param {{head?: boolean}} [opts]
 */
function sendJson(res, status, obj, opts = {}) {
  const text = JSON.stringify(obj)
  res.writeHead(status, {
    ...corsHeaders(opts.pna),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(opts.head ? undefined : text)
}

/**
 * 从 `plugin-auth.json` 取这个账号的凭据（页面只服务"当前账号"，取第一个 quwork 条目）。
 *
 * @param {string} configDir
 * @param {any} [override] 测试/排障可直接给 `{llmToken, token}`
 */
export function resolveCredential(configDir, override) {
  if (override && (override.llmToken || override.token)) return override
  const all = readAll(configDir)
  const key = Object.keys(all).find((k) => k === "quwork" || k.startsWith("quwork#"))
  if (!key) return {}
  const v = all[key] ?? {}
  return {
    accountId: v.accountId,
    llmToken: v.llmToken ?? v.access,
    token: v.token ?? v.refresh,
    expire: v.expire,
    phone: v.phone,
    metadata: v.metadata,
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
}

/**
 * CORS 头（**所有**响应都要带）。
 *
 * # 为什么必须有（真机根因）
 *
 * magpie 的插件页是 `file:` / 自定义协议加载的（`magpie.page.file = page/gateway.html`），
 * 页面 origin 是 **`null`**。此时 `fetch("http://127.0.0.1:4392/api/accounts")`
 * 属于**跨域**请求：服务端不回 CORS 头 ⇒ 浏览器直接拦掉 ⇒ 表格永远「加载中…」。
 *
 * Chrome 还有 PNA（Private Network Access）：从 `file:` 访问本机地址会先发
 * `Access-Control-Request-Private-Network: true` 的预检，必须回
 * `Access-Control-Allow-Private-Network: true`（loomy 也这么做）。
 */
export const CORS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
  Vary: "Access-Control-Request-Private-Network, Origin",
})

/**
 * 造一个面板 HTTP 服务（不 listen）。
 *
 * @param {{configDir?: string, platformBaseUrl?: string, log?: any, fetchImpl?: typeof fetch,
 *   credential?: any}} [opts]
 */
/**
 * 面板设置的**实际生效值**。
 *
 * 三层，后者覆盖前者：
 *
 *	① `DEFAULT_SETTINGS`        代码里的默认
 *	② `options.autoRefresh`     magpie 界面开关 `auth.options.autoRefresh`
 *	                            （`QuWorkPage` 从 `input.magpie.option()` 读出来传进
 *	                            `options`；只有布尔才认，`undefined` = 不覆盖）
 *	③ `quwork-panel-settings.json` 用户在面板「设置」里自己勾过的值（**最高**）
 *
 * 为什么要 ③ 最高：面板是完整的状态机，用户在那儿明确勾过一次就是最强的意图；
 * 界面开关只是"没设置过时的默认"。`settingsSave` 走的是同一层逻辑。
 *
 * @param {string} configDir
 * @param {{autoRefresh?: any, fromOption?: boolean}} [options]
 *   `autoRefresh`：magpie 界面开关的值（布尔才认）；`fromOption`：
 *   **这个值是不是用户刚在 magpie 里拨的** —— 是的话它要**覆盖**面板文件
 *   （用户刚拨了一下，<= 立刻生效；只作为"默认"用会让用户觉得拨了没反应）。
 *   没传 `fromOption` 时按"只是默认"处理（面板文件最高）。
 * @returns {Record<string, any>}
 */
export function effectiveSettings(configDir, options = {}) {
  const fromOption = typeof options?.autoRefresh === "boolean" ? { autoRefresh: options.autoRefresh } : {}
  const prev = readJsonFile(join(String(configDir ?? "").trim(), "quwork-panel-settings.json")) ?? {}
  return options?.fromOption === true
    ? { ...DEFAULT_SETTINGS, ...prev, ...fromOption }
    : { ...DEFAULT_SETTINGS, ...fromOption, ...prev }
}

/**
 * 构建面板 API（纯装配，不 listen）。
 *
 * 提出来的理由（T-32）：`effectiveSettings` 要能在**不监听的进程**里被验证
 * （原来的启动内联在里面，测试只能真起一个服务才能看设置）。
 *
 * @param {{configDir?: string, platformBaseUrl?: string, log?: any, fetchImpl?: typeof fetch,
 *   credential?: any, now?: () => number, autoRefresh?: boolean, publicBaseUrl?: string,
 *   bindAdminToken?: string, allocateWindowMs?: number, checkWindowMs?: number}} [opts]
 */
export function createPageServer(opts = {}) {
  const configDir = String(opts.configDir ?? "").trim()
  const platformBaseUrl = String(opts.platformBaseUrl ?? "").trim() || PLATFORM_BASE_URL
  const log = opts.log ?? console
  const fetchImpl = opts.fetchImpl
  const now = typeof opts.now === "function" ? opts.now : () => Date.now()

  // ── 微信绑定门户 ──
  //
  // 固定二维码指向 `<公网地址>/bind/go`；图案恒定，可以印出来群发。
  // 公网地址三级来源：显式 options.publicBaseUrl → `$QUWORK_BIND_PUBLIC_URL` → 请求头。
  // 管理接口鉴权：配了 `$QUWORK_BIND_ADMIN_TOKEN` 就比 Bearer，没配只允许本机。
  const bindPublicBaseUrl = String(opts.publicBaseUrl ?? globalThis.process?.env?.QUWORK_BIND_PUBLIC_URL ?? "")
    .trim()
    .replace(/\/+$/, "")
  const bindPortal = createBindPortal({
    configDir,
    platformBaseUrl,
    fetchImpl,
    now,
    adminToken: String(opts.bindAdminToken ?? globalThis.process?.env?.QUWORK_BIND_ADMIN_TOKEN ?? "").trim(),
  })

  /**
   * `/bind/go` 的按 IP 节流。
   *
   * # 为什么需要它
   *
   * 一次分配 = 2 次上游 + 占住一个号 5 分钟。没有节流时，一个脚本连点几下就能把
   * 整个池子的号全占住，别人再扫就只剩「暂时没有可绑定的账号」。
   * 窗口只是防呆，不是安全边界；`allocateWindowMs = 0` 可关掉（测试用）。
   */
  const rawWindow = Number(opts.allocateWindowMs ?? 3000)
  // 传了非法值（"3s" 之类）时**回落到默认**，别静悄悄把节流关掉
  const allocateWindowMs = Number.isFinite(rawWindow) ? Math.max(0, rawWindow) : 3000
  const allocateHits = new Map()
  /** `/bind/api/check` 的节流（每会话 1 秒一次；页面本身 3 秒一轮）。 */
  const rawCheck = Number(opts.checkWindowMs ?? 1000)
  const checkWindowMs = Number.isFinite(rawCheck) ? Math.max(0, rawCheck) : 1000
  const checkHits = new Map()
  /** `/bind/wall` 的节流：每 IP 15 秒一次（一次刷新会占 N 个号）。 */
  const wallHits = new Map()
  const allowWall = (ip, windowMs = 15000) => {
    const key = String(ip || "")
    const t = now()
    const last = Number(wallHits.get(key) ?? 0)
    if (t - last < windowMs) return false
    wallHits.set(key, t)
    if (wallHits.size > 2000) for (const [k, v] of [...wallHits.entries()].sort((a, b) => a[1] - b[1]).slice(0, 500)) wallHits.delete(k)
    return true
  }
  const allowCheck = (ip, session) => {
    if (!(checkWindowMs > 0)) return true
    const key = `${String(ip || "")}|${String(session || "")}`
    const t = now()
    const last = Number(checkHits.get(key) ?? 0)
    if (t - last < checkWindowMs) return false
    checkHits.set(key, t)
    if (checkHits.size > 5000) {
      for (const [k, v] of [...checkHits.entries()].sort((a, b) => a[1] - b[1]).slice(0, 1000)) checkHits.delete(k)
    }
    return true
  }
  const allowAllocate = (ip) => {
    if (!(allocateWindowMs > 0)) return true
    const key = String(ip || "")
    const t = now()
    const last = Number(allocateHits.get(key) ?? 0)
    if (t - last < allocateWindowMs) return false
    allocateHits.set(key, t)
    if (allocateHits.size > 5000) {
      for (const [k, v] of [...allocateHits.entries()].sort((a, b) => a[1] - b[1]).slice(0, 1000)) allocateHits.delete(k)
    }
    return true
  }

  /** 当前凭据（每次请求现读，用户在别处重新登录后不必重启面板）。 */
  const cred = () => resolveCredential(configDir, opts.credential)

  /** 本进程内的 job 表（key = jobId）——页面轮询进度用。 */
  const jobs = new Map()

  /**
   * 微信绑定的 state 表：`state → { key, at }`。
   *
   * 内存即可（重启丢失 = 重新扫码），10 分钟内有效、用后即焚。
   */
  const wechatStates = new Map()

  /**
   * 绑定流程的监听日志（最近 300 条，只在内存里）。
   *
   * 真绑定是「扫码人给 code → 换 wechat_token → POST /api/user/wechat/bind」，
   * 每一步都可能失败（code 过期 / 已被用 / 平台拒绝同一微信绑多号）。
   * 没有这份日志，界面上只剩一句「绑定失败」，没法定位到底是哪一步。
   */
  const bindLog = []
  const pushBindLog = (row) => {
    bindLog.push({ at: new Date(now()).toISOString(), ...row })
    while (bindLog.length > 300) bindLog.shift()
  }
  const WECHAT_STATE_TTL_MS = 10 * 60 * 1000

  /** 面板自己的 JSON 文件（都在 magpie 配置目录里）。 */
  const settingsFile = () => join(configDir, "quwork-panel-settings.json")
  const accountsCacheFile = () => join(configDir, "quwork-accounts-cache.json")

  /**
   * 固定二维码里要写死的公网地址（不含路径前缀；前缀由调用方拼）。
   *
   * 优先级：`QUWORK_BIND_PUBLIC_URL`（或 options.publicBaseUrl） > 面板设置里的 `bindPublicUrl`
   *        > 请求头（`x-forwarded-proto/host` → `Host`）。
   *
   * 中间这一层是为了「不改环境变量、不重启 magpie 也能换域名」—— 面板里填一下就生效。
   *
   * @param {import("node:http").IncomingMessage} req
   * @returns {string}
   */
  const bindFixedBase = (req) =>
    normalizePublicUrl(bindPublicBaseUrl) ||
    normalizePublicUrl(readJsonFile(settingsFile())?.bindPublicUrl) ||
    // 隧道脚本会把当前公网地址写到这里；没有设置项时用它，免得「公网链接」显示成本机地址
    normalizePublicUrl(readTextFile(join(configDir, "quwork-bind-public.txt"))) ||
    requestOrigin(req, "")
  const inviteCacheFile = () => join(configDir, "quwork-invite-cache.json")
  const rewardCacheFile = () => join(configDir, "quwork-reward-cache.json")

  /**
   * 这不是微信内置浏览器（UA 里没有 MicroMessenger）。
   *
   * 用途：门户页顶部直接告诉人「你现在不是用微信打开的，扫码链路走不通」——
   * 否则真人会一直在浏览器里点、等，然后说「他扫了但没绑上」。
   *
   * @param {import("node:http").IncomingMessage} req
   * @returns {boolean}
   */
  const isNotWeChat = (req) => !/MicroMessenger/i.test(String(req?.headers?.["user-agent"] ?? ""))

  // ── 多账号基础设施：所有平台操作都要「按 key 找账号 → 用它自己的 token」──

  /** `plugin-auth.json` 里所有 quwork 条的 key（顺序即文件顺序）。 */
  const listKeys = () => {
    const all = readAll(configDir)
    return Object.keys(all).filter((k) => k === "quwork" || k.startsWith("quwork#"))
  }

  /** 某个 key 的完整凭据（缺 key 就是空对象）。 */
  const credOfKey = (key) => {
    const all = readAll(configDir)
    const v = all[String(key ?? "")]
    if (!v) return {}
    return {
      key,
      accountId: String(v.accountId ?? v.phone ?? v.metadata?.nickname ?? ""),
      llmToken: v.llmToken ?? v.access,
      token: v.token ?? v.refresh,
      expire: v.expire,
      phone: v.phone,
    }
  }

  /** 某个 key 的平台 token（没有就是空串）。 */
  const tokenOfKey = (key) => String(credOfKey(key).token ?? "").trim()

  /** 某个 key 的显示名（账号）。 */
  const accountIdOfKey = (key) => credOfKey(key).accountId || String(key ?? "")

  /** 请求里的 `keys`；不传 = 全部账号；非法 key 会被过滤掉。 */
  const pickKeys = (input) => {
    const mine = listKeys()
    const wanted = Array.isArray(input?.keys) ? input.keys.map(String) : []
    if (wanted.length === 0) return mine
    return mine.filter((k) => wanted.includes(k))
  }

  /** 批量的并发度（来自面板设置，最小 1）。 */
  const concurrency = () => {
    const v = Number(readJsonFile(settingsFile())?.accountsConcurrency ?? DEFAULT_SETTINGS.accountsConcurrency)
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1
  }

  /** 简单的并发池：最多 `limit` 个 worker 同时跑 `fn`。 */
  const runLimited = async (items, limit, fn) => {
    const queue = [...items]
    const workers = Array.from({ length: Math.min(Math.max(1, limit), queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift()
        await fn(item)
      }
    })
    await Promise.all(workers)
  }

  const api = {
    /**
     * 账号列表：`plugin-auth.json` 里**所有** `quwork*` 条目。
     *
     * ⚠ 只读本地文件 + 缓存，**不打上游** —— 「打开页面零上游请求」的前提。
     * 积分来自上一次 `accounts/refresh` 留下的 `quwork-accounts-cache.json`；没有就是 null。
     */
    async accounts() {
      const all = readAll(configDir)
      const cache = readJsonFile(accountsCacheFile())
      /** @type {Record<string, any>} */
      const cached = cache?.accounts ?? {}

      const accounts = Object.keys(all)
        .filter((k) => k === "quwork" || k.startsWith("quwork#"))
        .map((key) => {
          const v = all[key] ?? {}
          const c = cached[key] ?? {}
          return {
            key,
            accountId: String(v.accountId ?? v.phone ?? v.metadata?.nickname ?? ""),
            phone: String(v.phone ?? v.metadata?.phone ?? ""),
            llmToken: maskToken(v.llmToken ?? v.access),
            hasPlatformToken: Boolean(String(v.token ?? v.refresh ?? "").trim()),
            points: c.points ?? null,
            expires: Number(v.expire) || 0,
            models: c.models ?? null,
            cachedAt: c.at ?? 0,
          }
        })

      return { ok: true, cached: true, at: Number(cache?.updatedAt) || 0, updatedAt: Number(cache?.updatedAt) || 0, accounts }
    },

    /**
     * 刷新账号积分（**打上游**；每个账号一次 `/api/user/self`），并写缓存。
     *
     * 支持 `{ keys: [...] }`：只刷选中的账号（表格里的「刷新选中」）。
     * 不传 `keys` = 全部。
     */
    async accountsRefresh(input) {
      const all = readAll(configDir)
      const mine = Object.keys(all).filter((k) => k === "quwork" || k.startsWith("quwork#"))
      const wanted = Array.isArray(input?.keys) ? input.keys.map(String) : []
      const keys = wanted.length ? mine.filter((k) => wanted.includes(k)) : mine

      /** @type {Record<string, any>} */
      const accounts = {}
      const doFetch = fetchImpl ?? ((...a) => globalThis.fetch(...a))
      let okCount = 0

      for (const key of keys) {
        const v = all[key] ?? {}
        const token = String(v.token ?? v.refresh ?? "").trim()
        if (!token) {
          accounts[key] = { points: null, at: now(), error: "没有平台 token" }
          continue
        }
        try {
          const resp = await doFetch(`${platformBaseUrl}/api/user/self`, {
            method: "GET",
            headers: (() => {
              const h = new Headers({ Accept: "application/json" })
              h.set("Authorization", `Bearer ${token}`)
              return h
            })(),
            signal: AbortSignal.timeout(10_000),
          })
          const body = await resp.json().catch(() => null)
          const total = body?.data?.points_entitlement?.total_points
          accounts[key] = { points: total ?? null, at: now() }
          okCount += 1
          // T-39：**同一个响应**顺手写额度缓存 —— `auth.usage` 只读缓存，
          // 用户点这一次「刷新」就是它唯一的更新入口（零额外请求）。
          const rendered = windowsFromSelf(body)
          if (rendered) {
            rememberUsage({
              configDir,
              accountKey: accountIdOfKey(key) || key,
              windows: rendered.windows,
            })
          }
        } catch (e) {
          accounts[key] = { points: null, at: now(), error: String(e?.message ?? e).slice(0, 120) }
        }
      }

      // T-39：模型目录缓存**不在这里刷**。它是 provider 级资源（1 次请求就够），
      // 与「刷新选中账号」是两件事 —— 混在一起会让「刷新 1 个账号 = 2 次上游请求」，
      // 也会破坏「只刷选中账号」这条语义。它有自己的按钮：`/api/models/refresh`。

      const stamp = now()
      // 合并：只更新本次刷的那些，别把别的账号的缓存抹掉
      const prev = readJsonFile(accountsCacheFile())?.accounts ?? {}
      writeJsonFile(accountsCacheFile(), { updatedAt: stamp, accounts: { ...prev, ...accounts } })
      return {
        ok: true,
        cached: false,
        at: stamp,
        updatedAt: stamp,
        okCount,
        total: keys.length,
        accounts,
      }
    },

    /**
     * 刷新**模型目录**缓存（T-39）：`provider.models` 只读 `quwork-models-cache.json`，
     * 这个接口是它唯一的更新入口（面板「刷新模型目录」按钮）。
     *
     * 只发 **1 次** `/v1/models`（provider 级，与账号数无关）。
     */
    async modelsRefresh() {
      const all = readAll(configDir)
      const key = Object.keys(all).find((k) => k === "quwork" || k.startsWith("quwork#"))
      const llmToken = String(all[key]?.llmToken ?? all[key]?.access ?? "").trim()
      if (!llmToken) return { ok: false, error: "没有可用的 llmToken（先添加一个账号）" }
      const r = await refreshCatalogCache({ configDir, llmToken, fetchImpl })
      return r.ok
        ? { ok: true, count: r.count ?? 0, at: now() }
        : { ok: false, error: `目录读取失败（${r.reason ?? "unknown"}）`, at: now() }
    },

    /**
     * 删除账号（从 `plugin-auth.json` 里摘掉指定 key）。
     *
     * ⚠ **先备份**：`plugin-auth.json.bak-<时间戳>`。删号是不可逆操作，
     * 用户点错一次就得重新登录一遍 —— 备份是成本最低的保险。
     */
    /**
     * 读取**本机 QuWork 桌面客户端**的登录态，导入成账号。
     *
     * # 为什么要有它
     *
     * 用户在客户端里已经登录过的账号，没必要再走一遍扫码/贴 token：
     * 客户端（Electron）把会话落在 `%APPDATA%\qurwork-desktop` 里，
     * 我们只读地把 JWT 捞出来、用 `/api/user/self` 验活、再用 `/api/token` 补齐模型 token。
     *
     * # 两段式
     *
     *	· `dryRun !== false`（默认）→ 只探测并返回清单，**不写文件**
     *	· `dryRun === false` → 把探测到的（可按 usernames 过滤）写进 plugin-auth.json
     *
     * @param {{dryRun?: boolean, usernames?: string[]}} [input]
     */
    async accountsFromDesktop(input) {
      const found = await discoverFromDesktop({ platformBaseUrl, fetchImpl, withModelToken: true })
      if (!found.ok) return { ok: false, error: found.message, dirs: found.dirs, scanned: found.scanned }

      /** @type {any[]} */
      const rows = found.accounts
      if (input?.dryRun !== false) {
        return {
          ok: true,
          dryRun: true,
          dirs: found.dirs,
          scanned: found.scanned,
          currentLogin: found.currentLogin ?? null,
          accounts: rows.map((a) => ({
            username: a.username,
            userId: a.userId,
            wechatBound: a.wechatBound,
            quota: a.quota,
            source: a.source,
            isCurrent: Boolean(a.isCurrent),
            hasModelToken: Boolean(a.llmToken),
            modelTokenError: a.modelTokenError || "",
          })),
        }
      }

      if (!configDir) return { ok: false, error: "没有配置目录，无法写入账号" }

      const wanted = (Array.isArray(input?.usernames) ? input.usernames : []).map(String).filter(Boolean)
      const targets = wanted.length > 0 ? rows.filter((a) => wanted.includes(a.username)) : rows
      if (targets.length === 0) return { ok: false, error: "没有匹配的账号要导入" }

      /** @type {any[]} */
      const imported = []
      /** @type {any[]} */
      const failed = []
      for (const a of targets) {
        if (!a.llmToken) {
          failed.push({ username: a.username, reason: a.modelTokenError || "没有模型 token，导入后无法调模型" })
          continue
        }
        try {
          const r = upsertAccount(configDir, {
            llmToken: a.llmToken,
            token: a.token,
            expire: a.expires,
            uid: String(a.userId ?? ""),
            phone: a.username,
          })
          imported.push({ username: a.username, key: r.key, created: r.created })
        } catch (e) {
          failed.push({ username: a.username, reason: String(e?.message ?? e) })
        }
      }
      return { ok: imported.length > 0, imported, failed, accounts: await api.accounts() }
    },

    async accountsDelete(input) {
      const wanted = (Array.isArray(input?.keys) ? input.keys : []).map(String).filter(Boolean)
      if (wanted.length === 0) return { ok: false, error: "没有指定要删除的账号" }
      if (!configDir) return { ok: false, error: "没有配置目录，无法删除" }

      const file = join(configDir, "plugin-auth.json")
      if (!existsSync(file)) return { ok: false, error: "plugin-auth.json 不存在" }

      const all = readAll(configDir)
      const mine = Object.keys(all).filter((k) => k === "quwork" || k.startsWith("quwork#"))
      const hit = mine.filter((k) => wanted.includes(k))
      if (hit.length === 0) return { ok: false, error: "没有匹配的账号" }

      // ① 备份（失败就不删，宁可不做也不丢凭据）
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-")
      const backup = `${file}.bak-${stamp}`
      try {
        writeFileSync(backup, readFileSync(file), { mode: 0o600 })
      } catch (e) {
        return { ok: false, error: `备份失败，未删除任何账号：${String(e?.message ?? e).slice(0, 120)}` }
      }

      // ② 删
      for (const k of hit) delete all[k]
      if (!writeJsonFile(file, all)) return { ok: false, error: "写回 plugin-auth.json 失败（备份已保留）" }

      // ③ 顺手清掉账号缓存里对应的条目
      const cache = readJsonFile(accountsCacheFile())
      if (cache?.accounts) {
        for (const k of hit) delete cache.accounts[k]
        writeJsonFile(accountsCacheFile(), cache)
      }

      return { ok: true, deleted: hit, backup }
    },

    /**
     * 邀请码信息：**只读缓存**（`quwork-invite-cache.json`）。
     * 没有缓存就 `{cached:false}` —— 绝不在打开页面时偷偷打上游。
     */
    /**
     * 邀请码汇总：**全账号**，只读缓存（`quwork-invite-cache.json`）。
     *
     * 缓存形状：`{ updatedAt, accounts: { [key]: { inviteCode, invitedCount, points, quota, at } } }`
     * 没有缓存的账号字段为 `null` —— 绝不在打开页面时偷偷打上游。
     */
    async summary() {
      const cache = readJsonFile(inviteCacheFile())
      /** @type {Record<string, any>} */
      const cached = cache?.accounts ?? {}

      const accounts = listKeys().map((key) => {
        const c = cached[key] ?? null
        return {
          key,
          accountId: accountIdOfKey(key),
          inviteCode: c?.inviteCode ?? null,
          invitedCount: c?.invitedCount ?? null,
          points: c?.points ?? null,
          quota: c?.quota ?? null,
          at: c?.at ?? 0,
        }
      })

      return { ok: true, cached: Boolean(cache), at: Number(cache?.updatedAt) || 0, updatedAt: Number(cache?.updatedAt) || 0, accounts }
    },

    /**
     * 邀请码刷新：**只刷选中**（不传 keys = 全部），并发受 `accountsConcurrency` 限制。
     *
     * 每个账号用**自己的**平台 token；结果合并进缓存，不抹掉别人的。
     */
    async summaryRefresh(input) {
      const keys = pickKeys(input)
      if (keys.length === 0) return { ok: false, error: "没有可刷新的账号" }

      const prev = readJsonFile(inviteCacheFile())?.accounts ?? {}
      /** @type {Record<string, any>} */
      const accounts = {}
      let okCount = 0
      let failed = 0

      await runLimited(keys, concurrency(), async (key) => {
        const token = tokenOfKey(key)
        if (!token) {
          accounts[key] = { ...(prev[key] ?? {}), at: now(), error: "没有平台 token" }
          failed += 1
          return
        }
        const r = await fetchInviteSummary({ platformBaseUrl, token, fetchImpl })
        if (r.ok) {
          accounts[key] = { inviteCode: r.inviteCode, invitedCount: r.invitedCount, points: r.points, quota: r.quota, at: now() }
          okCount += 1
        } else {
          accounts[key] = { ...(prev[key] ?? {}), at: now(), error: r.message }
          failed += 1
        }
      })

      const stamp = now()
      writeJsonFile(inviteCacheFile(), { updatedAt: stamp, accounts: { ...prev, ...accounts } })
      return { ok: true, cached: false, at: stamp, updatedAt: stamp, okCount, failed, total: keys.length, accounts }
    },

    /** 设置：读（含 magpie 界面开关提供的默认值，见 `effectiveSettings`）。 */
    async settings() {
      return { ok: true, settings: effectiveSettings(configDir, opts), path: settingsFile() }
    },

    /** 设置：写（只接受白名单字段，别让页面把任意键塞进文件）。 */
    async settingsSave(input) {
      /** @type {Record<string, any>} */
      const next = { ...effectiveSettings(configDir, opts) }
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (input && Object.prototype.hasOwnProperty.call(input, k)) next[k] = input[k]
      }
      // 公网地址要清洗：空 = 用请求头；非 http(s) 一律当没填（别让固定码里出现奇怪的东西）
      next.bindPublicUrl = normalizePublicUrl(next.bindPublicUrl)
      writeJsonFile(settingsFile(), next)
      return { ok: true, settings: next, path: settingsFile() }
    },

    /** 邀请记录「批量拉取」任务：立刻回 jobId，前端轮询进度。 */
    async recordsBatchStart(input) {
      const c = cred()
      if (!c?.token) return { ok: false, error: "没有平台 token" }

      const pages = Math.max(1, Math.min(20, Number(input?.pages) || 3))
      const pageSize = Math.max(1, Math.min(50, Number(input?.pageSize) || 10))
      const jobId = `rec-${now()}-${Math.random().toString(36).slice(2, 8)}`

      const job = { jobId, running: true, done: 0, total: pages, list: [], error: "" }
      jobs.set(jobId, job)

      void (async () => {
        for (let page = 1; page <= pages; page += 1) {
          const r = await fetchInviteRecords({
            platformBaseUrl,
            token: c.token,
            page,
            pageSize,
            fetchImpl,
          })
          if (!r.ok) {
            job.error = r.message
            break
          }
          job.list.push(...r.list)
          job.done += 1
          if (r.list.length < pageSize) break // 没有下一页了
        }
        job.running = false
      })().catch((e) => {
        job.error = String(e?.message ?? e).slice(0, 160)
        job.running = false
      })

      return { ok: true, jobId, total: pages }
    },

    /** 邀请记录任务：查进度（`GET /api/job?jobId=`）。 */
    async recordsBatchState(jobId) {
      const job = jobs.get(String(jobId ?? ""))
      if (!job) return { ok: false, error: "未知 jobId" }
      return {
        ok: true,
        jobId: job.jobId,
        running: job.running,
        done: job.done,
        total: job.total,
        result: job.list,
        error: job.error,
      }
    },

/**
     * 绑定邀请码：**指定账号**（用它的 token）。
     *
     * `key` 缺省时退化成「第一个账号」（兼容旧页面），但表格永远传 key。
     */
    async activate(input) {
      const key = String(input?.key ?? "").trim() || listKeys()[0] || ""
      const token = tokenOfKey(key)
      if (!token) return { ok: false, error: "没有平台 token，无法绑定邀请码" }
      return activateInvite({
        platformBaseUrl,
        token,
        inviteCode: input?.inviteCode ?? input?.invite_code ?? "",
        deviceIdentifier: deviceIdentifierFrom(),
        fetchImpl,
      })
    },

    /** 邀请记录：**同步分页**（表格直接翻页用；批量拉多页走 job）。 */
    async records(input) {
      const key = String(input?.key ?? "").trim() || listKeys()[0] || ""
      const token = tokenOfKey(key)
      if (!token) return { ok: false, error: "没有平台 token" }
      const page = Math.max(1, Number(input?.page) || 1)
      const size = Math.max(1, Math.min(50, Number(input?.size ?? input?.pageSize) || 10))

      const r = await fetchInviteRecords({ platformBaseUrl, token, page, pageSize: size, fetchImpl })
      if (!r.ok) return { ok: false, error: r.message }
      // ⚠ 页码/页大小按**请求值**回显（上游有时会回 1；表格翻页要的是"我现在在第几页"）
      return { ok: true, key, list: r.list, total: r.total, page, size }
    },

    /** 签到状态：**全账号**，只读缓存（`quwork-reward-cache.json`）。 */
    async rewardStatus() {
      const cache = readJsonFile(rewardCacheFile())
      /** @type {Record<string, any>} */
      const cached = cache?.accounts ?? {}

      const accounts = listKeys().map((key) => {
        const c = cached[key] ?? null
        return {
          key,
          accountId: accountIdOfKey(key),
          canClaim: c?.canClaim ?? null,
          claimed: c?.claimed ?? null,
          points: c?.points ?? null,
          consecutiveDays: c?.consecutiveDays ?? null,
          nextRefreshAt: c?.nextRefreshAt ?? null,
          wechatRequired: c?.wechatRequired ?? null,
          at: c?.at ?? 0,
        }
      })

      return { ok: true, cached: Boolean(cache), at: Number(cache?.updatedAt) || 0, updatedAt: Number(cache?.updatedAt) || 0, accounts }
    },

    /** 签到状态刷新：**只刷选中**（每个账号用自己的 token，并发受限）。 */
    async rewardStatusRefresh(input) {
      const keys = pickKeys(input)
      if (keys.length === 0) return { ok: false, error: "没有可刷新的账号" }

      const prev = readJsonFile(rewardCacheFile())?.accounts ?? {}
      /** @type {Record<string, any>} */
      const accounts = {}
      let okCount = 0
      let failed = 0

      await runLimited(keys, concurrency(), async (key) => {
        const token = tokenOfKey(key)
        if (!token) {
          accounts[key] = { ...(prev[key] ?? {}), at: now(), error: "没有平台 token" }
          failed += 1
          return
        }
        const r = await fetchDailyRewardStatus({ platformBaseUrl, token, fetchImpl })
        if (r.ok) {
          accounts[key] = {
            canClaim: r.canClaim,
            claimed: r.claimed,
            consecutiveDays: r.consecutiveDays,
            nextRefreshAt: r.nextRefreshAt,
            wechatRequired: r.wechatRequired,
            points: r.points ?? prev[key]?.points ?? null,
            at: now(),
          }
          okCount += 1
        } else {
          accounts[key] = { ...(prev[key] ?? {}), at: now(), error: r.message }
          failed += 1
        }
      })

      const stamp = now()
      writeJsonFile(rewardCacheFile(), { updatedAt: stamp, accounts: { ...prev, ...accounts } })
      return { ok: true, cached: false, at: stamp, updatedAt: stamp, okCount, failed, total: keys.length, accounts }
    },

    /** 签到：**指定账号**。 */
    async rewardClaim(input) {
      const key = String(input?.key ?? "").trim() || listKeys()[0] || ""
      const token = tokenOfKey(key)
      if (!token) return { ok: false, error: "没有平台 token" }

      const r = await claimDailyReward({ platformBaseUrl, token, fetchImpl })
      if (!r.ok) return { ok: false, error: r.message, key }

      // 顺手把这条缓存更新（签完就是「已签」）
      const prev = readJsonFile(rewardCacheFile())
      const accounts = { ...(prev?.accounts ?? {}) }
      accounts[key] = {
        ...(accounts[key] ?? {}),
        claimed: true,
        canClaim: false,
        consecutiveDays: r.consecutiveDays,
        points: r.points ?? accounts[key]?.points ?? null,
        at: now(),
      }
      writeJsonFile(rewardCacheFile(), { updatedAt: now(), accounts })

      return { ...r, key }
    },

    /** 月月送：**指定账号**（不缓存，页面点一次读一次）。 */
    async gifts(input) {
      const key = String(input?.key ?? "").trim() || listKeys()[0] || ""
      const token = tokenOfKey(key)
      if (!token) return { ok: false, error: "没有平台 token" }
      const r = await fetchMonthlyGifts({ platformBaseUrl, token, fetchImpl })
      return { ...r, key }
    },

    /** 权益兑换：**指定账号**。 */
    async redeem(input) {
      const key = String(input?.key ?? "").trim() || listKeys()[0] || ""
      const token = tokenOfKey(key)
      if (!token) return { ok: false, error: "没有平台 token" }
      return redeemBenefit({ platformBaseUrl, token, orderId: input?.orderId, fetchImpl })
    },

    /**
     * 微信绑定 · 第一步：生成 state 并给出授权页 URL。
     *
     * ⚠ 不打开浏览器（服务端不碰 UI）；由页面拿 `url` 交给 `openExternal`。
     */
    async wechatStart(input) {
      const key = String(input?.key ?? "").trim() || listKeys()[0] || ""
      if (!key) return { ok: false, error: "没有账号" }

      // ⚠ 原来这里用 `newState()` 自己造 32 hex —— 实测这样拿到的 state 换不到
      //   `wechat_token`（平台只认它按该账号 token 签发的 state），而且平台侧
      //   「按 state 找账号」也认不出来，最后只能变成「登录」。
      //   正确做法：用该号 token 去 `/api/oauth/wechat/url` 拿平台签发的 state。
      const token = tokenOfKey(key)
      if (!token) return { ok: false, error: "这个账号没有平台 token" }

      const got = await fetchAuthorizeUrl({ platformBaseUrl, token, fetchImpl })
      if (!got.ok || !got.state) return { ok: false, error: got.message ?? "取不到平台签发的授权地址" }

      const state = got.state
      wechatStates.set(state, { key, at: now() })

      // 顺手清掉过期的（表小，全扫一遍即可）
      for (const [s, v] of wechatStates) {
        if (now() - v.at > WECHAT_STATE_TTL_MS) wechatStates.delete(s)
      }

      return { ok: true, key, state, url: got.url }
    },

    /**
     * 微信绑定 · 第二步：解析回调地址 → 换 wechat_token → 绑定。
     *
     * 三道校验都属于「不打上游就必须拒绝」的：
     *   ① 地址里必须有 code
     *   ② state 必须是我们发过的
     *   ③ state 未过期；用后即焚（无论成败都删，防止重放）
     */
    async wechatFinish(input) {
      const key = String(input?.key ?? "").trim() || listKeys()[0] || ""
      const { code, state } = parseCallback(input?.callbackUrl ?? input?.url ?? "")

      if (!code) return { ok: false, error: "回调地址里没有 code，请把浏览器地址栏整段粘进来" }

      const issued = wechatStates.get(state)
      if (!issued) return { ok: false, error: "state 不匹配（可能不是本面板发起的，或已用过），请重新扫码" }
      if (now() - issued.at > WECHAT_STATE_TTL_MS) {
        wechatStates.delete(state)
        return { ok: false, error: "state 已过期（10 分钟），请重新扫码" }
      }
      wechatStates.delete(state) // 用后即焚

      const token = tokenOfKey(key || issued.key)
      if (!token) return { ok: false, error: "没有平台 token，无法绑定微信" }

      // ── 监听：真绑定的每一步都落一行日志（回答「到底卡在哪一步」）──
      const obs = (step, extra) => pushBindLog({ step, key: key || issued.key, state, ...extra })
      obs("finish:start", { codeLen: code.length })

      const ex = await exchangeCode({ code, state, platformBaseUrl, fetchImpl })
      if (!ex.ok) {
        obs("exchange:fail", { message: ex.message })
        return { ok: false, error: ex.message }
      }
      obs("exchange:ok", { wechatTokenLen: String(ex.wechatToken ?? "").length })

      const r = await bindWechat({ platformBaseUrl, token, wechatToken: ex.wechatToken, fetchImpl })
      obs(r.ok ? "bind:ok" : "bind:fail", { message: r.message })
      if (!r.ok) return { ok: false, error: r.message }

      // 绑定成功后把该账号的签到缓存标成「不再是需绑微信」
      const prev = readJsonFile(rewardCacheFile())
      if (prev?.accounts?.[key || issued.key]) {
        const accounts = { ...prev.accounts }
        accounts[key || issued.key] = { ...accounts[key || issued.key], wechatRequired: false, at: now() }
        writeJsonFile(rewardCacheFile(), { updatedAt: now(), accounts })
      }

      return { ok: true, key: key || issued.key, message: r.message || "绑定成功" }
    },
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname
    // HEAD 走与 GET 相同的路由，只是不发 body（`curl -I` 也能答）
    const isHead = req.method === "HEAD"
    const isGet = req.method === "GET" || isHead
    /** 这个请求要不要带 PNA 头（Chrome 从 file:// 访问本机会先问）。 */
    const pna = req.headers["access-control-request-private-network"] === "true"
    const json = (status, obj) => sendJson(res, status, obj, { head: isHead, pna })

    try {
      // ── CORS 预检：直接 204，不碰任何业务逻辑 ──
      //
      // ⚠ 管理接口（`/bind/api/pool|sync`）**不能**回通配 CORS，否则任意公网页面
      //   都能在本机浏览器里读走账号清单、把 sync 打满。见 `adminCorsHeaders`。
      if (req.method === "OPTIONS") {
        const adminPath = /\/bind\/api\/(pool|sync)$/.test(path)
        res.writeHead(204, {
          ...(adminPath
            ? { ...adminCorsHeaders(req), "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" }
            : corsHeaders(pna)),
          "cache-control": "no-store",
        })
        return res.end()
      }

      // ── 微信绑定门户：固定码 → 分配未绑定账号 → 出该账号的授权码 ──
      //
      //	GET  /bind            说明页（只读快照，**零上游**）
      //	GET  /bind/go         分配 + 展示该账号专属二维码（打上游：/api/oauth/wechat/url）
      //	GET  /bind/qr.png     固定二维码（内容 = <公网地址>/bind/go，图案恒定）
      //	GET  /bind/api/check  轮询绑定状态（打上游：/api/user/self）
      //	GET  /bind/api/pool   池子概览（鉴权；只读快照）
      //	POST /bind/api/sync   重读全池（鉴权；打上游）
      //
      // 这几个路径对陌生人开放，所以页面里只有编号（#3），没有手机号 / token / key。
      //
      // ⚠ 路径按**后缀**匹配：magpie 可能用带前缀的代理路径打开面板
      //   （`/_magpie/plugin/<hash>/_magpie/service/bind/go`），写死 `/bind/go` 会全部落到
      //   SPA 兜底返回面板 HTML。匹配出来的前缀再回填进页面里的绝对链接。
      const bind = /^(.*)\/bind(\/.*)?$/.exec(path)
      if (bind) {
        const mount = bind[1]
        const rest = (bind[2] ?? "").replace(/\/+$/, "") // "" | "/go" | "/qr.png" | "/api/check" …

        if (isGet && (rest === "" || rest === "/index.html")) {
          const ov = bindPortal.overview()
          return sendHtml(
            res,
            landingPage({ total: ov.total, available: ov.available, bound: ov.bound, mount, notWeChat: isNotWeChat(req) }),
            { head: isHead, pna, status: 200 },
          )
        }

        // 阵列页：一屏多个待绑定账号（群里发这个，谁扫哪一格都行）
        if (isGet && rest === "/wall") {
          if (!bindPortal.authorize(req) && !allowWall(clientIp(req))) {
            return sendHtml(res, errorPage("操作太快了，请等几秒再刷新", { mount }), { head: isHead, pna, status: 200 })
          }
          const want = Math.max(1, Math.min(24, Number(url.searchParams.get("n")) || 6))
          /** @type {Array<{sessionId: string, label: string, qrDataUri: string, ttlMs: number}>} */
          const cards = []
          const seen = new Set()
          for (let i = 0; i < want; i += 1) {
            // ⚠ 必须走 prepareScan：它出的是「微信真正要扫的 confirm?uuid= 码」，
            //   并在后台监听扫码、自动换 wechat_token 完成绑定。
            //   allocate() 是旧链路（把 qrconnect 页面地址编成码），扫了只会登录、绑不上。
            const r = await bindPortal.prepareScan()
            if (!r.ok || seen.has(r.key)) break
            seen.add(r.key)
            cards.push({
              sessionId: r.sessionId,
              label: r.label,
              qrDataUri: r.qr || "",
              url: r.confirmUrl || "",
              ttlMs: r.ttlMs,
            })
          }
          const ov = bindPortal.overview()
          return sendHtml(
            res,
            wallPage({ mount, cards, remainNote: `池子里还有 ${Math.max(0, ov.available - cards.length)} 个没绑的号。`, notWeChat: isNotWeChat(req) }),
            { head: isHead, pna, status: 200 },
          )
        }

        if (isGet && rest === "/go") {
          // 同一个 IP 3 秒内只发一次码：一次分配 = 2 次上游 + 占一个号 5 分钟，
          // 被脚本狂刷会把整个池子锁死。
          if (!allowAllocate(clientIp(req))) {
            return sendHtml(res, errorPage("操作太快了，请等几秒再扫一次", { mount }), { head: isHead, pna, status: 200 })
          }
          // 单号页同样走正确链路（prepareScan 会自动挑一个未绑的号；
          // 它出的是 confirm?uuid= 的真码，并在后台监听扫码自动绑定）
          const r = await bindPortal.prepareScan()
          if (!r.ok) {
            const html =
              r.reason === "no-account" ? noAccountPage({ mount }) : errorPage(String(r.message ?? ""), { mount })
            return sendHtml(res, html, { head: isHead, pna, status: 200 })
          }
          const qrDataUri = r.qr || ""
          if (!qrDataUri) {
            log?.warn?.("quwork bind: 二维码为空（prepareScan 没给图）")
            return sendHtml(res, errorPage("二维码生成失败", { mount }), { head: isHead, pna, status: 200 })
          }
          return sendHtml(
            res,
            goPage({
              sessionId: r.sessionId,
              label: r.label,
              qrDataUri,
              authorizeUrl: r.confirmUrl || r.authorizeUrl || "",
              ttlMs: r.ttlMs,
              mount,
            }),
            { head: isHead, pna, status: 200 },
          )
        }

        if (isGet && rest === "/qr.png") {
          // 固定二维码：内容就是「本服务公网地址 + /bind/go」，与图案一一对应、永不变化。
          //
          // `?scale=` 给「打印用」留口子：`/bind/qr.png?scale=16` 出来的是 1024px 级别的图。
          const target = `${bindFixedBase(req)}${mount}/bind/go`
          const scale = Math.max(4, Math.min(20, Number(url.searchParams.get("scale")) || 8))
          let buf
          try {
            buf = qrPng(target, { ecl: "L", scale, border: 4 })
          } catch (e) {
            // 这是一张 <img>：出错也得给一张图，否则页面上只看到裂图、看不到原因
            log?.warn?.(`quwork bind: 固定码生成失败: ${String(e?.message ?? e).slice(0, 120)}`)
            buf = PLACEHOLDER_PNG
          }
          res.writeHead(200, {
            ...corsHeaders(pna),
            "content-type": "image/png",
            // no-store：运维改了公网地址就要立刻能拿到新图
            "cache-control": "no-store",
            "content-length": String(buf.length),
            "x-qr-target": target,
          })
          return res.end(isHead ? undefined : buf)
        }

        if (isGet && rest === "/api/check") {
          const session = String(url.searchParams.get("session") ?? "")
          if (!allowCheck(clientIp(req), session)) {
            // 不报错、不改页面文案：只是这一次不真的去打上游
            return json(200, { status: "pending", throttled: true })
          }
          return json(200, await bindPortal.check(session))
        }

        if (isGet && rest === "/api/pool") {
          if (!bindPortal.authorize(req)) return sendAdminJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" }, req, { head: isHead })
          return sendAdminJson(res, 200, bindPortal.overview(), req, { head: isHead })
        }

        // 阵列页补号：某一格的号被收回（5 分钟没人扫）后，前端立刻要一个新号，页面不用刷新
        // 指定账号出码（面板里点某个号 → 直接显示它的绑定二维码 / 链接）
        // 批量出码：一次给多个号各出一张**真码**（与单号「出码」完全同一条链路）
        if (isGet && rest === "/api/qr-batch") {
          const raw = String(url.searchParams.get("keys") ?? "").trim()
          const keys = raw ? raw.split(",").map((x) => x.trim()).filter(Boolean) : []
          if (keys.length === 0) return sendAdminJson(res, 200, { ok: false, error: "没有指定账号" }, req, { head: isHead })
          if (keys.length > 12) return sendAdminJson(res, 200, { ok: false, error: "一次最多 12 个" }, req, { head: isHead })

          const cards = []
          const failed = []
          for (const k of keys) {
            const one = await bindPortal.prepareScan(k)
            if (one.ok) {
              cards.push({
                key: one.key,
                label: one.label,
                sessionId: one.sessionId,
                confirmUrl: one.confirmUrl,
                qr: one.qr,
                ttlMs: one.ttlMs,
              })
            } else {
              failed.push({ key: k, error: one.message ?? one.reason ?? "出码失败" })
            }
          }
          return sendAdminJson(res, 200, { ok: cards.length > 0, cards, failed }, req, { head: isHead })
        }

        if (isGet && rest === "/api/qr") {
          if (!bindPortal.authorize(req)) return sendAdminJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" }, req, { head: isHead })
          const key = String(url.searchParams.get("key") ?? "").trim()
          const one = await bindPortal.prepareScan(key)
          if (!one.ok) return sendAdminJson(res, 200, { ok: false, error: one.message ?? one.reason ?? "出码失败" }, req, { head: isHead })
          return sendAdminJson(res, 200, one, req, { head: isHead })
        }

        if (isGet && rest === "/api/reassign") {
          const want = Math.max(1, Math.min(6, Number(url.searchParams.get("n")) || 1))
          const cards = []
          for (let i = 0; i < want; i += 1) {
            // 换码同样必须是「真码」：confirm?uuid= + 后台监听
            const r = await bindPortal.prepareScan()
            if (!r.ok) break
            cards.push({
              sessionId: r.sessionId,
              label: r.label,
              qrDataUri: r.qr || "",
              url: r.confirmUrl || "",
              ttlMs: r.ttlMs,
            })
          }
          return json(200, { ok: cards.length > 0, cards })
        }

        if (req.method === "POST" && rest === "/api/sync") {
          if (!bindPortal.authorize(req)) return sendAdminJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" }, req, { head: isHead })
          let input = {}
          try {
            const raw = await readBody(req)
            input = raw ? JSON.parse(raw) : {}
          } catch {
            input = {}
          }
          return sendAdminJson(res, 200, await bindPortal.sync(input), req, { head: isHead })
        }

        // 手动释放所有占位（有人拿着码不确认挡住别人时用）
        if (req.method === "POST" && rest === "/api/release") {
          if (!bindPortal.authorize(req)) return sendAdminJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" }, req, { head: isHead })
          // 默认只清「没人盯」的会话；?all=1 才连正在被扫的也清（会作废别人手上的码）
          const idleMs = url.searchParams.get("all") === "1" ? 0 : 60_000
          return sendAdminJson(res, 200, bindPortal.releaseAll({ idleMs }), req, { head: isHead })
        }

        // 当前占位（只给数字，不含账号信息）
        if (isGet && rest === "/api/occupancy") {
          if (!bindPortal.authorize(req)) return sendAdminJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" }, req, { head: isHead })
          return sendAdminJson(res, 200, { ok: true, ...bindPortal.occupancy() }, req, { head: isHead })
        }

        return json(404, { ok: false, error: "未知接口" })
      }

      // ── 静态资源（打开页面时**零上游请求**）──
      if (isGet && (path === "/" || path === "/index.html")) {
        return sendFile(res, join(PAGE_DIR, "index.html"), { head: isHead, pna })
      }
      if (isGet && path.startsWith("/assets/")) {
        const safe = path.replace(/^\/assets\//, "").replace(/\.\./g, "")
        return sendFile(res, join(PAGE_DIR, "assets", safe), { head: isHead, pna })
      }

      // ── API（只有点按钮才走到这里）──
      if (isGet && path.startsWith("/api/")) {
        // GET/HEAD 只服务**只读**的东西：job 进度、设置、账号列表（都读文件/内存，不打上游）
        const name = path.slice("/api/".length)
        if (name === "job") return json(200, await api.recordsBatchState(url.searchParams.get("jobId")))
        if (name === "accounts") return json(200, await api.accounts())
        if (name === "invite/records") {
          return json(
            200,
            await api.records({
              key: url.searchParams.get("key"),
              page: url.searchParams.get("page"),
              size: url.searchParams.get("size"),
            }),
          )
        }
        if (name === "invite/summary") return json(200, await api.summary())
        if (name === "reward/status") return json(200, await api.rewardStatus())
        if (name === "reward/gifts") return json(200, await api.gifts({ key: url.searchParams.get("key") }))
        if (name === "settings") return json(200, await api.settings())
        // 绑定流程的监听日志（最近 300 条）：GET，只读
        if (name === "wechat/log") return json(200, { ok: true, entries: bindLog })
        return json(404, { ok: false, error: "未知接口" })
      }

      if (req.method === "POST" && path.startsWith("/api/")) {
        const name = path.slice("/api/".length)
        /** @type {Record<string, (i: any) => any>} */
        const table = {
          accounts: () => api.accounts(),
          "accounts/refresh": (i) => api.accountsRefresh(i),
          "models/refresh": () => api.modelsRefresh(),
          "accounts/delete": (i) => api.accountsDelete(i),
          "accounts/from-desktop": (i) => api.accountsFromDesktop(i),
          settings: (i) => api.settingsSave(i),
          "invite/summary": () => api.summary(),
          "invite/refresh": (i) => api.summaryRefresh(i),
          "invite/activate": (i) => api.activate(i),
          "invite/records": (i) => api.recordsBatchStart(i),
          "reward/status": () => api.rewardStatus(),
          "reward/status/refresh": (i) => api.rewardStatusRefresh(i),
          "reward/claim": (i) => api.rewardClaim(i),
          "reward/gifts": (i) => api.gifts(i),
          "benefit/monthly-gifts": (i) => api.gifts(i),
          "benefit/redeem": (i) => api.redeem(i),
          "wechat/start": (i) => api.wechatStart(i),
          "wechat/finish": (i) => api.wechatFinish(i),
        // 绑定流程的监听日志（最近 300 条）：回答「扫码人到底走到哪一步」
        "wechat/log": () => ({ ok: true, entries: bindLog }),
        }
        const fn = table[name]
        if (!fn) return json(404, { ok: false, error: "未知接口" })

        let input = {}
        try {
          const raw = await readBody(req)
          input = raw ? JSON.parse(raw) : {}
        } catch {
          input = {}
        }
        const out = await fn(input)
        return json(200, out)
      }

      // ── SPA 兜底：非 /api、非 /assets 的未知路径 → 面板 HTML ──
      //
      // magpie 可能用「带前缀」的 URL 打开面板（代理路径），此时 `/p/quwork/`
      // 这类路径必须仍然拿到面板，而不是 404。
      if (isGet) return sendFile(res, join(PAGE_DIR, "index.html"), { head: isHead, pna })

      return json(404, { ok: false, error: "not found" })
    } catch (e) {
      log?.warn?.(`quwork panel: 请求失败: ${String(e?.message ?? e).slice(0, 160)}`)
      return json(500, { ok: false, error: "内部错误" })
    }
  })
}

/** CORS 头；请求带 PNA 时额外回 allow-private-network（Chrome 预检要求）。 */
function corsHeaders(pna) {
  return pna ? { ...CORS, "Access-Control-Allow-Private-Network": "true" } : { ...CORS }
}

/**
 * 发静态文件（带 CORS；HEAD 只发头）。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} file
 * @param {{head?: boolean, pna?: boolean}} [opts]
 */
function sendFile(res, file, opts = {}) {
  if (!existsSync(file)) {
    res.writeHead(404, { ...corsHeaders(opts.pna), "content-type": "text/plain; charset=utf-8" })
    res.end(opts.head ? undefined : "not found")
    return
  }
  const ext = file.slice(file.lastIndexOf("."))
  const buf = readFileSync(file)
  res.writeHead(200, {
    ...corsHeaders(opts.pna),
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": "no-store",
    "content-length": String(buf.length),
  })
  res.end(opts.head ? undefined : buf)
}

/**
 * 发 HTML（门户页面用；带 CORS，HEAD 只发头）。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} html
 * @param {{head?: boolean, pna?: boolean, status?: number}} [opts]
 */
function sendHtml(res, html, opts = {}) {
  const buf = Buffer.from(String(html ?? ""), "utf8")
  res.writeHead(opts.status ?? 200, {
    ...corsHeaders(opts.pna),
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(buf.length),
  })
  res.end(opts.head ? undefined : buf)
}

/**
 * 规范化「固定码里的公网地址」。
 *
 * 只认 `http(s)://host[/path]`；空串 / 非法值一律返回空串（表示「用请求头兜底」）。
 * 去掉末尾斜杠，避免拼出 `https://x//bind/go`。
 *
 * @param {any} v
 * @returns {string}
 */
export function normalizePublicUrl(v) {
  const s = String(v ?? "").trim()
  if (!s) return ""
  try {
    const u = new URL(s)
    if (u.protocol !== "http:" && u.protocol !== "https:") return ""
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`
  } catch {
    return ""
  }
}

/**
 * 这个请求对外看到的 origin —— 固定二维码里要写死的那个地址。
 *
 * # 为什么不能直接用 `req.headers.host`
 *
 * 门户挂在反代后面时 `req.socket` 是 127.0.0.1，直接拼出来的是内网地址，
 * 印到固定码上就永远扫不通。所以：显式配置（`publicBaseUrl`）最高；
 * 否则信任 `x-forwarded-proto` / `x-forwarded-host`；再不行才用 Host。
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string} fixed 显式配置的公网地址（空 = 没配）
 * @returns {string} 形如 `https://bind.example.com`
 */
function requestOrigin(req, fixed) {
  if (fixed) return fixed
  const h = req?.headers ?? {}
  const proto =
    String(h["x-forwarded-proto"] ?? "").split(",")[0].trim() ||
    (/** @type {any} */ (req?.socket)?.encrypted ? "https" : "http")
  const host = String(h["x-forwarded-host"] ?? h.host ?? "").split(",")[0].trim() || "127.0.0.1"
  return `${proto}://${host}`
}

/**
 * 1×1 透明 PNG（固定码生成失败时的兜底图，避免页面上只显示一个裂图）。
 *
 * @type {Buffer}
 */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wHq6pjjAAAAAElFTkSuQmCC",
  "base64",
)

/** 请求来源 IP（反代后面取 `x-forwarded-for` 的**最后一段**）。 */
function clientIp(req) {
  const h = req?.headers ?? {}
  const chain = String(h["x-forwarded-for"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  // ⚠ 取最后一段：`$proxy_add_x_forwarded_for` 是**追加**，客户端伪造的部分在左边。
  //   取第一段等于让攻击者换个头就绕过节流。
  return chain.length ? chain[chain.length - 1] : String(req?.socket?.remoteAddress ?? "")
}

/**
 * 管理接口的 CORS 头。
 *
 * # 为什么不能沿用通配 `*`
 *
 * 面板整个服务都用 `Access-Control-Allow-Origin: *`（页面是 `file:` 加载的，必须给）。
 * 但 `/bind/api/pool`（账号清单）与 `/bind/api/sync`（会拿 token 挨个打平台）是**管理接口**：
 * 一旦允许任意站点跨域读取，任何一条公网网页都能在你本机浏览器里把池子读走、把 sync 打满
 * —— 本机回环判定在这里完全没有防线作用。
 *
 * 所以：只对「无 Origin」/「Origin: null（file: 面板）」/「回环 Origin」回 CORS 头，
 * 其它站点一律不回，浏览器就拒绝把响应交给页面。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Record<string, string>}
 */
function adminCorsHeaders(req) {
  const origin = String(req?.headers?.origin ?? "").trim()
  if (!origin) return { Vary: "Origin" }
  if (origin === "null") return { "Access-Control-Allow-Origin": "null", Vary: "Origin" }
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
  }
  return { Vary: "Origin" }
}

/** 发管理接口的 JSON（CORS 按 `adminCorsHeaders`，不给通配）。 */
function sendAdminJson(res, status, obj, req, opts = {}) {
  const text = JSON.stringify(obj)
  res.writeHead(status, {
    ...adminCorsHeaders(req),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(opts.head ? undefined : text)
}

/**
 * 面板服务的**宿主侧**：自己 listen（magpie 只负责把 options 传进来）。
 *
 * @param {{client?: any, directory?: string}} [input]
 * @param {{port?: number, configDir?: string, platformBaseUrl?: string, fetchImpl?: typeof fetch,
 *   credential?: any}} [options]
 * @returns {Promise<{ok: boolean, port: number, close: () => Promise<void>, reason?: string}>}
 */
export const QuWorkPage = async (input = {}, options = {}) => {
  const configDir = String(input?.directory ?? options?.configDir ?? "").trim()
  // 端口：options.port → $PAGESVC_PORT → 4392
  const want = resolvePort(options, globalThis.process?.env, 4392) || 4392
  const explicitPort = Number.isFinite(Number(options?.port)) ? Number(options.port) : null
  // 显式传 `port: 0` 表示「随便给我一个空闲口」（测试并行要用，生产不会传）。
  const startPort = explicitPort === 0 ? 0 : explicitPort !== null && explicitPort > 0 ? explicitPort : want

  // ⚠ 默认端口（没人显式指定时用的 4392）**不再漂移**：
  //   以前被占就回退 4392→4393→4394，结果每次 plugin update 端口会变，
  //   书签打开是空白、公网隧道还指向旧端口。
  //   只有「调用方显式给了端口」才允许回退（宿主/测试可以这么用）。
  const maxFallback = explicitPort !== null && explicitPort > 0 ? 3 : 1
  const chosen = await pickPort({ start: startPort, max: maxFallback, isFree: options?.isFree })
  if (!chosen && startPort !== 0) {
    return {
      ok: false,
      port: 0,
      close: async () => {},
      reason: `${startPort} 被占用（默认端口已固定，不再漂移到别的口）`,
    }
  }

  const server = createPageServer({
    configDir,
    platformBaseUrl: options?.platformBaseUrl,
    // magpie 界面开关 `auth.options.autorefresh`（`QuWorkPage` 在 index.mjs 里读好传进来）
    autoRefresh: typeof options?.autoRefresh === "boolean" ? options.autoRefresh : undefined,
    fromOption: options?.fromOption === true,
    log: input?.client?.app?.log ? { warn: (m) => input.client.app.log({ body: { service: "quwork", level: "warn", message: m } }) } : console,
    fetchImpl: options?.fetchImpl,
    credential: options?.credential,
    // 微信绑定门户：公网地址（印发固定码的那个域名）、管理 token、按 IP 节流窗口
    publicBaseUrl: options?.publicBaseUrl,
    bindAdminToken: options?.bindAdminToken,
    allocateWindowMs: options?.allocateWindowMs,
    checkWindowMs: options?.checkWindowMs,
  })

  return new Promise((resolve) => {
    server.once("error", (err) => {
      resolve({ ok: false, port: 0, close: async () => {}, reason: String(err?.message ?? err) })
    })
    server.listen(chosen, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : chosen

      // 把**最终**端口写进设置（页面标题旁会显示它，下次启动也读它）
      if (configDir) {
        const file = join(configDir, "quwork-panel-settings.json")
        const prev = readJsonFile(file) ?? {}
        writeJsonFile(file, { ...DEFAULT_SETTINGS, ...prev, port })
      }

      resolve({
        ok: true,
        port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}