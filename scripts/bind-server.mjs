// scripts/bind-server.mjs **只跑门户**的独立进程（面板不上公网）。
//
// # 为什么不让反代直接打面板端口
//
// 面板服务（`server.mjs`）同一个端口上还挂着 `/api/accounts`、`/api/invite/*`、`/api/settings`
// —— 那些没有登录态，只靠「本机回环」自保。把它整个反代出去 = 账号表、邀请码、设置对全网开放。
// 所以公网只暴露这一个进程：它能出码、能轮询、能给池子概览，别的什么都没有。
//
// # 跑法
//
//	PORT=4400 QUWORK_BIND_PUBLIC_URL=https://bind.example.com node scripts/bind-server.mjs
//	HOST=0.0.0.0 PORT=4400 node scripts/bind-server.mjs        # 放到 VPS 上
//
//	# 没有服务器也行：本机起 127.0.0.1:4400，再挂一条隧道
//	cloudflared tunnel --url http://127.0.0.1:4400
//
// # 和面板版的关系
//
//	路由语义完全一致（同一套 `createBindPortal` + 同一组页面），只是**只挂这几条**：
//	/bind、/bind/go、/bind/qr.png、/bind/api/check、/bind/api/pool|sync（管理接口，带鉴权）。

import { createServer } from "node:http"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"

import { createBindPortal, refreshPool } from "../src/wechat-bind.mjs"
import { errorPage, goPage, landingPage, noAccountPage } from "../src/bind-pages.mjs"
import { qrPng } from "../src/qr.mjs"

/** 1×1 透明 PNG（固定码生成失败时的兜底图）。 */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wHq6pjjAAAAAElFTkSuQmCC",
  "base64",
)

/**
 * 规范化公网地址（只认 http/https，去尾斜杠）。
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
 * 造一个**只服务门户**的 HTTP 服务（不 listen，便于测试）。
 *
 * @param {{configDir?: string, platformBaseUrl?: string, fetchImpl?: typeof fetch,
 *   publicBaseUrl?: string, adminToken?: string, allocateWindowMs?: number,
 *   checkWindowMs?: number, now?: () => number, log?: any}} [opts]
 */
export function createBindServer(opts = {}) {
  const configDir = String(opts.configDir ?? process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), ".config", "magpie")).trim()
  const publicBaseUrl = normalizePublicUrl(opts.publicBaseUrl ?? process.env.QUWORK_BIND_PUBLIC_URL)
  const now = typeof opts.now === "function" ? opts.now : () => Date.now()
  const log = opts.log ?? console
  /**
   * 访问日志文件（每行一次请求：时间 / IP / 方法 / 路径 / 状态 / 耗时 / UA）。
   *
   * 为什么要有它：这个进程跑在公网，「有没有人扫码」「扫到哪一步」只能靠日志回答。
   * UA 一栏能直接区分「微信扫码」与「运维自己用 curl/PowerShell 探活」。
   *
   * `BIND_LOG=""` 或 `logFile: false` 可关掉；测试默认关（不落盘）。
   */
  const logFile =
    opts.logFile === false ? "" : String(opts.logFile ?? process.env.BIND_LOG ?? "").trim()

  const portal = createBindPortal({
    configDir,
    platformBaseUrl: opts.platformBaseUrl,
    fetchImpl: opts.fetchImpl,
    now,
    adminToken: opts.adminToken ?? process.env.QUWORK_BIND_ADMIN_TOKEN,
  })

  const rawAlloc = Number(opts.allocateWindowMs ?? 3000)
  const allocateWindowMs = Number.isFinite(rawAlloc) ? Math.max(0, rawAlloc) : 3000
  const rawCheck = Number(opts.checkWindowMs ?? 1000)
  const checkWindowMs = Number.isFinite(rawCheck) ? Math.max(0, rawCheck) : 1000
  const hits = new Map()

  /** 简单节流（key 由调用方给；只防脚本狂刷，不是安全边界）。 */
  const allow = (key, windowMs) => {
    if (!(windowMs > 0)) return true
    const t = now()
    const last = Number(hits.get(key) ?? 0)
    if (t - last < windowMs) return false
    hits.set(key, t)
    if (hits.size > 5000) {
      for (const [k, v] of [...hits.entries()].sort((a, b) => a[1] - b[1]).slice(0, 1000)) hits.delete(k)
    }
    return true
  }

  const ipOf = (req) => {
    const chain = String(req?.headers?.["x-forwarded-for"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    return chain.length ? chain[chain.length - 1] : String(req?.socket?.remoteAddress ?? "")
  }

  const sendHtml = (res, html, status = 200) => {
    const buf = Buffer.from(String(html ?? ""), "utf8")
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(buf.length),
    })
    res.end(buf)
  }

  const sendJson = (res, status, obj) => {
    const text = JSON.stringify(obj)
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
    res.end(text)
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname
    const isGet = req.method === "GET" || req.method === "HEAD"
    const t0 = Date.now()

    // 访问日志：响应结束时写一行（路径里的 session 只留前 6 位，别把整串写进日志）
    if (logFile) {
      res.on("finish", () => {
        const ua = String(req.headers["user-agent"] ?? "").slice(0, 60)
        const wechat = /MicroMessenger/i.test(ua) ? "微信" : /curl|PowerShell|python|node/i.test(ua) ? "脚本" : "浏览器"
        const q = url.searchParams.get("session")
        const cleanPath = q ? `${path}?session=${String(q).slice(0, 6)}…` : path
        const line = `${new Date().toISOString()} ${ipOf(req)} ${req.method} ${cleanPath} ${res.statusCode} ${Date.now() - t0}ms ${wechat} "${ua}"\n`
        try {
          mkdirSync(dirname(logFile), { recursive: true })
          appendFileSync(logFile, line, "utf8")
        } catch {
          /* 日志写不进去不能影响出码 */
        }
      })
    }

    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(302, { location: "/bind" })
        return res.end()
      }

      const m = /^(.*)\/bind(\/.*)?$/.exec(path)
      if (!m) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        return res.end("not found")
      }
      const mount = m[1]
      const rest = (m[2] ?? "").replace(/\/+$/, "")

      if (isGet && (rest === "" || rest === "/index.html")) {
        const ov = portal.overview()
        return sendHtml(res, landingPage({ total: ov.total, available: ov.available, bound: ov.bound, mount }))
      }

      if (isGet && rest === "/go") {
        if (!allow(`go|${ipOf(req)}`, allocateWindowMs)) {
          return sendHtml(res, errorPage("操作太快了，请等几秒再扫一次", { mount }))
        }
        const r = await portal.allocate()
        if (!r.ok) {
          return sendHtml(res, r.reason === "no-account" ? noAccountPage({ mount }) : errorPage(String(r.message ?? ""), { mount }))
        }
        let qrDataUri = ""
        try {
          qrDataUri = `data:image/png;base64,${qrPng(r.authorizeUrl, { ecl: "L", scale: 8, border: 4 }).toString("base64")}`
        } catch (e) {
          log?.warn?.(`bind: 二维码生成失败: ${String(e?.message ?? e).slice(0, 120)}`)
          return sendHtml(res, errorPage("二维码生成失败", { mount }))
        }
        return sendHtml(res, goPage({ sessionId: r.sessionId, label: r.label, qrDataUri, authorizeUrl: r.authorizeUrl, ttlMs: r.ttlMs, mount }))
      }

      if (isGet && rest === "/qr.png") {
        const base = publicBaseUrl || `${req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]).split(",")[0] : "http"}://${String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "127.0.0.1").split(",")[0]}`
        const target = `${normalizePublicUrl(base) || base}${mount}/bind/go`
        const scale = Math.max(4, Math.min(20, Number(url.searchParams.get("scale")) || 8))
        let buf
        try {
          buf = qrPng(target, { ecl: "L", scale, border: 4 })
        } catch (e) {
          log?.warn?.(`bind: 固定码生成失败: ${String(e?.message ?? e).slice(0, 120)}`)
          buf = PLACEHOLDER_PNG
        }
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
          "content-length": String(buf.length),
          "x-qr-target": target,
        })
        return res.end(buf)
      }

      if (isGet && rest === "/api/check") {
        const session = String(url.searchParams.get("session") ?? "")
        if (!allow(`check|${ipOf(req)}|${session}`, checkWindowMs)) return sendJson(res, 200, { status: "pending", throttled: true })
        const r = await portal.check(session)
        // 绑成功是唯一值得单独记一行的事件（回答「有人绑定了吗」不用翻池子）
        if (r.status === "bound" && logFile) {
          try {
            appendFileSync(logFile, `${new Date().toISOString()} BOUND label=${r.label ?? "?"} ip=${ipOf(req)}\n`, "utf8")
          } catch {
            /* 日志失败不影响结果 */
          }
        }
        return sendJson(res, 200, r)
      }

      if (isGet && rest === "/api/pool") {
        if (!portal.authorize(req)) return sendJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" })
        return sendJson(res, 200, portal.overview())
      }

      if (req.method === "POST" && rest === "/api/sync") {
        if (!portal.authorize(req)) return sendJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" })
        const r = await refreshPool({ configDir, fetchImpl: opts.fetchImpl, now })
        return sendJson(res, 200, { ...r, overview: portal.overview() })
      }

      // 手动释放所有占位（有人拿着码不确认、或要重新从 #1 开始分配时用）
      if (req.method === "POST" && rest === "/api/release") {
        if (!portal.authorize(req)) return sendJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" })
        const r = portal.releaseAll()
        if (logFile) {
          try {
            appendFileSync(logFile, `${new Date().toISOString()} RELEASE 释放占位会话=${r.releasedSessions} 锁=${r.releasedLocks} 预留=${r.releasedReserved} ip=${ipOf(req)}\n`, "utf8")
          } catch {
            /* 日志失败不影响结果 */
          }
        }
        return sendJson(res, 200, r)
      }

      // 当前占位（只给数字，不含账号信息）
      if (isGet && rest === "/api/occupancy") {
        if (!portal.authorize(req)) return sendJson(res, 401, { ok: false, error: "需要管理员 token（或本机直连）" })
        return sendJson(res, 200, { ok: true, ...portal.occupancy() })
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      return res.end("not found")
    } catch (e) {
      log?.warn?.(`bind: 请求失败: ${String(e?.message ?? e).slice(0, 160)}`)
      if (!res.headersSent) sendHtml(res, errorPage("服务暂时不可用", {}), 200)
      else res.end()
    }
  })
}

// ── 直接运行：自己 listen ────────────────────────────────────────────────
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 4400)
  const host = String(process.env.HOST ?? "127.0.0.1")
  // 直接跑时默认写访问日志（库模式/测试默认不落盘）
  if (!process.env.BIND_LOG) process.env.BIND_LOG = join(process.cwd(), "bind-access.log")
  const server = createBindServer()
  server.listen(port, host, () => {
    const pub = normalizePublicUrl(process.env.QUWORK_BIND_PUBLIC_URL) || `http://${host}:${port}`
    console.log(`绑定门户：http://${host}:${port}/bind`)
    console.log(`固定二维码内容：${pub}/bind/go`)
    console.log(`访问日志：${process.env.BIND_LOG}`)
    console.log(`（这个进程只服务 /bind*，不含面板的 /api/*）`)
  })
}