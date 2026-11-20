// identity.test.mjs 登录落盘的身份字段：accountId 兜底链 / metadata 只放非空值 / expires 有才写。
//
// # 真机症状（这条测试的存在理由）
//
//	"quwork#pjcsg3": {"type":"oauth", "access":"sk-…",
//	                  "accountId":"", "metadata":{"uid":"","phone":"","token":""}}
//	→ 卡片显示 `Signed in (pjcsg3)`（随机键后缀）、额度「未知」
//
// 三处写错了：`accountId` 空、`metadata` 全是空串、`expires` 整个字段消失。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { QuWorkAuthPlugin } from "../index.mjs"
import { compact, accountIdOf } from "../src/identity.mjs"
import { readAll, upsertAccount } from "../src/auth-store.mjs"
import { makeUsageHook } from "../src/hooks/usage.mjs"

const LLM = "sk-2v6b3lUabcdefgh"
const PLATFORM = "platform-token"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-identity-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 走一次「手机号登录」拿到 magpie 的 success 对象。 */
async function loginSuccess({ phone, user = {}, expire = 1_800_000_000 } = {}) {
  const p = await QuWorkAuthPlugin(
    {},
    {
      log: { warn() {} },
      fetchImpl: async (url) => {
        if (String(url).includes("sendVerifyCode")) return Response.json({ success: true })
        return Response.json({ success: true, data: { token: PLATFORM, llm_token: LLM, expire, user } })
      },
    },
  )
  const sms = p.auth.methods.find((m) => String(m.label).includes("手机号"))
  await sms.authorize({ phone: phone ?? "13800000000" })
  return sms.callback("123456")
}

// ── compact / accountIdOf ──────────────────────────────────────────────

test("compact：删掉 undefined / null / 空串，保留其它值", () => {
  assert.deepEqual(compact({ a: 1, b: "", c: null, d: undefined, e: 0, f: false, g: "x" }), {
    a: 1,
    e: 0,
    f: false,
    g: "x",
  })
  assert.deepEqual(compact({}), {})
  assert.deepEqual(compact({ a: "", b: "" }), {})
})

test("accountIdOf 兜底链：phone → uid → llm_token:<前8位>，绝不为空", () => {
  assert.equal(accountIdOf({ phone: "13800000000", uid: "u-1", llmToken: LLM }), "13800000000")
  assert.equal(accountIdOf({ uid: "u-1", llmToken: LLM }), "u-1")
  assert.equal(accountIdOf({ llmToken: LLM }), `llm_token:${LLM.slice(0, 8)}`)
  assert.ok(accountIdOf({ llmToken: LLM }).length > 0)
  assert.ok(accountIdOf({}).length > 0, "全空也必须给一个非空兜底")
})

// ── successOf（登录结果）───────────────────────────────────────────────

test("1) phone 与 uid 都空 → accountId 落到 llm_token:<前8位>（非空）", async () => {
  const r = await loginSuccess({ phone: "13800000000", user: {} })
  // callback 的 accountId 用的是用户填的手机号，所以这里是手机号；再单独验无手机号路径
  assert.equal(r.accountId, "13800000000")

  const p = await QuWorkAuthPlugin(
    {},
    {
      log: { warn() {} },
      fetchImpl: async (url) =>
        String(url).includes("sendVerifyCode")
          ? Response.json({ success: true })
          : Response.json({ success: true, data: { token: PLATFORM, llm_token: LLM, expire: 0, user: {} } }),
    },
  )
  const paste = p.auth.methods.find((m) => String(m.label) === "粘贴 llm_token")
  const pasted = await paste.authorize({ llmToken: LLM })
  assert.equal(pasted.type, "success")
  assert.equal(pasted.accountId, `llm_token:${LLM.slice(0, 8)}`, "没有手机号/uid 时用 llm_token 前缀")
  assert.ok(String(pasted.accountId).length > 0)
})

test("2) 有 phone → accountId === phone，metadata.nickname === phone", async () => {
  const r = await loginSuccess({ phone: "13800000000", user: { id: "u-42" } })
  assert.equal(r.accountId, "13800000000")
  assert.equal(r.metadata.nickname, "13800000000")
  assert.equal(r.metadata.uid, "u-42")
  assert.equal(r.metadata.phone, "13800000000")
})

test("3) metadata 里不含任何空串键（compact 生效）", async () => {
  const p = await QuWorkAuthPlugin(
    {},
    {
      log: { warn() {} },
      fetchImpl: async () => Response.json({ success: true }),
    },
  )
  const paste = p.auth.methods.find((m) => String(m.label) === "粘贴 llm_token") // 不带平台 token
  const r = await paste.authorize({ llmToken: LLM })

  for (const [k, v] of Object.entries(r.metadata)) {
    assert.notEqual(v, "", `metadata.${k} 不许是空串`)
    assert.equal(v === undefined || v === null, false, `metadata.${k} 不许是 undefined/null`)
  }
  assert.equal("token" in r.metadata, false, "没有平台 token 时不该写 token 键")
})

test("4) expires 缺失时结果对象**没有** expires 键（不是 undefined）", async () => {
  const p = await QuWorkAuthPlugin(
    {},
    {
      log: { warn() {} },
      fetchImpl: async () => Response.json({ success: true }),
    },
  )
  const paste = p.auth.methods.find((m) => String(m.label) === "粘贴 llm_token")
  const r = await paste.authorize({ llmToken: LLM })

  assert.equal("expires" in r, false, `不该出现 expires 键: ${JSON.stringify(r)}`)
  assert.equal(r.access, LLM)
  assert.ok("refresh" in r, "refresh 恒存在（keptAs 需要）")
})

// ── upsertAccount ─────────────────────────────────────────────────────

test("5) upsertAccount：新值为空串、旧值非空 ⇒ 保留旧值", (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: LLM, token: PLATFORM, phone: "13800000000", uid: "u-1" })
  const before = readAll(dir)["quwork"]
  assert.equal(before.token, PLATFORM)

  upsertAccount(dir, { llmToken: LLM, token: "", phone: "", uid: "" })
  const after = readAll(dir)["quwork"]

  assert.equal(after.token, PLATFORM, "旧的非空 token 不许被空串覆盖")
  assert.equal(after.phone, "13800000000", "旧的 phone 不许被空串覆盖")
  assert.equal(after.uid, "u-1", "旧的 uid 不许被空串覆盖")
  for (const [k, v] of Object.entries(after)) {
    if (k === "type" || k === "access" || k === "llmToken") continue
    assert.notEqual(v, "", `字段 ${k} 不该是空串`)
  }
})

test("6) upsertAccount：accountId 为空 ⇒ 按兜底链补齐后再写", (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: LLM })
  const entry = readAll(dir)["quwork"]

  assert.ok(entry.accountId && String(entry.accountId).length > 0, "accountId 必须有值")
  assert.equal(entry.accountId, `llm_token:${LLM.slice(0, 8)}`)

  // 有手机号时优先用它
  upsertAccount(dir, { llmToken: LLM, phone: "13900000000" })
  assert.equal(readAll(dir)["quwork"].accountId, "13900000000")
})

// ── usage 卡片文案 ─────────────────────────────────────────────────────

test("7) usage：只有 llmToken ⇒ aside 窗 display 含 accountId", async () => {
  const usage = makeUsageHook({ log: { warn() {} }, fetchImpl: async () => {
    throw new Error("不该发请求")
  } })

  const u = await usage(async () => ({ llmToken: LLM, access: LLM, accountId: "13800000000" }))
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].aside, true)
  assert.match(String(u.windows[0].display), /13800000000/, `文案要带账号名: ${u.windows[0].display}`)

  // 没有 accountId 时也要能读通（用「该账号」兜底）
  const u2 = await usage(async () => ({ llmToken: LLM }))
  assert.match(String(u2.windows[0].display), /该账号/)
})