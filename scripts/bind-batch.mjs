// scripts/bind-batch.mjs 批量出码：给所有「还没绑微信」的号各出一张码，排成可打印页。
//
// # 为什么单独做这个
//
// 阵列页是「一个链接，群里谁扫哪格都行」；但如果是**你自己**一台电脑 + 一台手机逐个绑，
// 更好的形态是：一页 A4 印 6 个码，按 `#4 #5 #6` 顺序扫，扫完翻页。
// 码本身**不需要微信参与**（用各号的 token 现取现画），你的微信只负责「扫 + 确认」。
//
// # 用法
//
//	npm run bind-batch                       # 全部未绑号，每页 6 个 → out/批量码表.html
//	npm run bind-batch -- --count 12         # 只出前 12 个
//	npm run bind-batch -- --keys quwork#3,quwork#4
//	npm run bind-batch -- --per-page 4 --out ./out/码表.html
//
// 产出：
//	<out>.html      可打印的码表（A4 分页，每张码标 `#N`，附一句扫码说明）
//	<out>.csv       对照表：编号 ↔ 账号 key ↔ 手机号尾号 ↔ state（**只给自己看，别外发**）

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"

import { PLATFORM_BASE_URL } from "../src/constants.mjs"
import { fetchAuthorizeUrl, fetchSelf, listPoolTokens, readPool } from "../src/wechat-bind.mjs"
import { qrMatrix, qrPng } from "../src/qr.mjs"
import { esc } from "../src/bind-pages.mjs"

/** 解析 `--count 12` / `--keys a,b` / `--per-page 6` / `--out path`。 */
function parseArgs(argv) {
  const out = { count: 0, keys: [], perPage: 6, out: "out/批量码表.html", scale: 10 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--count") out.count = Math.max(0, Number(argv[++i]) || 0)
    else if (a === "--keys") out.keys = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--per-page") out.perPage = Math.max(1, Number(argv[++i]) || 6)
    else if (a === "--out") out.out = String(argv[++i] ?? out.out)
    else if (a === "--scale") out.scale = Math.max(4, Math.min(20, Number(argv[++i]) || 10))
  }
  return out
}

/**
 * 生成码表（库模式，可测试）。
 *
 * @param {{configDir: string, platformBaseUrl?: string, fetchImpl?: typeof fetch,
 *   keys?: string[], count?: number, perPage?: number, outHtml: string, scale?: number}} opts
 * @returns {Promise<{ok: boolean, reason?: string, made: number, skipped: number,
 *   outHtml?: string, outCsv?: string, items: Array<{label: string, key: string, phoneTail: string, state: string}>}>}
 */
export async function buildBatch(opts) {
  const configDir = String(opts?.configDir ?? "").trim()
  const platformBaseUrl = String(opts?.platformBaseUrl ?? "").trim() || PLATFORM_BASE_URL
  const all = listPoolTokens(configDir)
  const label = (key) => `#${all.findIndex((a) => a.key === key) + 1}`
  const pool = readPool(configDir).accounts

  // ① 挑号：显式 keys > 全部未绑（跳过快照里已知已绑 / token 失效的）
  let candidates = all
  if (Array.isArray(opts?.keys) && opts.keys.length > 0) {
    candidates = all.filter((a) => opts.keys.includes(a.key))
  } else {
    candidates = all.filter((a) => pool[a.key]?.wechatBound !== true && pool[a.key]?.tokenInvalid !== true)
  }
  if (Number(opts?.count) > 0) candidates = candidates.slice(0, Number(opts.count))
  if (candidates.length === 0) return { ok: false, reason: "没有可出码的账号", made: 0, skipped: 0, items: [] }

  const items = []
  let skipped = 0
  for (const a of candidates) {
    const token = String(a.token ?? "").trim()
    if (!token) {
      skipped += 1
      continue
    }
    // ② 出码前实测一次：已经绑过的号不能出现在码表里（否则你扫了等于白扫）
    const self = await fetchSelf({ platformBaseUrl, token, fetchImpl: opts?.fetchImpl })
    if (self.ok && self.wechatBound) {
      skipped += 1
      continue
    }
    if (!self.ok) {
      skipped += 1
      continue
    }
    const got = await fetchAuthorizeUrl({ platformBaseUrl, token, fetchImpl: opts?.fetchImpl })
    if (!got.ok || !got.state) {
      skipped += 1
      continue
    }
    let dataUri = ""
    try {
      dataUri = `data:image/png;base64,${qrPng(got.url, { ecl: "L", scale: Math.max(4, Number(opts?.scale) || 10), border: 4 }).toString("base64")}`
    } catch {
      skipped += 1
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

  if (items.length === 0) return { ok: false, reason: "候选号全部已绑或取不到码", made: 0, skipped, items: [] }

  // ③ 排页：每页 perPage 个，A4 打印
  const perPage = Math.max(1, Number(opts?.perPage) || 6)
  const pages = []
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage))

  const cellsOf = (list) =>
    list
      .map(
        (it) => `<div class="cell">
  <img src="${esc(it.dataUri)}" alt="${esc(it.label)}">
  <div class="cap">${esc(it.label)}</div>
</div>`,
      )
      .join("\n")

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>批量绑定码表（${items.length} 个号）</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #111; }
  .sheet { page-break-after: always; min-height: 265mm; display: flex; flex-direction: column; gap: 6mm; }
  .sheet:last-child { page-break-after: auto; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  h1 { font-size: 18px; margin: 0; }
  .alert { border: 2px solid #dc2626; color: #b91c1c; border-radius: 3mm; padding: 3mm 5mm; font-size: 13px; }
  .grid { flex: 1; display: grid; grid-template-columns: repeat(2, 1fr); gap: 6mm; align-content: start; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 2mm; border: 1px solid #e5e7eb; border-radius: 3mm; padding: 3mm; }
  .cell img { width: 62mm; height: 62mm; image-rendering: pixelated; }
  .cap { font-size: 16px; font-weight: 700; }
  footer { font-size: 12px; color: #6b7280; }
  @media print { .cell { break-inside: avoid; } }
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
  <div class="alert">用手机微信「<b>扫一扫</b>」扫下面任意一张 → 微信里点「<b>确认登录</b>」。<br>
  相册选图 / 长按识别 无效。一个码只绑一个号，扫过的那张就作废。</div>
  <div class="grid">
${cellsOf(list)}
  </div>
  <footer>每张码下面的大字是账号编号（面板「扫码绑定」里的 #N 对得上）。</footer>
</section>`,
  )
  .join("\n")}
</body>
</html>
`

  const outHtml = resolve(String(opts.outHtml))
  mkdirSync(dirname(outHtml), { recursive: true })
  writeFileSync(outHtml, html, "utf8")

  const csvPath = outHtml.replace(/\.html?$/i, "") + ".csv"
  const csv = ["编号,账号key,手机号尾号,state,版本"]
    .concat(items.map((it) => `"${it.label}","${it.key}","${it.phoneTail}","${it.state}",${it.version}`))
    .join("\n")
  writeFileSync(csvPath, csv + "\n", "utf8")

  return {
    ok: true,
    made: items.length,
    skipped,
    outHtml,
    outCsv: csvPath,
    pages: pages.length,
    items: items.map(({ label, key, phoneTail, state }) => ({ label, key, phoneTail, state })),
  }
}

// ── 直接运行 ─────────────────────────────────────────────────────────────
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2))
  const configDir = String(process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), ".config", "magpie"))
  const r = await buildBatch({
    configDir,
    platformBaseUrl: process.env.QUWORK_PLATFORM_BASE ?? PLATFORM_BASE_URL,
    keys: args.keys,
    count: args.count,
    perPage: args.perPage,
    outHtml: resolve(process.cwd(), args.out),
    scale: args.scale,
  })
  if (!r.ok) {
    console.error(`出码失败：${r.reason}`)
    process.exit(1)
  }
  console.log(`已出码 ${r.made} 个（跳过 ${r.skipped} 个已绑/取不到码的），共 ${r.pages} 页`)
  console.log(`码表（可打印）：${r.outHtml}`)
  console.log(`对照表（别外发）：${r.outCsv}`)
  console.log("")
  for (const it of r.items) console.log(`  ${it.label.padEnd(5)} ${it.key.padEnd(12)} 尾号 ${it.phoneTail}  state=${it.state}`)
  console.log("")
  console.log("用法提醒：手机微信「扫一扫」扫屏幕上的码 → 点「确认登录」。一个码只绑一个号。")
}