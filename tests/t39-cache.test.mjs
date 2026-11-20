// t39-cache.test.mjs（T-39）缓存化：所有会打上游的钩子默认只读缓存。
//
// # 用户原话（这就是验收标准）
//
//	「所有的东西都需要缓存。更新缓存是我们来控制的，不要自动更新缓存」
//	「重启项目的时候，我不希望它就会自动去发送什么请求」
//
// # 判据
//
//	magpie 重启 → 重读模型列表 → **会不会对每个账号各打一次上游？**
//	改造后：缓存命中 = 0 次；没有缓存 = 1 次（不是账号数）。缓存只由面板按钮写。
//
// 这里每一个用例都用一个**真临时目录**当 configDir（缓存文件真落盘），
// 并用 fetch 计数器把「上游请求数」变成可断言的数字。

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { makeModelsHook, refreshCatalogCache } from "../src/hooks/models.mjs"
import { makeUsageHook, windowsFromSelf, rememberUsage, NOTE_PREFIX } from "../src/hooks/usage.mjs"
import { makeRefresher } from "../src/refresh.mjs"
import { MODELS_CACHE_FILE, USAGE_CACHE_FILE, accountCacheKey, cacheFilePath, readCacheEntry } from "../src/cache.mjs"
import { DEFAULT_MODELS, MODEL_BASE_URL } from "../src/constants.mjs"
import { upsertAccount } from "../src/auth-store.mjs"
import { createPageServer, DEFAULT_SETTINGS } from "../server.mjs"
import { AUTH_OPTIONS } from "../index.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..")

const LLM = "llm-token-abc123"
const TOKEN = "platform-token-zzz999"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-t39-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 一个会数上游请求数的 fetch（只认 /models，其余一律 404）。 */
function countingFetch(handler) {
  const state = { calls: 0, urls: [] }
  const fn = async (url, init) => {
    state.calls += 1
    state.urls.push(String(url))
    return handler(url, init)
  }
  return { fetchImpl: fn, state }
}

const LIVE = { object: "list", data: [{ id: "deepseek-flash", name: "DeepSeek" }, { id: "glm-5.2" }] }

// ── 1) 缓存命中 → 零上游 ────────────────────────────────────────────────
test("T39-1) auth.models 命中缓存 → **零上游请求**（magpie 重启后就是这条路）", async (t) => {
  const dir = tempDir(t)
  const key = MODEL_BASE_URL
  // 预先放一份缓存（等于"上一轮已经拉过"）
  writeFileSync(
    cacheFilePath(dir, MODELS_CACHE_FILE),
    JSON.stringify({ [key]: { at: Date.now(), list: [{ id: "glm-5.2", name: "GLM 缓存" }] } }),
  )

  const { fetchImpl, state } = countingFetch(async () => {
    throw new Error("命中缓存还必须发请求 = 失败")
  })
  const models = makeModelsHook({ configDir: dir, fetchImpl, log: { warn() {} } })

  const out = await models({}, { auth: { llmToken: LLM } })
  assert.equal(state.calls, 0, "缓存命中时零上游")
  assert.deepEqual(Object.keys(out), ["glm-5.2"], "用的是缓存里的列表")
  assert.equal(out["glm-5.2"].name, "GLM 缓存")
})

// ── 2) 多账号并发未命中 → 恰好 1 次 ─────────────────────────────────────
test("T39-2) 多账号并发调用 auth.models（无缓存）→ 上游请求**恰好 1 次**", async (t) => {
  const dir = tempDir(t)
  let release
  const gate = new Promise((r) => (release = r))
  const { fetchImpl, state } = countingFetch(async () => {
    await gate // 卡住第一次请求，让后面几个账号真的并进来
    return Response.json(LIVE)
  })
  const models = makeModelsHook({ configDir: dir, fetchImpl, log: { warn() {} } })

  const pending = Promise.all(
    ["a", "b", "c", "d", "e"].map((id) => models({}, { auth: { llmToken: `llm-${id}` } })),
  )
  release()
  const results = await pending

  assert.equal(state.calls, 1, `5 个账号并发只能是 1 次上游请求（实际 ${state.calls} 次）`)
  for (const r of results) assert.deepEqual(Object.keys(r).sort(), ["deepseek-flash", "glm-5.2"])
})

// ── 3) 未命中 → 拉 1 次并写缓存；再调用读文件零上游 ──────────────────────
test("T39-3) 无缓存 → 拉 1 次并写缓存文件；再调用（新实例＝重启）读文件零上游", async (t) => {
  const dir = tempDir(t)
  const { fetchImpl, state } = countingFetch(async () => Response.json(LIVE))

  const first = makeModelsHook({ configDir: dir, fetchImpl, log: { warn() {} } })
  const out = await first({}, { auth: { llmToken: LLM } })
  assert.equal(state.calls, 1, "第一次必须真拉一次")
  assert.deepEqual(Object.keys(out).sort(), ["deepseek-flash", "glm-5.2"])

  const file = cacheFilePath(dir, MODELS_CACHE_FILE)
  assert.ok(existsSync(file), "缓存文件必须落盘")
  const cache = JSON.parse(readFileSync(file, "utf8"))
  assert.ok(Array.isArray(cache[MODEL_BASE_URL]?.list), "结构是 { [baseUrl]: { at, list } }")
  assert.equal(cache[MODEL_BASE_URL].list.length, 2)

  // 新实例 = magpie 重启：只读文件，不再发请求
  const second = makeModelsHook({ configDir: dir, fetchImpl, log: { warn() {} } })
  const again = await second({}, { auth: { llmToken: LLM } })
  assert.equal(state.calls, 1, "重启后不许再打上游")
  assert.deepEqual(Object.keys(again).sort(), ["deepseek-flash", "glm-5.2"])
})

// ── 4) 失败不写缓存（下次仍重试）───────────────────────────────────────
test("T39-4) 拉取失败 → 回退静态表且**不写缓存**（下次还会重试）", async (t) => {
  const dir = tempDir(t)
  const { fetchImpl, state } = countingFetch(async () => new Response("nope", { status: 500 }))

  const models = makeModelsHook({ configDir: dir, fetchImpl, log: { warn() {} } })
  const out = await models({}, { auth: { llmToken: LLM } })
  assert.deepEqual(Object.keys(out).sort(), DEFAULT_MODELS.map((m) => m.id).sort(), "回退静态表（10 个）")
  assert.equal(readCacheEntry(dir, MODELS_CACHE_FILE, MODEL_BASE_URL), null, "失败绝不能写缓存")

  // 第二次调用 → 仍然重试（不是"记住失败"）
  await models({}, { auth: { llmToken: LLM } })
  assert.equal(state.calls, 2, "失败后下一次仍然去试")
})

// ── 5) usage **不做缓存**：每次被问都真读上游（用户驳回「usage 也缓存」）──────
test("T39-5) auth.usage 每次都真读 /api/user/self（有缓存文件也不读它）", async (t) => {
  const dir = tempDir(t)
  // 预先放一份"过期数据"的额度缓存：钩子必须**无视**它
  writeFileSync(
    cacheFilePath(dir, USAGE_CACHE_FILE),
    JSON.stringify({ "13800000000": { at: 1, windows: [{ name: "额度 · 平台积分", balance: 999 }] } }),
  )

  const { fetchImpl, state } = countingFetch(async (url) =>
    String(url).endsWith("/api/user/self") ? Response.json({ data: { points_entitlement: { total_points: "42.00" } } }) : new Response("no", { status: 404 }),
  )
  const usage = makeUsageHook({ configDir: dir, fetchImpl, log: { warn() {} } })

  const u = await usage(async () => ({ llmToken: LLM, token: TOKEN, accountId: "13800000000" }))
  assert.equal(state.calls, 1, "usage 必须真打一次上游（≥1）")
  assert.equal(state.urls[0], "https://llm.rrzu.com/api/user/self")
  const main = u.windows.find((w) => String(w.name) === "额度 · 平台积分")
  assert.equal(main.balance, 42, "返回的是**实时**读到的数字，不是缓存里的 999")
  assert.equal(u.error, undefined)
})

// ── 5b) 面板「刷新」写的那份缓存只是副产品，钩子照样真读 ──────────────────
test("T39-5b) 面板「刷新」写额度缓存（副产品）→ auth.usage 仍然真读上游", async (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: LLM, token: TOKEN, phone: "13800000000", uid: "13800000000" })

  const server = createPageServer({
    configDir: dir,
    platformBaseUrl: "https://llm.rrzu.example",
    log: { warn() {} },
    now: () => 1_700_000_000_000,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/user/self")) {
        return Response.json({ success: true, data: { points_entitlement: { total_points: "1099.60" } } })
      }
      return Response.json({ success: true, data: {} })
    },
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  t.after(() => new Promise((done) => server.close(() => done())))
  const port = server.address().port

  const res = await fetch(`http://127.0.0.1:${port}/api/accounts/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 200)

  const file = cacheFilePath(dir, USAGE_CACHE_FILE)
  assert.ok(existsSync(file), "面板顺手写出额度快照（零额外请求）")

  const { fetchImpl, state } = countingFetch(async () =>
    Response.json({ data: { points_entitlement: { total_points: "7.00" } } }),
  )
  const usage = makeUsageHook({ configDir: dir, fetchImpl, log: { warn() {} } })
  const u = await usage(async () => ({ llmToken: LLM, token: TOKEN, accountId: "13800000000" }))
  const main = u.windows.find((w) => String(w.name) === "额度 · 平台积分")
  assert.equal(state.calls, 1, "钩子不读缓存，仍然真读上游")
  assert.equal(main.balance, 7, "用的是实时值")
})

// ── 6) 面板没有定时轮询；自动刷新默认关 ─────────────────────────────────
test("T39-6) 面板源码没有 setInterval 轮询；autoRefresh 默认关", async () => {
  const serverSrc = readFileSync(join(REPO, "server.mjs"), "utf8")
  assert.equal(/setInterval\s*\(/.test(serverSrc), false, "面板不许有 setInterval 轮询")

  const appSrc = readFileSync(join(REPO, "page", "assets", "app.js"), "utf8")
  assert.equal(/setInterval\s*\(/.test(appSrc), false, "页面 JS 不许有 setInterval 轮询")

  // 「打开页面自动刷新一次」= 一次，不是轮询
  const autoHits = appSrc.match(/settings\?\.settings\?\.autoRefresh === true/g) ?? []
  assert.equal(autoHits.length, 1, "autoRefresh 只允许在启动时触发一次")

  assert.equal(DEFAULT_SETTINGS.autoRefresh, false, "面板默认不自动刷新")
  const autorefresh = AUTH_OPTIONS.find((o) => o.key === "autorefresh")
  assert.ok(autorefresh, "auth.options 里应有 autorefresh")
  assert.equal(autorefresh.default, false, "magpie 界面开关默认必须是关")
})

// ── 7) 续期**保持原样**：剩余 < 1h 就续（用户驳回「只有过期才续」）──────────
test("T39-7) 续期闸门不变：剩余 <1h 会续（会发请求），>1h 不续", async (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: LLM, token: TOKEN, expire: 1 })
  const nowMs = 1_700_000_000_000
  // 30 分钟后过期 = 客户端口径的「临期」⇒ 要续
  const inHalfHour = Math.round((nowMs + 30 * 60 * 1000) / 1000)
  // 2 小时后过期 ⇒ 不续
  const inTwoHours = Math.round((nowMs + 2 * 60 * 60 * 1000) / 1000)

  const { fetchImpl, state } = countingFetch(async () => Response.json({ token: "NEW", expire: 1_800_000_000 }))
  const refresh = makeRefresher({ configDir: dir, log: { warn() {} }, now: () => nowMs, fetchImpl })

  const far = await refresh({ llmToken: LLM, token: TOKEN, expire: inTwoHours })
  assert.equal(far.refreshed, false)
  assert.equal(far.reason, "not-due")
  assert.equal(state.calls, 0, "剩余 >1h 不续（客户端口径）")

  const near = await refresh({ llmToken: LLM, token: TOKEN, expire: inHalfHour })
  assert.equal(near.refreshed, true, "临期（<1h）就续 —— 这是原来的行为，T-39 不动它")
  assert.equal(state.calls, 1)
})

// ── 8) 账号键里不许出现 token 原文（缓存文件是明文）─────────────────────
test("T39-8) 缓存键用 accountId/手机号，取不到才用散列 —— 绝不写 token 原文", () => {
  assert.equal(accountCacheKey({ accountId: "13800000000" }), "13800000000")
  assert.equal(accountCacheKey({ metadata: { phone: "13900000000" } }), "13900000000")
  const hashed = accountCacheKey({ llmToken: LLM })
  assert.equal(hashed.startsWith("llm:"), true)
  assert.equal(hashed.includes(LLM), false, "缓存键里不许出现 token 原文")

  // windowsFromSelf 仍然是额度渲染的唯一来源（钩子只搬运缓存，不改语义）
  const rendered = windowsFromSelf({ data: { points_entitlement: { total_points: "12.5" } } })
  assert.equal(rendered.windows[0].name, "额度 · 平台积分")
})

// ── 9) 面板「刷新模型目录」= 显式更新入口（1 次请求）────────────────────
test("T39-9) refreshCatalogCache 显式刷新 → 1 次请求并写缓存，之后钩子零上游", async (t) => {
  const dir = tempDir(t)
  const { fetchImpl, state } = countingFetch(async () => Response.json(LIVE))

  const r = await refreshCatalogCache({ configDir: dir, llmToken: LLM, fetchImpl, log: { warn() {} } })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.equal(state.calls, 1)

  const models = makeModelsHook({ configDir: dir, fetchImpl, log: { warn() {} } })
  const out = await models({}, { auth: { llmToken: LLM } })
  assert.equal(state.calls, 1, "钩子只管读文件")
  assert.deepEqual(Object.keys(out).sort(), ["deepseek-flash", "glm-5.2"])
})

// ── 10) rememberUsage 只是面板副产品：写进去以后钩子 **不读** 它 ─────────────
test("T39-10) rememberUsage 写额度快照（副产品）→ auth.usage 仍然真读上游", async (t) => {
  const dir = tempDir(t)
  const windows = windowsFromSelf({ data: { points_entitlement: { total_points: "20" } } }).windows
  assert.equal(rememberUsage({ configDir: dir, accountKey: "13900000000", windows }), true)

  const { fetchImpl, state } = countingFetch(async () =>
    Response.json({ data: { points_entitlement: { total_points: "99" } } }),
  )
  const usage = makeUsageHook({ configDir: dir, log: { warn() {} }, fetchImpl })
  const u = await usage(async () => ({ llmToken: LLM, token: TOKEN, accountId: "13900000000" }))
  assert.equal(state.calls, 1, "钩子不读缓存")
  const main = u.windows.find((w) => String(w.name) === "额度 · 平台积分")
  assert.equal(main.balance, 99, "用的是实时值，不是快照里的 20")
})
