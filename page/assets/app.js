// app.js QuWork 面板交互（纯原生，无框架）。
//
// # 一条铁律
//
// **打开页面不发任何上游请求**：只调 `GET /api/accounts`、`GET /api/invite/summary`、
// `GET /api/settings`（都只读文件/内存）并渲染缓存。所有上游调用都由按钮触发。

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const fmtNum = (n) => (n == null || n === "" ? "—" : Number(n).toLocaleString("zh-CN"))
const fmtTime = (sec) => {
  const n = Number(sec) || 0
  if (!n) return "—"
  const ms = n < 1e11 ? n * 1000 : n
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "—"
  const p = (x) => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtAgo = (ms) => {
  const t = Number(ms) || 0
  if (!t) return "无缓存"
  const diff = Math.max(0, Date.now() - t)
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}
/** 剩余天数（负数 = 已过期）。 */
const daysLeft = (sec) => {
  const n = Number(sec) || 0
  if (!n) return null
  return Math.floor((n * 1000 - Date.now()) / 86_400_000)
}

/**
 * 面板服务的根地址（含 magpie 反代前缀）。
 *
 * # 为什么用 import.meta.url（真机踩过）
 *
 * app.js 是 `<script type="module">`，**module 里 document.currentScript 恒为 null**，
 * 旧代码的 `currentScript.src` 分支永远不生效，于是回退到 location.origin —— 在
 * magpie web 下那是 8090，请求打到 `http://H:8090/api/accounts` → Failed to fetch。
 *
 * 正确做法：取本模块自身 URL 的**上一级目录**当服务根。本地与反代两种形态都对：
 *   · http://127.0.0.1:4392/assets/app.js → http://127.0.0.1:4392
 *   · http://H/_magpie/plugin/<hash>/_magpie/service/assets/app.js
 *     → http://H/_magpie/plugin/<hash>/_magpie/service
 *
 * 仍然支持 `?port=`：只在取不到 http 的 file:// 场景作为回退。
 */
const BASE = (() => {
  // ① 本模块自身 URL 的上一级目录 = 面板服务根（自动带 magpie 反代前缀）。
  //    module 里 document.currentScript 恒为 null，必须用 import.meta.url。
  try {
    const self = new URL(import.meta.url)
    if (/^https?:$/.test(self.protocol)) return new URL("..", self).href.replace(/\/+$/, "")
  } catch {
    /* 忽略 */
  }
  // ② file:// / 取不到 http → 桌面窗口：用 boot 带来的 ?port=，否则默认 4392
  try {
    const p = Number(new URLSearchParams(location.search).get("port"))
    if (Number.isInteger(p) && p > 0 && p < 65536) return `http://127.0.0.1:${p}`
  } catch {
    /* 忽略 */
  }
  return "http://127.0.0.1:4392"
})()

/**
 * 单次请求（一个 base）。
 *
 * @param {string} base
 * @param {string} path
 * @param {RequestInit} init
 */
async function apiOnce(base, path, init) {
  let resp
  try {
    resp = await fetch(base + path, init)
  } catch (e) {
    throw new Error(`无法连接面板服务（${base}）：${String(e?.message ?? e).slice(0, 80)}`)
  }
  const data = await resp.json().catch(() => null)
  if (!data || typeof data !== "object") throw new Error(`服务返回了无法解析的数据（HTTP ${resp.status}）`)
  if (!resp.ok) throw new Error(data.error || data.message || `HTTP ${resp.status}`)
  return data
}

/**
 * 带**多候选 base** 的重试：BASE 失败就换本机默认口 / 同源。
 *
 * # 为什么要这么写（真机踩过两轮）
 *
 * magpie 可能用 `file:` 加载面板（origin 为 `null`）、也可能用带前缀的代理路径。
 * 单看一个来源不可靠，所以给一个**有限**的候选列表：去重后最多试 3 次，
 * 全失败就把**最后一个**错误抛出去（不要无限循环）。
 */
async function api(path, body) {
  const init = body === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }

  const targets = [
    BASE,
    "http://127.0.0.1:4392",
    location.origin && location.origin !== "null" ? location.origin : null,
  ].filter(Boolean)

  let lastErr = null
  for (const base of [...new Set(targets)]) {
    try {
      return await apiOnce(base, path, init)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error("无法连接面板服务")
}

let toastTimer = 0
/**
 * 页面内弹窗，返回 Promise<boolean>（点确定 true / 取消 false）。
 *
 * 为什么不用原生 `confirm`：它在沙盒 iframe 或被策略拦截时会**静默返回 false**，
 * 用户看到的现象就是「点了没反应」。自己画一个就不会有这个问题。
 *
 * @param {{title?: string, body?: string, okText?: string, cancelText?: string, html?: boolean}} opts
 * @returns {Promise<boolean>}
 */
function askDialog(opts = {}) {
  return new Promise((resolve) => {
    const mask = $("dlg")
    if (!mask) return resolve(window.confirm(opts.body || opts.title || "确定？"))
    $("dlg-title").textContent = String(opts.title ?? "提示")
    const body = $("dlg-body")
    if (opts.html) body.innerHTML = String(opts.body ?? "")
    else body.textContent = String(opts.body ?? "")
    $("dlg-ok").textContent = String(opts.okText ?? "确定")
    $("dlg-cancel").textContent = String(opts.cancelText ?? "取消")
    mask.hidden = false

    const done = (v) => {
      mask.hidden = true
      $("dlg-ok").onclick = null
      $("dlg-cancel").onclick = null
      mask.onclick = null
      resolve(v)
    }
    $("dlg-ok").onclick = () => done(true)
    $("dlg-cancel").onclick = () => done(false)
    mask.onclick = (e) => {
      if (e.target === mask) done(false)
    }
  })
}

function toast(msg, bad = false) {
  const el = $("toast")
  el.textContent = String(msg)
  el.classList.toggle("bad", !!bad)
  el.classList.add("show")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000)
}
function setStatus(text, ok) {
  const el = $("status")
  el.textContent = text
  el.classList.toggle("ok", ok === true)
  el.classList.toggle("bad", ok === false)
}
function on(btn, fn) {
  btn?.addEventListener("click", async () => {
    if (btn.disabled) return
    btn.disabled = true
    try {
      await fn()
    } catch (e) {
      toast(String(e?.message ?? e), true)
    } finally {
      btn.disabled = false
    }
  })
}

// ── tab ────────────────────────────────────────────────────────────────
const TABS = ["account", "invite", "benefit", "settings", "bind"]
function activateTab(name) {
  for (const t of TABS) {
    const tab = $(`tab-${t}`)
    const pane = $(`pane-${t}`)
    const isOn = t === name
    tab.classList.toggle("is-on", isOn)
    tab.setAttribute("aria-selected", String(isOn))
    tab.tabIndex = isOn ? 0 : -1
    pane.classList.toggle("is-on", isOn)
    if (isOn) pane.removeAttribute("hidden")
    else pane.setAttribute("hidden", "")
  }
  // 绑定门户的池子状态只在切到那个 tab 时读（只读本地快照，不打上游）
  if (name === "bind") void loadBindPool()
}
for (const t of TABS) $(`tab-${t}`)?.addEventListener("click", () => activateTab(t))

// ── ① 账号表 ───────────────────────────────────────────────────────────
const state = {
  accounts: [],
  selected: new Set(),
  sort: { key: "accountId", dir: 1 },
  recordsPage: 1,
  recordsSize: 10,
}

function statusOf(a) {
  const left = daysLeft(a.expires)
  if (left !== null && left < 0) return { text: "已过期", cls: "fail" }
  if (!a.hasPlatformToken) return { text: "无平台 token", cls: "warn" }
  // 平台要求先绑微信（签到 / 绑定邀请码都会回 wechat_bind_required）
  if (a.wechatRequired === true) return { text: "需绑微信", cls: "warn" }
  return { text: "正常", cls: "done" }
}

function sortedAccounts() {
  const list = [...state.accounts]
  const { key, dir } = state.sort
  list.sort((a, b) => {
    const va = key === "points" ? Number(a.points ?? -1) : key === "expires" ? Number(a.expires) || 0 : String(a[key] ?? "")
    const vb = key === "points" ? Number(b.points ?? -1) : key === "expires" ? Number(b.expires) || 0 : String(b[key] ?? "")
    if (va === vb) return 0
    return va > vb ? dir : -dir
  })
  return list
}

function renderAccounts(data) {
  const list = data?.accounts ?? []
  state.accounts = list

  const sum = list.reduce((acc, a) => acc + (Number(a.points) || 0), 0)
  const anyPoints = list.some((a) => a.points != null)
  $("stat-accounts").textContent = String(list.length)
  $("stat-points").textContent = anyPoints ? fmtNum(sum) : "—"
  const expiries = list.map((a) => Number(a.expires) || 0).filter((n) => n > 0)
  $("stat-expire").textContent = expiries.length ? fmtTime(Math.min(...expiries)) : "—"
  $("accounts-cache-note").textContent = data?.at ? `缓存：${fmtAgo(data.at)}` : "还没有缓存"
  $("stat-points-at").textContent = data?.at ? `缓存于 ${fmtAgo(data.at)}` : "来自缓存，点「刷新」更新"

  const body = $("accounts-body")
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty">还没有 quwork 账号</div></td></tr>'
    updateSelectionUi()
    return
  }

  body.innerHTML = sortedAccounts()
    .map((a) => {
      const st = statusOf(a)
      const left = daysLeft(a.expires)
      const leftText = left === null ? "" : left < 0 ? `（已过期 ${-left} 天）` : `（剩 ${left} 天）`
      const checked = state.selected.has(a.key) ? "checked" : ""
      return `<tr data-key="${esc(a.key)}">
        <td class="col-check"><input type="checkbox" class="row-check" data-key="${esc(a.key)}" ${checked} aria-label="选择 ${esc(a.accountId)}"></td>
        <td>${esc(a.accountId || "—")}<small class="mono">${esc(a.key)}</small></td>
        <td><span class="pill ${st.cls}">${esc(st.text)}</span></td>
        <td>${a.points == null ? "—" : fmtNum(a.points)}</td>
        <td>${esc(fmtTime(a.expires))}<small>${esc(leftText)}</small></td>
        <td>${a.models == null ? "—" : fmtNum(a.models)}</td>
        <td class="row-actions">
          <button class="tiny" data-act="refresh" data-key="${esc(a.key)}">刷新</button>
          <button class="tiny" data-act="copy" data-key="${esc(a.key)}">复制 token</button>
          ${st.text === "需绑微信" ? `<button class="tiny primary" data-act="wechat" data-key="${esc(a.key)}">绑定微信</button>` : ""}
          <button class="tiny danger" data-act="delete" data-key="${esc(a.key)}">删除</button>
        </td>
      </tr>`
    })
    .join("")

  updateSelectionUi()
}

function updateSelectionUi() {
  const n = state.selected.size
  $("selected-count").textContent = `已选 ${n}`
  const allChecked = state.accounts.length > 0 && n === state.accounts.length
  $("check-all").checked = allChecked
  $("delete-selected").disabled = n === 0
  $("refresh-selected").disabled = n === 0
}

async function loadAccounts() {
  const data = await api("/api/accounts")
  renderAccounts(data)
  return data
}

// 行内勾选
$("accounts-body")?.addEventListener("change", (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement) || !el.classList.contains("row-check")) return
  const key = el.dataset.key
  if (el.checked) state.selected.add(key)
  else state.selected.delete(key)
  updateSelectionUi()
})

// 行内操作
$("accounts-body")?.addEventListener("click", async (e) => {
  const el = e.target
  if (!(el instanceof HTMLButtonElement)) return
  const act = el.dataset.act
  const key = el.dataset.key
  if (!act || !key) return

  if (act === "refresh") {
    el.disabled = true
    try {
      const d = await api("/api/accounts/refresh", { keys: [key] })
      await loadAccounts()
      toast(`已刷新 ${d.okCount}/${d.total}`)
    } finally {
      el.disabled = false
    }
    return
  }
  if (act === "copy") {
    const acc = state.accounts.find((a) => a.key === key)
    const text = acc?.llmToken ?? ""
    if (!text) return toast("这个账号没有模型 token", true)
    try {
      await navigator.clipboard.writeText(text)
      toast("已复制（打码显示，复制的是完整值请以 magpie 配置为准）")
    } catch {
      toast("复制失败，请在 plugin-auth.json 里查看", true)
    }
    return
  }
  if (act === "qr") {
    return showQrRow(el, key)
  }
  if (act === "wechat") {
    return openWechatPanel(key)
  }
  if (act === "delete") {
    const acc = state.accounts.find((a) => a.key === key)
    if (!acc) return
    if (!(await askDialog({ title: "删除账号", body: `确定删除 ${acc.accountId || key}？\n会先备份 plugin-auth.json。` }))) return
    const d = await api("/api/accounts/delete", { keys: [key] })
    state.selected.delete(key)
    await loadAccounts()
    toast(`已删除 ${d.deleted?.length ?? 1} 个账号（备份：${String(d.backup).split(/[\\/]/).pop()}）`)
  }
})

$("check-all")?.addEventListener("change", (e) => {
  if (e.target.checked) for (const a of state.accounts) state.selected.add(a.key)
  else state.selected.clear()
  renderAccounts({ accounts: state.accounts, at: 0 })
})

// ── 微信绑定小面板 ─────────────────────────────────────────────────────
//
// 链路：① 打开授权页 → 用户扫码 → 落到 llm.rrzu.com/oauth/wechat?code=…&state=…
//      ② 用户把地址栏整段粘回来 → 服务端换 wechat_token 并绑定。
//
// ⚠ redirect_uri 必须是已备案域名，不能指向 127.0.0.1，所以「粘贴回调」是必须的一步。

const wechatState = { key: "" }

/**
 * 点「出码」→ 在账号行下面就地展开这个号的绑定二维码（再点一次收起）。
 *
 * # 为什么要有「指定账号出码」
 *
 * 门户（`/bind/go`）是「随便给我一个还没绑的号」，操作者不知道给的是哪一个；
 * 在面板里点某个号，要的就是**这个**号 —— 走 `/bind/api/qr?key=…`：
 * 先实测 `/api/user/self`（已绑的直接拒绝，别让人白扫），再取平台签发的 state 出码，
 * 并且登记会话，所以下面「查一次状态」能看到它是否绑上了。
 *
 * 二维码下面给三样东西：授权链接（可复制发给别人，他用浏览器打开就出码）、
 * 会话编号（对账用）、有效期（10 分钟，与微信 code / wechat_token 对齐）。
 *
 * @param {HTMLButtonElement} btn
 * @param {string} key
 */
async function showQrRow(btn, key) {
  const tr = btn.closest("tr")
  if (!tr) return
  const opened = tr.nextElementSibling
  if (opened && opened.classList.contains("qr-row")) {
    opened.remove()
    return
  }

  btn.disabled = true
  try {
    const d = await api(`/bind/api/qr?key=${encodeURIComponent(key)}`)
    if (!d.ok) {
      toast(String(d.error || "出码失败"), true)
      return
    }

    const row = document.createElement("tr")
    row.className = "qr-row"
    row.innerHTML = `<td colspan="7">
      <div class="qr-box">
        <img class="qr-img" src="${esc(d.qr || "")}" alt="微信扫码绑定 ${esc(d.label || "")}" width="200" height="200">
        <div class="qr-side">
          <p class="big">${esc(d.label)} · 待绑定</p>
          <p class="hint">手机微信「扫一扫」扫左边这张（相册 / 长按识别无效），再点「确认登录」。</p>
          <p class="hint">有效期 ${Math.round((Number(d.ttlMs) || 0) / 1000)} 秒 · uuid <span class="mono">${esc(d.uuid || "")}</span></p>
          <div class="toolbar-actions">
            <button class="tiny" data-qr="copy">复制扫码链接</button>
            <button class="tiny" data-qr="poll">查一次状态</button>
            <button class="tiny danger" data-qr="close">收起</button>
          </div>
          <p class="hint" data-qr="status">等待扫码…</p>
          <p class="hint" style="margin-top:6px;color:#b45309">
            <strong>更可靠的做法（真绑定）</strong>：下面这个按钮走「扫完把地址粘回来」的流程 ——
            扫码的人点完「确认登录」后，把你给他的那串地址整段发回来，贴进去就能真绑上这个号。
          </p>
          <div class="toolbar-actions">
            <button class="tiny primary" data-qr="paste">用回调地址完成绑定</button>
          </div>
          <div data-qr="paste-box" hidden style="margin-top:6px">
            <input class="field-input" data-qr="paste-input" style="width:100%;margin-bottom:6px"
              placeholder="粘贴 https://llm.rrzu.com/oauth/wechat?code=...&state=... 整段">
            <button class="tiny primary" data-qr="paste-do">提交绑定</button>
          </div>
        </div>
      </div>
    </td>`
    tr.after(row)

    const status = row.querySelector('[data-qr="status"]')
    row.querySelector('[data-qr="close"]').addEventListener("click", () => row.remove())
    row.querySelector('[data-qr="copy"]').addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(d.authorizeUrl ?? ""))
        toast("授权链接已复制，发给别人用浏览器打开即可出码")
      } catch {
        toast("复制失败：请手动选中下面的链接复制", true)
        status.textContent = String(d.confirmUrl || d.authorizeUrl || "")
      }
    })
    row.querySelector('[data-qr="poll"]').addEventListener("click", async () => {
      try {
        const st = await api(`/bind/api/check?session=${encodeURIComponent(d.sessionId)}`)
        status.textContent =
          st.status === "bound"
            ? "✅ 已绑定"
            : st.status === "expired"
              ? "⏳ 已过期，重新点「出码」"
              : `等待中…${st.message ? "（" + st.message + "）" : ""}`
        if (st.status === "bound") {
          toast("这个号已绑定成功")
          void loadAccounts()
        }
      } catch (e) {
        status.textContent = `查询失败：${String(e?.message ?? e)}`
      }
    })

    // 盯着这一行：新链路在服务端监听微信，前端只把状态显示出来。
    // ⚠ 不用 setInterval（面板不许有常驻轮询）：用自我重排的 setTimeout，
    //   行一收起 / 会话一落定就停，不会在上游留下长跑请求。
    let alive = true
    const map = {
      waiting: "等待扫码…",
      scanned: "👀 已扫码，等他在微信里点「确认登录」",
      confirmed: "⏳ 已确认，正在换 token 并绑定…",
    }
    const tick = async () => {
      if (!alive || !row.isConnected) return
      try {
        const st = await api(`/bind/api/check?session=${encodeURIComponent(d.sessionId)}`)
        if (st.status === "bound") {
          alive = false
          status.textContent = "✅ 已绑定（平台已确认）"
          toast("绑定成功")
          void loadAccounts()
          return
        }
        if (st.status === "expired") {
          alive = false
          status.textContent = `⏳ ${st.message || "已过期，重新点「出码」"}`
          return
        }
        status.textContent = map[st.scanState] || `等待中…${st.message ? "（" + st.message + "）" : ""}`
      } catch {}
      if (alive) setTimeout(tick, 2000)
    }
    setTimeout(tick, 1500)
    row.querySelector('[data-qr="close"]').addEventListener("click", () => { alive = false })

    // 兜底：万一自动监听不通，还能手动「用回调地址完成绑定」（POST /api/wechat/finish）
    const box = row.querySelector('[data-qr="paste-box"]')
    row.querySelector('[data-qr="paste"]').addEventListener("click", () => {
      box.hidden = !box.hidden
      if (!box.hidden) row.querySelector('[data-qr="paste-input"]').focus()
    })
    row.querySelector('[data-qr="paste-do"]').addEventListener("click", async () => {
      const callbackUrl = String(row.querySelector('[data-qr="paste-input"]').value ?? "").trim()
      if (!callbackUrl) return toast("先把扫码后的地址粘进来", true)
      status.textContent = "正在换 wechat_token 并绑定…"
      try {
        const r = await api("/api/wechat/finish", { key, callbackUrl })
        if (!r?.ok) {
          status.textContent = `❌ ${r?.error ?? "绑定失败"}`
          toast(String(r?.error ?? "绑定失败"), true)
          return
        }
        status.textContent = "✅ 已绑定（平台确认 wechat_bound=true）"
        toast("绑定成功")
        box.hidden = true
        void loadAccounts()
      } catch (e) {
        status.textContent = `❌ ${String(e?.message ?? e)}`
        toast(String(e?.message ?? e), true)
      }
    })
  } finally {
    btn.disabled = false
  }
}

function openWechatPanel(key) {
  const acc = state.accounts.find((a) => a.key === key)
  wechatState.key = key
  $("wechat-panel").hidden = false
  $("wechat-account").textContent = acc ? `${acc.accountId || key}（${key}）` : key
  $("wechat-callback").value = ""
  $("wechat-note").textContent = ""
  $("wechat-state-note").textContent = ""
  $("wechat-panel").scrollIntoView({ behavior: "smooth", block: "nearest" })
}

$("wechat-close")?.addEventListener("click", () => {
  $("wechat-panel").hidden = true
  wechatState.key = ""
})

on($("wechat-start"), async () => {
  if (!wechatState.key) return toast("先选一个账号", true)
  const d = await api("/api/wechat/start", { key: wechatState.key })
  if (!d.ok) return toast(d.error || "生成授权页失败", true)

  $("wechat-state-note").textContent = `已生成 state（10 分钟内有效）：${String(d.state).slice(0, 8)}…`
  // 交给系统浏览器打开（面板本身不弹窗）
  try {
    window.open(d.url, "_blank", "noopener,noreferrer")
  } catch {
    /* 被拦截就让用户手动点链接 */
  }
  $("wechat-note").textContent = "已打开授权页，扫码后把回调地址粘到下面"
  $("wechat-note").className = "status"
  toast("已打开微信授权页")
})

on($("wechat-finish"), async () => {
  const callbackUrl = $("wechat-callback").value.trim()
  const note = $("wechat-note")
  if (!callbackUrl) {
    note.textContent = "请粘贴回调地址"
    note.className = "status bad"
    return
  }
  const d = await api("/api/wechat/finish", { key: wechatState.key, callbackUrl })
  if (!d.ok) {
    note.textContent = d.error || "绑定失败"
    note.className = "status bad"
    toast(note.textContent, true)
    return
  }
  note.textContent = d.message || "绑定成功"
  note.className = "status ok"
  await loadAccounts()
  toast("绑定成功")
})

for (const th of document.querySelectorAll("th.sortable")) {
  th.addEventListener("click", () => {
    const key = th.dataset.sort
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 }
    renderAccounts({ accounts: state.accounts, at: 0 })
  })
}

on($("select-all"), () => {
  for (const a of state.accounts) state.selected.add(a.key)
  renderAccounts({ accounts: state.accounts, at: 0 })
})
on($("select-none"), () => {
  state.selected.clear()
  renderAccounts({ accounts: state.accounts, at: 0 })
})
on($("refresh-selected"), async () => {
  const keys = [...state.selected]
  if (keys.length === 0) return toast("先选中账号", true)
  setStatus(`刷新 ${keys.length} 个账号…`)
  const d = await api("/api/accounts/refresh", { keys })
  await loadAccounts()
  setStatus(`已刷新 ${d.okCount}/${d.total}`, true)
  toast("选中账号已刷新")
})
on($("delete-selected"), async () => {
  const keys = [...state.selected]
  if (keys.length === 0) return toast("先选中账号", true)
  if (!(await askDialog({ title: "删除账号", body: `确定删除 ${keys.length} 个账号？\n会先备份 plugin-auth.json。` }))) return
  const d = await api("/api/accounts/delete", { keys })
  state.selected.clear()
  await loadAccounts()
  toast(`已删除 ${d.deleted?.length ?? keys.length} 个账号`)
})


// ── ② 邀请（多账号表格）───────────────────────────────────────────────
//
// 每行 = 一个账号。读接口只读缓存（零上游）；「读取 / 绑定 / 记录」都只对**选中**账号生效，
// 每行单独用一个账号自己的 token（后端按 `key` 找 token）。

const inviteState = { accounts: [], selected: new Set(), recordsKey: "", recordsPage: 1 }

function inviteSelectedKeys() {
  return [...inviteState.selected]
}

function updateInviteSelectionUi() {
  const n = inviteState.selected.size
  $("invite-selected-count").textContent = `已选 ${n}`
  $("invite-check-all").checked = inviteState.accounts.length > 0 && n === inviteState.accounts.length
  $("invite-refresh-selected").disabled = n === 0
  $("activate-run").disabled = n === 0
  $("records-run").disabled = n === 0 && !inviteState.recordsKey
}

function renderInvite(data) {
  const list = data?.accounts ?? []
  inviteState.accounts = list
  $("invite-cache-note").textContent = data?.at ? `缓存：${fmtAgo(data.at)}` : "还没有缓存"

  const body = $("invite-body")
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="8"><div class="empty">还没有 quwork 账号</div></td></tr>'
    updateInviteSelectionUi()
    return
  }

  body.innerHTML = list
    .map((a) => {
      const checked = inviteState.selected.has(a.key) ? "checked" : ""
      const code = a.inviteCode ? `<code class="invite-code-big">${esc(a.inviteCode)}</code>` : "—"
      return `<tr data-key="${esc(a.key)}"${inviteState.recordsKey === a.key ? ' class="is-current"' : ""}>
        <td class="col-check"><input type="checkbox" class="invite-check" data-key="${esc(a.key)}" ${checked} aria-label="选择 ${esc(a.accountId)}"></td>
        <td>${esc(a.accountId || "—")}<small class="mono">${esc(a.key)}</small></td>
        <td>${code}</td>
        <td>${a.invitedCount == null ? "—" : fmtNum(a.invitedCount)}</td>
        <td>${a.points == null ? "—" : fmtNum(a.points)}</td>
        <td>${a.quota == null ? "—" : fmtNum(a.quota)}</td>
        <td>${a.at ? fmtAgo(a.at) : "无缓存"}</td>
        <td class="row-actions">
          <button class="tiny" data-iact="read" data-key="${esc(a.key)}">读取</button>
          <button class="tiny" data-iact="copy" data-key="${esc(a.key)}">复制</button>
        </td>
      </tr>`
    })
    .join("")

  updateInviteSelectionUi()
}

async function loadInvite() {
  const data = await api("/api/invite/summary")
  renderInvite(data)
  return data
}

$("invite-body")?.addEventListener("change", (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement) || !el.classList.contains("invite-check")) return
  if (el.checked) inviteState.selected.add(el.dataset.key)
  else inviteState.selected.delete(el.dataset.key)
  updateInviteSelectionUi()
})

$("invite-body")?.addEventListener("click", async (e) => {
  const el = e.target
  if (!(el instanceof HTMLButtonElement)) return
  const key = el.dataset.key
  const act = el.dataset.iact

  if (act === "copy") {
    const acc = inviteState.accounts.find((a) => a.key === key)
    if (!acc?.inviteCode) return toast("这个账号还没有邀请码，先点「读取」", true)
    try {
      await navigator.clipboard.writeText(String(acc.inviteCode))
      toast(`已复制 ${acc.inviteCode}`)
    } catch {
      toast(`复制失败，请手动选中：${acc.inviteCode}`, true)
    }
    return
  }
  if (act === "read") {
    el.disabled = true
    try {
      const d = await api("/api/invite/refresh", { keys: [key] })
      await loadInvite()
      toast(`已读取 ${d.okCount ?? 0}/${d.total ?? 1}`)
    } finally {
      el.disabled = false
    }
  }
})

$("invite-check-all")?.addEventListener("change", (e) => {
  if (e.target.checked) for (const a of inviteState.accounts) inviteState.selected.add(a.key)
  else inviteState.selected.clear()
  renderInvite({ accounts: inviteState.accounts, at: 0 })
})

on($("invite-select-all"), () => {
  for (const a of inviteState.accounts) inviteState.selected.add(a.key)
  renderInvite({ accounts: inviteState.accounts, at: 0 })
})
on($("invite-select-none"), () => {
  inviteState.selected.clear()
  renderInvite({ accounts: inviteState.accounts, at: 0 })
})

on($("invite-refresh-selected"), async () => {
  const keys = inviteSelectedKeys()
  if (keys.length === 0) return toast("先选中账号", true)

  const bar = $("invite-progress")
  bar.hidden = false
  bar.querySelector("i").style.width = "0%"

  setStatus(`读取 ${keys.length} 个账号的邀请码…`)
  const d = await api("/api/invite/refresh", { keys })
  await loadInvite()

  bar.querySelector("i").style.width = "100%"
  setTimeout(() => {
    bar.hidden = true
  }, 600)

  setStatus(`邀请码已更新 ${d.okCount ?? 0}/${d.total ?? keys.length}`, true)
  toast("邀请码已更新")
})

on($("activate-run"), async () => {
  const keys = inviteSelectedKeys()
  const note = $("activate-note")
  const inviteCode = $("activate-code").value.trim()

  if (keys.length === 0) {
    note.textContent = "先选中要绑定的账号"
    note.className = "status bad"
    return
  }
  if (!inviteCode) {
    note.textContent = "请输入邀请码"
    note.className = "status bad"
    return
  }

  // 一次只绑一个账号（平台语义就是「这个号绑那个码」），多选时逐个来并汇总
  const results = []
  for (const key of keys) {
    const d = await api("/api/invite/activate", { key, inviteCode })
    const who = inviteState.accounts.find((a) => a.key === key)?.accountId ?? key
    results.push(`${who}: ${d.message || (d.ok ? "绑定成功" : "绑定失败")}`)
  }
  note.textContent = results.join(" · ")
  note.className = `status ${results.every((r) => r.includes("成功")) ? "ok" : "bad"}`
  toast(results.join(" · "), !results.every((r) => r.includes("成功")))
})

// ── 邀请记录（选中账号后显示）──────────────────────────────────────────

function currentRecordsKey() {
  return inviteState.recordsKey || inviteSelectedKeys()[0] || ""
}

function renderRecords(list, { total = 0, page = 1, size = 10 } = {}) {
  const body = $("records-body")
  if (!Array.isArray(list) || list.length === 0) {
    body.innerHTML = '<tr><td colspan="4"><div class="empty">没有邀请记录</div></td></tr>'
  } else {
    body.innerHTML = list
      .map(
        (r) => `<tr>
          <td>${esc(fmtTime(r?.created_at ?? r?.createdAt))}</td>
          <td>${esc(r?.phone ?? r?.invitee_phone ?? "—")}</td>
          <td>${esc(r?.status ?? (r?.activated === true ? "已激活" : "—"))}</td>
          <td>${fmtNum(r?.points ?? r?.reward_points)}</td>
        </tr>`,
      )
      .join("")
  }
  const pages = size > 0 ? Math.max(1, Math.ceil(Number(total) / size)) : 1
  const who = inviteState.accounts.find((a) => a.key === inviteState.recordsKey)?.accountId
  $("records-title").textContent = who ? `邀请记录 · ${who}` : "邀请记录"
  $("records-note").textContent = `第 ${page}/${pages} 页 · 共 ${total} 条`
  inviteState.recordsPage = page
}

async function loadRecordsPage(page = 1) {
  const key = currentRecordsKey()
  if (!key) throw new Error("先在表格里选一个账号")
  inviteState.recordsKey = key
  const size = Number($("records-size").value) || 10
  renderInvite({ accounts: inviteState.accounts, at: 0 })

  const d = await api(`/api/invite/records?key=${encodeURIComponent(key)}&page=${page}&size=${size}`)
  if (!d.ok) throw new Error(d.error || "读取失败")
  renderRecords(d.list, { total: d.total, page: d.page, size: d.size })
}

on($("records-run"), async () => {
  await loadRecordsPage(1)
  toast("邀请记录已更新")
})
on($("records-page-prev"), () => loadRecordsPage(Math.max(1, inviteState.recordsPage - 1)))
on($("records-page-next"), () => loadRecordsPage(inviteState.recordsPage + 1))

// ── ③ 权益（多账号表格）───────────────────────────────────────────────

const rewardState = { accounts: [], selected: new Set() }

function rewardSelectedKeys() {
  return [...rewardState.selected]
}

function updateRewardSelectionUi() {
  const n = rewardState.selected.size
  $("reward-selected-count").textContent = `已选 ${n}`
  $("reward-check-all").checked = rewardState.accounts.length > 0 && n === rewardState.accounts.length
  $("reward-status-refresh").disabled = n === 0
  $("reward-claim-selected").disabled = n === 0
}

function renderRewardStatus(data) {
  const list = data?.accounts ?? []
  rewardState.accounts = list
  updateKeyOptions(list, rewardState.selected)

  const body = $("reward-body")
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="8"><div class="empty">还没有 quwork 账号</div></td></tr>'
    updateRewardSelectionUi()
    return
  }

  body.innerHTML = list
    .map((a) => {
      const checked = rewardState.selected.has(a.key) ? "checked" : ""
      const st = a.claimed === true ? { t: "已签到", c: "done" } : a.canClaim === true ? { t: "可签到", c: "warn" } : a.canClaim === false ? { t: "不可签到", c: "" } : { t: "未知", c: "" }
      const wx = a.wechatRequired === true ? '<span class="pill warn">是</span>' : a.wechatRequired === false ? '<span class="pill done">否</span>' : "—"
      return `<tr data-key="${esc(a.key)}">
        <td class="col-check"><input type="checkbox" class="reward-check" data-key="${esc(a.key)}" ${checked} aria-label="选择 ${esc(a.accountId)}"></td>
        <td>${esc(a.accountId || "—")}<small class="mono">${esc(a.key)}</small></td>
        <td><span class="pill ${st.c}">${esc(st.t)}</span>${a.consecutiveDays != null ? `<small>连续 ${a.consecutiveDays} 天</small>` : ""}</td>
        <td>${a.points == null ? "—" : fmtNum(a.points)}</td>
        <td>${a.nextRefreshAt ? fmtTime(a.nextRefreshAt) : "—"}</td>
        <td>${wx}</td>
        <td>${a.at ? fmtAgo(a.at) : "无缓存"}</td>
        <td class="row-actions">
          <button class="tiny" data-ract="query" data-key="${esc(a.key)}">查询</button>
          <button class="tiny" data-ract="claim" data-key="${esc(a.key)}">签到</button>
        </td>
      </tr>`
    })
    .join("")

  updateRewardSelectionUi()
}

/** 兑换下拉：跟着账号列表刷新。 */
function updateKeyOptions(list, selected) {
  const sel = $("redeem-key")
  if (!sel) return
  const current = sel.value
  sel.innerHTML = list.map((a) => `<option value="${esc(a.key)}">${esc(a.accountId || a.key)}</option>`).join("")
  const wanted = current || [...selected][0]
  if (wanted && list.some((a) => a.key === wanted)) sel.value = wanted
}

async function loadRewardStatus() {
  const data = await api("/api/reward/status")
  renderRewardStatus(data)
  return data
}

$("reward-body")?.addEventListener("change", (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement) || !el.classList.contains("reward-check")) return
  if (el.checked) rewardState.selected.add(el.dataset.key)
  else rewardState.selected.delete(el.dataset.key)
  updateRewardSelectionUi()
})

$("reward-body")?.addEventListener("click", async (e) => {
  const el = e.target
  if (!(el instanceof HTMLButtonElement)) return
  const key = el.dataset.key
  const act = el.dataset.ract
  const note = $("reward-note")

  if (act === "query") {
    el.disabled = true
    try {
      const d = await api("/api/reward/status/refresh", { keys: [key] })
      await loadRewardStatus()
      note.textContent = d.ok ? "已查询" : d.error || "查询失败"
      note.className = `status ${d.ok ? "" : "bad"}`
    } finally {
      el.disabled = false
    }
    return
  }
  if (act === "claim") {
    el.disabled = true
    try {
      const d = await api("/api/reward/claim", { key })
      await loadRewardStatus()
      note.textContent = d.ok ? `签到成功：+${d.granted ?? 0}` : d.message || d.error || "签到失败"
      note.className = `status ${d.ok ? "ok" : "bad"}`
    } finally {
      el.disabled = false
    }
  }
})

$("reward-check-all")?.addEventListener("change", (e) => {
  if (e.target.checked) for (const a of rewardState.accounts) rewardState.selected.add(a.key)
  else rewardState.selected.clear()
  renderRewardStatus({ accounts: rewardState.accounts, at: 0 })
})

on($("reward-select-all"), () => {
  for (const a of rewardState.accounts) rewardState.selected.add(a.key)
  renderRewardStatus({ accounts: rewardState.accounts, at: 0 })
})
on($("reward-select-none"), () => {
  rewardState.selected.clear()
  renderRewardStatus({ accounts: rewardState.accounts, at: 0 })
})

on($("reward-status-refresh"), async () => {
  const keys = rewardSelectedKeys()
  if (keys.length === 0) return toast("先选中账号", true)
  setStatus(`查询 ${keys.length} 个账号的签到状态…`)
  const d = await api("/api/reward/status/refresh", { keys })
  await loadRewardStatus()
  $("reward-note").textContent = `已查询 ${d.okCount ?? 0}/${d.total ?? keys.length}`
  $("reward-note").className = "status"
  setStatus("签到状态已更新", true)
})

on($("reward-claim-selected"), async () => {
  const keys = rewardSelectedKeys()
  if (keys.length === 0) return toast("先选中账号", true)

  const lines = []
  for (const key of keys) {
    const d = await api("/api/reward/claim", { key })
    const who = rewardState.accounts.find((a) => a.key === key)?.accountId ?? key
    lines.push(`${who}: ${d.ok ? `+${d.granted ?? 0}` : d.message || d.error || "失败"}`)
  }
  await loadRewardStatus()
  $("reward-note").textContent = lines.join(" · ")
  $("reward-note").className = "status"
  toast("签到已执行")
})

on($("gifts-load"), async () => {
  const key = $("redeem-key")?.value || rewardSelectedKeys()[0]
  const body = $("gifts-body")
  if (!key) {
    body.innerHTML = '<tr><td colspan="4"><div class="empty">先选择一个账号</div></td></tr>'
    return
  }
  const d = await api(`/api/reward/gifts?key=${encodeURIComponent(key)}`)
  const list = d.ok ? (d.list ?? []) : []
  const who = rewardState.accounts.find((a) => a.key === key)?.accountId ?? key
  $("gifts-note").textContent = d.ok ? `${list.length} 项` : d.message || d.error || "读取失败"
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="4"><div class="empty">暂无月月送活动</div></td></tr>'
    return
  }
  body.innerHTML = list
    .map(
      (g) => `<tr>
        <td>${esc(who)}</td>
        <td>${esc(g?.name ?? g?.title ?? "—")}</td>
        <td class="mono">${esc(g?.description ?? JSON.stringify(g))}</td>
        <td>${esc(g?.expire_at ? fmtTime(g.expire_at) : "—")}</td>
      </tr>`,
    )
    .join("")
})

on($("redeem-run"), async () => {
  const note = $("redeem-note")
  const key = $("redeem-key")?.value || ""
  const orderId = $("redeem-order").value.trim()
  if (!key) {
    note.textContent = "先选择账号"
    note.className = "status bad"
    return
  }
  const d = await api("/api/benefit/redeem", { key, orderId })
  note.textContent = d.message || (d.ok ? "兑换成功" : "兑换失败")
  note.className = `status ${d.ok ? "ok" : "bad"}`
})

// ── ④ 设置 ─────────────────────────────────────────────────────────────
function renderSettings(data) {
  const s = data?.settings ?? {}
  $("setting-port").value = s.port ?? ""
  $("setting-auto").checked = s.autoRefresh === true
  $("setting-acc-conc").value = s.accountsConcurrency ?? 1
  $("setting-pages").value = s.recordsPages ?? 3
  $("settings-path").textContent = data?.path ?? "—"
}
async function loadSettings() {
  const data = await api("/api/settings")
  renderSettings(data)
  return data
}
async function saveSettings() {
  const payload = {
    port: Number($("setting-port").value) || undefined,
    autoRefresh: $("setting-auto").checked,
    accountsConcurrency: Number($("setting-acc-conc").value) || 1,
    recordsPages: Number($("setting-pages").value) || 3,
  }
  const data = await api("/api/settings", payload)
  renderSettings(data)
  $("settings-note").textContent = "已保存"
  setTimeout(() => {
    $("settings-note").textContent = ""
  }, 2500)
}
for (const id of ["setting-port", "setting-auto", "setting-acc-conc", "setting-pages"]) {
  $(id)?.addEventListener("change", () => saveSettings().catch((e) => toast(String(e?.message ?? e), true)))
}

// ── ⑤ 扫码绑定门户 ─────────────────────────────────────────────────────
//
// 这个 tab 只是「看池子 + 拿固定码」：
//   固定码 URL = `<面板服务根>/bind/qr.png`，内容是 `<公网地址>/bind/go`，图案永不变。
//   真正扫码的人走的是 `/bind/go`（对陌生人开放，页面里只有编号，没有手机号）。
function bindStateCell(a) {
  if (a.tokenInvalid) return { text: "token 失效", cls: "fail" }
  if (a.wechatBound) return { text: "已绑微信", cls: "done" }
  return { text: "未绑（可分配）", cls: "warn" }
}

function renderBind(data) {
  // 记下最近一次数据：切换筛选时直接重绘，不用再打一次上游
  state.bindData = data
  const allAccounts = Array.isArray(data?.accounts) ? data.accounts : []
  const filter = $("bind-filter")?.value || "24h"
  const accounts = allAccounts.filter((x) => {
    if (filter === "today") return x.registeredToday === true
    if (filter === "24h") return x.inviteEligible === true
    return true
  })
  $("bind-summary").textContent =
    `共 ${data?.total ?? allAccounts.length} · 已绑 ${data?.bound ?? 0} · 可分配 ${data?.available ?? 0}` +
    (data?.broken ? ` · 失效 ${data.broken}` : "") +
    (data?.todayCount ? ` · 今天注册 ${data.todayCount}` : "") +
    (data?.inviteEligible ? ` · 可补邀请 ${data.inviteEligible}` : "")
  $("bind-note").textContent = data?.updatedAt ? `快照：${fmtAgo(data.updatedAt)}` : "还没有快照，点「刷新全部账号状态」"

  $("bind-body").innerHTML = accounts.length
    ? accounts
        .map((a) => {
          const st = bindStateCell(a)
          return `<tr>
            <td>${esc(a.label ?? a.key)}</td>
            <td><span class="pill ${st.cls}">${esc(st.text)}</span></td>
            <td>${fmtNum(a.quota)}</td>
            <td>
              ${a.createdTime ? esc(new Date(a.createdTime * 1000).toLocaleDateString("zh-CN")) : "—"}
              ${a.registeredToday ? '<span class="pill ok">今天</span>' : ""}
              ${a.inviteEligible && !a.registeredToday ? '<span class="pill">24h内</span>' : ""}
            </td>
            <td class="row-actions">
              ${a.wechatBound ? '<span class="muted">—</span>' : `<button class="tiny primary bind-qr-btn" data-key="${esc(a.key)}" data-label="${esc(a.label ?? a.key)}">出码</button>`}
            </td>
          </tr>`
        })
        .join("")
    : `<tr><td colspan="5"><div class="empty">` +
      (filter === "24h"
        ? "没有「24 小时内注册」的账号。邀请码只认这个窗口；老号绑微信后只能签到，补不了邀请。<br>要把老号绑上微信做签到，把上面的筛选切到「全部未绑」。"
        : filter === "today"
          ? "今天没有新注册的账号。"
          : "没有 quwork 账号（先在账号页添加）") +
      "</div></td></tr>"
}

async function loadBindPool() {
  try {
    renderBind(await api("/bind/api/pool"))
  } catch (e) {
    $("bind-body").innerHTML = `<tr><td colspan="5"><div class="empty bad">读取失败：${esc(String(e?.message ?? e))}</div></td></tr>`
  }
  // 公网地址与固定码：顺手带上（都是只读本地文件）
  try {
    const s = await api("/api/settings")
    $("bind-public").value = String(s?.settings?.bindPublicUrl ?? "")
  } catch {
    /* 设置读不到不影响看池子 */
  }
  void refreshBindQr()
}

/**
 * 刷新固定码图片，并把**图片里真正编码的那条 URL**显示出来（读响应的 `x-qr-target`）。
 *
 * 为什么要读响应头：固定码的内容由「环境变量 / 面板设置 / 请求头」三级决定，
 * 页面上猜不出来；只有服务端自己知道最终拼成了什么。
 */
async function refreshBindQr() {
  // 公网地址是随机隧道，重启就变 —— 所以这里**只给链接**，不画二维码
  const bust = BASE + "/bind/qr.png?scale=8&t=" + Date.now()
  let target = ""
  try {
    const head = await fetch(bust, { method: "HEAD" })
    target = String(head.headers.get("x-qr-target") || "").trim()
  } catch {}

  const publicUrl = target || BASE + "/bind/go"
  const localUrl = BASE + "/bind/go"

  const aPub = $("bind-url-public")
  if (aPub) {
    aPub.textContent = publicUrl
    aPub.href = publicUrl
  }
  const aLoc = $("bind-url-local")
  if (aLoc) {
    aLoc.textContent = localUrl
    aLoc.href = localUrl
  }
  state.bindPublicUrl = publicUrl
  state.bindLocalUrl = localUrl
}

on($("bind-refresh"), loadBindPool)

// 只换筛选条件时不必再打上游：用最近一次数据重绘即可
/**
 * 批量出码：给选中的（或当前筛选里前 N 个）账号各出一张**真码**。
 *
 * 与单号「出码」走的是同一个 `prepareScan` —— 出的是 confirm?uuid= 的真码，
 * 后台自动监听扫码并完成绑定。区别只是这里一次出多张，方便截图/复制链接发出去。
 */
on($("bind-batch"), async () => {
  const btn = $("bind-batch")
  const box = $("bind-batch-codes")
  const labels = String(btn.textContent || "")

  // 选中优先；没选就用当前筛选结果的前 6 个
  let keys = [...(state.selected || [])].filter((k) => /^quwork(#\d+)?$/.test(k))
  if (keys.length === 0) {
    const data = Array.isArray(state.bindData?.accounts) ? state.bindData.accounts : []
    const filter = $("bind-filter")?.value || "24h"
    const pool = data.filter((x) => {
      if (x.wechatBound || x.tokenInvalid) return false
      if (filter === "today") return x.registeredToday === true
      if (filter === "24h") return x.inviteEligible === true
      return true
    })
    keys = pool.slice(0, 6).map((x) => x.key)
  }
  if (keys.length === 0) {
    await askDialog({
      title: "没有可出码的账号",
      body: "先在表格里勾选账号，或者把筛选切到「全部未绑」再点批量出码。",
      okText: "知道了",
      cancelText: "关闭",
    })
    return
  }
  if (keys.length > 12) keys = keys.slice(0, 12)

  btn.disabled = true
  btn.textContent = "出码中…"
  try {
    const d = await api("/bind/api/qr-batch?keys=" + encodeURIComponent(keys.join(",")))
    if (!d.ok) {
      await askDialog({ title: "出码失败", body: String(d.error || (d.failed ?? []).map((f) => f.key + ": " + f.error).join("\n") || "未知原因"), okText: "知道了", cancelText: "关闭" })
      return
    }

    box.hidden = false
    box.innerHTML = (d.cards ?? [])
      .map(
        (c, i) => `<div class="code-card" data-i="${i}">
        <div class="lb">${esc(c.label)}</div>
        <img src="${esc(c.qr || "")}" alt="${esc(c.label)}">
        <button class="tiny" data-code-act="copy" data-i="${i}">复制链接</button>
        <div class="st" data-code-st="${i}">等待扫码…</div>
      </div>`,
      )
      .join("")

    // 复制 + 每张独立轮询状态
    box.querySelectorAll('[data-code-act="copy"]').forEach((b) => {
      b.addEventListener("click", async () => {
        const c = (d.cards ?? [])[Number(b.dataset.i)]
        try {
          await navigator.clipboard.writeText(String(c?.confirmUrl ?? ""))
          toast("扫码链接已复制")
        } catch {
          toast("复制失败，请手动复制", true)
        }
      })
    })
    for (const [i, c] of (d.cards ?? []).entries()) {
      let alive = true
      const tick = async () => {
        if (!alive) return
        const el = box.querySelector('[data-code-st="' + i + '"]')
        if (!el) return
        try {
          const st = await api("/bind/api/check?session=" + encodeURIComponent(c.sessionId))
          if (st.status === "bound") {
            alive = false
            el.textContent = "✅ 已绑定"
            void loadAccounts()
            return
          }
          if (st.status === "expired") {
            alive = false
            el.textContent = "⏳ 已过期"
            return
          }
          el.textContent =
            st.scanState === "scanned" ? "👀 已扫码待确认" : st.scanState === "confirmed" ? "⏳ 正在绑定…" : `等待扫码…${Math.round((st.remainingMs || 0) / 1000)}s`
        } catch {}
        if (alive) setTimeout(tick, 3000)
      }
      setTimeout(tick, 2000)
    }
    toast(`已出 ${(d.cards ?? []).length} 张码`)
  } finally {
    btn.disabled = false
    btn.textContent = labels
  }
})

on($("bind-filter"), () => {
  if (state.bindData) renderBind(state.bindData)
})

/**
 * 「扫码绑定」页每行的「出码」：就地展开该号的绑定二维码 + 粘贴回调完成绑定。
 * 这一页就是管「谁还没绑、怎么绑」，出码 / 查状态 / 粘回调放同一处。
 */
$("bind-body")?.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLButtonElement ? e.target.closest(".bind-qr-btn") : null
  if (!btn) return
  return showQrRow(btn, btn.dataset.key)
})

on($("bind-save-public"), async () => {
  const v = String($("bind-public").value ?? "").trim()
  const d = await api("/api/settings", { bindPublicUrl: v })
  const saved = String(d?.settings?.bindPublicUrl ?? "")
  $("bind-public").value = saved
  $("bind-public-note").textContent = saved ? "已保存，链接已刷新" : "已清空（改用当前面板地址）"
  await refreshBindQr()
  toast(saved ? `固定码已指向 ${saved}` : "已清空公网地址")
})

on($("bind-sync"), async () => {
  $("bind-note").textContent = "正在逐个读取账号状态…"
  const d = await api("/bind/api/sync", {})
  renderBind(d.overview ?? d)
  toast(`已更新 ${d.updated} 个，失败 ${d.failed} 个`, d.failed > 0)
  void loadAccounts()
})

/**
 * 释放所有占位。
 *
 * 场景：有人（或扫描器）拿了码不确认，把号占住了 1 分半，真正想绑的人扫进来就是
 * 「暂时没有可绑定的账号」。点一下把占位全放回池子 —— **已绑的号不会被放回来**。
 */
on($("bind-release"), async () => {
  const d = await api("/bind/api/release", {})
  $("bind-note").textContent = `已释放：会话 ${d.releasedSessions ?? 0} · 锁 ${d.releasedLocks ?? 0}`
  if (d.overview) renderBind(d.overview)
  toast(`已释放 ${d.releasedLocks ?? 0} 个占位`)
})

;(function initBindStatic() {
  const open = $("bind-open")
  if (open) open.href = BASE + "/bind"
  const wall = $("bind-wall")
  if (wall) wall.href = BASE + "/bind/wall"
  void refreshBindQr()
})()

// 复制链接（公网 / 本地）
on($("bind-copy-public"), async () => {
  try {
    await navigator.clipboard.writeText(String(state.bindPublicUrl ?? ""))
    toast("公网链接已复制")
  } catch {
    toast("复制失败，请手动选中链接", true)
  }
})
on($("bind-copy-local"), async () => {
  try {
    await navigator.clipboard.writeText(String(state.bindLocalUrl ?? ""))
    toast("本地链接已复制")
  } catch {
    toast("复制失败，请手动选中链接", true)
  }
})

// ── 顶栏 ───────────────────────────────────────────────────────────────
on($("bind-release-all"), async () => {
  const yes = await askDialog({
    title: "全部强制清掉",
    body: "这会作废别人正在扫的码（他点了确认也绑不上）。\n确定要全部清掉吗？",
    okText: "强制清掉",
    cancelText: "取消",
  })
  if (!yes) return
  const d = await api("/bind/api/release?all=1", {})
  $("bind-note").textContent = `已强制清掉全部占用：会话 ${d.releasedSessions ?? 0} · 锁 ${d.releasedLocks ?? 0}`
  if (d.overview) renderBind(d.overview)
  toast("已全部清掉")
  await refreshBindQr()
})

on($("refresh-all"), async () => {
  setStatus("刷新中…")
  await api("/api/accounts/refresh", {})
  await loadAccounts()
  await api("/api/invite/refresh", {}).then((d) => renderInvite({ ...d, at: d.updatedAt })).catch(() => {})
  setStatus("已刷新", true)
  toast("全部已刷新")
})

// T-39：模型目录缓存**只**从这里更新（`provider.models` 钩子只读缓存）。
// 1 次 `/v1/models`（与账号数无关）；打开页面时不会自己发。
/**
 * 「桌面端登录态」：读取本机 QuWork 桌面客户端里已登录的账号，一键导入。
 *
 * 两段式：先探测（不写文件）→ 把发现列出来 → 用户确认后再写。
 * 只读客户端目录，不碰它的 cookie / 加密密钥，也不改客户端任何文件。
 */
on($("import-desktop"), async () => {
  const btn = $("import-desktop")
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = "读取中…"
  toast("正在读取本机客户端登录态…")
  try {
    const probe = await api("/api/accounts/from-desktop", { dryRun: true })
    if (!probe.ok) {
      await askDialog({ title: "没有读到登录态", body: String(probe.error || "未知原因"), okText: "知道了", cancelText: "关闭" })
      return
    }

    const list = Array.isArray(probe.accounts) ? probe.accounts : []
    if (list.length === 0) {
      await askDialog({ title: "没有可用账号", body: "客户端里没找到有效登录态。", okText: "知道了", cancelText: "关闭" })
      return
    }

    const cur = probe.currentLogin ? String(probe.currentLogin.username ?? "") : ""
    const rows = list
      .map((x) => {
        const star = x.isCurrent ? '<span class="cur">★ 当前登录</span>' : "　"
        const w = x.wechatBound ? " · 已绑微信" : ""
        const m = x.hasModelToken ? "" : " · 无模型token"
        return `${star}  ${esc(x.username)}（积分 ${fmtNum(x.quota)}${w}${m}）`
      })
      .join("<br>")
      const body = (cur ? `当前客户端登录的是：<b>${esc(cur)}</b><br><br>` : "") +
      `共找到 ${list.length} 个已登录账号：<br><br>${rows}`

    const go = await askDialog({
      title: "桌面端登录态",
      html: true,
      body,
      okText: "全部导入",
      cancelText: "取消",
    })
    if (!go) return

    const done = await api("/api/accounts/from-desktop", { dryRun: false })
    if (done.ok) {
      const n = (done.imported || []).length
      const f = (done.failed || []).length
      await askDialog({
        title: "导入完成",
        body: `已导入 ${n} 个账号` + (f ? `，跳过 ${f} 个` : "") + (cur ? `\n当前登录：${cur}` : ""),
        okText: "好",
        cancelText: "关闭",
      })
      await loadAccounts()
    } else {
      await askDialog({ title: "导入失败", body: String(done.error || "未知原因"), okText: "知道了", cancelText: "关闭" })
    }
  } catch (e) {
    toast("读取失败：" + String(e?.message ?? e), true)
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
})

on($("refresh-models"), async () => {
  setStatus("读取模型目录…")
  const d = await api("/api/models/refresh", {})
  if (d?.ok) {
    setStatus(`模型目录已更新（${d.count} 个）`, true)
    toast(`模型目录已更新（${d.count} 个）`)
  } else {
    const msg = String(d?.error || "读取失败")
    setStatus(msg, false)
    toast(msg, true)
  }
})

// ── 启动：只读缓存（零上游）────────────────────────────────────────────
;(async () => {
  try {
    $("upstream-model").textContent = "https://llm.quwork.cn/v1"
    $("upstream-platform").textContent = "https://llm.rrzu.com"

    const [accounts, invite, reward, settings] = await Promise.all([
      loadAccounts(),
      api("/api/invite/summary"),
      api("/api/reward/status"),
      loadSettings(),
    ])
    renderInvite(invite)
    renderRewardStatus(reward)
    setStatus(`缓存已载入（${accounts.accounts?.length ?? 0} 个账号）`, true)

    if (settings?.settings?.autoRefresh === true) {
      await api("/api/accounts/refresh", {}).then(loadAccounts).catch(() => {})
    }
  } catch (e) {
    // ⚠ 失败必须**看得见**：否则表格永远停在「加载中…」（真机踩过）
    const msg = String(e?.message ?? e)
    setStatus(msg, false)
    $("accounts-body").innerHTML = `<tr><td colspan="7"><div class="empty bad">无法连接面板服务：${esc(msg)}</div></td></tr>`
    $("accounts-cache-note").textContent = "连接失败"
    for (const [id, cols] of [["invite-body", 8], ["records-body", 4], ["reward-body", 8], ["gifts-body", 4]]) {
      const el = $(id)
      if (el) el.innerHTML = `<tr><td colspan="${cols}"><div class="empty bad">无法连接面板服务：${esc(msg)}</div></td></tr>`
    }
    toast(msg, true)
  }
})()

