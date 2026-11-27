// scripts/bind-wall-static.mjs 出「静态码墙」：一次把 N 个号的码和链接全排好，**不占位、不过期**。
//
// # 为什么单独做
//
// 阵列页（`/bind/wall`）是「临时分配 + 5 分钟占位 + 过期换码」，适合发群里抢。
// 但如果要「发一条公网链接，让人慢慢扫」，占位锁反而碍事（5 分钟换一次，人还没扫完就变了）。
//
// 静态码墙：码是你自己生成的、`state` 长期有效（平台签发，不随我们的会话过期），
// 所以**不需要占位锁**，谁扫哪张都行，只要没绑上就一直可用。
//
// # 产出
//
//	<out>.html   一页多码（A4 可打印 / 也可当网页投屏）
//	<out>.links.txt  每行 `#4 <授权链接>`
//	<out>.csv    编号 ↔ key ↔ 尾号 ↔ state（只给自己看）
//
// # 用法
//
//	npm run bind-wall-static                      # 全部未绑号
//	npm run bind-wall-static -- --count 12        # 只要 12 个
//	npm run bind-wall-static -- --per-page 9 --delay 800

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"

import { PLATFORM_BASE_URL } from "../src/constants.mjs"
import { fetchAuthorizeUrl, fetchSelf, listPoolTokens, readPool } from "../src/wechat-bind.mjs"
import { qrMatrix, qrPng } from "../src/qr.mjs"
import { esc } from "../src/bind-pages.mjs"

function parseArgs(argv) {
  const out = { count: 0, keys: [], perPage: 9, out: "out/静态码墙.html", scale: 8, delayMs: 800 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--count") out.count = Math.max(0, Number(argv[++i]) || 0)
    else if (a === "--keys") out.keys = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--per-page") out.perPage = Math.max(1, Number(argv[++i]) || 9)
    else if (a === "--out") out.out = String(argv[++i] ?? out.out)
    else if (a === "--scale") out.scale = Math.max(4, Math.min(20, Number(argv[++i]) || 8))
    else if (a === "--delay") out.delayMs = Math.max(0, Number(argv[++i]) || 0)
  }
  return out
}

/**
 * 生成静态码墙。
 *
 * @param {{configDir: string, platformBaseUrl?: string, fetchImpl?: typeof fetch,
 *   keys?: string[], count?: number, perPage?: number, outHtml: string, scale?: number,
 *   delayMs?: number, onRetry?: (info: any) => void}} opts
 */
export async function buildStaticWall(opts) {
  const configDir = String(opts?.configDir ?? "").trim()
  const platformBaseUrl = String(opts?.platformBaseUrl ?? "").trim() || PLATFORM_BASE_URL
  const all = listPoolTokens(configDir)
  const label = (key) => `#${all.findIndex((a) => a.key === key) + 1}`
  const pool = readPool(configDir).accounts

  let candidates = all
  if (Array.isArray(opts?.keys) && opts.keys.length > 0) candidates = all.filter((a) => opts.keys.includes(a.key))
  else candidates = all.filter((a) => pool[a.key]?.wechatBound !== true && pool[a.key]?.tokenInvalid !== true)
  if (Number(opts?.count) > 0) candidates = candidates.slice(0, Number(opts.count))
  if (candidates.length === 0) return { ok: false, reason: "没有可出码的账号", made: 0, skipped: 0, items: [], skippedReasons: [] }

  const items = []
  const skippedReasons = []
  let skipped = 0
  const delayMs = Math.max(0, Number(opts?.delayMs ?? 800))
  let first = true

  for (const a of candidates) {
    if (!first && delayMs > 0) await new Promise((d) => setTimeout(d, delayMs))
    first = false

    const token = String(a.token ?? "").trim()
    if (!token) {
      skipped += 1
      skippedReasons.push(`${a.key}: 没有平台 token`)
      continue
    }

    // 出码前实测：已绑的别放进来（否则白扫）
    const self = await fetchSelf({ platformBaseUrl, token, fetchImpl: opts?.fetchImpl })
    if (!self.ok) {
      skipped += 1
      skippedReasons.push(`${a.key}: 读状态失败 ${self.message ?? ""}`)
      continue
    }
    if (self.wechatBound) {
      skipped += 1
      skippedReasons.push(`${a.key}: 已经绑过微信`)
      continue
    }

    // 取授权地址：429 退避重试
    /** @type {any} */
    let got = null
    const backoff = [15_000, 30_000, 60_000]
    for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
      got = await fetchAuthorizeUrl({ platformBaseUrl, token, fetchImpl: opts?.fetchImpl })
      if (got.ok) break
      const throttled = /频繁|429|too many/i.test(String(got.message ?? ""))
      if (!throttled || attempt >= backoff.length) break
      const wait = backoff[attempt]
      opts?.onRetry?.({ key: a.key, attempt: attempt + 1, waitMs: wait, message: got.message })
      await new Promise((d) => setTimeout(d, wait))
    }
    if (!got?.ok || !got.state) {
      skipped += 1
      skippedReasons.push(`${a.key}: ${got?.message ?? "取不到授权地址"}`)
      continue
    }

    let dataUri = ""
    try {
      dataUri = `data:image/png;base64,${qrPng(got.url, { ecl: "L", scale: Math.max(4, opts?.scale ?? 8), border: 4 }).toString("base64")}`
    } catch {
      skipped += 1
      skippedReasons.push(`${a.key}: 二维码生成失败`)
      continue
    }

    items.push({
      label: label(a.key),
      key: a.key,
      phoneTail: String(a.phone ?? "").slice(-4),
      state: got.state,
      url: got.url,
      dataUri,
      version: qrMatrix(got.url, { ecl: "L" }).version,
    })
  }

  if (items.length === 0) return { ok: false, reason: "候选号全部取不到码", made: 0, skipped, items: [], skippedReasons }

  const perPage = Math.max(1, Number(opts?.perPage) || 9)
  const pages = []
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage))

  const cell = (it) => `<div class="cell">
  <div class="lb">${esc(it.label)}</div>
  <img src="${esc(it.dataUri)}" alt="${esc(it.label)}">
</div>`

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>扫码帮绑微信 · 静态码墙（${items.length} 个号）</title>
<style>
  :root { color-scheme: light dark; }
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f7f9; color: #16181d;
    font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .sheet { page-break-after: always; background: #fff; min-height: 277mm; padding: 8mm;
    display: flex; flex-direction: column; gap: 4mm; }
  .sheet:last-child { page-break-after: auto; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  h1 { font-size: 16px; margin: 0; }
  .alert { border: 2px solid #dc2626; color: #b91c1c; border-radius: 3mm; padding: 2mm 4mm; font-size: 12px; }
  .grid { flex: 1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; align-content: start; }
  .cell { border: 1px solid #e5e7eb; border-radius: 3mm; padding: 2mm; display: flex; flex-direction: column;
    align-items: center; gap: 1mm; }
  .cell img { width: 48mm; height: 48mm; image-rendering: pixelated; }
  .lb { font-weight: 800; font-size: 14px; }
  footer { font-size: 11px; color: #6b7280; }
  @media print { .cell { break-inside: avoid; } body { background: #fff; } }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e5e7eb; }
    .sheet { background: #171a21; }
    .cell { border-color: #2a303c; }
  }
</style>
</head>
<body>
${pages
  .map(
    (list, idx) => `<section class="sheet">
  <header>
    <h1>扫码帮绑微信 · 第 ${idx + 1}/${pages.length} 页（${esc(list[0].label)} – ${esc(list[list.length - 1].label)}）</h1>
    <span>${new Date().toISOString().slice(0, 16).replace("T", " ")}</span>
  </header>
  <div class="alert">手机微信「<b>扫一扫</b>」扫任意一张 → 微信里点「<b>确认登录</b>」。相册/长按识别无效；一码只绑一个号。</div>
  <div class="grid">
${list.map(cell).join("\n")}
  </div>
  <footer>每格左上角是账号编号（与面板「扫码绑定」的 #N 一致）。这批码不占位、不过期，扫完对应的号就不再可用。</footer>
</section>`,
  )
  .join("\n")}
</body>
</html>
`

  const outHtml = resolve(String(opts.outHtml))
  mkdirSync(dirname(outHtml), { recursive: true })
  writeFileSync(outHtml, html, "utf8")

  const linksPath = outHtml.replace(/\.html?$/i, "") + ".links.txt"
  writeFileSync(
    linksPath,
    ["# 每行一条：编号<TAB>授权链接（浏览器打开 → 页里出现码 → 微信扫它）"]
      .concat(items.map((it) => `${it.label}\t${it.url}`))
      .join("\n") + "\n",
    "utf8",
  )

  const csvPath = outHtml.replace(/\.html?$/i, "") + ".csv"
  writeFileSync(
    csvPath,
    ["编号,账号key,手机号尾号,state,版本"]
      .concat(items.map((it) => `"${it.label}","${it.key}","${it.phoneTail}","${it.state}",${it.version}`))
      .join("\n") + "\n",
    "utf8",
  )

  return {
    ok: true,
    made: items.length,
    skipped,
    skippedReasons,
    pages: pages.length,
    outHtml,
    outLinks: linksPath,
    outCsv: csvPath,
    items: items.map(({ label, key, phoneTail, state, url }) => ({ label, key, phoneTail, state, url })),
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2))
  const configDir = String(process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), ".config", "magpie"))
  const r = await buildStaticWall({
    configDir,
    platformBaseUrl: process.env.QUWORK_PLATFORM_BASE ?? PLATFORM_BASE_URL,
    keys: args.keys,
    count: args.count,
    perPage: args.perPage,
    outHtml: resolve(process.cwd(), args.out),
    scale: args.scale,
    delayMs: args.delayMs,
    onRetry: (i) => console.log(`  ${i.key} 被限流（${i.message}），${i.waitMs / 1000}s 后重试（第 ${i.attempt} 次）`),
  })
  if (!r.ok) {
    console.error(`生成失败：${r.reason}`)
    process.exit(1)
  }
  console.log(`已出码 ${r.made} 个（跳过 ${r.skipped} 个），共 ${r.pages} 页`)
  for (const why of r.skippedReasons) console.log(`  跳过 ${why}`)
  console.log(`码墙：${r.outHtml}`)
  console.log(`链接表：${r.outLinks}`)
  console.log(`对照表（别外发）：${r.outCsv}`)
}