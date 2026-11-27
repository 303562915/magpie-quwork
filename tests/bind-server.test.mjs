// bind-server.test.mjs 只跑门户的独立进程：能出码，但**不能**把面板接口带出去。
//
// 这条是「公网部署」的安全底线：反代/隧道只能指向这个进程，
// 一旦它顺手把 `/api/accounts` 之类的面板接口也服务了，等于把账号表交出去。

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
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

function fakeFetch(boundTokens = []) {
  const calls = []
  const bound = new Set(boundTokens)
  const fetchImpl = async (url, init) => {
    const p = new URL(String(url)).pathname
    const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "")
    calls.push({ p, token })
    if (p === "/api/user/self") return Response.json({ success: true, data: { wechat_bound: bound.has(token), quota: 0 } })
    if (p === "/api/oauth/wechat/url") {
      return Response.json({ success: true, data: { url: `https://open.weixin.qq.com/connect/qrconnect?state=s-${token}` } })
    }
    // 授权页：prepareScan 要从里面取 uuid（真实机制见 src/wechat-watch.mjs 头注释）
    if (p === "/connect/qrconnect") {
      const st = new URL(String(url)).searchParams.get("state") ?? "x"
      return new Response(`<html><script>var uuid="TESTUUID${st.replace(/[^a-z0-9]/gi, "").slice(0, 8).padEnd(8, "0")}";</script></html>`, {
        headers: { "content-type": "text/html" },
      })
    }
    // 官方二维码图：给一段最小 PNG 头，让 prepareScan 认为取到了图
    if (p.startsWith("/connect/qrcode/")) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(200)]), {
        headers: { "content-type": "image/png" },
      })
    }
    // 微信长轮询：默认一直「等待扫码」
    if (p === "/connect/l/qrconnect") return new Response("window.wx_errcode=408;window.wx_code='';")
    return Response.json({ success: false, message: "?" })
  }
  return { fetchImpl, calls, bound }
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
  // 取授权地址必须用**这个号**的 token（真机踩过：用错字段会 401）
  const urlCalls = platform.calls.filter((c) => c.p === "/api/oauth/wechat/url")
  assert.ok(urlCalls.length >= 1, "至少要取一次授权地址")
  assert.deepEqual([...new Set(urlCalls.map((c) => c.token))], ["tok-a"], "只该用 #1 的 token")
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

  const stray = join(process.cwd(), "bind-access.log")
  const before = existsSync(stray) ? statSync(stray).mtimeMs : 0
  await fetch(`${base}/bind`)
  const after = existsSync(stray) ? statSync(stray).mtimeMs : 0
  assert.equal(after, before, "库模式不该往 cwd 写日志")
})

test("B9 绑定成功要单独落一行 BOUND（回答「有人绑定了吗」不用翻池子）", async (t) => {
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

  const html = await fetch(`${base}/bind/go`).then((r) => r.text())
  const session = (html.match(/var sid = "([^"]+)"/) ?? [])[1]
  assert.equal((await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())).status, "pending")

  // 扫码的人在微信里点了「确认登录」→ 平台侧变成已绑
  platform.bound.add("tok-a")
  const bound = await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())
  assert.equal(bound.status, "bound")

  await new Promise((done) => setTimeout(done, 100))
  const text = readFileSync(logFile, "utf8")
  assert.match(text, /BOUND label=#1 ip=127\.0\.0\.1/, `日志里应有 BOUND 行：${text}`)
})

test("B10 POST /api/release：一键释放所有占位，之后重新从 #1 分配", async (t) => {
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

  const a = await fetch(`${base}/bind/go`).then((r) => r.text())
  assert.match(a, /待绑定账号 #1/)
  assert.deepEqual(await fetch(`${base}/bind/api/occupancy`).then((r) => r.json()), { ok: true, sessions: 1, locks: 1, reserved: 0 })

  // ① 默认（不带 ?all=1）只清空闲会话：刚分配的还算「有人在扫」，不该被清掉
  const kept = await fetch(`${base}/bind/api/release`, { method: "POST" }).then((r) => r.json())
  assert.equal(kept.releasedLocks, 0, "刚出的码不该被默认清占用干掉")
  assert.equal(kept.keptActive, 1)
  assert.deepEqual(await fetch(`${base}/bind/api/occupancy`).then((r) => r.json()), { ok: true, sessions: 1, locks: 1, reserved: 0 })

  // ② 显式 ?all=1 才连正在扫的一起清（运维真要重启时用）
  const rel = await fetch(`${base}/bind/api/release?all=1`, { method: "POST" }).then((r) => r.json())
  assert.equal(rel.ok, true)
  assert.equal(rel.releasedLocks, 1)
  assert.deepEqual(await fetch(`${base}/bind/api/occupancy`).then((r) => r.json()), { ok: true, sessions: 0, locks: 0, reserved: 0 })

  const b = await fetch(`${base}/bind/go`).then((r) => r.text())
  assert.match(b, /待绑定账号 #1/, "释放后重新从 #1 开始")
  await new Promise((done) => setTimeout(done, 100))
  assert.match(readFileSync(logFile, "utf8"), /RELEASE 释放占位会话=1 锁=1 预留=0/)
})

test("B10b 管理接口仍然要鉴权（release / occupancy 不能裸奔）", async (t) => {
  const { base } = await start(t, { adminToken: "s3cret" })
  assert.equal((await fetch(`${base}/bind/api/release`, { method: "POST" })).status, 401)
  assert.equal((await fetch(`${base}/bind/api/occupancy`)).status, 401)
  assert.equal((await fetch(`${base}/bind/api/occupancy`, { headers: { authorization: "Bearer s3cret" } })).status, 200)
})

test("B11 /bind/wall：一屏多个待绑定账号，每格一个独立 session + 码 + 倒计时", async (t) => {
  const platform = fakeFetch()
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "sk-a", token: "tok-a", uid: "u1" })
  upsertAccount(dir, { llmToken: "sk-b", token: "tok-b", uid: "u2" })
  upsertAccount(dir, { llmToken: "sk-c", token: "tok-c", uid: "u3" })

  const server = createBindServer({
    configDir: dir,
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    wallWindowMs: 0,
    allocateWindowMs: 0,
    checkWindowMs: 0,
    log: { warn() {} },
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((done) => server.close(() => done())))

  const html = await fetch(`${base}/bind/wall?n=3`).then((r) => r.text())

  // 三格、三张码、三个独立 session、三个倒计时
  assert.equal((html.match(/class="cell"/g) ?? []).length, 3, "应有 3 个格子")
  assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, 3, "每格一张码")
  const sessions = [...html.matchAll(/"session":"([^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(sessions).size, 3, "每格必须是不同的会话")
  assert.equal((html.match(/id="left-\d+"/g) ?? []).length, 3, "每格一个倒计时")
  assert.match(html, /必须用微信「扫一扫」直接扫/)
  assert.ok(html.includes("#1") && html.includes("#2") && html.includes("#3"))

  // 三个号都真的被占住了（别的页面再要不走）
  assert.deepEqual(await fetch(`${base}/bind/api/occupancy`).then((r) => r.json()), { ok: true, sessions: 3, locks: 3, reserved: 0 })

  // 第一格绑定成功 → 只有它变「已绑定」
  platform.bound.add("tok-a")
  const first = await fetch(`${base}/bind/api/check?session=${sessions[0]}`).then((r) => r.json())
  assert.equal(first.status, "bound")
  const second = await fetch(`${base}/bind/api/check?session=${sessions[1]}`).then((r) => r.json())
  assert.equal(second.status, "pending", "其它格子不受影响")
})

test("B11b /bind/wall 没号时给友好页，不是 500", async (t) => {
  const platform = fakeFetch()
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "sk-a", token: "tok-a", uid: "u1" })
  const server = createBindServer({
    configDir: dir,
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    wallWindowMs: 0,
    allocateWindowMs: 0,
    checkWindowMs: 0,
    log: { warn() {} },
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((done) => server.close(() => done())))

  // 第一次拿光唯一的号，第二次再来就没号了
  await fetch(`${base}/bind/wall?n=6`)
  const again = await fetch(`${base}/bind/wall?n=6`)
  assert.equal(again.status, 200)
  assert.match(await again.text(), /暂时没有空位|待绑定/)
})

test("B12 号被收回后前端能要新号（/bind/api/reassign），页面不用刷新", async (t) => {
  const platform = fakeFetch()
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "sk-a", token: "tok-a", uid: "u1" })
  upsertAccount(dir, { llmToken: "sk-b", token: "tok-b", uid: "u2" })

  let clock = 1_700_000_000_000
  const server = createBindServer({
    configDir: dir,
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    now: () => clock,
    wallWindowMs: 0,
    allocateWindowMs: 0,
    checkWindowMs: 0,
    log: { warn() {} },
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((done) => server.close(() => done())))

  // 网格拿一个号 → 5 分钟没人扫 → 服务端收回并明确告知
  await fetch(`${base}/bind/wall?n=1`)
  const first = await fetch(`${base}/bind/api/reassign?n=1`).then((r) => r.json())
  assert.equal(first.ok, true)
  assert.equal(first.cards.length, 1, "补号要直接给一张新码")
  assert.ok(first.cards[0].qrDataUri.startsWith("data:image/png;base64,"))

  // 把时钟推过 5 分钟占位 + 续码上限（默认续 6 次 ≈ 30 分钟），这个号会被释放
  // ⚠ 一次 check 只续一张码，所以要连续轮到它耗尽
  let lost = { status: "pending" }
  for (let i = 0; i < 8 && lost.status === "pending"; i += 1) {
    clock += 10 * 60 * 1000
    lost = await fetch(`${base}/bind/api/check?session=${first.cards[0].sessionId}`).then((r) => r.json())
  }
  assert.equal(lost.status, "expired")
  assert.equal(lost.released, true)

  // 页面就是靠这个标记去要新号：要得到，而且不是刚才那个会话
  const again = await fetch(`${base}/bind/api/reassign?n=1`).then((r) => r.json())
  assert.equal(again.ok, true)
  assert.notEqual(again.cards[0].sessionId, first.cards[0].sessionId)
})

test("B6 会话过期后先续码、续满才 expired（不是一直 pending）", async (t) => {
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

  // 占位过期后：**默认不再续码**（maxRenewals=0，为了不给平台压力），直接收回号并告知前端
  clock += 11 * 60 * 1000 // > 10 分钟占位
  const gone = await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())
  assert.equal(gone.status, "expired", "过期即收回，不再向平台反复要码")
  assert.equal(gone.released, true, "要明确告诉前端「号已被收回」，阵列页据此换新号")
  assert.match(String(gone.message ?? ""), /放回池子/)
})

test("B13 bind-batch：给未绑号批量出码，已绑的跳过，产出可打印码表 + 对照表", async (t) => {
  const { buildBatch } = await import("../scripts/bind-batch.mjs")
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "sk-a", token: "tok-a", uid: "u1", phone: "17000000001" })
  upsertAccount(dir, { llmToken: "sk-b", token: "tok-b", uid: "u2", phone: "17000000002" })
  upsertAccount(dir, { llmToken: "sk-c", token: "tok-c", uid: "u3", phone: "17000000003" })

  const platform = fakeFetch(["tok-b"]) // b 已绑 → 不该出现在码表里
  const outHtml = join(tempDir(t), "batch.html")
  const r = await buildBatch({
    configDir: dir,
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    perPage: 2,
    outHtml,
  })

  assert.equal(r.ok, true)
  assert.equal(r.made, 2, "3 个号里 1 个已绑，应只出 2 张")
  assert.equal(r.skipped, 1)
  assert.equal(r.pages, 1, "2 个一张 A4")
  assert.deepEqual(r.items.map((i) => i.label), ["#1", "#3"], "编号沿用池子顺序")

  const html = readFileSync(outHtml, "utf8")
  assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, 2, "码表里应有 2 张码")
  assert.match(html, /必须用微信|扫一扫/)
  assert.match(html, /#1/)
  assert.match(html, /#3/)
  assert.ok(!html.includes("#2"), "已绑的号不该出现在码表里")

  const csv = readFileSync(r.outCsv, "utf8")
  assert.match(csv, /编号,账号key,手机号尾号,state/)
  assert.match(csv, /quwork#2/, "对照表里要有真实 key（只给自己看）")
})

test("B14 /bind/api/qr?key=…：指定账号出码（管理鉴权；已绑的返回 ok:false）", async (t) => {
  const platform = fakeFetch(["tok-a"]) // tok-a 已绑
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "sk-a", token: "tok-a", uid: "u1" })
  upsertAccount(dir, { llmToken: "sk-b", token: "tok-b", uid: "u2" })

  const server = createBindServer({
    configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl,
    wallWindowMs: 0, allocateWindowMs: 0, checkWindowMs: 0, log: { warn() {} },
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise((done) => server.close(() => done())))

  // 已绑的号被拒绝
  const bad = await fetch(`${base}/bind/api/qr?key=quwork`).then((r) => r.json())
  assert.equal(bad.ok, false)
  assert.match(String(bad.error ?? ""), /已经绑过微信/)

  // 未绑的号出码：走 prepareScan（打开授权页取 uuid → 真正的码是 confirm?uuid=）
  const good = await fetch(`${base}/bind/api/qr?key=quwork%231`).then((r) => r.json())
  assert.equal(good.ok, true, `出码应成功：${JSON.stringify(good)}`)
  assert.equal(good.label, "#2")
  assert.ok(String(good.qr).startsWith("data:image/"), "要直接给一张可显示的图")
  assert.ok(String(good.uuid).length > 0, "必须拿到微信 uuid")
  assert.match(String(good.confirmUrl), /connect\/confirm\?uuid=/, "真正要扫的是 confirm?uuid=")
})

test("B14b /bind/api/qr 也要鉴权（不能给公网裸奔）", async (t) => {
  const { base } = await start(t, { adminToken: "s3cret" })
  assert.equal((await fetch(`${base}/bind/api/qr?key=quwork#1`)).status, 401)
  assert.equal((await fetch(`${base}/bind/api/qr?key=quwork#1`, { headers: { authorization: "Bearer s3cret" } })).status, 200)
})
