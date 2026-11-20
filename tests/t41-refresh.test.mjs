// t41-refresh.test.mjs（T-41 / T-42）续期判据 = **总有效期的 50%**。
//
// # 用户口径
//
//	「把我们现在所有的插件的续期修改成：还有一半的时间就过期了，那就续期。
//	  我们按百分比来算……按百分比 50% 时间来计算」
//
// 于是：`剩余 <= 总长的一半` 才续，否则**一个请求都不发**。
//
// 判据靠签发时间（JWT 的 `iat`/`exp`）；拿不到 iat 才回落到固定窗口兜底。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pastHalfLife, readJwtClaims, msUntilHalfLife } from "../src/token-life.mjs"
import { needsRefresh, makeRefresher } from "../src/refresh.mjs"
import { upsertAccount } from "../src/auth-store.mjs"
import { PLATFORM_BASE_URL } from "../src/constants.mjs"

const LLM = "llm-token-t41"
const TOKEN = "platform-token-zzz999"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-t41-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 造一个 JWT 形状的 token（不签名，只用 iat/exp）。 */
function jwt(iat, exp) {
  const h = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const p = Buffer.from(JSON.stringify({ iat, exp, sub: "t41" })).toString("base64url")
  return `${h}.${p}.sig`
}

// ── 1) 半程前：false ────────────────────────────────────────────────────
test("T41-1) 剩 3601 秒 > 一半（3600）→ 不该续", () => {
  const iat = 1_700_000_000
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 3599), false)
})

// ── 2) 到半程：true ─────────────────────────────────────────────────────
test("T41-2) 剩 3599 秒 <= 一半 → 该续", () => {
  const iat = 1_700_000_000
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 3601), true)
})

// ── 3) 已过期 → true ────────────────────────────────────────────────────
test("T41-3) 已过期 → 该续", () => {
  const iat = 1_700_000_000
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 7201), true)
  assert.equal(pastHalfLife(iat, iat + 7200, iat + 999_999), true)
})

// ── 4) 数据坏（total <= 0）→ needsRefresh 退回固定窗口兜底 ────────────────
test("T41-4) iat 不可信（total<=0）→ 回退固定窗口，不会每轮都续", () => {
  const nowMs = 1_700_000_000_000
  const farSec = Math.round((nowMs + 48 * 3600_000) / 1000)
  // iat 晚于 exp（坏数据）：不该被当成"该续"
  assert.equal(needsRefresh(farSec, { nowMs, iatSec: farSec + 100 }), false, "坏 iat ⇒ 走固定窗口，还剩 48h 不续")
  // 快到期：固定窗口内才续
  const nearSec = Math.round((nowMs + 30 * 60_000) / 1000)
  assert.equal(needsRefresh(nearSec, { nowMs, iatSec: farSec + 100 }), true)
})

// ── 5) JWT 解出来的 iat/exp 直接可用 ─────────────────────────────────────
test("T41-5) readJwtClaims 解出 iat/exp；半程判据 + msUntilHalfLife 都对", () => {
  const iat = 1_795_110_136
  const exp = 1_797_702_136 // 720 小时
  const claims = readJwtClaims(jwt(iat, exp))
  assert.deepEqual(claims, { iat, exp })

  // 真机口径：还没到一半 ⇒ 还需正数天
  const now = Math.floor(Date.now() / 1000)
  const left = msUntilHalfLife(claims.iat, claims.exp, now)
  assert.ok(left > 0, `还需 ${left} ms 到半程（应为正数天）`)
  assert.equal(pastHalfLife(claims.iat, claims.exp, now), false)

  // 不是 JWT / 缺字段 → null（走兜底）
  assert.equal(readJwtClaims("plain-opaque-token"), null)
  assert.equal(readJwtClaims(""), null)
})

// ── 6) 端到端：半程前零请求，过半才发 1 次 ───────────────────────────────
test("T41-6) 续期器：半程前零上游，过半才发 1 次", async (t) => {
  const dir = tempDir(t)
  const iat = 1_795_110_136
  const exp = 1_797_702_136
  upsertAccount(dir, { llmToken: jwt(iat, exp), token: TOKEN, expire: 1 })

  let calls = 0
  const nowSec = Math.floor(Date.now() / 1000)
  const refresh = makeRefresher({
    configDir: dir,
    log: { warn() {} },
    now: () => nowSec * 1000,
    fetchImpl: async (url, init) => {
      calls += 1
      assert.equal(String(url), `${PLATFORM_BASE_URL}/api/user/refresh`)
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`)
      return Response.json({ token: "platform-token-NEW", expire: exp })
    },
  })

  // ① 半程前：零请求
  const early = await refresh({ llmToken: jwt(iat, exp), token: TOKEN, expire: exp })
  assert.equal(early.refreshed, false)
  assert.equal(calls, 0, "没过半 ⇒ 一个请求都不发")

  // ② 已过半：真续一次（把"现在"推到半程之后 60 秒）
  const halfMs = (Math.floor(iat + (exp - iat) * 0.5) + 60) * 1000
  const lateNow = makeRefresher({
    configDir: dir,
    log: { warn() {} },
    now: () => halfMs,
    fetchImpl: async () => {
      calls += 1
      return Response.json({ token: "platform-token-NEW", expire: exp })
    },
  })
  const late = await lateNow({ llmToken: jwt(iat, exp), token: TOKEN, expire: exp })
  assert.equal(late.refreshed, true)
  assert.equal(calls, 1, "过半才续，且只 1 次")
})
