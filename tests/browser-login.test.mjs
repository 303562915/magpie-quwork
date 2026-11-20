// browser-login.test.mjs 登录入口：**启动 QuWork 客户端**（不是打开网页）+ 轮询抓取。
//
// # 为什么必须启动客户端（真机复核过）
//
// `llm_token` 只有 QuWork **桌面客户端**会写进 sqlite / `.credentials.yaml`。
// 用系统浏览器打开网页不会写这两处 ⇒ 轮询永远抓不到。所以「浏览器登录」这个名字
// 其实是「启动能产生凭据的那个东西」：客户端优先，网页只是退路。
//
// # 三条关键语义
//
//	① 启动失败**不影响**返回（用户可以自己打开）—— 只 warn
//	② 轮询必须拿到**新**凭据：进入时快照旧值，只接受 ≠ 旧值（旧值本来为空则任意非空都算）
//	③ `signal.abort()` 立刻退出，不再 sleep
//
// ⚠ 测试绝不真启动客户端/浏览器（注入 `exists`/`spawn`/`openExternal`），
//   也绝不真等 3 分钟（注入 `sleep`/`pollIntervalMs`/`pollMs`）。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { QuWorkAuthPlugin } from "../index.mjs"
import { readLocalCredential, defaultPaths } from "../src/browser-login.mjs"

const OLD_LLM = "sk-OLD-000000000000"
const NEW_LLM = "sk-NEW-111111111111"
const PLATFORM = "pt-22222222222222"
const FAKE_EXE = "C:\\fake\\QuWork.exe"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-browser-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 取出「打开客户端登录」那一项。 */
async function loginMethod(opts = {}) {
  const p = await QuWorkAuthPlugin({}, { log: { warn() {} }, ...opts })
  return p.auth.methods.find((m) => /客户端|浏览器/.test(String(m.label)))
}

/** 让「找 exe」永远失败 ⇒ 走网页退路。 */
const noClient = {
  exists: () => false,
  readRegistry: () => "",
}

// ── A) authorize 启动客户端 ────────────────────────────────────────────

test("1) 命中客户端 exe → 启动它（spawn 一次、参数是那个 exe），url 为空", async () => {
  /** @type {Array<{cmd: string, argv: any[]}>} */
  const spawned = []
  const m = await loginMethod({
    clientPath: FAKE_EXE,
    exists: (p) => p === FAKE_EXE,
    readRegistry: () => "",
    spawn: (cmd, argv) => {
      spawned.push({ cmd, argv })
      return { unref() {}, on() {} }
    },
  })

  const r = await m.authorize({})

  assert.equal(spawned.length, 1, "必须真的启动一次客户端")
  assert.equal(spawned[0].cmd, FAKE_EXE)
  assert.equal(r.method, "other")
  assert.equal(r.url, "", "客户端场景不给 url —— 否则 magpie 会再开一个网页")
  assert.equal(typeof r.callback, "function")
  assert.match(String(r.instructions), /客户端/)
})

test("2) 找不到客户端 → 退化成网页：url 非空，且 openExternal 收到该 url", async () => {
  /** @type {string[]} */
  const opened = []
  const m = await loginMethod({
    ...noClient,
    openExternal: async (u) => opened.push(String(u)),
  })

  const r = await m.authorize({})

  assert.equal(r.method, "other")
  assert.ok(String(r.url).startsWith("https://"), `网页退路要给 url: ${JSON.stringify(r.url)}`)
  assert.equal(opened[0], r.url, "openExternal 应该打开同一个 url")
})

test("3) 启动失败（spawn 抛错）→ authorize 仍返回，info 有 warn", async () => {
  /** @type {string[]} */
  const warns = []
  const p = await QuWorkAuthPlugin(
    {},
    {
      log: { warn: (m) => warns.push(String(m)) },
      clientPath: FAKE_EXE,
      exists: () => true,
      readRegistry: () => "",
      spawn: () => {
        throw new Error("spawn denied")
      },
      openExternal: async () => {},
    },
  )
  const m = p.auth.methods.find((x) => /客户端|浏览器/.test(String(x.label)))
  const r = await m.authorize({})

  assert.equal(r.method, "other")
  assert.equal(typeof r.callback, "function")
  assert.ok(warns.length > 0, "启动失败要留一条 warn")
})

// ── D) callback 轮询抓取 ───────────────────────────────────────────────

test("4) callback 第一次就读到**新**凭据 → success（access/refresh/expires/accountId）", async () => {
  let clock = 0
  /** 快照那次读返回空（本机没登录过），轮询那次返回新凭据 */
  const queue = [
    { ok: false, error: "没找到" },
    { ok: true, llmToken: NEW_LLM, token: PLATFORM, expire: 1_800_000_000, phone: "13800000000" },
  ]
  let reads = 0
  const m = await loginMethod({
    ...noClient,
    openExternal: async () => {},
    pollIntervalMs: 1,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    readLocal: () => {
      const v = queue[Math.min(reads, queue.length - 1)]
      reads += 1
      return v
    },
  })

  const r = await m.callback(undefined, {})

  assert.equal(r.type, "success")
  assert.equal(r.access, NEW_LLM)
  assert.equal(r.refresh, PLATFORM)
  assert.equal(r.expires, 1_800_000_000 * 1000)
  assert.equal(r.accountId, "13800000000")
  assert.equal(r.metadata.nickname, "13800000000")
})

test("5) 先读到**旧**凭据（与基准相同）→ 继续轮询；读到新值 → success", async () => {
  /** @type {Array<any>} */
  const queue = [
    { ok: true, llmToken: OLD_LLM, token: "pt-old", expire: 1 }, // 快照（基准）
    { ok: true, llmToken: OLD_LLM, token: "pt-old", expire: 1 }, // 第 1 轮：还是旧的
    { ok: true, llmToken: NEW_LLM, token: PLATFORM, expire: 1_800_000_000 }, // 第 2 轮：新的
  ]
  let reads = 0
  let clock = 0
  const m = await loginMethod({
    ...noClient,
    openExternal: async () => {},
    pollIntervalMs: 1,
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    readLocal: () => {
      const v = queue[Math.min(reads, queue.length - 1)]
      reads += 1
      return v
    },
  })

  const r = await m.callback(undefined, {})
  assert.equal(r.type, "success")
  assert.equal(r.access, NEW_LLM, "不能拿旧凭据当成功")
  assert.ok(reads >= 3, `应当轮询到新值（读了 ${reads} 次）`)
})

test("6) 一直读不到 → 到 deadline 后 failed，error 含「3 分钟」", async () => {
  let clock = 0
  const m = await loginMethod({
    ...noClient,
    openExternal: async () => {},
    pollIntervalMs: 1,
    pollMs: 5,
    sleep: async (ms) => { clock += ms },
    now: () => clock,
    readLocal: () => ({ ok: false, error: "没找到" }),
  })

  const r = await m.callback(undefined, {})

  assert.equal(r.type, "failed")
  assert.match(String(r.error), /3 分钟/)
})

test("7) signal.abort() → 立刻 failed「登录已取消」，不再 sleep", async () => {
  const ac = new AbortController()
  let clock = 0
  let sleeps = 0
  const m = await loginMethod({
    ...noClient,
    openExternal: async () => {},
    pollIntervalMs: 1,
    sleep: async (ms) => {
      sleeps += 1
      clock += ms
      ac.abort()
    },
    now: () => clock,
    readLocal: () => ({ ok: false }),
  })

  const r = await m.callback(undefined, { signal: ac.signal })
  assert.equal(r.type, "failed")
  assert.match(String(r.error), /取消/)
  assert.equal(sleeps, 1, "取消后不该再睡第二轮")
})

// ── E) leveldb 兜底 ────────────────────────────────────────────────────

test("8) readLocalCredential：sqlite/yaml 都没有时读 leveldb（字节里找 llmToken）", (t) => {
  const home = tempDir(t)
  const appData = join(home, "Roaming")
  const ldb = join(appData, "qurwork-desktop", "Local Storage", "leveldb")
  mkdirSync(ldb, { recursive: true })
  writeFileSync(
    join(ldb, "000003.log"),
    `LEVELDBBLOB{"accessToken":"${PLATFORM}","llmToken":"${NEW_LLM}","expiresAt":1800000000000}BLOB`,
  )

  const got = readLocalCredential({
    paths: defaultPaths({ home, appData }),
    // sqlite / yaml 都读不到；leveldb 的那个文件读得到
    readFile: (p) => {
      if (String(p).endsWith(".log")) return readFileSync(p)
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    },
    readDir: (dir) => ["000003.log"].map((n) => join(dir, n)),
  })

  assert.equal(got.ok, true)
  assert.equal(got.llmToken, NEW_LLM)
  assert.equal(got.token, PLATFORM)
  assert.equal(got.source, "leveldb")
})

test("9) pollIntervalMs / sleep / pollMs 可注入（不真等）", async () => {
  /** @type {number[]} */
  const sleeps = []
  let clock = 0
  let reads = 0
  const m = await loginMethod({
    ...noClient,
    openExternal: async () => {},
    pollIntervalMs: 7,
    pollMs: 30,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
      reads += 1
      if (reads > 50) throw new Error("循环没退出")
    },
    now: () => clock,
    readLocal: () => ({ ok: false }),
  })

  const r = await m.callback(undefined, {})
  assert.equal(r.type, "failed")
  assert.ok(sleeps.length > 0, "应当进入轮询")
  assert.ok(sleeps.every((ms) => ms === 7), `sleep 应收到注入的间隔，实际: ${sleeps.join(",")}`)
})