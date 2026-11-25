// scripts/bind-qr.mjs 生成「印出来能用」的固定二维码：一张 PNG + 一张 A4 打印页。
//
// # 用法
//
//	npm run bind-qr -- https://bind.example.com
//	npm run bind-qr -- https://bind.example.com ./out/fixed-qr.png
//
// 不给参数时读 `QUWORK_BIND_PUBLIC_URL`；都没有就报错退出（绝不把占位域名印出去）。
//
// # 出什么
//
//	<out>.png          1024px 级别的 PNG（scale=16，静区 4 模块）
//	<out>.print.html   A4 排版：二维码 + 强制提示（必须用微信扫一扫，相册无效）
//
// 二维码内容永远是 `<公网地址>/bind/go`（图案不随池子变化，可以印一次发一辈子）。
//
// # 也被 scripts/bind-tunnel.mjs 复用
//
// 隧道脚本拿到 trycloudflare 地址后调 `buildFixedQr()` 重出码 —— 域名一变，码立刻跟着变。

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { qrMatrix, qrPng } from "../src/qr.mjs"

/**
 * 规范化公网地址：只留 origin + path，去尾斜杠；非 http(s) 返回空串。
 *
 * @param {any} v
 * @returns {string}
 */
export function normalizeBase(v) {
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

/**
 * 出「固定码」三件套：PNG、A4 打印页、二维码里真正编码的 URL。
 *
 * @param {{publicBaseUrl: string, outPng: string}} opts
 * @returns {{ok: boolean, reason?: string, target?: string, png?: string, html?: string, version?: number, bytes?: number}}
 */
export function buildFixedQr(opts) {
  const base = normalizeBase(opts?.publicBaseUrl)
  if (!base) return { ok: false, reason: "公网地址不合法（必须是 http(s)://…）" }

  const target = `${base}/bind/go`
  const out = resolve(String(opts.outPng))
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
  .sheet { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 240mm; gap: 6mm; }
  h1 { font-size: 24px; margin: 0; }
  img { width: 76mm; height: 76mm; }
  .alert { margin-top: 2mm; padding: 6mm 8mm; border: 2px solid #dc2626; border-radius: 4mm; color: #b91c1c; text-align: center; }
  .alert b { font-size: 21px; }
  .alert small { display: block; margin-top: 2mm; font-size: 14px; color: #dc2626; }
  .hint { color: #555; font-size: 14px; text-align: center; }
  code { font-size: 12px; color: #666; }
</style>
</head>
<body>
<div class="sheet">
  <h1>微信扫一扫，帮我们绑一个账号</h1>
  <img src="${out.split(/[\\/]/).pop()}" alt="微信扫码绑定">
  <div class="alert">
    <b>必须用微信「扫一扫」直接扫上面这张码</b>
    <small>从相册选图 / 长按识别 打开的无效，不会跳「确认登录」</small>
  </div>
  <p class="hint">扫进来后页面会分给你一个<strong>还没绑定微信</strong>的账号，<br>再让<strong>另一台手机</strong>用它自己的微信扫那一张、点「确认登录」就完成了。</p>
  <p class="hint"><code>${target}</code></p>
</div>
</body>
</html>
`
  const htmlPath = out.replace(/\.png$/i, "") + ".print.html"
  writeFileSync(htmlPath, html, "utf8")

  return { ok: true, target, png: out, html: htmlPath, version, size, bytes: png.length }
}

// ── 直接运行 ─────────────────────────────────────────────────────────────
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rawArg = process.argv[2] ?? process.env.QUWORK_BIND_PUBLIC_URL ?? ""
  const outArg = process.argv[3] ?? "fixed-qr.png"

  const r = buildFixedQr({ publicBaseUrl: rawArg, outPng: outArg })
  if (!r.ok) {
    console.error(`用法：npm run bind-qr -- https://bind.example.com [输出路径]`)
    console.error(`（${r.reason}）`)
    process.exit(1)
  }
  if (String(r.target).startsWith("http://")) {
    console.error("⚠ 微信内置浏览器对 http 会提示「非官方网页」，公网请用 HTTPS。")
  }
  console.log(`二维码内容：${r.target}`)
  console.log(`版本 v${r.version} · PNG ${r.bytes} 字节 → ${r.png}`)
  console.log(`A4 打印页 → ${r.html}`)
}