// scripts/bind-tunnel.mjs 起一条 Cloudflare 快速隧道**并自动把固定码跟着换**。
//
// # 为什么需要它
//
// trycloudflare 的随机域名**没法固定**（要固定必须 Cloudflare 账号 + 自己的域名 → 命名隧道）。
// 隧道一重启域名就变，而固定二维码的图案是跟着域名变的 —— 手改太容易出错。
//
// 这个脚本把「起隧道 → 抓到域名 → 重出二维码 → 写一行当前地址」连成一步：
//
//	npm run bind-tunnel                 # 默认转发到 http://127.0.0.1:4400
//	npm run bind-tunnel -- 4400 ./out   # 指定端口与输出目录
//
// 产物（域名变了会**自动覆盖**）：
//
//	<out>/固定码.png           可以直接转发/打印的二维码
//	<out>/固定码.print.html    A4 打印页（含「必须用微信扫一扫」的强制提示）
//	<out>/当前公网地址.txt     当前隧道地址 + 出码时间
//
// # 它不会做什么
//
//	· 不改插件配置、不重启 magpie、不碰面板端口（只连门户进程）
//	· 隧道进程退出会**自动重连**并重新出码（新域名），日志里能看到每一步
//
// ⚠ 生产别用这个：快速隧道没有可用性保证，且域名会变。要「印一次发一辈子」，
//   请用 Cloudflare 命名隧道（cloudflared tunnel login/create/route dns）或自己的 VPS。

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

import { buildFixedQr } from "./bind-qr.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..")

/** cloudflared 的位置：环境变量 → 仓库外的 tools/ → PATH。 */
function findCloudflared() {
  const fromEnv = String(process.env.CLOUDFLARED ?? "").trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const sibling = resolve(REPO, "..", "tools", "cloudflared.exe")
  if (existsSync(sibling)) return sibling
  return "cloudflared"
}

const port = String(process.argv[2] ?? process.env.PORT ?? "4400")
const outDir = resolve(process.argv[3] ?? process.env.BIND_OUT ?? join(REPO, "out"))
const localUrl = `http://127.0.0.1:${port}`
const cloudflared = findCloudflared()

mkdirSync(outDir, { recursive: true })
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19)

console.log(`[${stamp()}] 隧道目标：${localUrl}`)
console.log(`[${stamp()}] cloudflared：${cloudflared}`)
console.log(`[${stamp()}] 出码目录：${outDir}`)

let current = ""
let child = null

/** 抓到域名就重出码（域名不变就不重复出）。 */
function onUrl(url) {
  const clean = url.replace(/\/+$/, "")
  if (clean === current) return
  current = clean

  const r = buildFixedQr({ publicBaseUrl: clean, outPng: join(outDir, "固定码.png"), entryPath: process.env.BIND_ENTRY_PATH || "/bind/go" })
  if (!r.ok) {
    console.error(`[${stamp()}] 出码失败：${r.reason}`)
    return
  }
  writeFileSync(
    join(outDir, "当前公网地址.txt"),
    `${clean}\n${r.target}\n出码时间：${stamp()}\n（快速隧道域名每次重启都会变；要固定请用命名隧道）\n`,
    "utf8",
  )
  console.log(`[${stamp()}] 公网地址：${clean}`)

  // 把当前公网地址也写进 magpie 配置目录：面板没有设置 bindPublicUrl 时读这个文件，
  // 否则「公网链接」会显示成本机地址（127.0.0.1），发出去别人打不开。
  try {
    const cfgDir = String(process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), ".config", "magpie")).trim()
    if (cfgDir) {
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(join(cfgDir, "quwork-bind-public.txt"), `${clean}\n`, "utf8")
      console.log(`[${stamp()}] 面板公网地址已同步：${join(cfgDir, "quwork-bind-public.txt")}`)
    }
  } catch (e) {
    console.error(`[${stamp()}] 同步面板公网地址失败：${String(e?.message ?? e)}`)
  }
  console.log(`[${stamp()}] 二维码内容：${r.target}（v${r.version}，${r.bytes} 字节）`)
  console.log(`[${stamp()}] 已更新：${join(outDir, "固定码.png")}`)
  console.log(`[${stamp()}] 已更新：${join(outDir, "固定码.print.html")}`)
}

function start() {
  // ⚠ 只打印 cloudflared 输出的**域名**，别的行一律透传（方便排障）
  child = spawn(cloudflared, ["tunnel", "--url", localUrl, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })

  const scan = (buf) => {
    const text = String(buf)
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line)
      if (m) onUrl(m[0])
    }
  }
  child.stdout.on("data", scan)
  child.stderr.on("data", (buf) => {
    scan(buf)
    const text = String(buf)
    if (/ERR|WARN|failed|error/i.test(text)) process.stderr.write(text)
  })

  child.on("exit", (code, signal) => {
    console.log(`[${stamp()}] 隧道退出（code=${code} signal=${signal}），3 秒后重连…`)
    setTimeout(start, 3000)
  })
  child.on("error", (e) => {
    console.error(`[${stamp()}] 起不来：${String(e?.message ?? e)}`)
    process.exit(1)
  })
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[${stamp()}] 收到 ${sig}，停隧道`)
    child?.kill()
    process.exit(0)
  })
}

start()