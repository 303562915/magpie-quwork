// scripts/bind-log.mjs 看「有没有人扫码」：把门户访问日志汇总成一眼能读的结论。
//
// # 用法
//
//	npm run bind-log                                  # 默认读 ./bind-access.log
//	npm run bind-log -- G:\trae\R1\fandai\out\访问日志.txt
//
// # 读什么
//
// 每行一次请求：`时间 IP 方法 路径 状态 耗时 类型 "UA"`（见 scripts/bind-server.mjs）。
// 「类型」由 UA 判出来：微信（MicroMessenger）/ 脚本（curl、PowerShell…）/ 其它浏览器。
//
// # 为什么需要
//
// 「有人扫码了吗」只能靠日志回答。要区分「真有人扫」和「自己 curl 探活」，
// 看 `/bind/go` 的次数 + 类型是不是微信 + 后面有没有跟着 `/bind/api/check` 的轮询。

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const file = resolve(process.argv[2] ?? process.env.BIND_LOG ?? "bind-access.log")
if (!existsSync(file)) {
  console.error(`读不到日志：${file}`)
  console.error("（门户进程默认写 ./bind-access.log；也可以设 BIND_LOG 指到别处）")
  process.exit(1)
}

const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean)
const rows = []
for (const line of lines) {
  const m =
    /^(\S+) (\S+) (\S+) (\S+) (\d{3}) (\d+)ms (\S+) "(.*)"$/.exec(line) ??
    /^(\S+) (\S+) (\S+) (\S+) (\d{3}) (\d+)ms (\S+)$/.exec(line)
  if (!m) continue
  rows.push({ at: m[1], ip: m[2], method: m[3], path: m[4], status: Number(m[5]), ms: Number(m[6]), kind: m[7], ua: m[8] ?? "" })
}

if (rows.length === 0) {
  console.log(`日志里没有可解析的行：${file}`)
  process.exit(0)
}

const count = (fn) => rows.filter(fn).length
const byKind = rows.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {})

const goHits = rows.filter((r) => /\/(go|bind\/go)(\/)?$/.test(r.path) || r.path.endsWith("/go"))
const scans = goHits.filter((r) => r.kind === "微信")
const checks = count((r) => r.path.includes("/api/check"))
const pages = count((r) => r.path.includes("/bind") && !r.path.includes("/api/"))

const first = rows[0].at
const last = rows[rows.length - 1].at

console.log(`日志：${file}`)
console.log(`时间范围：${first} → ${last}（共 ${rows.length} 次请求）`)
console.log(`类型分布：${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(" · ")}`)
console.log("")
console.log(`出码页（/bind/go）：${goHits.length} 次，其中微信扫码 ${scans.length} 次`)
console.log(`页面访问（/bind*）：${pages} 次 · 状态轮询（/api/check）：${checks} 次`)

if (scans.length === 0) {
  console.log("")
  console.log("结论：**没有微信扫码**。上面那些请求都是脚本/浏览器探活（你自己 curl 或面板预览）。")
} else {
  console.log("")
  console.log("微信扫码明细（最近 10 次）：")
  for (const r of scans.slice(-10)) console.log(`  ${r.at}  ${r.ip}  ${r.path}  ${r.status}  ${r.ms}ms`)
  const ipSet = new Set(scans.map((r) => r.ip))
  console.log(`去重后的扫码 IP：${[...ipSet].join(", ")}`)
  console.log("")
  console.log(
    checks > 0
      ? "接着有状态轮询 → 说明对方确实把页面打开并等过「确认登录」。绑没绑成看池子里 wechatBound / 面板「扫码绑定」tab。"
      : "没有后续轮询 → 页面可能没加载完，或对方直接关掉了。",
  )
}

console.log("")
console.log("最近 8 次请求：")
for (const r of rows.slice(-8)) console.log(`  ${r.at}  ${r.ip}  ${r.method} ${r.path} ${r.status} ${r.ms}ms ${r.kind}`)