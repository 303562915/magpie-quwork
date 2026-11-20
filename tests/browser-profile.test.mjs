// browser-profile.test.mjs 网页登录：从**浏览器 profile** 读 token（用户不要客户端）。
//
// # 背景
//
// 用户明确要求「打开浏览器手动登录，登录后自动抓取」。网页版是纯前端 SPA，
// token 落在浏览器 `Local Storage/leveldb`。所以这条来源在「不装客户端」时是首选。
//
// # 三条语义
//
//	① 列候选 profile：Chrome / Edge / Brave / Opera / Chromium
//	② 文件被浏览器占用（读报错）⇒ **跳过**，不影响其它文件
//	③ 多个 profile 命中：优先 host 含 quwork / rrzu 的，其次最近写入的

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { browserProfileDirs, readFromBrowserProfiles } from "../src/browser-profile.mjs"

const NEW_LLM = "sk-BROWSER-11111111"
const PLATFORM = "pt-browser-2222"

function blob({ llmToken = NEW_LLM, accessToken = PLATFORM, mtime = 1000 } = {}) {
  return `LEVELDB{"accessToken":"${accessToken}","llmToken":"${llmToken}","expiresAt":1800000000000}`
}

/** 造一个假 profile：返回 {dir, files:{[path]: content}} */
function fakeProfile(root, name, files) {
  const dir = join(root, name)
  mkdirSync(join(dir, "Local Storage", "leveldb"), { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, "Local Storage", "leveldb", file), content)
  }
  return dir
}

test("1) browserProfileDirs（Windows）：返回 Chrome / Edge 候选 profile", () => {
  const env = { LOCALAPPDATA: "C:\\LAD", APPDATA: "C:\\AD" }
  // 用注入的 exists + 真实目录名列表（readdirSync 只能读真实目录，所以这里造一个假根）
  const root = mkdtempSync(join(tmpdir(), "bp-"))
  try {
    mkdirSync(join(root, "Google", "Chrome", "User Data", "Default"), { recursive: true })
    mkdirSync(join(root, "Google", "Chrome", "User Data", "Profile 1"), { recursive: true })
    mkdirSync(join(root, "Microsoft", "Edge", "User Data", "Default"), { recursive: true })

    const dirs = browserProfileDirs({
      platform: "win32",
      env: { LOCALAPPDATA: root, APPDATA: join(root, "roaming") },
      exists: (p) => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      },
    })

    assert.ok(dirs.some((d) => d.includes(join("Chrome", "User Data", "Default"))))
    assert.ok(dirs.some((d) => d.includes("Profile 1")))
    assert.ok(dirs.some((d) => d.includes("Edge")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("2) readFromBrowserProfiles：从伪造的 leveldb 字节里读到 llmToken", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp2-"))
  try {
    const dir = fakeProfile(root, "Chrome", { "000003.log": blob() })
    const got = await readFromBrowserProfiles({ dirs: [dir], stat: () => ({ mtimeMs: 5000 }) })

    assert.equal(got.ok, true)
    assert.equal(got.llmToken, NEW_LLM)
    assert.equal(got.token, PLATFORM)
    assert.equal(got.source.startsWith("browser:"), true)
    assert.equal(got.fileMtime, 5000)
    assert.equal(got.hasPlatformToken, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("3) 多个 profile 命中：优先 host 含 quwork 的那条", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp3-"))
  try {
    const other = fakeProfile(root, "Profile-A", {
      "000003.log": `BLOB{"llmToken":"sk-OTHER-999","accessToken":"pt-x"}`, // 没有 host 线索
    })
    const quwork = fakeProfile(root, "Profile-B", {
      "000004.log": `_https://quwork.cn\u0000{"llmToken":"${NEW_LLM}","accessToken":"${PLATFORM}"}`,
    })

    const got = await readFromBrowserProfiles({
      dirs: [other, quwork],
      // A 的 mtime 更新，但 B 有 host 线索 ⇒ 仍然选 B
      stat: (p) => ({ mtimeMs: String(p).includes("Profile-A") ? 9000 : 1000 }),
    })

    assert.equal(got.llmToken, NEW_LLM, "host 线索优先于 mtime")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("4) 文件被占用（readFile 抛错）→ 跳过该文件继续，不抛", async () => {
  const root = mkdtempSync(join(tmpdir(), "bp4-"))
  try {
    const dir = fakeProfile(root, "Chrome", { "000003.log": blob() })
    const got = await readFromBrowserProfiles({
      dirs: [dir],
      readFile: () => {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" })
      },
    })
    assert.equal(got.ok, false, "读不到就是 ok:false，绝不抛")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
