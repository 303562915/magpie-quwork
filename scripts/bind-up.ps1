// scripts/bind-up.ps1 一键把「门户 + 隧道」拉起来（重启电脑后跑这一条）。
//
// 用法（PowerShell）：
//   cd G:\trae\R1\fandai\repos\magpie-quwork
//   pwsh -File scripts\bind-up.ps1              # 起门户 + 隧道，并打印当前公网地址
//   pwsh -File scripts\bind-up.ps1 -Release     # 先清掉所有占位，再起（号全部回池子）
//   pwsh -File scripts\bind-up.ps1 -Stop        # 只停掉正在跑的门户/隧道
//
// 它不会碰 magpie（不重启、不改配置），只在本机占用 4400 端口并起 cloudflared。

param(
  [switch]$Release,
  [switch]$Stop,
  [int]$Port = 4400
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
$cloudflared = Join-Path (Split-Path -Parent $repo) 'tools\cloudflared.exe'
$outDir = Join-Path (Split-Path -Parent $repo) 'out'
$logFile = Join-Path $outDir '访问日志.txt'

function Stop-Mine {
  # ⚠ 只停「我们起的」：命令行里带 scripts\bind-server.mjs 或 cloudflared tunnel --url 的进程
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*bind-server.mjs*' } |
    ForEach-Object { Write-Host "停门户 pid=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
  Get-Process cloudflared -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "停隧道 pid=$($_.Id)"; Stop-Process -Id $_.Id -Force }
}

if ($Stop) {
  Stop-Mine
  Write-Host '已停止（占位随进程消失，号自动回到池子）'
  exit 0
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 已经跑着就先停，保证用的是最新代码
Stop-Mine
Start-Sleep -Milliseconds 800

$env:HOST = '0.0.0.0'
$env:PORT = "$Port"
$env:BIND_LOG = $logFile
$env:NO_PROXY = '127.0.0.1,localhost'
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''

Start-Process -FilePath $node -ArgumentList 'scripts\bind-server.mjs' -WorkingDirectory $repo -WindowStyle Hidden
Write-Host "门户已起：http://127.0.0.1:$Port/bind"
Start-Sleep -Seconds 2

if ($Release) {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/bind/api/release" -Method POST -TimeoutSec 10 -UseBasicParsing
    Write-Host "已清掉占用：$($r.Content)"
  } catch {
    Write-Host "清占用失败（可稍后在面板点「清掉占用」）：$($_.Exception.Message)"
  }
}

$env:CLOUDFLARED = $cloudflared
$env:BIND_OUT = $outDir
$env:BIND_ENTRY_PATH = '/bind/wall'
Start-Process -FilePath $node -ArgumentList 'scripts\bind-tunnel.mjs', "$Port", $outDir -WorkingDirectory $repo -WindowStyle Hidden

Write-Host '隧道启动中（约 10 秒），随后会打印公网地址…'
$addrFile = Join-Path $outDir '当前公网地址.txt'
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $addrFile) {
    $stamp = (Get-Item $addrFile).LastWriteTime
    if ($stamp -gt (Get-Date).AddSeconds(-60)) { break }
  }
}
if (Test-Path $addrFile) {
  $url = (Get-Content $addrFile -TotalCount 1).Trim()
  Write-Host ''
  Write-Host "阵列页（发群里）：  $url/bind/wall"
  Write-Host "固定二维码：        $url/bind/qr.png   （本地文件 out\固定码.png）"
  Write-Host "单号出码：          $url/bind/go"
  Write-Host ''
  Write-Host '⚠ 随机域名，隧道重启就变；变了重跑本脚本即可（码会自动重出）。'
} else {
  Write-Host '还没拿到公网地址，稍等一会儿看 out\当前公网地址.txt'
}