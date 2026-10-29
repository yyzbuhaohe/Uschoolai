# U 校园自动化 · 一键卸载
# 双击 uninstall.cmd，或在 PowerShell 里执行： powershell -ExecutionPolicy Bypass -File uninstall.ps1
# 参数：-Yes 跳过确认；-All 连浏览器调试目录、Whisper 模型、pip 包一起清；-DryRun 只演练不真删
param([switch]$Yes, [switch]$All, [switch]$DryRun)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Info($m) { Write-Host "         $m" -ForegroundColor Gray }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Dry($m)  { Write-Host "  [DRY]  $m" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  ============================================" -ForegroundColor DarkYellow
Write-Host "     U 校园视听说自动化  ·  卸载" -ForegroundColor Yellow
Write-Host "  ============================================" -ForegroundColor DarkYellow
Write-Host ""
if ($DryRun) { Write-Host "  演练模式：只列出会做什么，不动任何东西。" -ForegroundColor Cyan; Write-Host "" }
Write-Host "  将要停掉并清理：" -ForegroundColor Cyan
Write-Host "    - 跑课进程 node run-all.js"
Write-Host "    - 注入守护 node potato-watch.js"
Write-Host "    - 本地服务 serve.py（8787 端口）"
Write-Host "    - control.json、state.json、logs\、run-all.log、.dev\"
if ($All) {
  Write-Host "    - 浏览器调试目录 C:\chrome-debug" -ForegroundColor Yellow
  Write-Host "    - Whisper 模型缓存（约 140MB）" -ForegroundColor Yellow
  Write-Host "    - Python 包 faster-whisper" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  项目文件本身不会被删，要彻底移除直接删文件夹。" -ForegroundColor Gray
Write-Host ""

if (-not $Yes -and -not $DryRun) {
  $ans = Read-Host "  确认继续？输入 y 回车（其他键取消）"
  if ($ans -notmatch '^(y|Y)') {
    Write-Host "  已取消，什么都没动。" -ForegroundColor Gray
    Write-Host ""
    Read-Host "按回车关闭"
    exit
  }
}

Write-Host ""
Write-Host "  正在停止进程…" -ForegroundColor Cyan

$killed = 0
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match 'run-all\.js|potato-watch\.js'
}
foreach ($p in $procs) {
  if ($DryRun) { Dry ("会结束 node 进程 " + $p.ProcessId); $killed++ ; continue }
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Ok ("结束 node 进程 " + $p.ProcessId); $killed++ }
  catch { Warn ("结束失败 " + $p.ProcessId) }
}

$conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) {
  if ($DryRun) { Dry ("会结束占 8787 的进程 " + $c.OwningProcess); $killed++; continue }
  try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; Ok ("结束本地服务进程 " + $c.OwningProcess); $killed++ }
  catch { Warn ("结束失败 " + $c.OwningProcess) }
}
if ($killed -eq 0) { Info "没有在跑的进程" }

Write-Host ""
Write-Host "  正在清理运行期文件…" -ForegroundColor Cyan
$targets = @('control.json', 'state.json', 'run-all.log', 'logs', '.dev')
foreach ($t in $targets) {
  if (-not (Test-Path $t)) { continue }
  if ($DryRun) { Dry ("会删除 " + $t); continue }
  Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $t) { Warn ("删不掉 " + $t + "（可能被占用）") } else { Ok ("删除 " + $t) }
}

if ($All) {
  Write-Host ""
  Write-Host "  正在清理 -All 项目…" -ForegroundColor Cyan

  if (Test-Path 'C:\chrome-debug') {
    if ($DryRun) { Dry "会删除 C:\chrome-debug" }
    else {
      Remove-Item 'C:\chrome-debug' -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path 'C:\chrome-debug') { Warn "C:\chrome-debug 删不掉，浏览器可能还开着" }
      else { Ok "删除浏览器调试目录 C:\chrome-debug" }
    }
  }

  $hub = Join-Path $env:USERPROFILE '.cache\huggingface\hub'
  if (Test-Path $hub) {
    $models = Get-ChildItem $hub -Directory -Filter 'models--Systran--faster-whisper-*' -ErrorAction SilentlyContinue
    foreach ($m in $models) {
      if ($DryRun) { Dry ("会删除模型 " + $m.Name) }
      else { Remove-Item $m.FullName -Recurse -Force -ErrorAction SilentlyContinue; Ok ("删除 Whisper 模型 " + $m.Name) }
    }
  }

  $py = $null
  foreach ($cand in @('python', 'py', 'python3')) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
  }
  if ($py) {
    if ($DryRun) { Dry "会执行 pip uninstall -y faster-whisper" }
    else {
      & $py -m pip uninstall -y faster-whisper *> $null
      if ($LASTEXITCODE -eq 0) { Ok "卸载 Python 包 faster-whisper" } else { Info "faster-whisper 没装或已卸载" }
    }
  }
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor DarkYellow
if ($DryRun) { Write-Host "  演练结束，什么都没动。" -ForegroundColor Green }
else { Write-Host "  清理完成。" -ForegroundColor Green }
Write-Host ("  项目文件夹还在原处：" + $root) -ForegroundColor Gray
Write-Host "  确认不再使用，直接把这个文件夹删掉即可。" -ForegroundColor Gray
Write-Host "  ============================================" -ForegroundColor DarkYellow
Write-Host ""
if (-not $DryRun) { Read-Host "按回车关闭" }
