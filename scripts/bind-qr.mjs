// scripts/bind-qr.mjs 生成「印出来能用」的固定二维码：一张 PNG + 一张 A4 打印页。
//
// # 用法
//
//	npm run bind-qr -- https://bind.example.com
//	npm run bind-qr -- https://bind.example.com ./out/fixed-qr.png
//
// 不给参数时读 `QUWORK_BIND_PUBLIC_URL`；再不济就用占位域名并**明确告警**（别把占位码印出去）。
//
// # 出什么
//
//	<out>.png          1024px 级别的 PNG（scale=16，静区 4 模块）
//	<out>.print.html   A4 排版：二维码 + 一句「微信扫一扫，帮我们绑一个账号」
//
// 二维码内容永远是 `<公网地址>/bind/go`（图案不随池子变化，可以印一次发一辈子）。

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { qrMatrix, qrPng } from "../src/qr.mjs"

const rawArg = process.argv[2] ?? process.env.QUWORK_BIND_PUBLIC_URL ?? ""
const outArg = process.argv[3] ?? "fixed-qr.png"

/** 规范化：只留 origin + path，去掉末尾斜杠。 */
function normalize(v) {
  const s = String(v ?? "").trim()
  if (!s) return ""
  try {
    const u = new URL(s)
    if (u.protocol !== "http:" && u.protocol !== "https:") return ""
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`
  } catch {
    return ""
  }
}

const base = normalize(rawArg)
if (!base) {
  console.error("用法：npm run bind-qr -- https://bind.example.com [输出路径]")
  console.error("（也可以用环境变量 QUWORK_BIND_PUBLIC_URL）")
  process.exit(1)
}
if (base.startsWith("http://")) {
  console.error("⚠ 微信内置浏览器对 http 会提示「非官方网页」，公网请用 HTTPS。")
}

const target = `${base}/bind/go`
const out = resolve(outArg)
mkdirSync(dirname(out), { recursive: true })

const png = qrPng(target, { ecl: "L", scale: 16, border: 4 })
const { version, size } = qrMatrix(target, { ecl: "L" })
writeFileSync(out, png)

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>微信扫码绑定 · 固定二维码</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { margin: 0; font: 15px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #111; }
  .sheet { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 240mm; gap: 8mm; }
  h1 { font-size: 22px; margin: 0; }
  img { width: 70mm; height: 70mm; }
  .hint { color: #555; font-size: 14px; text-align: center; }
  code { font-size: 12px; color: #666; }
</style>
</head>
<body>
<div class="sheet">
  <h1>微信扫一扫，帮我们绑一个账号</h1>
  <img src="${out.split(/[\\/]/).pop()}" alt="微信扫码绑定">
  <p class="hint">扫码后页面会分给你一个<strong>还没绑定微信</strong>的账号，<br>再扫它给出的二维码、在微信里点「确认登录」就完成了。</p>
  <p class="hint"><code>${target}</code></p>
</div>
</body>
</html>
`
const htmlPath = out.replace(/\.png$/i, "") + ".print.html"
writeFileSync(htmlPath, html, "utf8")

console.log(`二维码内容：${target}`)
console.log(`版本 v${version} · ${size}×${size} 模块 · PNG ${png.length} 字节 → ${out}`)
console.log(`A4 打印页 → ${htmlPath}`)