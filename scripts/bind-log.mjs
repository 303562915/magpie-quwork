// scripts/bind-log.mjs 看「有没有人扫码 / 有人绑定了吗」：把门户访问日志汇总成结论。
//
// # 用法
//
//	npm run bind-log                                  # 默认读 ./bind-access.log
//	npm run bind-log -- G:\trae\R1\fandai\out\访问日志.txt
//
// # 日志里有两种行
//
//	<时间> <IP> <方法> <路径> <状态> <耗时> <类型> "<UA>"     每次请求一行
//	<时间> BOUND label=#4 ip=…                              绑定成功的时刻（单独一行，最好找）
//
// 「类型」由 UA 判出来：微信（MicroMessenger）/ 脚本（curl、PowerShell…）/ 其它浏览器。
// **关键判定**：真正的「扫码」一定带着 MicroMessenger —— 没有这个 UA 说明对方是
// 用普通浏览器打开的链接（复制粘贴、别人转发），走的不是微信扫码那条路。

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const file = resolve(process.argv[2] ?? process.env.BIND_LOG ?? "bind-access.log")
if (!existsSync(file)) {
  console.error(`读不到日志：${file}`)
  console.error("（门户进程默认写 ./bind-access.log；也可以设 BIND_LOG 指到别处）")
  process.exit(1)
}

const raw = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean)
const rows = []
const bounds = []
for (const line of raw) {
  if (/\sBOUND\s/.test(line)) {
    const m = /^(\S+)\s+BOUND\s+label=(\S+)\s+ip=(\S+)/.exec(line)
    bounds.push({ at: m?.[1] ?? "?", label: m?.[2] ?? "?", ip: m?.[3] ?? "?" })
    continue
  }
  const m =
    /^(\S+) (\S+) (\S+) (\S+) (\d{3}) (\d+)ms (\S+) "(.*)"$/.exec(line) ??
    /^(\S+) (\S+) (\S+) (\S+) (\d{3}) (\d+)ms (\S+)$/.exec(line)
  if (!m) continue
  rows.push({ at: m[1], ip: m[2], method: m[3], path: m[4], status: Number(m[5]), ms: Number(m[6]), kind: m[7], ua: m[8] ?? "" })
}

if (rows.length === 0 && bounds.length === 0) {
  console.log(`日志里没有可解析的行：${file}`)
  process.exit(0)
}

const count = (fn) => rows.filter(fn).length
const byKind = rows.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {})
const goHits = rows.filter((r) => /\/go(\/)?$/.test(r.path))
const wechatGo = goHits.filter((r) => r.kind === "微信")
const checks = count((r) => r.path.includes("/api/check"))
const qr = count((r) => r.path.includes("qr.png"))

const first = rows[0]?.at ?? bounds[0]?.at
const last = rows[rows.length - 1]?.at ?? bounds[bounds.length - 1]?.at

console.log(`日志：${file}`)
console.log(`时间范围：${first} → ${last}（共 ${rows.length} 次请求）`)
console.log(`类型分布：${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(" · ") || "（无）"}`)
console.log("")

// ── 结论一：有没有人绑成功 ──
if (bounds.length > 0) {
  console.log(`**绑定成功 ${bounds.length} 次**：`)
  for (const b of bounds) console.log(`  ${b.at}  ${b.label}  ip=${b.ip}`)
} else {
  console.log("**没有任何绑定成功**（日志里没有 BOUND 行）。")
}
console.log("")

// ── 结论二：有没有人真的「扫码」──
console.log(`出码页（/bind/go）：${goHits.length} 次，其中微信扫码 ${wechatGo.length} 次`)
console.log(`固定码图片：${qr} 次 · 状态轮询（/api/check）：${checks} 次`)
if (wechatGo.length === 0) {
  console.log("")
  console.log("**没人用微信扫过码**：所有出码请求的 UA 都不带 MicroMessenger，")
  console.log("对方是用普通浏览器/脚本打开的链接 —— 微信扫码那条路还没被真正走过。")
} else {
  console.log("")
  console.log("微信扫码明细（最近 10 次）：")
  for (const r of wechatGo.slice(-10)) console.log(`  ${r.at}  ${r.ip}  ${r.status}  ${r.ms}ms`)
}
console.log("")

// ── 按访客分：谁来过、出没出码 ──
const byIp = new Map()
for (const r of rows) {
  const v = byIp.get(r.ip) ?? { ip: r.ip, n: 0, go: 0, check: 0, kinds: new Set(), ua: r.ua }
  v.n += 1
  if (/\/go(\/)?$/.test(r.path)) v.go += 1
  if (r.path.includes("/api/check")) v.check += 1
  v.kinds.add(r.kind)
  byIp.set(r.ip, v)
}
const visitors = [...byIp.values()].sort((a, b) => b.n - a.n)
console.log(`不同来源 IP：${visitors.length} 个（前 10）`)
for (const v of visitors.slice(0, 10)) {
  const ua = v.ua.replace(/^.*?\(([^)]{0,28}).*$/, "$1") || v.ua.slice(0, 24)
  console.log(`  ${v.ip.padEnd(38)} 请求${String(v.n).padStart(4)}  出码${String(v.go).padStart(3)}  轮询${String(v.check).padStart(4)}  ${[...v.kinds].join("/")}  ${ua}`)
}