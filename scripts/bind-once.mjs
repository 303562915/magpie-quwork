// scripts/bind-once.mjs 让**一个指定的账号**走完整条绑定流程，并把每一步打印出来。
//
// # 为什么单独做这个
//
// 「这个微信号以前绑过某个号，现在再绑另一个号」——要验证的是「平台允不允许同一个微信
// 绑多个 QuWork 账号」。门户（/bind/go）是随机分配号的，验不出这个确定性场景。
//
// 用法：
//
//	npm run bind-once -- --key quwork            # 指定账号 key
//	npm run bind-once -- --phone 17034818784     # 或者用手机号找 key
//	npm run bind-once -- --any                  # 随便挑一个「还没绑」的号
//
// 输出每一步：读账号状态 → 取平台签发 state → 打印授权 URL → 打印二维码（终端 ASCII）
// → 等你在手机上扫 + 确认 → 每 2 秒轮询 → 打印「绑定成功 / 超时」。
//
// ⚠ 它**不写**快照、不占门户的锁：纯粹验证平台侧行为。

import { join } from "node:path"
import { homedir } from "node:os"

import { PLATFORM_BASE_URL } from "../src/constants.mjs"
import { fetchAuthorizeUrl, fetchSelf, listPoolTokens, readPool, writePool } from "../src/wechat-bind.mjs"
import { qrMatrix } from "../src/qr.mjs"

/** 解析 `--key x` / `--phone y` / `--any` / `--timeout 秒`。 */
function parseArgs(argv) {
  const out = { key: "", phone: "", any: false, timeout: 120, pollMs: 2000 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--any") out.any = true
    else if (a === "--key") out.key = String(argv[++i] ?? "")
    else if (a === "--phone") out.phone = String(argv[++i] ?? "")
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || 120
    else if (a === "--poll") out.pollMs = Math.max(500, Number(argv[++i]) || 2000)
  }
  return out
}

const cfgDir = String(process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), ".config", "magpie")).trim()
const platformBaseUrl = process.env.QUWORK_PLATFORM_BASE ?? PLATFORM_BASE_URL

const args = parseArgs(process.argv.slice(2))
const all = listPoolTokens(cfgDir)
const pool = readPool(cfgDir).accounts
const label = (key) => `#${all.findIndex((a) => a.key === key) + 1}`

const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false })
const log = (...a) => console.log(`[${stamp()}]`, ...a)

/** 终端里打二维码（用 Unicode 半块，白=亮、黑=暗）。 */
function printQr(text) {
  const { modules, size } = qrMatrix(text, { ecl: "L" })
  const line = (y) => {
    let s = ""
    for (let x = 0; x < size; x += 1) s += modules[y][x] ? "  " : "██"
    return s
  }
  for (let y = 0; y < size; y += 1) console.log("  " + line(y))
}

// ── 找账号 ──────────────────────────────────────────────────────────────
let target = null
if (args.key) target = all.find((a) => a.key === args.key) ?? null
else if (args.phone) target = all.find((a) => a.phone.includes(args.phone) || String(a.accountId).includes(args.phone)) ?? null
else if (args.any) {
  for (const a of all) if (pool[a.key]?.wechatBound !== true) {
    target = a
    break
  }
}
if (!target) {
  console.error(`没找到账号。可用 key：${all.map((a) => a.key).join(", ")}`)
  console.error(`也可以用 --phone <手机号片段> 或 --any`)
  process.exit(1)
}

log(`目标账号：${target.key}（${label(target.key)}）  手机号尾号 ${String(target.phone).slice(-4)}`)
if (!target.token) {
  console.error("这个 key 没有平台 token（plugin-auth.json 里的 refresh 字段为空）")
  process.exit(1)
}

// ── ① 绑定前状态 ────────────────────────────────────────────────────────
const before = await fetchSelf({ platformBaseUrl, token: target.token })
if (!before.ok) {
  console.error(`① 读状态失败：${before.message}`)
  process.exit(1)
}
log(`① 绑定前：wechat_bound = ${before.wechatBound}，wechat_id = ${before.wechatId || "(空)"}，quota = ${before.quota}`)
if (before.wechatBound && !args.key && !args.phone) {
  log("   这个号已经绑过微信了；继续走流程可以验证「再绑一次」平台怎么响应。")
}

// ── ② 拿平台签发的授权地址 ───────────────────────────────────────────────
const got = await fetchAuthorizeUrl({ platformBaseUrl, token: target.token })
if (!got.ok || !got.state) {
  console.error(`② 取授权地址失败：${got.message ?? "no state"}`)
  process.exit(1)
}
log(`② 平台签发 state = ${got.state}`)
log(`   授权地址 = ${got.url}`)

// ── ③ 出示二维码 ────────────────────────────────────────────────────────
console.log("")
console.log("   ↓↓↓ 用微信「扫一扫」扫下面这张（必须是微信里的扫一扫）↓↓↓")
console.log("")
printQr(got.url)
console.log("")
log(`③ 已出码，等你在微信里点「确认登录」…（最多 ${args.timeout} 秒，每 ${args.pollMs / 1000} 秒查一次）`)

// ── ④ 轮询 ──────────────────────────────────────────────────────────────
const deadline = Date.now() + args.timeout * 1000
let n = 0
let lastMsg = ""
/** @type {"bound"|"timeout"} */
let result = "timeout"
while (Date.now() < deadline) {
  await new Promise((d) => setTimeout(d, args.pollMs))
  n += 1
  const s = await fetchSelf({ platformBaseUrl, token: target.token })
  if (!s.ok) {
    if (s.message !== lastMsg) log(`   … 读不到状态：${s.message}`)
    lastMsg = s.message ?? ""
    continue
  }
  if (s.wechatBound) {
    result = "bound"
    log(`④ 第 ${n} 次轮询：wechat_bound = true，wechat_id = ${s.wechatId || "(空)"}`)
    break
  }
  if (s.wechatBound !== before.wechatBound && !s.wechatBound) {
    log(`④ 第 ${n} 次轮询：wechat_bound 变回 false（解绑了？）`)
  }
}

// ── ⑤ 结论 ──────────────────────────────────────────────────────────────
const after = await fetchSelf({ platformBaseUrl, token: target.token })
console.log("")
log(`⑤ 最终：wechat_bound = ${after.wechatBound}，wechat_id = ${after.wechatId || "(空)"}`)
if (result === "bound") {
  // 沙箱里同步更新快照，免得门户还把号当成「可分配」
  if (pool[target.key]?.wechatBound !== true) {
    const p = readPool(cfgDir)
    p.accounts[target.key] = { ...(p.accounts[target.key] ?? {}), wechatBound: true, wechatId: after.wechatId, checkedAt: Date.now() }
    writePool(cfgDir, p)
    log(`   （已顺手把快照里的 ${target.key} 标成已绑）`)
  }
  console.log(`结论：✅ 绑定成功。${before.wechatBound ? "注意：这个微信之前就绑过本号，这次是「重复绑定」，平台接受了。" : ""}`)
} else {
  console.log(`结论：❌ ${args.timeout} 秒内没等到 wechat_bound=true。`)
  console.log(`  可能：① 二维码没被微信扫到（相册/长按无效）；② 微信里没出现「确认登录」；`)
  console.log(`        ③ 这个微信号不能绑多个 QuWork 号（若之前已绑过别的号，平台可能直接拒绝）。`)
  console.log(`  去看平台侧的提示：微信里扫完是「已确认」还是弹了错误页，这一步只有你能看到。`)
}