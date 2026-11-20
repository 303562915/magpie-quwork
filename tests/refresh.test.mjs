// refresh.test.mjs 平台 token 续期：2h 兜底 / 剩余 <1h 触发 / 60s 节流 / 只覆盖 token+expire。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expiresAtOf, needsRefresh, makeRefresher } from "../src/refresh.mjs"
import { readAll, upsertAccount } from "../src/auth-store.mjs"
import { PLATFORM_BASE_URL, TOKEN_TTL_MS, REFRESH_WINDOW_MS } from "../src/constants.mjs"

const LLM = "llm-token-abc123"
const TOKEN = "platform-token-zzz999"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-refresh-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("expire 缺失按 2 小时算（客户端口径）", () => {
  const issuedAt = 1_700_000_000_000
  assert.equal(expiresAtOf({ issuedAt }), Math.round((issuedAt + TOKEN_TTL_MS) / 1000))
  assert.equal(expiresAtOf({ expire: 1_800_000_000, issuedAt }), 1_800_000_000, "有 expire 就用它")
})

test("剩余 <1h 触发、>1h 不触发", () => {
  const now = 1_700_000_000_000
  const inHalfHour = Math.round((now + 30 * 60 * 1000) / 1000)
  const inTwoHours = Math.round((now + 2 * 60 * 60 * 1000) / 1000)

  assert.equal(needsRefresh(inHalfHour, { nowMs: now }), true)
  assert.equal(needsRefresh(inTwoHours, { nowMs: now }), false)
  assert.equal(needsRefresh(inHalfHour, { nowMs: now, windowMs: REFRESH_WINDOW_MS }), true)
})

test("到点才续；成功后续期结果写回 auth（token/expire 覆盖，llmToken 不动）", async (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: LLM, token: TOKEN, expire: 1 })
  const before = readAll(dir)["quwork"]
  assert.equal(before.llmToken, LLM)

  /** @type {string[]} */
  const urls = []
  const refresh = makeRefresher({
    configDir: dir,
    log: { warn() {} },
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, init) => {
      urls.push(String(url))
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`)
      return Response.json({ token: "platform-token-NEW", expire: 1_800_000_000 })
    },
  })

  const r = await refresh({ llmToken: LLM, token: TOKEN, expire: 1 })
  assert.equal(r.refreshed, true)
  assert.equal(urls[0], `${PLATFORM_BASE_URL}/api/user/refresh`)

  const after = readAll(dir)["quwork"]
  assert.equal(after.token, "platform-token-NEW")
  assert.equal(after.expire, 1_800_000_000)
  assert.equal(after.llmToken, LLM, "模型 token 绝不许被续期改写")
  assert.equal(after.access, LLM, "access 是 llmToken 的镜像，也不许变")
})

test("60 秒内只触发一次（同一账号）", async (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: LLM, token: TOKEN, expire: 1 })

  let calls = 0
  let clock = 1_700_000_000_000
  const refresh = makeRefresher({
    configDir: dir,
    log: { warn() {} },
    now: () => clock,
    fetchImpl: async () => {
      calls += 1
      return Response.json({ token: `t-${calls}`, expire: 1_800_000_000 })
    },
  })

  await refresh({ llmToken: LLM, token: TOKEN, expire: 1 })
  clock += 5_000
  const second = await refresh({ llmToken: LLM, token: TOKEN, expire: 1 })
  assert.equal(calls, 1, "5 秒内不该再续")
  assert.equal(second.reason, "throttled")

  clock += 61_000
  await refresh({ llmToken: LLM, token: TOKEN, expire: 1 })
  assert.equal(calls, 2, "过了 60 秒可以再续")
})

test("不需要续期时**不发请求**", async () => {
  let calls = 0
  const refresh = makeRefresher({
    log: { warn() {} },
    now: () => 1_700_000_000_000,
    fetchImpl: async () => {
      calls += 1
      return Response.json({})
    },
  })
  const future = Math.round((1_700_000_000_000 + 2 * 60 * 60 * 1000) / 1000)
  const r = await refresh({ llmToken: LLM, token: TOKEN, expire: future })
  assert.equal(r.refreshed, false)
  assert.equal(calls, 0)
})

test("续期失败（500 / 网络）不抛、不写盘", async (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: LLM, token: TOKEN, expire: 1 })
  const before = readAll(dir)["quwork"].token

  const bad = makeRefresher({
    configDir: dir,
    log: { warn() {} },
    now: () => 1_700_000_000_000,
    fetchImpl: async () => new Response("no", { status: 500 }),
  })
  const r = await bad({ llmToken: LLM, token: TOKEN, expire: 1 })
  assert.equal(r.refreshed, false)
  assert.equal(readAll(dir)["quwork"].token, before, "失败不许改动存盘")

  const thrown = makeRefresher({
    configDir: dir,
    log: { warn() {} },
    now: () => 1_700_000_000_000,
    fetchImpl: async () => {
      throw new Error("ECONNRESET")
    },
  })
  assert.equal((await thrown({ llmToken: LLM, token: TOKEN, expire: 1 })).refreshed, false)
})

test("没有平台 token → 直接跳过（不报错）", async () => {
  const refresh = makeRefresher({ log: { warn() {} }, fetchImpl: async () => new Response("{}") })
  const r = await refresh({ llmToken: LLM })
  assert.equal(r.refreshed, false)
  assert.equal(r.reason, "no-platform-token")
})
