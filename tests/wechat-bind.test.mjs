// wechat-bind.test.mjs 微信绑定门户：固定码 → 分账号 → 出授权码 → 轮询到绑定成功。
//
// # 覆盖的判据
//
//	① `/bind` 打开**零上游**，且页面里不出现手机号（打开它的是陌生人）
//	② `/bind/go` 打一次 `/api/oauth/wechat/url`，返回的二维码是**平台签发 state** 的那条 URL
//	③ 同一个人扫两次 / 两个人同时扫：拿到**不同**账号（占位锁）
//	④ `/bind/api/check` 靠 `wechat_bound=true` 判成功，并顺带把快照标成已绑、释放锁
//	⑤ 池子空了给「没有可绑定账号」页，不是 500
//	⑥ 会话过期 → expired
//	⑦ 管理接口要鉴权；没配 token 时只允许本机
//	⑧ token 失效的账号不参与分配
//	⑨ 固定二维码 PNG 恒定、内容 = `<公网地址>/bind/go`

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createPageServer } from "../server.mjs"
import { upsertAccount } from "../src/auth-store.mjs"
import {
  BIND_POOL_FILE,
  createBindPortal,
  fetchAuthorizeUrl,
  labelOf,
  listPoolTokens,
  poolOverview,
  readPool,
  refreshPool,
  writePool,
} from "../src/wechat-bind.mjs"
import { qrMatrix, qrPng } from "../src/qr.mjs"

const PLATFORM = "https://llm.rrzu.example"
const PHONE_A = "17034818784"
const PHONE_B = "17060315531"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-bind-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 假平台：按 token 决定 `wechat_bound`；`/api/oauth/wechat/url` 每次给不同 state。
 *
 * @param {{bound?: Set<string>, dead?: Set<string>}} [opts]
 */
function fakePlatform(opts = {}) {
  const bound = opts.bound ?? new Set()
  const dead = opts.dead ?? new Set()
  const calls = []
  /** 每次 `/api/oauth/wechat/url` 返回的那条授权 URL（测试用来核对页面里的二维码）。 */
  const urls = []
  let seq = 0

  const fetchImpl = async (url, init) => {
    const u = new URL(String(url))
    const auth = String(new Headers(init?.headers).get("authorization") ?? "")
    const token = auth.replace(/^Bearer\s+/i, "")
    calls.push({ path: u.pathname, token })

    if (dead.has(token)) return new Response("nope", { status: 401 })

    if (u.pathname === "/api/user/self") {
      return Response.json({
        success: true,
        data: {
          id: 1,
          phone: PHONE_A,
          quota: 0,
          wechat_bound: bound.has(token),
          wechat_id: bound.has(token) ? "wx-openid-1" : "",
          aff_code: "953240",
        },
      })
    }
    if (u.pathname === "/api/oauth/wechat/url") {
      seq += 1
      const state = `state-${seq}-${token.slice(-4)}`
      const url = `https://open.weixin.qq.com/connect/qrconnect?appid=wxac3315fe86ebb901&redirect_uri=https%3A%2F%2Fllm.rrzu.com%2Foauth%2Fwechat&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`
      urls.push(url)
      return Response.json({ success: true, data: { url } })
    }
    return Response.json({ success: false, message: `未预期的路径 ${u.pathname}` })
  }

  return { fetchImpl, calls, bound, dead, urls }
}

/** 造一个带两个「没绑微信」账号的配置目录。 */
function seed(t, tokens = ["tok-aaa", "tok-bbb"]) {
  const dir = tempDir(t)
  tokens.forEach((token, i) => {
    upsertAccount(dir, {
      llmToken: `sk-llm-${i}-abcdefghijklm`,
      token,
      phone: i === 0 ? PHONE_A : PHONE_B,
      uid: `uid-${i}`,
    })
  })
  return dir
}

/** 起一个真面板服务（含门户路由）。 */
async function startServer(t, opts = {}) {
  const dir = opts.configDir ?? seed(t)
  const platform = opts.platform ?? fakePlatform()
  const server = createPageServer({
    configDir: dir,
    platformBaseUrl: PLATFORM,
    log: { warn() {} },
    fetchImpl: platform.fetchImpl,
    now: opts.now,
    publicBaseUrl: opts.publicBaseUrl,
    bindAdminToken: opts.bindAdminToken,
    // 默认关掉按 IP 节流：同一个测试进程里几十个请求都来自 127.0.0.1
    allocateWindowMs: opts.allocateWindowMs ?? 0,
    // 同理：同一会话在测试里会被连续轮询多次
    checkWindowMs: opts.checkWindowMs ?? 0,
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const port = server.address().port
  t.after(() => new Promise((done) => server.close(() => done())))
  return { base: `http://127.0.0.1:${port}`, dir, platform }
}

// ── ① 池子读取：token 在 refresh 字段 ─────────────────────────────────

test("§1 账号池：token 取 `refresh` 字段，编号按文件顺序", (t) => {
  const dir = seed(t)
  const list = listPoolTokens(dir)

  assert.equal(list.length, 2)
  assert.ok(list.every((a) => a.token.startsWith("tok-")), "token 应能读到")
  assert.deepEqual(list.map((a) => a.key), ["quwork", "quwork#1"])
  // 对外只显示编号
  assert.equal(labelOf(list.map((a) => a.key), "quwork"), "#1")
  assert.equal(labelOf(list.map((a) => a.key), "quwork#1"), "#2")
})

// ── ② 落地页：零上游 + 不泄露手机号 ────────────────────────────────────

test("§2 GET /bind 零上游，且页面不含手机号", async (t) => {
  const { base, platform } = await startServer(t)
  const resp = await fetch(`${base}/bind`)
  const html = await resp.text()

  assert.equal(resp.status, 200)
  assert.match(html, /开始绑定/)
  assert.ok(!html.includes(PHONE_A), "落地页不能出现手机号")
  assert.ok(!html.includes(PHONE_B), "落地页不能出现手机号")
  assert.equal(platform.calls.length, 0, "落地页不该打上游")
})

// ── ③ /bind/go：一次上游拿授权码，页面里有二维码 ───────────────────────

test("§3 GET /bind/go 打一次实测 + 一次取授权地址，出二维码且不泄露手机号", async (t) => {
  const { base, platform } = await startServer(t)
  const resp = await fetch(`${base}/bind/go`)
  const html = await resp.text()

  assert.equal(resp.status, 200)
  // ① 实测这个号绑没绑（防止把早就绑过的号发出去）② 取这个号的授权地址
  assert.deepEqual(
    platform.calls.map((c) => c.path),
    ["/api/user/self", "/api/oauth/wechat/url"],
  )
  assert.ok(platform.calls.every((c) => c.token === "tok-aaa"), "应该用第一个未绑账号的 token")

  assert.match(html, /data:image\/png;base64,/, "页面要有二维码图")
  assert.match(html, /待绑定账号 #1/)
  assert.match(html, /确认登录/)
  // 授权链接现在**只**编码在二维码里（页面上不再给「点这里打开」的按钮），
  // 所以用同一个编码器把预期 URL 编一遍，看页面里是不是那一张。
  assert.ok(platform.urls.length === 1, "平台应只被要过一次授权地址")
  const expectedQr = qrPng(platform.urls[0], { ecl: "L", scale: 8, border: 4 }).toString("base64")
  assert.ok(html.includes(expectedQr), "页面里的二维码必须就是平台签发的那条授权 URL")
  assert.ok(!html.includes(PHONE_A), "出码页不能出现手机号")
})

// ── ④ 并发占位：两个人不能拿到同一个账号 ────────────────────────────────

test("§4 同时访问两次 /bind/go 拿到不同账号（占位锁）", async (t) => {
  const { base } = await startServer(t)
  const [a, b] = await Promise.all([fetch(`${base}/bind/go`).then((r) => r.text()), fetch(`${base}/bind/go`).then((r) => r.text())])

  const labels = [a, b].map((html) => (html.match(/待绑定账号 (#\d+)/) ?? [])[1]).sort()
  assert.deepEqual(labels, ["#1", "#2"])
})

// ── ⑤ 轮询：wechat_bound 一变就 success，并把账号标成已绑 ───────────────

test("§5 /bind/api/check：pending → bound，快照标记已绑 + 释放锁", async (t) => {
  const { base, dir, platform } = await startServer(t)

  const goHtml = await fetch(`${base}/bind/go`).then((r) => r.text())
  const session = (goHtml.match(/var sid = "([^"]+)"/) ?? [])[1]
  assert.ok(session, "页面里应有 sessionId")

  const pending = await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())
  assert.equal(pending.status, "pending")
  assert.ok(pending.remainingMs > 0)

  // 扫码的人在微信里点了「确认登录」→ 平台侧变成已绑
  platform.bound.add("tok-aaa")
  const bound = await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())
  assert.equal(bound.status, "bound")
  assert.equal(bound.label, "#1")

  const pool = readPool(dir)
  assert.equal(pool.accounts["quwork"].wechatBound, true, "快照要记住这个号已绑")

  // 锁已释放 + 该号已绑 → 下一个人拿到第二个号
  const next = await fetch(`${base}/bind/go`).then((r) => r.text())
  assert.match(next, /待绑定账号 #2/)
})

// ── ⑥ 池子空了：友好页，不是 500 ───────────────────────────────────────

test("§6 全部账号都绑完 → 「没有可绑定账号」页（200）", async (t) => {
  const platform = fakePlatform({ bound: new Set(["tok-aaa", "tok-bbb"]) })
  const { base, dir } = await startServer(t, { platform })

  // 先把快照刷新成「都绑完了」（sync 会逐个实测 /api/user/self）
  const portal = createBindPortal({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl })
  await portal.sync()
  assert.equal(poolOverview({ configDir: dir }).available, 0)

  const resp = await fetch(`${base}/bind/go`)
  const html = await resp.text()
  assert.equal(resp.status, 200)
  assert.match(html, /现在没有可绑定的账号/)
})

// ── ⑦ 会话过期 ─────────────────────────────────────────────────────────

test("§7 会话过期 → 先续码；续满次数才 expired；号回到池子", async (t) => {
  let clock = 1_700_000_000_000
  const platform = fakePlatform()
  const dir = seed(t)
  const portal = createBindPortal({
    configDir: dir,
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    now: () => clock,
    sessionTtlMs: 1000,
    maxRenewals: 1,
  })
  await portal.sync()

  const alloc = await portal.allocate()
  assert.equal(alloc.ok, true)
  assert.equal((await portal.check(alloc.sessionId)).status, "pending")

  // 过期第 1 次：续一张新码（不是直接作废，用户不用重扫固定码）
  clock += 5000
  const renewed = await portal.check(alloc.sessionId)
  assert.equal(renewed.status, "pending")
  assert.equal(renewed.renewed, true)

  // 再过期：续码次数用完 → 真的作废，号回到池子
  clock += 5000
  assert.equal((await portal.check(alloc.sessionId)).status, "expired")
  const again = await portal.allocate()
  assert.equal(again.ok, true)
  assert.equal(again.key, alloc.key)
})

// ── ⑧ 管理接口鉴权 ─────────────────────────────────────────────────────

test("§8 配了 adminToken：无 Bearer → 401，带 Bearer → 200", async (t) => {
  const { base } = await startServer(t, { bindAdminToken: "s3cret" })

  assert.equal((await fetch(`${base}/bind/api/pool`)).status, 401)
  const ok = await fetch(`${base}/bind/api/pool`, { headers: { authorization: "Bearer s3cret" } })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.equal(body.total, 2)

  assert.equal((await fetch(`${base}/bind/api/sync`, { method: "POST", body: "{}" })).status, 401)
  const synced = await fetch(`${base}/bind/api/sync`, {
    method: "POST",
    headers: { authorization: "Bearer s3cret" },
    body: "{}",
  })
  assert.equal(synced.status, 200)
})

test("§29 releaseAll：一键把占位全放回池子（已绑的号不会被放回来）", async (t) => {
  const platform = fakePlatform()
  const dir = seed(t)
  const portal = createBindPortal({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl })
  await portal.sync()

  // 占住两个号（模拟被扫描器拿走的码）
  const a = await portal.allocate()
  const b = await portal.allocate()
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.deepEqual(portal.occupancy(), { sessions: 2, locks: 2, reserved: 0 })
  assert.equal((await portal.allocate()).ok, false, "两个号都被占着，第三次分配应该没有号")

  // 显式「全清」用 releaseAll({ idleMs: 0 })；默认（不传）只清没人盯的
  const rel = portal.releaseAll({ idleMs: 0 })
  assert.equal(rel.releasedSessions, 2)
  assert.equal(rel.releasedLocks, 2)
  assert.deepEqual(portal.occupancy(), { sessions: 0, locks: 0, reserved: 0 })

  // 释放后马上又能从 #1 开始分
  const again = await portal.allocate()
  assert.equal(again.ok, true)
  assert.equal(again.label, "#1")
  // 被释放的旧会话不再是 pending（再轮询应报过期），不会和新人抢同一个号
  assert.equal((await portal.check(a.sessionId)).status, "expired")
})

test("§29b 真绑上的号不会被 releaseAll 放回池子", async (t) => {
  const platform = fakePlatform({ bound: new Set(["tok-aaa"]) })
  const dir = seed(t)
  const portal = createBindPortal({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl })
  await portal.sync() // 快照会记下 #1 已绑

  const alloc = await portal.allocate()
  assert.equal(alloc.label, "#2", "已绑的 #1 不参与分配")

  portal.releaseAll()
  const next = await portal.allocate()
  assert.equal(next.label, "#2", "释放占位后 #1 仍然不会被发出去")
  assert.equal(poolOverview({ configDir: dir }).bound, 1)
})

// ── ㉛ 默认「清占用」不许动正在被扫的会话 ─────────────────────────────────
//
// 真机教训：管理员一点「释放所有占位」，正在扫码的人手上那张码当场失去映射，
// 他在微信里点「确认登录」，平台找不到号 → 他那边像成功了，我们这边永远 pending。

test("§31 releaseAll 默认只清空闲会话，保留正在被轮询的那一个", async (t) => {
  let clock = 1_700_000_000_000
  const platform = fakePlatform()
  const dir = seed(t)
  const portal = createBindPortal({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl, now: () => clock })
  await portal.sync()

  const live = await portal.allocate() // 有人正在盯
  const zombie = await portal.allocate() // 没人管
  assert.deepEqual(portal.occupancy(), { sessions: 2, locks: 2, reserved: 0 })

  // 只让 live 有轮询记录（lastSeenAt），zombie 保持了很久没动
  await portal.check(live.sessionId)
  clock += 120_000 // 两分钟
  await portal.check(live.sessionId) // live 刚刚又被轮询过

  const rel = portal.releaseAll({ idleMs: 60_000 })
  assert.equal(rel.releasedSessions, 1, "只该清掉没人管的那一个")
  assert.equal(rel.keptActive, 1, "正在被扫的要留着")
  assert.equal(portal.occupancy().locks, 1)

  // live 还能继续（它没被作废）
  assert.equal((await portal.check(live.sessionId)).status, "pending")
  // zombie 已经作废
  assert.equal((await portal.check(zombie.sessionId)).status, "expired")
})

// ── ⑨ token 失效的账号不参与分配 ────────────────────────────────────────
test("§9 上游 401 的账号标记 tokenInvalid，不参与分配", async (t) => {
  const platform = fakePlatform({ dead: new Set(["tok-aaa"]) })
  const dir = seed(t)
  const portal = createBindPortal({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl })

  const r = await portal.sync()
  assert.equal(r.failed, 1)
  assert.equal(poolOverview({ configDir: dir }).broken, 1)

  const alloc = await portal.allocate()
  assert.equal(alloc.ok, true)
  assert.equal(alloc.key, "quwork#1", "坏号要跳过")

  const tokens = platform.calls.filter((c) => c.path === "/api/oauth/wechat/url").map((c) => c.token)
  assert.deepEqual(tokens, ["tok-bbb"])
})

// ── ⑩ 固定二维码：恒定 + 指向 /bind/go ─────────────────────────────────

test("§10 GET /bind/qr.png 是 PNG，内容指向 <公网地址>/bind/go 且图案恒定", async (t) => {
  const { base } = await startServer(t, { publicBaseUrl: "https://bind.example.com" })

  const a = await fetch(`${base}/bind/qr.png`)
  const b = await fetch(`${base}/bind/qr.png`)
  assert.equal(a.status, 200)
  assert.equal(a.headers.get("content-type"), "image/png")
  assert.equal(a.headers.get("x-qr-target"), "https://bind.example.com/bind/go")

  const bufA = Buffer.from(await a.arrayBuffer())
  const bufB = Buffer.from(await b.arrayBuffer())
  assert.deepEqual([...bufA], [...bufB], "固定码的字节必须完全一致（图案永不变）")
  assert.deepEqual([...bufA.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

// ── ⑪ 二维码编码器结构自证 ─────────────────────────────────────────────

test("§11 qr.mjs：版本随长度增长、矩阵尺寸 4v+17、静区为白", () => {
  const short = qrMatrix("a", { ecl: "L" })
  const long = qrMatrix("x".repeat(200), { ecl: "L" })
  assert.equal(short.version, 1)
  assert.equal(short.size, 21)
  assert.ok(long.version > short.version, "更长的文本应选更高版本")
  assert.equal(long.size, long.version * 4 + 17)

  // 左上角定位图形：7×7 回字
  const m = short.modules
  assert.equal(m[0][0], true)
  assert.equal(m[0][6], true)
  assert.equal(m[1][1], false)
  assert.equal(m[3][3], true)

  // PNG：静区必须是纯白（扫不出来多半是这里坏了）
  const png = qrPng("https://bind.example.com/bind/go", { scale: 4, border: 4 })
  assert.ok(png.length > 100)
  assert.equal(png.includes(Buffer.from("IEND")), true)
})

// ── ⑫ 池子快照：读坏当没有 ─────────────────────────────────────────────

test("§12 readPool：文件不存在 / 损坏都当空池，不抛", async (t) => {
  const dir = tempDir(t)
  assert.deepEqual(readPool(dir), { updatedAt: 0, accounts: {} })

  writePool(dir, { updatedAt: 1, accounts: { quwork: { wechatBound: true } } })
  assert.equal(readPool(dir).accounts.quwork.wechatBound, true)
  assert.ok(existsSync(join(dir, BIND_POOL_FILE)))
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, BIND_POOL_FILE), "utf8")))

  writePool(dir, { updatedAt: Date.now(), accounts: {} })
  const ov = poolOverview({ configDir: dir })
  assert.equal(ov.total, 0)
  assert.equal(ov.stale, false)
})

// ── ⑬ 授权地址：缺 url 要报错，不要静悄悄返回空 ─────────────────────────

test("§13 fetchAuthorizeUrl：平台不回 url → ok:false；正常时抽出 state", async () => {
  const bad = await fetchAuthorizeUrl({
    platformBaseUrl: PLATFORM,
    token: "tok",
    fetchImpl: async () => Response.json({ success: true, data: {} }),
  })
  assert.equal(bad.ok, false)

  const good = await fetchAuthorizeUrl({
    platformBaseUrl: PLATFORM,
    token: "tok",
    fetchImpl: async () => Response.json({ success: true, data: { url: "https://x/y?state=abc#frag" } }),
  })
  assert.equal(good.ok, true)
  assert.equal(good.state, "abc")
})

// ── ⑭ 刷新池子用每个账号**自己的** token ────────────────────────────────

test("§14 refreshPool：每个账号用自己的 token 读 /api/user/self", async (t) => {
  const dir = seed(t)
  const platform = fakePlatform()
  const r = await refreshPool({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl })

  assert.equal(r.updated, 2)
  assert.deepEqual(
    platform.calls.map((c) => [c.path, c.token]),
    [
      ["/api/user/self", "tok-aaa"],
      ["/api/user/self", "tok-bbb"],
    ],
  )
  assert.equal(poolOverview({ configDir: dir }).available, 2)
})

// ── ⑯ 面板里的「扫码绑定」tab 不能被悄悄删掉 ─────────────────────────────
test("§16 面板 page 里有绑定 tab 与固定码预览，app.js 里有对应渲染", () => {
  const root = new URL("../", import.meta.url)
  const html = readFileSync(new URL("page/index.html", root), "utf8")
  for (const id of ["tab-bind", "pane-bind", "bind-body", "bind-sync", "bind-qr", "bind-summary"]) {
    assert.ok(html.includes(`id="${id}"`), `面板 HTML 缺 ${id}`)
  }

  const js = readFileSync(new URL("page/assets/app.js", root), "utf8")
  assert.ok(js.includes('"bind"]'), "TABS 里要有 bind")
  assert.ok(js.includes("loadBindPool"), "要有 loadBindPool")
  assert.ok(js.includes("/bind/api/pool"), "池子状态要读 /bind/api/pool")
})

// ── ⑮ 快照是空的也不会把「早已绑过」的号发出去 ────────────────────────────
//
// 真机复现过：首次扫码（快照还没建立）分到一个早就绑过微信的号，页面 3 秒后直接
// 显示「绑定成功」，对方什么都没做。所以出码前必须实测一次 `/api/user/self`。

test("§15 快照为空 + 第一个号其实已绑 → 跳过它，发给下一个未绑的", async (t) => {
  const platform = fakePlatform({ bound: new Set(["tok-aaa"]) })
  const dir = seed(t)
  const portal = createBindPortal({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl: platform.fetchImpl })

  const alloc = await portal.allocate()
  assert.equal(alloc.ok, true)
  assert.equal(alloc.key, "quwork#1", "已绑的号不能发给扫码的人")
  assert.equal(alloc.label, "#2")

  // 顺手把已绑的事实记进快照，下一次分配不用再试它
  assert.equal(readPool(dir).accounts.quwork.wechatBound, true)
  assert.equal(
    platform.calls.filter((c) => c.path === "/api/oauth/wechat/url").map((c) => c.token).join(","),
    "tok-bbb",
  )
})

// ── ⑰ 慢上游下也不能重号（预留要覆盖两次上游超时）────────────────────────
//
// 早先预留写死 15s < 2×上游超时（10s），慢一点就会中途失效 → 两个人拿到同一个号。
// 这里的上游每次「耗时 20 秒」（推进虚拟时钟），只有把预留调大 + 每次上游后都续期
// 才可能仍然分到两个不同的号。

test("§17 预留窗口必须 ≥ 两次上游超时（否则慢上游时会重号）", async () => {
  const { PLATFORM_TIMEOUT_MS } = await import("../src/constants.mjs")
  const { reserveWindowMs } = await import("../src/wechat-bind.mjs")
  assert.ok(
    reserveWindowMs() >= PLATFORM_TIMEOUT_MS * 2,
    `预留 ${reserveWindowMs()}ms 必须覆盖两次上游超时 ${PLATFORM_TIMEOUT_MS * 2}ms`,
  )
})

test("§17b 上游很慢（每次 20s 虚拟时间）时并发两次 /bind/go 仍然拿到不同账号", async (t) => {
  let clock = 1_700_000_000_000
  const base = fakePlatform()
  const fetchImpl = async (url, init) => {
    // 模拟一次 20 秒的上游（推进虚拟时钟，比真实等待快得多）
    await new Promise((done) => setTimeout(done, 0))
    clock += 20_000
    return base.fetchImpl(url, init)
  }
  const platform = { ...base, fetchImpl }

  const { base: url } = await startServer(t, { platform, now: () => clock })
  const [a, b] = await Promise.all([
    fetch(`${url}/bind/go`).then((r) => r.text()),
    fetch(`${url}/bind/go`).then((r) => r.text()),
  ])
  const labels = [a, b].map((html) => (html.match(/待绑定账号 (#\d+)/) ?? [])[1]).sort()
  assert.deepEqual(labels, ["#1", "#2"])
})

// ── ⑱ 反代形态（带 forwarded 头）下管理接口必须 401 ────────────────────────
//
// nginx `proxy_pass 127.0.0.1:4392` 时，所有外网请求的 remoteAddress 都是 127.0.0.1。
// 只看回环 = 把 pool/sync 对全网开放，而 sync 会拿你的 token 挨个打平台。

test("§18 没配 adminToken 时带 x-forwarded-* 的请求一律 401（不能被当成本机）", async (t) => {
  const { base } = await startServer(t)

  const proxied = { headers: { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" } }
  assert.equal((await fetch(`${base}/bind/api/pool`, proxied)).status, 401)
  assert.equal((await fetch(`${base}/bind/api/sync`, { ...proxied, method: "POST", body: "{}" })).status, 401)

  // 本机直连（无 forwarded 头）仍然可用，否则面板读不到池子
  assert.equal((await fetch(`${base}/bind/api/pool`)).status, 200)
})

// ── ⑲ /bind/api/check 不能把账号 key 吐给陌生人 ───────────────────────────

test("§19 /bind/api/check 三个分支都不带 key / token / 手机号", async (t) => {
  const { base, platform } = await startServer(t)
  const secrets = (o) => {
    const s = JSON.stringify(o)
    assert.equal(Object.prototype.hasOwnProperty.call(o, "key"), false, "不能给 key")
    assert.ok(!s.includes("quwork"), "不能出现账号 key 前缀")
    assert.ok(!s.includes(PHONE_A) && !s.includes(PHONE_B), "不能出现手机号")
    assert.ok(!s.includes("tok-"), "不能出现平台 token")
  }

  const goHtml = await fetch(`${base}/bind/go`).then((r) => r.text())
  const session = (goHtml.match(/var sid = "([^"]+)"/) ?? [])[1]

  // ① pending 分支
  const pending = await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())
  assert.equal(pending.status, "pending")
  assert.ok(pending.remainingMs > 0)
  secrets(pending)

  // ② bound 分支（要有 label，但同样不能有 key）
  platform.bound.add("tok-aaa")
  const bound = await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())
  assert.equal(bound.status, "bound")
  assert.equal(bound.label, "#1")
  secrets(bound)

  // ③ 上游读不到的分支（session 仍 pending 时平台 5xx）
  const go2 = await fetch(`${base}/bind/go`).then((r) => r.text())
  const session2 = (go2.match(/var sid = "([^"]+)"/) ?? [])[1]
  platform.dead.add("tok-bbb")
  const failed = await fetch(`${base}/bind/api/check?session=${session2}`).then((r) => r.json())
  assert.equal(failed.status, "pending")
  assert.match(String(failed.message ?? ""), /读不到状态|HTTP/) // 只是说明，不是密钥
  secrets(failed)
})

// ── ⑳ wechat_bound 不是布尔时也要认 ───────────────────────────────────────

test("§20 wechat_bound 为 1 / \"true\" 时算已绑（否则会把已绑号发出去）", async (t) => {
  const { isTruthyFlag } = await import("../src/wechat-bind.mjs")
  for (const v of [true, 1, "true", "1", " TRUE "]) assert.equal(isTruthyFlag(v), true, `${v} 应为真`)
  for (const v of [false, 0, "false", "", null, undefined, "0"]) assert.equal(isTruthyFlag(v), false, `${v} 应为假`)

  // 端到端：平台回 1（而不是 true），出码前实测应判为已绑并跳过
  const fetchImpl = async (url, init) => {
    const p = new URL(String(url)).pathname
    const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer\s+/i, "")
    if (p === "/api/user/self") {
      // 第一个号回 1（数字），第二个号回 "true"（字符串）—— 两种都算已绑
      return Response.json({ success: true, data: { wechat_bound: token === "tok-aaa" ? 1 : "true" } })
    }
    if (p === "/api/oauth/wechat/url") return Response.json({ success: true, data: { url: "https://x/y?state=s1" } })
    return Response.json({ success: false, message: "?" })
  }
  const dir = seed(t)
  const portal = createBindPortal({ configDir: dir, platformBaseUrl: PLATFORM, fetchImpl })
  const alloc = await portal.allocate()
  // 两个号都被实测判成已绑 → 池子真的空了（页面给「暂时没有可绑定账号」，不是「稍后再试」）
  assert.equal(alloc.ok, false)
  assert.equal(alloc.reason, "no-account")
})

// ── ㉑ 带前缀的代理路径也要能用（不能用相对链接）──────────────────────────

test("§21 前缀部署：/svc/bind 与 /svc/bind/go 都通，页面链接是绝对路径", async (t) => {
  const { base } = await startServer(t)

  const land = await fetch(`${base}/svc/bind`).then((r) => r.text())
  assert.match(land, /href="\/svc\/bind\/go"/, "落地页按钮要绝对路径")
  assert.match(land, /开始绑定/)

  const go = await fetch(`${base}/svc/bind/go`).then((r) => r.text())
  assert.match(go, /待绑定账号 #1/)
  assert.match(go, /var checkUrl = "\/svc\/bind\/api\/check"/, "轮询要打前缀下的绝对地址")
  assert.ok(go.includes('href="/svc/bind/go"'))

  // 轮询真的能通
  const session = (go.match(/var sid = "([^"]+)"/) ?? [])[1]
  const c = await fetch(`${base}/svc/bind/api/check?session=${session}`).then((r) => r.json())
  assert.equal(c.status, "pending")

  // 带尾斜杠也要命中（`rest` 先剥尾斜杠）
  const goSlash = await fetch(`${base}/svc/bind/go/`).then((r) => r.text())
  assert.match(goSlash, /待绑定账号 #2/)
})

test("§21b 后缀匹配不能误伤：/bindable 仍走面板 SPA 兜底", async (t) => {
  const { base } = await startServer(t)
  const html = await fetch(`${base}/bindable`).then((r) => r.text())
  assert.ok(html.includes("QuWork 工作台"), "不是门户页，应该是面板 HTML")
  assert.ok(!html.includes("开始绑定"))
})

// ── ㉒ 按 IP 节流：狂刷 /go 不能把池子一次占光 ─────────────────────────────

test("§22 同一个 IP 3 秒内第二次 /bind/go 会被挡（默认节流），窗口过后恢复", async (t) => {
  let clock = 1_700_000_000_000
  const { base, platform } = await startServer(t, { allocateWindowMs: 3000, now: () => clock })

  const first = await fetch(`${base}/bind/go`).then((r) => r.text())
  assert.match(first, /待绑定账号/)

  const second = await fetch(`${base}/bind/go`).then((r) => r.text())
  assert.match(second, /操作太快了/, "第二次要被挡")
  // 第二次不该再打上游（节流发生在分配之前）
  assert.equal(platform.calls.filter((c) => c.path === "/api/oauth/wechat/url").length, 1)

  // 窗口过后要恢复，不能永久封
  clock += 3500
  const third = await fetch(`${base}/bind/go`).then((r) => r.text())
  assert.match(third, /待绑定账号 #2/)
})

test("§22b 非法窗口值不能把节流静默关掉", async (t) => {
  const { base } = await startServer(t, { allocateWindowMs: "3s" })
  await fetch(`${base}/bind/go`)
  const second = await fetch(`${base}/bind/go`).then((r) => r.text())
  assert.match(second, /操作太快了/, "NaN 窗口要回落成默认 3s，而不是 0")
})

test("§28 占位 5 分钟 + 页面会自续码（过期不逼用户重扫固定码）", async (t) => {
  const { SESSION_TTL_MS } = await import("../src/wechat-bind.mjs")
  assert.equal(SESSION_TTL_MS, 300_000, "默认占位时间应是 5 分钟")

  const { base } = await startServer(t)
  const go = await fetch(`${base}/bind/go`).then((r) => r.text())
  // 页面把 ttl 写进倒计时，并且**过期后原地换码**（服务端下一轮会回新的 qr）
  assert.match(go, /var deadline = Date\.now\(\) \+ \(Number\(300000\)/, "倒计时要按 300s 来")
  assert.match(go, /if \(j\.qr\) \{/, "页面要能接收并替换新码")
  assert.match(go, /var hardStop = Date\.now\(\) \+ maxWait;/, "要有总等待上限，别无限轮询")

  // 服务端也要按 180s 判过期
  const body = await fetch(`${base}/bind/go`).then((r) => r.text())
  const session = (body.match(/var sid = "([^"]+)"/) ?? [])[1]
  const st = await fetch(`${base}/bind/api/check?session=${session}`).then((r) => r.json())
  assert.ok(st.remainingMs <= 300_000 && st.remainingMs > 290_000, `剩余时间应 ≈300s，实际 ${st.remainingMs}`)
})

test("§32 绑定成功要有醒目反馈（顶部横幅 + 声音 + 标题变化），阵列页和出码页都要有", async (t) => {
  const { base } = await startServer(t)
  const wall = await fetch(`${base}/bind/wall?n=1`).then((r) => r.text())
  assert.match(wall, /id="done-banner"/, "阵列页要有顶部「已绑定」横幅")
  assert.match(wall, /function celebrate\(/, "绑定成功要触发 celebrate()")
  assert.match(wall, /AudioContext/, "要有一声提示音")
  assert.match(wall, /navigator\.vibrate/, "手机要震一下")
  assert.match(wall, /document\.title = "✓ 已绑定/, "标题要变，切回浏览器也能看见")

  const go = await fetch(`${base}/bind/go`).then((r) => r.text())
  assert.match(go, /document\.title = "✓ 绑定成功"/, "单人页同样要有反馈")
  assert.match(go, /绑定成功 ✓ 谢谢！/)
})

// ── ㉚ 过期续码：同一个号、新 state、页面不用重扫固定码 ──────────────────────

test("§30 会话过期后 check 会原地续码（pending + qr + ttlMs），号不变", async (t) => {
  let clock = 1_700_000_000_000
  const platform = fakePlatform()
  const dir = seed(t)
  const portal = createBindPortal({
    configDir: dir,
    platformBaseUrl: PLATFORM,
    fetchImpl: platform.fetchImpl,
    now: () => clock,
    sessionTtlMs: 1000,
    maxRenewals: 2,
  })
  await portal.sync()

  const a = await portal.allocate()
  assert.equal(a.ok, true)
  const firstState = a.state

  clock += 2000 // 过期
  const r1 = await portal.check(a.sessionId)
  assert.equal(r1.status, "pending", "过期不是抛弃，而是续一张新码")
  assert.equal(r1.renewed, true)
  assert.equal(r1.key, a.key, "还是同一个号")
  assert.ok(r1.qr?.startsWith("data:image/png;base64,"), "要直接给页面一张可替换的图")
  assert.ok(r1.ttlMs > 0)
  const newState = new URL(r1.qrUrl).searchParams.get("state")
  assert.ok(newState && newState !== firstState, "续码必须换新的平台 state")

  // 号还归这一个会话（别人抢不到）
  const other = await portal.allocate()
  assert.notEqual(other.key, a.key)

  // 续满 maxRenewals 次就真的作废
  clock += 2000
  assert.equal((await portal.check(a.sessionId)).renewed, true)
  clock += 2000
  const dead = await portal.check(a.sessionId)
  assert.equal(dead.status, "expired")
  assert.match(String(dead.message ?? ""), /已放回池子/)
  assert.equal(dead.released, true, "作废时必须明确告诉前端「号已被收回」，阵列页据此换新号")
})

test("§27 出码页必须明确「用微信扫一扫直接扫，相册/长按识别无效」", async (t) => {
  const { base } = await startServer(t)
  const go = await fetch(`${base}/bind/go`).then((r) => r.text())

  assert.match(go, /必须用/, "要有强制提示")
  assert.match(go, /扫一扫/)
  assert.match(go, /相册/, "要明确相册无效")
  assert.match(go, /无效/)
  assert.match(go, /另一台手机/, "要告诉用户拿另一台手机扫")
  // 「长按识别」只能出现在「无效」的语境里，不能作为操作指引出现
  assert.ok(!go.includes("长按上面的二维码"), "不能教用户长按那张码去识别")
  assert.match(go, /长按识别[\s\S]{0,24}无效/, "提到长按识别时必须明确是无效路径")
  assert.match(go, /用<strong>电脑<\/strong>打开|用电脑打开/, "单人场景要给出「用电脑打开本页」的解法")

  const land = await fetch(`${base}/bind`).then((r) => r.text())
  assert.match(land, /扫一扫/)
  assert.match(land, /相册/)
})

// ── ㉔ 面板里能改固定码的公网地址（不用重启 magpie）────────────────────────
//
// 环境变量改了要重启 magpie 才生效，而 magpie 一停所有模型请求全断。
// 所以固定码里的地址必须能在面板里改。

test("§24 设置里填 bindPublicUrl → 固定码内容立刻跟着变；清空则回落到请求地址", async (t) => {
  const { base } = await startServer(t)

  // ① 先看默认：没配 → 用请求头拼出来的本机地址
  const before = await fetch(`${base}/bind/qr.png`)
  assert.match(before.headers.get("x-qr-target"), /^http:\/\/127\.0\.0\.1:\d+\/bind\/go$/)

  // ② 存一个带尾斜杠 + 大写的地址：要被规范化
  const saved = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindPublicUrl: "https://Bind.Example.com/" }),
  }).then((r) => r.json())
  assert.equal(saved.ok, true)
  assert.equal(saved.settings.bindPublicUrl, "https://bind.example.com")

  const after = await fetch(`${base}/bind/qr.png`)
  assert.equal(after.headers.get("x-qr-target"), "https://bind.example.com/bind/go")
  const readBack = await fetch(`${base}/api/settings`).then((r) => r.json())
  assert.equal(readBack.settings.bindPublicUrl, "https://bind.example.com")

  // ③ 非法值 = 清空（不能把垃圾拼进固定码）
  const bad = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindPublicUrl: "javascript:alert(1)" }),
  }).then((r) => r.json())
  assert.equal(bad.settings.bindPublicUrl, "")
  const cleared = await fetch(`${base}/bind/qr.png`)
  assert.match(cleared.headers.get("x-qr-target"), /^http:\/\/127\.0\.0\.1:\d+\/bind\/go$/)
})

test("§25 normalizePublicUrl：只认 http(s)，去尾斜杠，拦垃圾", async () => {
  const { normalizePublicUrl } = await import("../server.mjs")
  assert.equal(normalizePublicUrl("https://a.example"), "https://a.example")
  assert.equal(normalizePublicUrl("  https://a.example/  "), "https://a.example")
  assert.equal(normalizePublicUrl("https://a.example/sub/"), "https://a.example/sub")
  assert.equal(normalizePublicUrl(""), "")
  assert.equal(normalizePublicUrl(null), "")
  assert.equal(normalizePublicUrl("not a url"), "")
  assert.equal(normalizePublicUrl("ftp://a.example"), "")
  assert.equal(normalizePublicUrl("javascript:alert(1)"), "")
})

test("§26 /bind/qr.png?scale=16 出的是打印用大图（IHDR 尺寸更大）", async (t) => {
  const { base } = await startServer(t)
  const small = Buffer.from(await (await fetch(`${base}/bind/qr.png?scale=4`)).arrayBuffer())
  const big = Buffer.from(await (await fetch(`${base}/bind/qr.png?scale=16`)).arrayBuffer())

  // PNG: 8 字节签名 + 4 长度 + 4 类型("IHDR") + 4 宽 + 4 高
  const width = (buf) => buf.readUInt32BE(16)
  assert.ok(width(big) > width(small), `大图应更宽：${width(big)} vs ${width(small)}`)
  assert.equal(width(big), width(small) * 4, "scale 从 4 到 16，宽度应正好是 4 倍")
})
//
// 面板整体是 `Access-Control-Allow-Origin: *`（file: 加载必须），但管理接口一旦也通配，
// 任何一条公网网页都能在本机浏览器里把池子读走、把 sync 打满。

// ── ㉓ 管理接口不能对任意站点开放 CORS ─────────────────────────────────────
//
// 面板整体是 `Access-Control-Allow-Origin: *`（file: 加载必须），但管理接口一旦也通配，
// 任何一条公网网页都能在本机浏览器里把池子读走、把 sync 打满。

test("§23 /bind/api/pool 的 CORS：面板（null / 回环）放行，外站一律不给 ACAO", async (t) => {
  const { base } = await startServer(t)

  const evil = await fetch(`${base}/bind/api/pool`, { headers: { origin: "https://evil.example" } })
  assert.equal(evil.status, 200)
  assert.equal(evil.headers.get("access-control-allow-origin"), null, "外站不能拿到 ACAO")

  const file = await fetch(`${base}/bind/api/pool`, { headers: { origin: "null" } })
  assert.equal(file.headers.get("access-control-allow-origin"), "null", "file: 面板要能用")

  const local = await fetch(`${base}/bind/api/pool`, { headers: { origin: "http://127.0.0.1:4392" } })
  assert.equal(local.headers.get("access-control-allow-origin"), "http://127.0.0.1:4392")

  // 预检同样不能给外站开绿灯
  const pre = await fetch(`${base}/bind/api/pool`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get("access-control-allow-origin"), null)
})
