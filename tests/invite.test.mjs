// invite.test.mjs 邀请码 / 签到 / 兑换的平台封装（全部不带 X-QurWork-*）。

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  activateInvite,
  claimDailyReward,
  fetchDailyRewardStatus,
  fetchInviteRecords,
  fetchInviteSummary,
  redeemBenefit,
} from "../src/invite.mjs"
import { deviceIdentifierFrom } from "../src/login.mjs"
import { PLATFORM_BASE_URL } from "../src/constants.mjs"

const TOKEN = "platform-token-zzz"

/** 抓请求的假 fetch。 */
function capture(responder) {
  /** @type {Array<{url: string, init: any, headers: Headers, body: any}>} */
  const calls = []
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(url), init, headers, body: init?.body })
    return responder(calls.length)
  }
  return { calls, fetchImpl }
}

test("1) summary：解析 invite_code / invited_count / points / quota", async () => {
  const { calls, fetchImpl } = capture(() =>
    Response.json({ data: { invite_code: "573529", invited_count: 2, points: 300, quota: 50 }, success: true }),
  )
  const r = await fetchInviteSummary({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, fetchImpl })

  assert.equal(r.ok, true)
  assert.equal(r.inviteCode, "573529")
  assert.equal(r.invitedCount, 2)
  assert.equal(r.points, 300)
  assert.equal(r.quota, 50)
  assert.equal(calls[0].url, `${PLATFORM_BASE_URL}/api/user/invite/summary`)
  assert.match(String(calls[0].headers.get("authorization")), /^Bearer /)
})

test("2) activate 成功：POST body 带 invite_code + device_identifier + device_uuid", async () => {
  const { calls, fetchImpl } = capture(() => Response.json({ success: true, data: {}, message: "" }))
  const deviceIdentifier = deviceIdentifierFrom({ machineGuid: "GUID-A" })
  const r = await activateInvite({
    platformBaseUrl: PLATFORM_BASE_URL,
    token: TOKEN,
    inviteCode: "573529",
    deviceIdentifier,
    fetchImpl,
  })

  assert.equal(r.ok, true)
  const body = JSON.parse(String(calls[0].body))
  assert.equal(body.invite_code, "573529")
  assert.equal(body.device_identifier, deviceIdentifier)
  assert.equal(body.device_uuid, "")
  assert.equal(calls[0].url, `${PLATFORM_BASE_URL}/api/user/activate`)
})

test("3) activate 失败：服务端 message **原样**透传", async () => {
  const { fetchImpl } = capture(() =>
    Response.json({ message: "不能使用自己的邀请码", success: false }),
  )
  const r = await activateInvite({
    platformBaseUrl: PLATFORM_BASE_URL,
    token: TOKEN,
    inviteCode: "573529",
    deviceIdentifier: "d".repeat(64),
    fetchImpl,
  })

  assert.equal(r.ok, false)
  assert.equal(r.message, "不能使用自己的邀请码", "必须原样，不能改写成「绑定失败」")
})

test("4) records：分页参数进 query，返回 list/page/page_size/total", async () => {
  const { calls, fetchImpl } = capture(() =>
    Response.json({ success: true, data: { list: [{ id: 1 }], page: 2, page_size: 5, total: 11 } }),
  )
  const r = await fetchInviteRecords({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, page: 2, pageSize: 5, fetchImpl })

  assert.equal(r.ok, true)
  assert.equal(r.total, 11)
  assert.equal(r.list.length, 1)
  assert.match(calls[0].url, /\/api\/user\/invite\/records\?page=2&page_size=5$/)
})

test("5) device_identifier 仍是 64 hex（与登录同一口径）", () => {
  const a = deviceIdentifierFrom({ machineGuid: "GUID-A", smbiosUuid: "UUID-B" })
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(a, deviceIdentifierFrom({ machineGuid: "GUID-A", smbiosUuid: "UUID-B" }), "同输入必须同值")
})

// 平台接口**必须带**版本头，否则服务端误报 client_version_too_low（2026-11-20 真机实测）：
//
//	不带 X-QurWork-Version → {"data":{"client_version_too_low":true,"min_client_version":"1.6.5"},
//	                           "message":"客户端版本过低…"}      ← 假错误，掩盖真实原因
//	带 1.7.5               → {"data":{"error_code":"wechat_bind_required"},
//	                           "message":"请先绑定微信"}          ← 真实原因浮出来
//
// ❌ 例外：`sendVerifyCode` / `loginWithCode` **不能带**（会被阿里云滑块拦），
//    那两条的断言在 `tests/login-headers.test.mjs`，不要动。
test("6) 已登录后的平台接口**必须带** x-qurwork-version / x-qurwork-env（否则误报版本过低）", async () => {
  const { calls, fetchImpl } = capture(() => Response.json({ success: true, data: {} }))

  const mustHave = [
    () => fetchInviteSummary({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, fetchImpl }),
    () => activateInvite({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, inviteCode: "123", deviceIdentifier: "x", fetchImpl }),
    () => fetchInviteRecords({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, fetchImpl }),
    () => fetchDailyRewardStatus({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, fetchImpl }),
    () => claimDailyReward({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, fetchImpl }),
    () => redeemBenefit({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, orderId: 12345, fetchImpl }),
  ]
  for (const call of mustHave) await call()

  assert.equal(calls.length, mustHave.length, "六个接口都该发一次")
  for (const c of calls) {
    assert.equal(c.headers.get("x-qurwork-version"), "1.7.5", `必须带 version: ${c.url}`)
    assert.equal(c.headers.get("x-qurwork-env"), "prod", `必须带 env: ${c.url}`)
    assert.match(String(c.headers.get("authorization")), /^Bearer /, `必须带鉴权: ${c.url}`)
  }
})

test("7) 签到状态 / 兑换：order_id 必须是正整数（字符串会被本地挡掉）", async () => {
  const { calls, fetchImpl } = capture(() => Response.json({ success: true, data: { can_claim: true, claimed: false, consecutive_days: 3, next_refresh_at: 1795190400 } }))
  const s = await fetchDailyRewardStatus({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, fetchImpl })
  assert.equal(s.ok, true)
  assert.equal(s.canClaim, true)
  assert.equal(s.consecutiveDays, 3)

  const before = calls.length
  const bad = await redeemBenefit({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, orderId: "abc", fetchImpl })
  assert.equal(bad.ok, false)
  assert.match(String(bad.message), /订单号/)
  assert.equal(calls.length, before, "非法订单号不该发请求")

  const ok = await redeemBenefit({ platformBaseUrl: PLATFORM_BASE_URL, token: TOKEN, orderId: 12345, fetchImpl })
  assert.equal(ok.ok, true)
  assert.deepEqual(JSON.parse(String(calls.at(-1).body)), { order_id: 12345 }, "必须是 int64 数字")
})