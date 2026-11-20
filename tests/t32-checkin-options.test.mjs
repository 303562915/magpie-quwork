// t32-checkin-options.test.mjs —— T-32：`auth.checkin` 形状修正 + `auth.options` 界面开关
//
// # 为什么需要这一整个文件
//
// 真机现象（2026-11-20，`~/.config/magpie/plugin-checkin.json` 的 quwork 条目）：
//
//	"quwork|quwork":   {"outcome":"failed","msg":"the plugin answered no outcome: 今天已经签过了（连续 1 天）"}
//	"quwork|quwork#1": {"outcome":"failed","msg":"the plugin answered no outcome: 该账号签到需要先绑定微信"}
//
// 两行都不是「上游坏了」，是**插件答错了形状**。宿主 `checkinOf()`（host-*.js 约
// 3393-3411）只认 `{outcome, credit?, streak?, message?, until?}`，`outcome` 必须是
// `claimed|done|ineligible|inactive|captcha|failed` 之一；看不到 `outcome` 就自己拼
// 「the plugin answered …」并判成 `failed`。卡片于是显示 "quwork's plugin doesn't check in"
// 之类的失败态，用户点不了「立即签到」。
//
// 这个文件把「形状」钉成断言，并顺带把 `auth.options` 的**严格 schema** 钉住
// （真源 `optionsOf()`：key `^[a-z0-9_-]{1,40}$`、label 必填、default 只认 `=== true`）。
//
// ⚠ 全部离线：所有上游都经 `fetchImpl` 注入，零真实网络。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { QuWorkAuthPlugin, QuWorkPage, AUTH_OPTIONS, makeCheckinHook } from "../index.mjs"
import { effectiveSettings, DEFAULT_SETTINGS } from "../server.mjs"

/** 宿主认的 outcome 全集（`host.js` 的 `checkinOutcomes`）。 */
const OUTCOMES = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]

const PLATFORM = "https://llm.rrzu.example"
const TOKEN = "platform-token-zzz"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-t32-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 造一个假上游：只认 `/api/user/daily-reward/status` 与 `/claim`。
 *
 * @param {{status?: any, claim?: any, statusResp?: Response, claimResp?: Response}} plan
 */
function upstream(plan) {
  /** @type {string[]} */
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(String(url)).pathname
    calls.push(`${init.method ?? "GET"} ${p}`)
    if (p.endsWith("/api/user/daily-reward/status")) {
      return plan.statusResp ?? Response.json({ success: true, data: plan.status ?? {} })
    }
    if (p.endsWith("/api/user/daily-reward/claim")) {
      return plan.claimResp ?? Response.json({ success: true, data: plan.claim ?? {} })
    }
    return Response.json({ success: true, data: {} })
  }
  return { calls, fetchImpl }
}

/** 用给定的凭据跑一次 checkin。 */
async function runCheckin(plan, auth = { token: TOKEN }) {
  const hook = makeCheckinHook({ platformBaseUrl: PLATFORM, fetchImpl: upstream(plan).fetchImpl, log: { warn() {} } })
  return hook(async () => auth)
}

// ═══ ① 形状契约：每个返回都必须带合法 outcome，且不夹带旧字段 ═══════

for (const [name, plan] of [
  ["今天已签", { status: { claimed: true, consecutive_days: 1, next_refresh_at: 1795190400 } }],
  ["需绑微信", { status: { claimed: false, wechat_required: true, next_refresh_at: 1795190400 } }],
  ["可签（成功）", { status: { claimed: false, can_claim: true }, claim: { granted: 50, points: 150, consecutive_days: 2 } }],
  ["上游拒绝", { status: {}, claimResp: Response.json({ success: false, message: "服务器开小差" }) }],
]) {
  test(`T32-1) ${name} → outcome 合法、无 ok 字段、有一句可读 message`, async () => {
    const r = await runCheckin(plan)
    assert.ok(OUTCOMES.includes(r.outcome), `outcome 不合法: ${JSON.stringify(r.outcome)}`)
    assert.equal("ok" in r, false, "旧形状的 ok 字段必须彻底消失（宿主不认它）")
    assert.equal(typeof r.message, "string")
    assert.ok(r.message.length > 0, "message 必须能读")
  })
}

// ═══ ② 三条真机路径的具体语义 ═══════════════════════════════════════

test("T32-2) 已签到 → done（成功态）+ streak + until，且**不**打 claim", async () => {
  const up = upstream({ status: { claimed: true, consecutive_days: 3, next_refresh_at: 1795190400 } })
  const hook = makeCheckinHook({ platformBaseUrl: PLATFORM, fetchImpl: up.fetchImpl, log: { warn() {} } })
  const r = await hook(async () => ({ token: TOKEN }))

  assert.equal(r.outcome, "done", "已签到必须是 done —— 报 failed 就是真机那条红色失败")
  assert.equal(r.streak, 3)
  // next_refresh_at=1795190400 是**秒** → 归一成毫秒（host.js 认毫秒，也认 RFC3339）
  assert.equal(r.until, 1795190400 * 1000, "秒必须 ×1000；给秒会让宿主把「今天」判成 1970 年")
  assert.equal(
    up.calls.some((c) => c.includes("/claim")),
    false,
    "已签到不该再打 claim（幂等请求能省就省）",
  )
})

test("T32-3) 可签到 → 真打 claim → claimed + credit（获得的积分）", async () => {
  const up = upstream({ status: { claimed: false, can_claim: true }, claim: { granted: 50, points: 150, consecutive_days: 2 } })
  const hook = makeCheckinHook({ platformBaseUrl: PLATFORM, fetchImpl: up.fetchImpl, log: { warn() {} } })
  const r = await hook(async () => ({ token: TOKEN }))

  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 50, "credit = 这次拿到的积分")
  assert.equal(r.streak, 2)
  assert.deepEqual(up.calls, ["GET /api/user/daily-reward/status", "POST /api/user/daily-reward/claim"])
  assert.match(r.message, /\+50/)
})

test("T32-4) 需绑微信 → ineligible（不是 failed），message 含 wechat_bind_required 语义", async () => {
  const up = upstream({ status: { claimed: false, wechat_required: true } })
  const hook = makeCheckinHook({ platformBaseUrl: PLATFORM, fetchImpl: up.fetchImpl, log: { warn() {} } })
  const r = await hook(async () => ({ token: TOKEN }))

  assert.equal(r.outcome, "ineligible", "没资格 ≠ 失败；报 failed 会让用户以为重试就能签")
  assert.match(r.message, /微信/)
  assert.match(r.message, /wechat_bind_required/)
  assert.equal(up.calls.some((c) => c.includes("/claim")), false, "没资格就不该打 claim")
})

test("T32-5) claim 回 success:false 但文案是「今天已领取」→ done（不报红）", async () => {
  const plan = {
    status: {},
    claimResp: Response.json({ success: false, message: "今日已领取，请勿重复签到" }),
  }
  const r = await runCheckin(plan)
  assert.equal(r.outcome, "done")
  assert.match(r.message, /今天已经签过了/)
})

test("T32-6) claim 回 success:false 且文案夹带微信 → ineligible", async () => {
  const plan = {
    status: {},
    claimResp: Response.json({ success: false, message: '{"error_code":"wechat_bind_required"} 请先绑定微信' }),
  }
  const r = await runCheckin(plan)
  assert.equal(r.outcome, "ineligible")
  assert.match(r.message, /微信/)
})

test("T32-7) 没有平台 token → ineligible（说明了「只配了模型 token」）", async () => {
  const r = await runCheckin({ status: {} }, { access: "sk-only-llm" })
  assert.equal(r.outcome, "ineligible")
  assert.match(r.message, /平台 token/)
})

test("T32-8) 网络异常 → failed + message（不往外抛）", async () => {
  const hook = makeCheckinHook({
    platformBaseUrl: PLATFORM,
    fetchImpl: async () => {
      throw new Error("socket hang up")
    },
    log: { warn() {} },
  })
  const r = await hook(async () => ({ token: TOKEN }))
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /socket hang up/)
})

// ═══ ③ 装配：auth.checkin / auth.options 都挂在 auth 上，且插件真的在用它 ═══

test("T32-9) 装配：auth.checkin 是函数，auth.options 是合法开关表", async () => {
  const p = await QuWorkAuthPlugin({}, { log: { warn() {} } })
  assert.equal(typeof p.auth.checkin, "function")
  assert.ok(Array.isArray(p.auth.options), "auth.options 必须是数组（optionsOf 只认数组）")

  const KEY = /^[a-z0-9_-]{1,40}$/
  assert.ok(p.auth.options.length <= 16, "宿主最多认 16 个开关")
  const keys = p.auth.options.map((o) => o.key)
  assert.deepEqual(keys, ["autorefresh", "pollfaster"])
  for (const o of p.auth.options) {
    assert.match(o.key, KEY, `key 不合规: ${o.key}`)
    assert.equal(typeof o.label, "string", `label 必填（缺 label 整项静默消失）: ${o.key}`)
    assert.ok(o.label.trim().length > 0 && o.label.length <= 60, `label 长度 1~60: ${o.key}`)
    assert.equal(typeof o.default, "boolean", `default 只认布尔: ${o.key}`)
    assert.ok(o.label !== o.key, "开关上不能只显示 key —— 那样用户看不懂")
  }
  // 老 magpie 只读 label，新 magpie 读 labels/descriptions；两套都要有
  assert.equal(AUTH_OPTIONS[0].labels.zh, AUTH_OPTIONS[0].label)
})

test("T32-10) 界面开关真的被插件读（input.magpie.option），且 key 全小写", async () => {
  /** @type {string[]} */
  const asked = []
  const input = {
    magpie: {
      option(provider, key) {
        asked.push(`${provider}:${key}`)
        return key === "autorefresh" ? true : false
      },
    },
  }
  const p = await QuWorkAuthPlugin(input, { log: { warn() {} }, skipNetwork: true })
  assert.deepEqual(asked, ["quwork:autorefresh", "quwork:pollfaster"])
  assert.equal(typeof p.auth.checkin, "function")

  // 没有 magpie 通道（OpenCode / 测试）时不能炸
  const bare = await QuWorkAuthPlugin({}, { log: { warn() {} } })
  assert.equal(typeof bare.auth.checkin, "function")
})

test("T32-11) 面板设置：autoRefresh 开关作为默认，面板文件里的值覆盖它", (t) => {
  const dir = tempDir(t)

  // ① 没有面板文件：开关说了算
  assert.equal(effectiveSettings(dir, { autoRefresh: true }).autoRefresh, true)
  assert.equal(effectiveSettings(dir, { autoRefresh: undefined }).autoRefresh, DEFAULT_SETTINGS.autoRefresh)

  // ② 面板文件里用户明确勾过 → 压过"只是默认"的开关值
  writeFileSync(join(dir, "quwork-panel-settings.json"), JSON.stringify({ autoRefresh: false, port: 4399 }))
  const s = effectiveSettings(dir, { autoRefresh: true })
  assert.equal(s.autoRefresh, false, "面板里明确勾过的值必须覆盖插件开关（开关只是默认）")
  assert.equal(s.port, 4399)
  assert.equal(s.accountsConcurrency, DEFAULT_SETTINGS.accountsConcurrency, "未设置项回落到默认")

  // ③ 用户**刚在 magpie 里拨的**（fromOption）→ 立刻生效，压过面板旧记录
  assert.equal(effectiveSettings(dir, { autoRefresh: true, fromOption: true }).autoRefresh, true)
})

test("T32-12) QuWorkPage 把开关带进服务；/api/settings 能读出来", async (t) => {
  const dir = tempDir(t)
  const page = await QuWorkPage(
    { magpie: { option: (_p, k) => (k === "autorefresh" ? true : false) } },
    { configDir: dir, port: 0, fetchImpl: async () => Response.json({}) },
  )
  assert.equal(page.ok, true)
  t.after(() => page.close())

  const body = await (await fetch(`http://127.0.0.1:${page.port}/api/settings`)).json()
  assert.equal(body.ok, true)
  assert.equal(body.settings.autoRefresh, true, "开关必须落到 /api/settings（面板据此决定打开时要不要自动刷）")
  assert.equal(readFileSync(join(dir, "quwork-panel-settings.json"), "utf8").includes(String(page.port)), true)
})