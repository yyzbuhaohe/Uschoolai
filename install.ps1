# U 校园自动化 · 一键环境安装
# 双击 install.cmd 运行，或在 PowerShell 里执行： powershell -ExecutionPolicy Bypass -File install.ps1
# 参数：-CheckOnly 只体检不安装；-NonInteractive 不等待回车
param([switch]$NonInteractive, [switch]$CheckOnly)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Step($n, $t) {
  Write-Host ""
  Write-Host "[$n] $t" -ForegroundColor Cyan
  Write-Host ("-" * 52) -ForegroundColor DarkGray
}
function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Info($m) { Write-Host "         $m" -ForegroundColor Gray }

Write-Host ""
Write-Host "  ============================================" -ForegroundColor DarkYellow
Write-Host "     U 校园视听说自动化  ·  环境安装向导" -ForegroundColor Yellow
Write-Host "  ============================================" -ForegroundColor DarkYellow

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$problems = @()

# ---------- 1. Node.js ----------
Step 1 "检查 Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $nv = (& node -v) 2>$null
  Ok "已安装 Node.js $nv"
  $major = 0
  if ($nv -match 'v(\d+)') { $major = [int]$Matches[1] }
  if ($major -lt 20) { Warn "版本偏旧，建议 20 以上" }
} else {
  Bad "没有找到 Node.js"
  Info "正在尝试用 winget 安装…"
  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if ($CheckOnly) {
    $problems += "缺少 Node.js（-CheckOnly 模式不安装）。执行：winget install OpenJS.NodeJS.LTS"
  } elseif ($wg) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { Ok "Node.js 安装完成，请关掉这个窗口重新运行一次" }
    else { $problems += "Node.js 装完但当前窗口读不到，重开一次 cmd 再跑本脚本" }
  } else {
    $problems += "没有 winget，请手动安装 Node.js：https://nodejs.org/"
    Info "下载 LTS 版本，一路下一步即可"
  }
}

# ---------- 2. Python ----------
Step 2 "检查 Python"
$py = $null
foreach ($cand in @('python', 'py', 'python3')) {
  $c = Get-Command $cand -ErrorAction SilentlyContinue
  if ($c) { $py = $cand; break }
}
if ($py) {
  $pv = (& $py --version) 2>$null
  Ok "已安装 $pv（命令：$py）"
  $pmin = 0
  if ($pv -match "3\.(\d+)") { $pmin = [int]$Matches[1] }
  if ($pmin -gt 12) {
    Warn "Python 3.$pmin 太新，faster-whisper 的依赖可能没有预编译包"
    Info "建议装 Python 3.11 或 3.12：https://www.python.org/downloads/release/python-3127/"
    $problems += "Python 版本过新（3.$pmin），建议降到 3.11 / 3.12 再装 faster-whisper"
  } elseif ($pmin -gt 0 -and $pmin -lt 9) {
    Warn "Python 3.$pmin 太旧，建议 3.9 以上"
  }
  # 检查是否真的能用 pip
  $pipOk = $false
  try { & $py -m pip --version *> $null; if ($LASTEXITCODE -eq 0) { $pipOk = $true } } catch {}
  if (-not $pipOk) {
    Warn "pip 不可用，尝试修复…"
    & $py -m ensurepip --upgrade *> $null
  }
} else {
  Bad "没有找到 Python"
  Info "正在尝试用 winget 安装…"
  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if ($CheckOnly) {
    $problems += "缺少 Python（-CheckOnly 模式不安装）。执行：winget install Python.Python.3.12"
  } elseif ($wg) {
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    $problems += "Python 装完需要重开窗口，再运行一次本脚本"
  } else {
    $problems += "没有 winget，请手动安装 Python：https://www.python.org/downloads/"
    Info "安装时务必勾选 Add Python to PATH"
  }
}

# ---------- 3. faster-whisper ----------
Step 3 "安装转写引擎 faster-whisper"
if ($py) {
  $hasFw = $false
  try {
    $show = (& $py -m pip show faster-whisper 2>$null | Out-String)
    if ($show -match "Version:\s*(\S+)") {
      $hasFw = $true
      Ok "已安装 faster-whisper $($Matches[1])"
    }
  } catch {}

  if (-not $hasFw -and $CheckOnly) {
    Warn "缺少 faster-whisper（-CheckOnly 模式不安装）"
    $problems += "需要执行：pip install faster-whisper==1.0.3"
  } elseif (-not $hasFw) {
    Info "设置国内镜像 HF_ENDPOINT=https://hf-mirror.com"
    $env:HF_ENDPOINT = 'https://hf-mirror.com'
    $env:HF_HUB_DISABLE_XET = '1'

    Info "正在安装，可能需要 2-5 分钟…"
    & $py -m pip install --upgrade pip *> $null
    & $py -m pip install "faster-whisper==1.0.3" -i https://pypi.tuna.tsinghua.edu.cn/simple
    if ($LASTEXITCODE -eq 0) { Ok "faster-whisper 安装完成" }
    else {
      Bad "安装失败，换回官方源重试…"
      & $py -m pip install "faster-whisper==1.0.3"
      if ($LASTEXITCODE -eq 0) { Ok "faster-whisper 安装完成" }
      else { $problems += "faster-whisper 安装失败，手动执行：pip install faster-whisper==1.0.3" }
    }
  }
} else {
  Warn "跳过（Python 未就绪）"
}

# ---------- 4. 预下载模型 ----------
Step 4 "预下载 Whisper 模型（约 140MB）"
if ($CheckOnly) {
  Info "跳过模型下载（-CheckOnly）"
} elseif ($py) {
  $env:HF_ENDPOINT = 'https://hf-mirror.com'
  $env:HF_HUB_DISABLE_XET = '1'
  Info "第一次下载会慢一些，请耐心等…"
  $code = @'
from faster_whisper import WhisperModel
import sys
m = WhisperModel('base.en', device='cpu', compute_type='int8')
print('MODEL_READY')
'@
  $tmp = Join-Path $env:TEMP 'fw_dl.py'
  Set-Content -Path $tmp -Value $code -Encoding UTF8
  & $py $tmp
  if ($LASTEXITCODE -eq 0) { Ok "模型就绪" }
  else { $problems += "模型下载失败，首次答题时会重试" }
  Remove-Item $tmp -ErrorAction SilentlyContinue
} else {
  Warn "跳过（Python 未就绪）"
}

# ---------- 5. 浏览器 ----------
Step 5 "检查浏览器"
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) { Ok "Chrome：$chrome" }
elseif ($edge) { Ok "Edge：$edge" }
else {
  Bad "没有找到 Chrome 或 Edge"
  $problems += "请先装一个 Chromium 内核浏览器"
}

# ---------- 6. 项目文件自检 ----------
Step 6 "检查项目文件"
$need = @('run-all.js', 'serve.py', 'cdp.js', 'keyvault.js', 'dub.js', 'dub-hook.js', 'potato-ui.user.js', 'potato-farm.user.js', 'potato-watch.js', 'ui.html', 'assets/potato-report.pdf')
$missing = @()
foreach ($f in $need) {
  if (Test-Path (Join-Path $root $f)) { Ok $f }
  else { Bad "缺少 $f"; $missing += $f }
}
if ($missing.Count -gt 0) { $problems += "项目文件不全，请重新解压完整的项目包" }

# ---------- 汇总 ----------
Write-Host ""
Write-Host ("=" * 52) -ForegroundColor DarkYellow
if ($problems.Count -eq 0) {
  Write-Host "  环境就绪！" -ForegroundColor Green
  Write-Host ("=" * 52) -ForegroundColor DarkYellow
  Write-Host ""
  Write-Host "  接下来四步：" -ForegroundColor Cyan
  Write-Host "    1. 双击 start-chrome.cmd   开调试版浏览器（1024 以上分辨率）"
  Write-Host "    2. 双击 serve.cmd          起本地服务（窗口别关）"
  Write-Host "    3. 双击 potato-watch.cmd   注入土豆控制台（窗口别关）"
  Write-Host "    4. 浏览器里打开 U 校园课程页，点右下角土豆球，填 API Key，点开始"
  Write-Host ""
  Write-Host "  API Key 怎么拿：docs\API-KEY.md      完整步骤：docs\SETUP.md" -ForegroundColor Gray
} else {
  Write-Host "  还有 $($problems.Count) 个问题要处理：" -ForegroundColor Yellow
  Write-Host ("=" * 52) -ForegroundColor DarkYellow
  $i = 1
  foreach ($p in $problems) {
    Write-Host "  $i. $p" -ForegroundColor Yellow
    $i++
  }
  Write-Host ""
  Write-Host "  处理完重新运行一次本脚本即可。" -ForegroundColor Gray
}
Write-Host ""
if (-not $NonInteractive) { Read-Host "按回车关闭" } else { Write-Host "(非交互模式，直接退出)" }