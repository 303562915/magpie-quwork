// bind-server.test.mjs 只跑门户的独立进程：能出码，但**不能**把面板接口带出去。
//
// 这条是「公网部署」的安全底线：反代/隧道只能指向这个进程，
// 一旦它顺手把 `/api/accounts` 之类的面板接口也服务了，等于把账号表交出去。

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBindServer, normalizePublicUrl } from "../scripts/bind-server.mjs"
import { upsertAccount } from "../src/auth-store.mjs"

const PLATFORM = "https://llm.rrzu.example"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-bind-server-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function seed(t) {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "sk-a", token: "tok-a", phone: "17000000001", uid: "u1" })
  upsertAccount(dir, { llmToken: "sk-b", token: "tok-b", phone: "17000000002", uid: "u2" })
  return dir
}

function fakeFetch() {
  const calls = []
  const fetchImpl = async (url, init) => {
    const p = new URL(String(url)).pathname
    const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "")
    calls.push({ p, token })
    if (p === "/api/user/self") return Response.json({ success: true, data: { wechat_bound: false, quota: 0 } })
    if (p === "/api/oauth/wechat/url") {
      return Response.json({ success: true, data: { url: `https://open.weixin.qq.com/connect/qrconnect?state=s-${token}` } })
    }
    return Response.json({ success: false, message: "?" })
  }
  return { fetchImpl, calls }
}

async function start(t, opts = {}) {
  const platform = fakeFetch()
  const server = createBindServer({
    configDir: opts.configDir ?? seed(t),
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    publicBaseUrl: opts.publicBaseUrl,
    adminToken: opts.adminToken,
    allocateWindowMs: 0,
    checkWindowMs: 0,
    log: { warn() {} },
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const port = server.address().port
  t.after(() => new Promise((done) => server.close(() => done())))
  return { base: `http://127.0.0.1:${port}`, platform }
}

test("B1 只服务门户：/bind 通，面板接口一律 404（不把账号表带出去）", async (t) => {
  const { base } = await start(t)
  assert.equal((await fetch(`${base}/bind`)).status, 200)
  // `/` 只是把人送到 /bind（不跟随跳转，直接看 302）
  const root = await fetch(`${base}/`, { redirect: "manual" })
  assert.equal(root.status, 302)
  assert.equal(root.headers.get("location"), "/bind")
  for (const p of ["/api/accounts", "/api/settings", "/api/invite/summary", "/assets/app.js"]) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, `${p} 不该被这个进程服务`)
  }
})

test("B2 /bind/go 出码时用的是该账号的平台 token，页面不出手机号", async (t) => {
  const { base, platform } = await start(t)
  const html = await fetch(`${base}/bind/go`).then((r) => r.text())

  assert.match(html, /待绑定账号 #1/)
  assert.match(html, /data:image\/png;base64,/)
  assert.ok(!html.includes("17000000001"), "不能出现手机号")
  assert.equal(platform.calls.filter((c) => c.p === "/api/oauth/wechat/url").length, 1)
})

test("B3 固定码：publicBaseUrl 生效，图案字节恒定", async (t) => {
  const { base } = await start(t, { publicBaseUrl: "https://bind.example.com/" })
  const a = await fetch(`${base}/bind/qr.png`)
  const bufA = Buffer.from(await a.arrayBuffer())
  const b = await fetch(`${base}/bind/qr.png`)
  const bufB = Buffer.from(await b.arrayBuffer())

  assert.equal(a.headers.get("content-type"), "image/png")
  assert.equal(a.headers.get("x-qr-target"), "https://bind.example.com/bind/go")
  assert.ok(bufA.length > 100)
  assert.deepEqual([...bufA], [...bufB], "固定码字节必须完全一致")
})

test("B4 管理接口：带 forwarded 头 → 401；配了 token → 必须 Bearer", async (t) => {
  const plain = await start(t)
  assert.equal((await fetch(`${plain.base}/bind/api/pool`)).status, 200)
  assert.equal((await fetch(`${plain.base}/bind/api/pool`, { headers: { "x-forwarded-for": "1.2.3.4" } })).status, 401)

  const tokened = await start(t, { adminToken: "s3cret" })
  assert.equal((await fetch(`${tokened.base}/bind/api/pool`)).status, 401)
  assert.equal((await fetch(`${tokened.base}/bind/api/pool`, { headers: { authorization: "Bearer s3cret" } })).status, 200)
})

test("B5 normalizePublicUrl：只认 http(s)、去尾斜杠、拦垃圾", () => {
  assert.equal(normalizePublicUrl("https://a.example/"), "https://a.example")
  assert.equal(normalizePublicUrl("https://a.example/x/"), "https://a.example/x")
  assert.equal(normalizePublicUrl("ftp://a.example"), "")
  assert.equal(normalizePublicUrl("javascript:alert(1)"), "")
  assert.equal(normalizePublicUrl(""), "")
})

test("B7 访问日志：一行一次请求，带 UA 分类（能看出是微信扫的还是脚本探的）", async (t) => {
  const logFile = join(tempDir(t), "access.log")
  const platform = fakeFetch()
  const server = createBindServer({
    configDir: seed(t),
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    logFile,
    allocateWindowMs: 0,
    checkWindowMs: 0,
    log: { warn() {} },
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((done) => server.close(() => done())))

  await fetch(`${base}/bind`, { headers: { "user-agent": "Mozilla/5.0 MicroMessenger/8.0.49" } })
  await fetch(`${base}/bind/go`, { headers: { "user-agent": "curl/8.4.0" } })
  await new Promise((done) => setTimeout(done, 100))

  const lines = readFileSync(logFile, "utf8").trim().split("\n")
  assert.equal(lines.length, 2, `应有 2 行日志，实际：${lines.join(" | ")}`)
  assert.match(lines[0], /\/bind 200/, "第一行是 /bind")
  assert.match(lines[0], /微信/, "MicroMessenger 要标成微信")
  assert.match(lines[1], /\/bind\/go 200/)
  assert.match(lines[1], /脚本/, "curl 要标成脚本")
})

test("B8 库模式默认不写访问日志（测试/嵌入时不该往仓库落文件）", async (t) => {
  const dir = seed(t)
  const platform = fakeFetch()
  const server = createBindServer({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl, allocateWindowMs: 0, checkWindowMs: 0, log: { warn() {} } })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((done) => server.close(() => done())))

  await fetch(`${base}/bind`)
  assert.equal(existsSync(join(process.cwd(), "bind-access.log")), false, "不该在 cwd 落日志")
})

test("B6 会话过期后 check 返回 expired（不是一直 pending）", async (t) => {
  let clock = 1_700_000_000_000
  const platform = fakeFetch()
  const server = createBindServer({
    configDir: seed(t),
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    now: () => clock,
    allocateWindowMs: 0,
    checkWindowMs: 0,
    log: { warn() {} },
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((done) => server.close(() => done())))

  const html = await fetch(`${base}/bind/go`).then((r) => r.text())
  const session = (html.match(/var sid = "([^"]+)"/) ?? [])[1]
  assert.equal((await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())).status, "pending")

  clock += 10 * 60 * 1000
  assert.equal((await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())).status, "expired")
})