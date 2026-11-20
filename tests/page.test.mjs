// page.test.mjs 面板服务（T-20 版）：只读缓存 + 显式刷新 + job + 设置 + 静态资源。
//
// # 一条铁律
//
// **打开页面零上游请求**。读接口只读文件/内存：`GET /api/accounts`、
// `GET /api/invite/summary`（无缓存就 `cached:false`）、`GET /api/settings`。
// 只有 `refresh` / `activate` / `reward/*` / `benefit/*` 才打上游。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import net from "node:net"

import { QuWorkAuthPlugin, QuWorkPage } from "../index.mjs"
import { createPageServer, resolvePort, resolveCredential, DEFAULT_SETTINGS, pickPort, autostartEnabled } from "../server.mjs"
import { upsertAccount } from "../src/auth-store.mjs"

const TOKEN = "platform-token-zzz"
const LLM = "sk-llm-token-abc123456789"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-page-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 起一个真服务；`fetchImpl` 会计数（用来证明「打开页面零上游」）。 */
async function startServer(t, opts = {}) {
  let upstream = 0
  const fetchImpl = async (url) => {
    upstream += 1
    const p = new URL(String(url)).pathname
    if (p.endsWith("/invite/summary")) {
      return Response.json({ success: true, data: { invite_code: "573529", invited_count: 1, points: 10, quota: 0 } })
    }
    if (p.endsWith("/invite/records")) {
      return Response.json({ success: true, data: { list: [{ id: 1 }], page: 1, page_size: 10, total: 1 } })
    }
    if (p.endsWith("/activate")) return Response.json({ success: false, message: "不能使用自己的邀请码" })
    if (p.endsWith("/self")) {
      return Response.json({ success: true, data: { phone: "138****0000", points_entitlement: { total_points: "1099.60" } } })
    }
    return Response.json({ success: true, data: {} })
  }

  const server = createPageServer({
    // ⚠ 默认给一个临时目录：configDir 是 "" 时缓存文件会落到 cwd，污染仓库
    configDir: opts.configDir ?? tempDir(t),
    platformBaseUrl: "https://llm.rrzu.example",
    log: { warn() {} },
    fetchImpl,
    credential: { llmToken: LLM, token: TOKEN, accountId: "13800000000" },
    now: () => 1_700_000_000_000,
    ...opts,
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const port = server.address().port
  t.after(() => new Promise((done) => server.close(() => done())))

  return { base: `http://127.0.0.1:${port}`, count: () => upstream }
}

/** 造一个带两个账号的配置目录。 */
function seedAccounts(t) {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: LLM, token: TOKEN, phone: "13800000000", uid: "13800000000" })
  upsertAccount(dir, { llmToken: `${LLM}-2`, token: `${TOKEN}-2`, phone: "13900000000", uid: "13900000000" })
  return dir
}

// ── 1) 打开页面零上游 ─────────────────────────────────────────────────

test("1) 打开 / 与 assets 全部零上游请求", async (t) => {
  const { base, count } = await startServer(t)

  const html = await fetch(`${base}/`)
  assert.equal(html.status, 200)

  for (const f of ["app.js", "style.css", "logo.png"]) {
    const r = await fetch(`${base}/assets/${f}`)
    assert.equal(r.status, 200, `${f} 应可访问`)
  }
  assert.equal(count(), 0, `打开页面不该有上游请求，实际 ${count()}`)
})

// ── 2) 账号列表（读文件 + 缓存，不打上游）──────────────────────────────

test("2) GET /api/accounts 返回全部 quwork* 条目（accountId/points/expires），且零上游", async (t) => {
  const dir = seedAccounts(t)
  const { base, count } = await startServer(t, { configDir: dir })

  const resp = await fetch(`${base}/api/accounts`)
  const body = await resp.json()

  assert.equal(resp.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.accounts.length, 2, `应有 2 个账号: ${JSON.stringify(body.accounts)}`)
  for (const a of body.accounts) {
    assert.ok(a.key === "quwork" || a.key.startsWith("quwork#"))
    assert.ok(String(a.accountId).length > 0)
    assert.ok("points" in a)
    assert.ok("expires" in a)
  }
  assert.equal(count(), 0, "读账号列表不许打上游")
})

test("2b) POST /api/accounts/refresh 才打上游，并把积分写进 quwork-accounts-cache.json", async (t) => {
  const dir = seedAccounts(t)
  const { base, count } = await startServer(t, { configDir: dir })

  const body = await (await fetch(`${base}/api/accounts/refresh`, { method: "POST", body: "{}" })).json()

  assert.equal(body.ok, true)
  assert.ok(count() >= 1, "刷新必须真的打上游")
  assert.ok(body.updatedAt > 0)

  const cache = JSON.parse(readFileSync(join(dir, "quwork-accounts-cache.json"), "utf8"))
  assert.ok(Object.keys(cache.accounts).length >= 1)
  assert.equal(cache.accounts["quwork"].points, "1099.60")
})

// ── 3) 激活 / 邀请码缓存 ──────────────────────────────────────────────

test("3) POST /api/invite/activate 转发上游并把失败 message 原文回传", async (t) => {
  const dir = seedAccounts(t)
  const { base } = await startServer(t, { configDir: dir })

  const body = await (
    await fetch(`${base}/api/invite/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "quwork", inviteCode: "573529" }),
    })
  ).json()

  assert.equal(body.ok, false)
  assert.equal(body.message, "不能使用自己的邀请码")
})

test("3b) GET /api/invite/summary 无缓存 → 账号 inviteCode 为 null 且零上游；POST refresh 后有数据", async (t) => {
  const dir = seedAccounts(t)
  const { base, count } = await startServer(t, { configDir: dir })

  const cold = await (await fetch(`${base}/api/invite/summary`)).json()
  assert.equal(cold.ok, true)
  assert.ok(cold.accounts.length >= 1)
  assert.equal(cold.accounts[0].inviteCode, null, "没缓存就是 null")
  assert.equal(count(), 0, "无缓存也不许偷偷打上游")

  const warm = await (await fetch(`${base}/api/invite/refresh`, { method: "POST", body: "{}" })).json()
  assert.equal(warm.ok, true)
  assert.equal(warm.accounts["quwork"].inviteCode, "573529")

  const again = await (await fetch(`${base}/api/invite/summary`)).json()
  assert.equal(again.accounts.find((a) => a.key === "quwork").inviteCode, "573529")
})

// ── 4) job ────────────────────────────────────────────────────────────

test("4) POST /api/invite/records 返回 jobId；GET /api/job?jobId= 返 {running,done,total,result}", async (t) => {
  const { base } = await startServer(t)

  const started = await (
    await fetch(`${base}/api/invite/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pages: 2, pageSize: 10 }),
    })
  ).json()

  assert.equal(started.ok, true)
  assert.ok(String(started.jobId).length > 0)

  let state = null
  for (let i = 0; i < 60; i += 1) {
    state = await (await fetch(`${base}/api/job?jobId=${encodeURIComponent(started.jobId)}`)).json()
    if (state.running === false) break
    await new Promise((r) => setTimeout(r, 10))
  }

  assert.equal(state.ok, true)
  assert.equal(typeof state.running, "boolean")
  assert.equal(typeof state.done, "number")
  assert.equal(typeof state.total, "number")
  assert.ok(Array.isArray(state.result), "结果放 result")
})

// ── 5) 设置 ───────────────────────────────────────────────────────────

test("5) POST /api/settings 写 quwork-panel-settings.json，GET 读回", async (t) => {
  const dir = tempDir(t)
  const { base } = await startServer(t, { configDir: dir })

  const defaults = await (await fetch(`${base}/api/settings`)).json()
  assert.equal(defaults.ok, true)
  assert.equal(defaults.settings.port, DEFAULT_SETTINGS.port)

  await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: 4500, autoRefresh: true }),
  })

  const file = JSON.parse(readFileSync(join(dir, "quwork-panel-settings.json"), "utf8"))
  assert.equal(file.port, 4500)
  assert.equal(file.autoRefresh, true)

  const readBack = await (await fetch(`${base}/api/settings`)).json()
  assert.equal(readBack.settings.port, 4500)
})

// ── 6) 静态资源 ───────────────────────────────────────────────────────

test("6) 三个静态资源 200 且 content-type 正确", async (t) => {
  const { base } = await startServer(t)

  const css = await fetch(`${base}/assets/style.css`)
  assert.equal(css.status, 200)
  assert.match(String(css.headers.get("content-type")), /text\/css/)

  const js = await fetch(`${base}/assets/app.js`)
  assert.equal(js.status, 200)
  assert.match(String(js.headers.get("content-type")), /javascript/)

  const png = await fetch(`${base}/assets/logo.png`)
  assert.equal(png.status, 200)
  assert.match(String(png.headers.get("content-type")), /image\/png/)
})

// ── 7) 未知路径 ───────────────────────────────────────────────────────

test("7) 未知路径：非 /api 走 SPA 兜底（200），/api 未知接口仍 404，且零上游", async (t) => {
  const { base, count } = await startServer(t)

  // 非 /api 且非 /assets 的未知路径 → 面板 HTML（T-24 起的 SPA 兜底）
  const spa = await fetch(`${base}/nope`)
  assert.equal(spa.status, 200)
  assert.match(await spa.text(), /QuWork/)

  // 未知 API 仍然是 404（不许把接口错误伪装成页面）
  assert.equal((await fetch(`${base}/api/nope`, { method: "POST", body: "{}" })).status, 404)
  assert.equal(count(), 0)
})

// ── 8) 4 个 tab ───────────────────────────────────────────────────────

test("8) index.html 含 4 个 tab 标记（account|invite|benefit|settings）", async (t) => {
  const { base } = await startServer(t)
  const html = await (await fetch(`${base}/`)).text()

  for (const tab of ["account", "invite", "benefit", "settings"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`), `缺少 tab: ${tab}`)
  }
})

// ── 附加：端口 / 凭据 / 装配 ──────────────────────────────────────────

test("9) 端口：options.port 优先，PAGESVC_PORT 次之；非法值忽略", () => {
  assert.equal(resolvePort({ port: 4392 }, {}, 0), 4392)
  assert.equal(resolvePort({}, { PAGESVC_PORT: "4500" }, 0), 4500)
  assert.equal(resolvePort({ port: "abc" }, {}, 0), 0)
  assert.equal(resolvePort({ port: 70000 }, {}, 0), 0)
})

test("10) resolveCredential 读 plugin-auth 的 quwork 条目，override 优先", (t) => {
  const dir = seedAccounts(t)
  const cred = resolveCredential(dir)
  assert.equal(cred.llmToken, LLM)
  assert.equal(cred.token, TOKEN)
  assert.equal(resolveCredential(dir, { llmToken: "x", token: "y" }).token, "y")
})

test("11) 装配：QuWorkPage 是函数、icon 是 data URI、auth.checkin 存在、能 listen", async (t) => {
  assert.equal(typeof QuWorkPage, "function")
  const p = await QuWorkAuthPlugin({}, { log: { warn() {} } })
  assert.match(String(p.icon), /^data:image\/png;base64,/)
  assert.equal(typeof p.auth.checkin, "function")

  const page = await QuWorkPage({}, { port: 0, configDir: "", fetchImpl: async () => Response.json({}) })
  assert.equal(page.ok, true)
  assert.ok(page.port > 0)
  await page.close()
})
// ── T-21 图标 / 表格 / 批量 API ────────────────────────────────────────

test("T21-1) auth.icon 是 data URI 且 > 10000 字节（magpie 读的是 auth.icon）", async () => {
  const p = await QuWorkAuthPlugin({}, { log: { warn() {} } })
  const icon = p?.auth?.icon
  assert.equal(typeof icon, "string", "auth.icon 必须是字符串")
  assert.match(icon, /^data:image\/png;base64,/)
  assert.ok(icon.length > 10_000, `图标太小: ${icon.length}`)
})

test("T21-2) /api/accounts 带 models 字段（无缓存为 null）", async (t) => {
  const dir = seedAccounts(t)
  const { base } = await startServer(t, { configDir: dir })

  const body = await (await fetch(`${base}/api/accounts`)).json()
  assert.equal(body.ok, true)
  assert.ok(body.accounts.length >= 1)
  for (const a of body.accounts) assert.ok("models" in a, "每行都要有 models 字段")
  assert.equal(body.accounts[0].models, null, "没有缓存时是 null")
})

test("T21-3) POST /api/accounts/refresh 支持 {keys:[...]}：只刷新选中的账号", async (t) => {
  const dir = seedAccounts(t)
  const { base, count } = await startServer(t, { configDir: dir })

  const before = count()
  const body = await (
    await fetch(`${base}/api/accounts/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["quwork#1"] }),
    })
  ).json()

  assert.equal(body.ok, true)
  assert.equal(count() - before, 1, "只该打一次上游（一个账号）")
  assert.deepEqual(Object.keys(body.accounts), ["quwork#1"])
})

test("T21-4) POST /api/accounts/delete 删掉指定 key，且**先备份**", async (t) => {
  const dir = seedAccounts(t)
  const { base } = await startServer(t, { configDir: dir })

  const before = JSON.parse(readFileSync(join(dir, "plugin-auth.json"), "utf8"))
  assert.ok(before["quwork#1"], "删除前应有该账号")

  const body = await (
    await fetch(`${base}/api/accounts/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["quwork#1"] }),
    })
  ).json()

  assert.equal(body.ok, true)
  assert.deepEqual(body.deleted, ["quwork#1"])
  assert.ok(String(body.backup).includes("plugin-auth.json.bak-"), `应有备份路径: ${body.backup}`)
  assert.ok(readFileSync(body.backup, "utf8").includes("quwork#1"), "备份里必须还有被删的账号")

  const after = JSON.parse(readFileSync(join(dir, "plugin-auth.json"), "utf8"))
  assert.equal(after["quwork#1"], undefined, "主文件里应已删除")
  assert.ok(after["quwork"], "别的账号不许被误删")
})

test("T21-5) GET /api/invite/records 同步分页返回 {list,total,page,size}", async (t) => {
  const dir = seedAccounts(t)
  const { base } = await startServer(t, { configDir: dir })
  const body = await (await fetch(`${base}/api/invite/records?key=quwork&page=2&size=5`)).json()

  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.list))
  assert.equal(typeof body.total, "number")
  assert.equal(body.page, 2)
  assert.equal(body.size, 5)
})

test("T21-6) index.html 有 <table> 且表头含「账号」「积分」「到期」「操作」", async (t) => {
  const { base } = await startServer(t)
  const html = await (await fetch(`${base}/`)).text()

  assert.match(html, /<table/, "要有表格")
  for (const col of ["账号", "积分", "到期", "操作"]) {
    assert.ok(html.includes(col), `表头缺「${col}」`)
  }
})

// ── T-22 面板连接：BASE origin / 错误可见 / 端口回退 / 自动拉起守卫 ─────

test("T22-1) app.js 有 const BASE，且 api() 用 base + path（源码断言）", () => {
  const src = readFileSync(join("page", "assets", "app.js"), "utf8")
  assert.match(src, /const BASE/, "必须从脚本自身 URL 取 origin")
  // T-24 起换成多 base 重试：单次请求在 apiOnce(base, …) 里拼 `base + path`
  assert.match(src, /fetch\((?:BASE|base) \+ path/, "必须拼 origin，不能用相对路径")
  assert.equal(/fetch\(path[,\s)]/.test(src), false, "不许再出现裸 fetch(path)")
})

test("T22-2) app.js 的首次加载失败时把错误写进表格（不停在「加载中」）", () => {
  const src = readFileSync(join("page", "assets", "app.js"), "utf8")
  assert.match(src, /无法连接面板服务/, "必须有可见的错误文案")
  assert.match(src, /colspan="7"/, "错误行要占满账号表")
  // 启动 catch 里必须调用渲染/状态，而不是静默
  assert.match(src, /setStatus\(String\(e\?\.message \?\? e\), false\)|setStatus\(/, "错误要进状态条")
})

test("T22-3) app.js 能读 ?port= 覆盖 BASE；boot.js 跳转时带上 port", () => {
  const app = readFileSync(join("page", "assets", "app.js"), "utf8")
  assert.ok(app.includes('get("port")') || /searchParams\.get\(.port.\)/.test(app), "app.js 要读 ?port=")

  const boot = readFileSync(join("page", "boot.js"), "utf8")
  assert.match(boot, /port=/, "boot.js 要把 port 带进目标 URL")
})

test("T22-4) 端口被占时自动回退：4392 占 → 4393", async () => {
  const picked = await pickPort({ start: 4392, max: 3, isFree: async (p) => p !== 4392 })
  assert.equal(picked, 4393, `应回退到 4393，实际 ${picked}`)
})

test("T22-5) startServer 把最终端口写进 quwork-panel-settings.json", async (t) => {
  const dir = tempDir(t)

  // 先找一个**当下真的空闲**的高位端口当"起点"，再把它伪装成"被占用"
  const realFree = async (p) =>
    new Promise((resolve) => {
      const s = net.createServer()
      s.once("error", () => resolve(false))
      s.once("listening", () => s.close(() => resolve(true)))
      s.listen(p, "127.0.0.1")
    })

  let start = 45600
  while (!(await realFree(start))) start += 1

  const page = await QuWorkPage(
    {},
    {
      configDir: dir,
      port: start,
      fetchImpl: async () => Response.json({}),
      // 起点伪装成被占用 → 必须回退到下一个，且那个必须真的能 bind
      isFree: async (p) => p !== start && (await realFree(p)),
    },
  )

  assert.equal(page.ok, true, `回退后应能 listen（page=${JSON.stringify(page)}）`)
  assert.notEqual(page.port, start, "起点被占用时必须换口")
  const settings = JSON.parse(readFileSync(join(dir, "quwork-panel-settings.json"), "utf8"))
  assert.equal(settings.port, page.port, "最终端口必须落盘（页面/下次启动都读它）")
  await page.close()
})

test("T22-6) QW_PANEL_AUTOSTART 未设置时 import 不监听（测试不残留监听）", () => {
  assert.equal(autostartEnabled({}), false)
  assert.equal(autostartEnabled({ QW_PANEL_AUTOSTART: "0" }), false)
  assert.equal(autostartEnabled({ QW_PANEL_AUTOSTART: "1" }), true)
  // 测试进程里没有残留的面板监听（本文件所有服务都已 close）
  assert.equal(globalThis.__quworkAutostarted, undefined, "import 阶段不该自启")
})

// ── T-24 CORS / HEAD / SPA 兜底 / 多 base 重试 ─────────────────────────
//
// 真机根因：magpie 用 `file:` 加载面板页 ⇒ 页面 origin 是 `null`，
// `fetch("http://127.0.0.1:4392/api/accounts")` 是**跨域**请求。
// 服务端不回 CORS 头 ⇒ 浏览器拦掉 ⇒ 表格永远「加载中…」。

test("T24-1) GET /api/accounts 带 Access-Control-Allow-Origin: *", async (t) => {
  const { base } = await startServer(t)
  const resp = await fetch(`${base}/api/accounts`, { headers: { Origin: "null" } })

  assert.equal(resp.status, 200)
  assert.equal(resp.headers.get("access-control-allow-origin"), "*")
})

test("T24-2) OPTIONS /api/accounts → 204 且带 CORS 头", async (t) => {
  const { base } = await startServer(t)
  const resp = await fetch(`${base}/api/accounts`, {
    method: "OPTIONS",
    headers: { Origin: "null", "Access-Control-Request-Method": "POST" },
  })

  assert.equal(resp.status, 204)
  assert.equal(resp.headers.get("access-control-allow-origin"), "*")
  assert.match(String(resp.headers.get("access-control-allow-methods")), /POST/)
})

test("T24-3) HEAD / → 200、无 body、带 CORS 头", async (t) => {
  const { base } = await startServer(t)
  const resp = await fetch(`${base}/`, { method: "HEAD" })

  assert.equal(resp.status, 200)
  assert.equal(resp.headers.get("access-control-allow-origin"), "*")
  const text = await resp.text()
  assert.equal(text, "", "HEAD 不该有 body")
})

test("T24-4) GET /whatever-unknown → 200 且是面板 HTML（SPA 兜底）", async (t) => {
  const { base } = await startServer(t)
  const resp = await fetch(`${base}/whatever-unknown`)

  assert.equal(resp.status, 200)
  const text = await resp.text()
  assert.match(text, /QuWork/, "兜底要回 index.html")
  assert.match(String(resp.headers.get("content-type")), /text\/html/)
})

test("T24-5) app.js 有多 base 重试（有限次数，不是无限循环）", () => {
  const src = readFileSync(join("page", "assets", "app.js"), "utf8")
  assert.match(src, /const targets = \[|targets = \[/, "要有候选 base 列表")
  assert.match(src, /for \(const base of/, "要逐个尝试")
  assert.match(src, /new Set\(targets\)/, "要去重（避免同 base 试两次）")
  assert.equal(/while \(true\)/.test(src), false, "不许无限循环")
})

// ── T-25 邀请 / 权益 改成「多账号表格」 ────────────────────────────────
//
// 每行 = 一个账号。读接口只读缓存（零上游），只有 refresh / activate /
// claim / records / gifts 才打上游，且**必须用该 key 自己的平台 token**。

/** 起一个会记录「每次上游调用的 Authorization」的服务。 */
async function startRecording(t, opts = {}) {
  /** @type {Array<{url: string, auth: string}>} */
  const calls = []
  const fetchImpl = async (url, init) => {
    const auth = String(new Headers(init?.headers).get("authorization") ?? "")
    calls.push({ url: String(url), auth })
    const p = new URL(String(url)).pathname
    if (p.endsWith("/invite/summary")) {
      const code = auth.includes("token-a") ? "111111" : auth.includes("token-b") ? "222222" : "333333"
      return Response.json({ success: true, data: { invite_code: code, invited_count: 1, points: 10, quota: 0 } })
    }
    if (p.endsWith("/invite/records")) {
      return Response.json({ success: true, data: { list: [{ id: 1, phone: "138****0000" }], page: 1, page_size: 10, total: 1 } })
    }
    if (p.endsWith("/activate")) return Response.json({ success: false, message: "不能使用自己的邀请码" })
    if (p.endsWith("/daily-reward/status")) {
      return Response.json({ success: true, data: { can_claim: true, claimed: false, consecutive_days: 2, next_refresh_at: 1795190400, wechat_required: false } })
    }
    if (p.endsWith("/daily-reward/claim")) {
      return Response.json({ success: true, data: { granted: 5, consecutive_days: 3, points: 100 } })
    }
    if (p.endsWith("/monthly-gifts")) return Response.json({ success: true, data: { list: [{ name: "月月送A" }] } })
    // 微信绑定链路：③ 换 token、④ 绑定
    if (p.endsWith("/api/oauth/wechat")) return Response.json({ success: true, data: { wechat_token: "wx-token-1" } })
    if (p.endsWith("/wechat/bind")) return Response.json({ success: true, message: "绑定成功" })
    if (p.endsWith("/redeem")) return Response.json({ success: true, data: {} })
    if (p.endsWith("/self")) return Response.json({ success: true, data: { points_entitlement: { total_points: "9.99" } } })
    return Response.json({ success: true, data: {} })
  }

  const server = createPageServer({
    configDir: opts.configDir ?? tempDir(t),
    platformBaseUrl: "https://llm.rrzu.example",
    log: { warn() {} },
    now: () => 1_700_000_000_000,
    ...opts,
    // ⚠ 显式放在 opts 之后：调用方给了 fetchImpl 就用它的；否则用会计数的探针
    fetchImpl: opts.fetchImpl ?? fetchImpl,
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const port = server.address().port
  t.after(() => new Promise((done) => server.close(() => done())))
  return { base: `http://127.0.0.1:${port}`, calls }
}

/** 3 个账号：token-a / token-b / token-c。 */
function seedThree(t) {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "sk-llm-a", token: "token-a", phone: "15000000001", uid: "15000000001" })
  upsertAccount(dir, { llmToken: "sk-llm-b", token: "token-b", phone: "15000000002", uid: "15000000002" })
  upsertAccount(dir, { llmToken: "sk-llm-c", token: "token-c", phone: "15000000003", uid: "15000000003" })
  return dir
}

test("T25-1) /api/invite/summary 返回**全部**账号（3 条），每条含 inviteCode/invitedCount/points", async (t) => {
  const dir = seedThree(t)
  const { base, calls } = await startRecording(t, { configDir: dir })

  // 先批量刷一次，把缓存灌满
  await fetch(`${base}/api/invite/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: ["quwork", "quwork#1", "quwork#2"] }),
  })
  const before = calls.length

  const body = await (await fetch(`${base}/api/invite/summary`)).json()
  assert.equal(body.ok, true)
  assert.equal(body.accounts.length, 3, JSON.stringify(body.accounts))
  for (const a of body.accounts) {
    assert.ok(a.key)
    assert.ok("inviteCode" in a)
    assert.ok("invitedCount" in a)
    assert.ok("points" in a)
  }
  assert.equal(calls.length, before, "读汇总不许打上游")
})

test("T25-2) POST /api/invite/refresh {keys:[一个]} 只打 1 次上游，且只更新该 key", async (t) => {
  const dir = seedThree(t)
  const { base, calls } = await startRecording(t, { configDir: dir })

  const body = await (
    await fetch(`${base}/api/invite/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["quwork#1"] }),
    })
  ).json()

  assert.equal(body.ok, true)
  assert.equal(calls.length, 1, `只该打 1 次，实际 ${calls.length}`)
  assert.match(calls[0].auth, /token-b/, "必须用 quwork#1 自己的 token")
  assert.deepEqual(Object.keys(body.accounts), ["quwork#1"])
})

test("T25-3) POST /api/invite/activate {key} 用**指定账号**的 token", async (t) => {
  const dir = seedThree(t)
  const { base, calls } = await startRecording(t, { configDir: dir })

  const body = await (
    await fetch(`${base}/api/invite/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "quwork#2", inviteCode: "573529" }),
    })
  ).json()

  assert.equal(body.ok, false)
  assert.equal(body.message, "不能使用自己的邀请码")
  assert.equal(calls.length, 1)
  assert.match(calls[0].auth, /token-c/, "必须用 quwork#2 的 token")
})

test("T25-4) /api/invite/records?key=&page=2&size=5 回显分页且只打 1 次", async (t) => {
  const dir = seedThree(t)
  const { base, calls } = await startRecording(t, { configDir: dir })

  const body = await (await fetch(`${base}/api/invite/records?key=quwork%231&page=2&size=5`)).json()

  assert.equal(body.ok, true)
  assert.equal(body.page, 2)
  assert.equal(body.size, 5)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /page=2/)
  assert.match(calls[0].auth, /token-b/)
})

test("T25-5) /api/reward/status 返回全部账号（读缓存，零上游）", async (t) => {
  const dir = seedThree(t)
  const { base, calls } = await startRecording(t, { configDir: dir })

  await fetch(`${base}/api/reward/status/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys: ["quwork", "quwork#1", "quwork#2"] }),
  })
  const before = calls.length

  const body = await (await fetch(`${base}/api/reward/status`)).json()
  assert.equal(body.ok, true)
  assert.equal(body.accounts.length, 3)
  for (const a of body.accounts) {
    assert.ok(a.key)
    assert.ok("canClaim" in a)
    assert.ok("claimed" in a)
    assert.ok("consecutiveDays" in a)
  }
  assert.equal(calls.length, before, "读状态不许打上游")
})

test("T25-6) POST /api/reward/claim {key} 只打 1 次且用该 key 的 token", async (t) => {
  const dir = seedThree(t)
  const { base, calls } = await startRecording(t, { configDir: dir })

  const body = await (
    await fetch(`${base}/api/reward/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "quwork#2" }),
    })
  ).json()

  assert.equal(body.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].auth, /token-c/)
})

test("T25-7) 邀请 tab 有表格，表头含 账号/邀请码/已邀请/已获积分/操作", async (t) => {
  const { base } = await startRecording(t)
  const html = await (await fetch(`${base}/`)).text()
  const invitePane = html.slice(html.indexOf('id="pane-invite"'), html.indexOf('id="pane-benefit"'))

  assert.match(invitePane, /<table/, "邀请页要有表格")
  for (const col of ["账号", "邀请码", "已邀请", "已获积分", "操作"]) {
    assert.ok(invitePane.includes(col), `邀请页表头缺「${col}」`)
  }
})

test("T25-8) 权益 tab 有表格，表头含 账号/签到状态/今日积分/操作", async (t) => {
  const { base } = await startRecording(t)
  const html = await (await fetch(`${base}/`)).text()
  const benefitPane = html.slice(html.indexOf('id="pane-benefit"'), html.indexOf('id="pane-settings"'))

  assert.match(benefitPane, /<table/, "权益页要有表格")
  for (const col of ["账号", "签到状态", "今日积分", "操作"]) {
    assert.ok(benefitPane.includes(col), `权益页表头缺「${col}」`)
  }
})

// ── T-26 平台接口补版本头 + 微信绑定 ──────────────────────────────────
//
// 真机结论（纠正 T-15 的过度修正）：
//	不带版本头 → activate 回「客户端版本过低：无法识别当前版本」
//	带上         → 真实原因浮出来（wechat_bind_required）
// 但 `sendVerifyCode` 带上会被阿里云滑块拦 ⇒ **发码类仍然不带**。

test("T26-1) platformHeaders 带 x-qurwork-version / x-qurwork-env", async () => {
  const { platformHeaders } = await import("../src/invite.mjs")
  const h = platformHeaders("tok-abc")

  assert.equal(h.get("x-qurwork-env"), "prod")
  assert.equal(h.get("x-qurwork-version"), "1.7.5")
  assert.equal(h.get("authorization"), "Bearer tok-abc")
  assert.equal(h.get("accept"), "application/json")
})

test("T26-2) sendVerifyCode / loginWithCode **不带**这两个头（回归 T-15）", async () => {
  const { sendVerifyCode, loginWithCode } = await import("../src/login.mjs")
  /** @type {any[]} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    return Response.json({ success: true, data: {} })
  }

  await sendVerifyCode({ phone: "15000000001", deviceIdentifier: "d".repeat(64), fetchImpl })
  await loginWithCode({ phone: "15000000001", code: "1234", deviceIdentifier: "d".repeat(64), fetchImpl })

  for (const c of calls) {
    assert.equal(c.headers.get("x-qurwork-env"), null)
    assert.equal(c.headers.get("x-qurwork-version"), null)
  }
})

test("T26-3) activateInvite 带这两个头（真机组装断言）", async () => {
  const { activateInvite } = await import("../src/invite.mjs")
  /** @type {any[]} */
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    return Response.json({ success: false, message: "请先绑定微信", data: { error_code: "wechat_bind_required" } })
  }

  const r = await activateInvite({ token: "tok", inviteCode: "573529", deviceIdentifier: "d".repeat(64), fetchImpl })
  assert.equal(r.ok, false)
  assert.equal(calls[0].headers.get("x-qurwork-version"), "1.7.5")
  assert.equal(calls[0].headers.get("x-qurwork-env"), "prod")
})

test("T26-4) buildAuthorizeUrl 含 appid / scope / redirect_uri / state", async () => {
  const { buildAuthorizeUrl, DEFAULT_APP_ID } = await import("../src/wechat.mjs")
  const url = new URL(buildAuthorizeUrl({ state: "abc123" }))

  assert.equal(url.origin + url.pathname, "https://open.weixin.qq.com/connect/qrconnect")
  assert.equal(url.searchParams.get("appid"), DEFAULT_APP_ID)
  assert.equal(DEFAULT_APP_ID, "wxac3315fe86ebb901")
  assert.equal(url.searchParams.get("scope"), "snsapi_login")
  assert.equal(url.searchParams.get("response_type"), "code")
  assert.equal(url.searchParams.get("redirect_uri"), "https://llm.rrzu.com/oauth/wechat")
  assert.equal(url.searchParams.get("state"), "abc123")
})

test("T26-5) newState 是 32 hex", async () => {
  const { newState } = await import("../src/wechat.mjs")
  const s = newState()
  assert.match(s, /^[0-9a-f]{32}$/)
  assert.notEqual(newState(), s, "每次都要新 state")
})

test("T26-6) POST /api/wechat/start 返回 {url, state}，state 存起来", async (t) => {
  const dir = seedThree(t)
  const { base } = await startRecording(t, { configDir: dir })

  const body = await (
    await fetch(`${base}/api/wechat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "quwork#1" }),
    })
  ).json()

  assert.equal(body.ok, true)
  assert.match(String(body.state), /^[0-9a-f]{32}$/)
  assert.match(String(body.url), /open\.weixin\.qq\.com\/connect\/qrconnect/)
  assert.ok(String(body.url).includes(`state=${body.state}`))
})

test("T26-7) POST /api/wechat/finish 解析 code/state → 换 token → 绑定（两次上游）", async (t) => {
  const dir = seedThree(t)
  const { base, calls } = await startRecording(t, { configDir: dir })

  const started = await (
    await fetch(`${base}/api/wechat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "quwork#1" }),
    })
  ).json()

  const body = await (
    await fetch(`${base}/api/wechat/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "quwork#1",
        callbackUrl: `https://llm.rrzu.com/oauth/wechat?code=CODE-X&state=${started.state}`,
      }),
    })
  ).json()

  assert.equal(body.ok, true)
  assert.equal(calls.length, 2, `应只打 2 次（换 token + 绑定），实际 ${calls.length}`)
  assert.match(calls[0].url, /\/api\/oauth\/wechat\?code=CODE-X/)
  assert.match(calls[0].url, /state=/) 
  assert.match(calls[1].url, /\/api\/user\/wechat\/bind/)
  assert.match(calls[1].auth, /token-b/, "必须用该 key 的 token")
})

test("T26-8) finish 用未知/过期 state → {ok:false} 且不打上游", async (t) => {
  const dir = seedThree(t)
  const { base, calls } = await startRecording(t, { configDir: dir })

  const body = await (
    await fetch(`${base}/api/wechat/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "quwork#1",
        callbackUrl: `https://llm.rrzu.com/oauth/wechat?code=CODE-X&state=${"0".repeat(32)}`,
      }),
    })
  ).json()

  assert.equal(body.ok, false)
  assert.match(String(body.error), /state|过期|重新扫码/)
  assert.equal(calls.length, 0, "state 不对就不许打上游")
})

test("T26-9) finish 上游错误原文回传", async (t) => {
  const dir = seedThree(t)
  const { base } = await startRecording(t, {
    configDir: dir,
    fetchImpl: async (url) => {
      const p = new URL(String(url)).pathname
      if (p.includes("/oauth/wechat")) {
        return Response.json({ success: false, message: "凭证已过期，请重新扫码" })
      }
      return Response.json({ success: true, data: {} })
    },
  })

  const started = await (
    await fetch(`${base}/api/wechat/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "quwork#1" }),
    })
  ).json()

  const body = await (
    await fetch(`${base}/api/wechat/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "quwork#1", callbackUrl: `https://x/oauth/wechat?code=C&state=${started.state}` }),
    })
  ).json()

  assert.equal(body.ok, false)
  assert.equal(body.error, "凭证已过期，请重新扫码")
})

test("T26-10) index.html 有「绑定微信」按钮 + 微信小面板（两按钮一输入框）", async (t) => {
  const { base } = await startRecording(t)
  const html = await (await fetch(`${base}/`)).text()

  assert.ok(html.includes("绑定微信"), "账号表要有「绑定微信」按钮")
  assert.ok(html.includes('id="wechat-panel"'), "要有微信绑定小面板")
  assert.ok(html.includes('id="wechat-start"'), "要有「打开微信扫码」按钮")
  assert.ok(html.includes('id="wechat-callback"'), "要能粘贴回调地址")
  assert.ok(html.includes('id="wechat-finish"'), "要有「完成绑定」按钮")
})
