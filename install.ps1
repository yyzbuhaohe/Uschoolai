# U 校园自动化 · 一键环境安装 (v2)
# 双击 install.cmd 安装；只体检不装：doctor.cmd（等于 install.cmd -CheckOnly）
# 参数：
#   -CheckOnly      只体检，不动任何东西
#   -NonInteractive 结束不停留（脚本调用用）
#   -Force          依赖已存在也重装一遍
#   -NoShortcut     不建桌面快捷方式
param([switch]$NonInteractive, [switch]$CheckOnly, [switch]$Force, [switch]$NoShortcut)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$LOG = Join-Path $root 'install-log.txt'
$script:Lines = New-Object System.Collections.ArrayList

function Say($m, $c) {
  if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m }
  [void]$script:Lines.Add(('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m))
}
function SaveLog { try { Set-Content -Path $LOG -Value $script:Lines -Encoding UTF8 -ErrorAction SilentlyContinue } catch {} }
function Step($n, $t) { Say '' ; Say "[$n] $t" 'Cyan' ; Say ('-' * 52) 'DarkGray' }
function Ok($m)   { Say "  [OK]   $m" 'Green' }
function Warn($m) { Say "  [WARN] $m" 'Yellow' }
function Bad($m)  { Say "  [FAIL] $m" 'Red' }
function Info($m) { Say "         $m" 'Gray' }

$problems = New-Object System.Collections.ArrayList
function Problem($m) { [void]$problems.Add($m) }

# ---------- 工具 ----------
function IsAdmin {
  try { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { return $false }
}
function GetJson($url, $timeout) {
  if (-not $timeout) { $timeout = 30 }
  try { return Invoke-RestMethod -Uri $url -TimeoutSec $timeout -UseBasicParsing } catch { return $null }
}
function Download($urls, $dest, $minMB) {
  foreach ($u in $urls) {
    try {
      Info ('下载 ' + $u)
      if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
      Invoke-WebRequest -Uri $u -OutFile $dest -TimeoutSec 900 -UseBasicParsing
      if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt ([double]$minMB * 1MB))) { return $true }
      Warn '下下来的文件不对（太小），换下一个源'
    } catch {
      Warn ('这个源不行：' + $_.Exception.Message)
    }
  }
  return $false
}
function PortOpen($port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $port)
    $c.Close()
    return $true
  } catch { return $false }
}
function AsciiOnly($s) {
  try { return -not ($s -match '[^\x00-\x7F]') } catch { return $true }
}

Say ''
Say '  ============================================' 'DarkYellow'
Say '     U 校园自动化  ·  环境安装向导 v2' 'Yellow'
Say '  ============================================' 'DarkYellow'
if ($CheckOnly) { Say '  体检模式：只查不装，不动环境（会留一份 install-log.txt 方便反馈）' 'Cyan' }
Say ('  目录：' + $root) 'Gray'
Say ('  管理员：' + (IsAdmin)) 'Gray'

# ---------- 0. 环境摸底 ----------
Step 0 '这台机器的情况'
$osv = [System.Environment]::OSVersion.Version
Say ('  Windows ' + $osv.Major + '.' + $osv.Minor + '  ' + $env:PROCESSOR_ARCHITECTURE) 'Gray'
if ($env:PROCESSOR_ARCHITECTURE -notmatch 'AMD64|x86') {
  Warn ('CPU 架构是 ' + $env:PROCESSOR_ARCHITECTURE + '，faster-whisper / ctranslate2 基本没有 ARM 的预编译包')
  Problem 'CPU 架构不是 x64，转写引擎装不上（换一台 Intel/AMD 的机器）'
}
if (-not (AsciiOnly $root)) {
  Warn '安装目录里有中文'
  Info '本脚本能处理，但 Chrome 传路径、部分 Python 轮子在中文路径下会抽风'
  Info '稳妥做法：整个文件夹挪到 D:\unipus 这种纯英文路径再装'
}
if ($root -match ' ') {
  Warn ('安装目录里有空格：' + $root)
  Info '脚本已全部加引号可跑；出怪问题时优先把目录挪到无空格路径'
}
try {
  $d = (Get-CimInstance Win32_LogicalDisk -Filter ('DeviceID=''' + (Split-Path $root -Qualifier) + '''')).FreeSpace
  if ($d -and $d -lt 2GB) { Warn ('磁盘剩余 ' + [math]::Round($d / 1GB, 1) + ' GB，模型 + 依赖需要 2 GB 以上') }
} catch {}
if (PortOpen 8787) { Info '8787 已经有服务在跑（开着也行，装完记得重启一次拿新代码）' }
if (PortOpen 9222) { Info '9222 已经有调试浏览器在跑（复用就行）' }

# ---------- 1. Node.js ----------
Step 1 '检查 Node.js（要 22 以上）'
function NodeExe {
  $cands = New-Object System.Collections.ArrayList
  $g = Get-Command node -ErrorAction SilentlyContinue
  if ($g -and $g.Source) { [void]$cands.Add($g.Source) }
  [void]$cands.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
  [void]$cands.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
function NodeWsOk($exe) {
  try {
    # 注意：不要在这个字符串里放双引号 —— PowerShell 5.1 传给原生命令时会把内层引号吃掉，
    # node 收到的是没有引号的 bare word，直接语法错误退出 1，会把好 Node 判成坏的。
    & $exe -e 'process.exit(typeof WebSocket === typeof Function ? 0 : 1)' 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}
function InstallNode {
  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if ($wg -and (IsAdmin)) {
    Info '用 winget 装 Node LTS（可能弹 UAC）'
    & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
    $e = NodeExe
    if ($e -and (NodeWsOk $e)) { return $e }
  }
  $ver = $null
  foreach ($idx in @('https://npmmirror.com/mirrors/node/index.json', 'https://nodejs.org/dist/index.json')) {
    $j = GetJson $idx 45
    if ($j) { $ver = ($j | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version }
    if ($ver) { break }
  }
  if (-not $ver) { $ver = 'v22.11.0' }
  Info ('下便携版 ' + $ver + '（不用管理员权限，解压即用）')
  $zip = Join-Path $env:TEMP ('node-' + $ver + '-win-x64.zip')
  $ok = Download @('https://npmmirror.com/mirrors/node/' + $ver + '/node-' + $ver + '-win-x64.zip',
                   'https://nodejs.org/dist/' + $ver + '/node-' + $ver + '-win-x64.zip') $zip 20
  if (-not $ok) { return $null }
  $tmpd = Join-Path $env:TEMP ('nodex-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    Expand-Archive -Path $zip -DestinationPath $tmpd -Force
    $inner = (Get-ChildItem $tmpd -Directory | Select-Object -First 1).FullName
    $dest = Join-Path $env:LOCALAPPDATA 'Programs\nodejs'
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $inner '*') $dest -Recurse -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $tmpd -Recurse -Force -ErrorAction SilentlyContinue
    return (Join-Path $dest 'node.exe')
  } catch {
    Warn ('解压失败：' + $_.Exception.Message)
    return $null
  }
}

$nodeExe = NodeExe
$nodeVer = ''
if ($nodeExe) { $nodeVer = (('' + (& $nodeExe -v 2>$null))).Trim() }
if ($nodeExe -and (NodeWsOk $nodeExe)) {
  Ok ('Node ' + $nodeVer + '   ' + $nodeExe)
} else {
  if ($nodeExe) {
    Bad ('Node ' + $nodeVer + ' 太旧：没有全局 WebSocket，run-all.js 一跑就崩')
    Info '新版代码用 Node 自带的 WebSocket 连浏览器，22 以下没有这个对象'
  } else {
    Bad '没找到 Node.js'
  }
  if ($CheckOnly) {
    Problem 'Node 不合格：装 22 以上的 LTS（winget install OpenJS.NodeJS.LTS，或重新跑 install.cmd 自动装）'
  } else {
    $nodeExe = InstallNode
    if ($nodeExe -and (NodeWsOk $nodeExe)) {
      $nodeVer = (('' + (& $nodeExe -v 2>$null))).Trim()
      Ok ('Node 装好了：' + $nodeVer + '   ' + $nodeExe)
    } else {
      Problem 'Node 自动安装失败：手动装 22 以上（https://nodejs.org/ 选 LTS）后重跑本脚本'
    }
  }
}
if ($nodeExe -and -not $CheckOnly) {
  try {
    [System.IO.File]::WriteAllText((Join-Path $root 'node.path'), $nodeExe, (New-Object System.Text.UTF8Encoding($false)))
    Info ('已记下 Node 路径：' + $nodeExe)
  } catch {}
}

# ---------- 2. Python ----------
Step 2 '检查 Python（要 3.10 ~ 3.12）'
function PyVersionOf($exe) {
  try {
    $v = (('' + (& $exe -c "import sys;print(str(sys.version_info[0])+'.'+str(sys.version_info[1]))" 2>$null))).Trim()
    if ($v -match '^3\.[0-9]+$') { return $v }
    return ''
  } catch { return '' }
}
function PyExeOf($exe) {
  try { return (('' + (& $exe -c "import sys;print(sys.executable)" 2>$null))).Trim() } catch { return '' }
}
function PyUsable($exe) {
  if (-not $exe) { return $false }
  if (-not (Test-Path $exe)) { return $false }
  if ($exe -like '*\WindowsApps\*') { return $false }   # 商店占位符，跑起来会弹应用商店
  $v = PyVersionOf $exe
  return ($v -ne '')
}
function FindGoodPython {
  $cands = New-Object System.Collections.ArrayList
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    foreach ($t in @('3.12', '3.11', '3.10')) {
      try {
        $p = (('' + (& py ('-' + $t) '-c' 'import sys;print(sys.executable)' 2>$null))).Trim()
        if ($p -and (Test-Path $p)) { [void]$cands.Add($p) }
      } catch {}
    }
  }
  $g = Get-Command python -ErrorAction SilentlyContinue
  if ($g -and $g.Source) { [void]$cands.Add($g.Source) }
  foreach ($base in @((Join-Path $env:LOCALAPPDATA 'Programs\Python'), $env:ProgramFiles)) {
    if (-not (Test-Path $base)) { continue }
    foreach ($d in @('Python312', 'Python311', 'Python310')) {
      $p = Join-Path $base ($d + '\python.exe')
      if (Test-Path $p) { [void]$cands.Add($p) }
    }
  }
  foreach ($c in $cands) {
    if (-not (PyUsable $c)) { continue }
    $v = PyVersionOf $c
    $minor = [int]($v.Split('.')[1])
    if ($minor -ge 10 -and $minor -le 12) { return $c }
  }
  return $null
}
function FindAnyPython {
  $cands = New-Object System.Collections.ArrayList
  $g = Get-Command python -ErrorAction SilentlyContinue
  if ($g -and $g.Source) { [void]$cands.Add($g.Source) }
  foreach ($base in @((Join-Path $env:LOCALAPPDATA 'Programs\Python'), $env:ProgramFiles)) {
    foreach ($d in @('Python314', 'Python313', 'Python312', 'Python311', 'Python310')) {
      $p = Join-Path $base ($d + '\python.exe')
      if (Test-Path $p) { [void]$cands.Add($p) }
    }
  }
  foreach ($c in $cands) { if (PyUsable $c) { return $c } }
  return $null
}
function InstallPython {
  $ver = '3.12.7'
  $tmp = Join-Path $env:TEMP ('python-' + $ver + '-amd64.exe')
  $ok = Download @('https://mirrors.huaweicloud.com/python/' + $ver + '/python-' + $ver + '-amd64.exe',
                   'https://registry.npmmirror.com/-/binary/python/' + $ver + '/python-' + $ver + '-amd64.exe',
                   'https://www.python.org/ftp/python/' + $ver + '/python-' + $ver + '-amd64.exe') $tmp 20
  if (-not $ok) { return $null }
  try {
    $sig = Get-AuthenticodeSignature $tmp
    if ($sig.Status -ne 'Valid') { Warn ('安装包签名状态 ' + $sig.Status + '，继续（第三方镜像常见）') }
  } catch {}
  Info '静默安装到当前用户（约 1~2 分钟，不用管理员）'
  try {
    Start-Process -FilePath $tmp -ArgumentList '/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_pip=1', 'Include_test=0', 'Include_launcher=1' -Wait
  } catch {
    Warn ('安装失败：' + $_.Exception.Message)
    return $null
  }
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  return (FindGoodPython)
}

$py = FindGoodPython
if ($py) {
  $pv = PyVersionOf $py
  Ok ('Python ' + $pv + '   ' + $py)
  $pipOk = $false
  try { & $py -m pip --version *> $null; if ($LASTEXITCODE -eq 0) { $pipOk = $true } } catch {}
  if (-not $pipOk) {
    Warn 'pip 不可用，尝试修复（ensurepip）'
    if (-not $CheckOnly) { & $py -m ensurepip --upgrade *> $null }
  }
} else {
  $any = FindAnyPython
  if ($any) {
    Bad ('只找到 Python ' + (PyVersionOf $any) + '：3.13 起 faster-whisper 的依赖没有预编译包')
    Info '不会动你现在的 Python，另装一个 3.12 放在用户目录'
  } else {
    Bad '没找到 Python'
  }
  if ($CheckOnly) {
    Problem 'Python 不合格：需要 3.10~3.12（重跑 install.cmd 自动装 3.12.7）'
  } else {
    $py = InstallPython
    if ($py) {
      Ok ('Python 装好了：' + (PyVersionOf $py) + '   ' + $py)
    } else {
      Problem 'Python 自动安装失败：手动装 3.12（https://www.python.org/downloads/release/python-3127/ ，勾 Add Python to PATH）'
    }
  }
}
if ($py -and -not $CheckOnly) {
  try {
    [System.IO.File]::WriteAllText((Join-Path $root 'py.path'), $py, (New-Object System.Text.UTF8Encoding($false)))
    Info ('已记下 Python 路径：' + $py)
  } catch {}
}

# ---------- 3. faster-whisper ----------
Step 3 '转写引擎 faster-whisper'
function FwVersion($exe) {
  try {
    $o = & $exe -c "import faster_whisper as f;print(getattr(f,'__version__','?'))" 2>$null
    if ($LASTEXITCODE -eq 0) { return (('' + $o)).Trim() } else { return '' }
  } catch { return '' }
}
$fw = ''
if ($py) { $fw = FwVersion $py }
if ($fw -and -not $Force) {
  Ok ('已安装 faster-whisper ' + $fw)
} elseif (-not $py) {
  Warn '跳过（Python 未就绪）'
} elseif ($CheckOnly) {
  Warn '缺 faster-whisper（体检模式不装）'
  Problem '没装 faster-whisper：双击 install.cmd'
} else {
  $env:HF_ENDPOINT = 'https://hf-mirror.com'
  $env:HF_HUB_DISABLE_XET = '1'
  Info '升级 pip'
  & $py -m pip install --upgrade pip --disable-pip-version-check -i https://pypi.tuna.tsinghua.edu.cn/simple *> $null
  Info '安装 faster-whisper==1.0.3 + requests（2~5 分钟，卡住就是在编译）'
  $indexes = @('https://pypi.tuna.tsinghua.edu.cn/simple', 'https://mirrors.aliyun.com/pypi/simple/', '')
  foreach ($idx in $indexes) {
    # requests 必须显式装：faster-whisper 1.0.3 的 utils.py 里 import requests，
    # 但 setup 里没写这个依赖。新版 huggingface-hub 换成 httpx 之后，requests 就不在环境里了，
    # 结果是 pip 打 "Successfully installed"，import 时却 ModuleNotFoundError。
    $a = @('-m', 'pip', 'install', '--disable-pip-version-check', '--timeout', '120', '--retries', '3', 'faster-whisper==1.0.3', 'requests')
    if ($idx) { $a += @('-i', $idx) }
    Info ('源：' + ($(if ($idx) { $idx } else { 'pypi.org' })))
    & $py @a
    $fw = FwVersion $py
    if ($fw) { break }
    Warn '这个源没装上，换一个'
  }
  if ($fw) {
    Ok ('faster-whisper ' + $fw + ' 装好了')
  } else {
    Bad 'faster-whisper 装不上'
    Info ('pip show 看到：' + ((('' + (& $py -m pip show faster-whisper 2>$null | Out-String)).Trim() -split "`n" | Where-Object { $_ -match '^Version:' }) -join ' '))
    $errOut = (('' + (& $py -c 'import faster_whisper' 2>&1 | Out-String)).Trim() -split "`n" | Where-Object { $_.Trim() -ne '' })
    if ($errOut -and $errOut.Count -gt 0) { Info ('import 报错：' + (($errOut | Select-Object -Last 2) -join ' | ')) }
    Info '常见原因 1：缺 VC++ 运行库 → https://aka.ms/vs/17/release/vc_redist.x64.exe'
    Info '常见原因 2：模块缺失（比如 no module named requests）→ 手动 pip install requests'
    Problem 'faster-whisper 装不上：看完上面那行 import 报错再对症处理；不成就换 Python 3.11 重跑'
  }
}

# ---------- 4. Whisper 模型 ----------
Step 4 '语音模型（约 140MB）'
$modelDir = Join-Path $root 'models\whisper-base.en'
$modelBin = Join-Path $modelDir 'model.bin'
# 以前从 hf-mirror 下过的话，缓存里已经有 base.en，别再让人白等 140MB
$hubHit = $null
$hubCache = Join-Path $env:USERPROFILE '.cache\huggingface\hub'
if (Test-Path $hubCache) {
  $hubHit = Get-ChildItem $hubCache -Directory -Filter 'models--Systran--faster-whisper-base.en*' -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (Test-Path $modelBin) {
  $sz = [math]::Round((Get-Item $modelBin).Length / 1MB, 1)
  Ok ('用项目里的模型：models\whisper-base.en（model.bin ' + $sz + ' MB），不联网')
} else {
  # 项目自带的 zip 优先于 HF 缓存：懒人包里塞的就是这个，
  # 必须能离线解压 —— 不能因为这台机器以前下过、缓存里有一份就跳过（那"自带模型"等于没用）
  $zips = New-Object System.Collections.ArrayList
  foreach ($p in @((Join-Path $root 'whisper-base.en.zip'), (Join-Path $root 'models\whisper-base.en.zip'))) {
    if (Test-Path $p) { [void]$zips.Add($p) }
  }
  try {
    Get-ChildItem $root -Filter '*whisper*.zip' -File -ErrorAction SilentlyContinue | ForEach-Object { if ($zips -notcontains $_.FullName) { [void]$zips.Add($_.FullName) } }
  } catch {}
  if ($zips.Count -gt 0) {
    Ok ('找到模型包：' + (Split-Path $zips[0] -Leaf) + '，自动解压')
    if (-not $CheckOnly) {
      $tmpd = Join-Path $env:TEMP ('fwmodel-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
      try {
        Expand-Archive -Path $zips[0] -DestinationPath $tmpd -Force
        $found = Get-ChildItem $tmpd -Recurse -Filter 'model.bin' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
          New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
          Copy-Item (Join-Path $found.DirectoryName '*') $modelDir -Recurse -Force
          if (Test-Path $modelBin) {
            Ok ('模型放好了：models\whisper-base.en（' + [math]::Round((Get-Item $modelBin).Length / 1MB, 1) + ' MB）')
          } else {
            Problem '模型包解压了但没找到 model.bin，手动解压到 models\whisper-base.en'
          }
        } else {
          Problem '这个 zip 里没有 model.bin：确认下的是 whisper-base.en.zip'
        }
      } catch {
        Problem ('模型包解压失败：' + $_.Exception.Message + '（手动解压到 models\whisper-base.en）')
      }
      Remove-Item $tmpd -Recurse -Force -ErrorAction SilentlyContinue
    }
  } elseif ($hubHit) {
    Ok ('HF 缓存里有模型（' + $hubHit.Name + '）：首次转写直接读缓存，不会重下 140MB')
    Info '想彻底离线就把缓存里那份拷到 models\whisper-base.en（或放 whisper-base.en.zip 到项目根目录重跑）'
  } elseif ($CheckOnly) {
    Warn '没有本地模型（体检模式不下载）'
  } elseif ($py) {
    Info '没有本地模型，开始下载（断网就失败，可以去群里下 whisper-base.en.zip 放项目根目录）'
    $tmp = Join-Path $env:TEMP 'fw_dl.py'
    $code = @'
import os, sys
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
target = sys.argv[1]
try:
    from huggingface_hub import snapshot_download
    snapshot_download('Systran/faster-whisper-base.en', local_dir=target, local_dir_use_symlinks=False)
    print('MODEL_READY')
    sys.exit(0)
except Exception as e:
    print('snapshot failed: %s' % str(e)[:200])
try:
    from faster_whisper import WhisperModel
    WhisperModel('base.en', device='cpu', compute_type='int8')
    print('MODEL_READY')
    sys.exit(0)
except Exception as e:
    print('load failed: %s' % str(e)[:200])
sys.exit(1)
'@
    [System.IO.File]::WriteAllText($tmp, $code, (New-Object System.Text.UTF8Encoding($false)))
    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
    $done = $false
    foreach ($m in @('https://hf-mirror.com', 'https://huggingface.co')) {
      $env:HF_ENDPOINT = $m
      Info ('试镜像 ' + $m)
      & $py $tmp $modelDir
      if (Test-Path $modelBin) { $done = $true; Ok '模型就绪'; break }
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if (-not $done) {
      Problem '模型没下下来：去群里下 whisper-base.en.zip 放到项目根目录，再重跑 install.cmd（会自动解压）'
    }
  } else {
    Warn '跳过（Python 未就绪）'
  }
}

# ---------- 5. 英文音色 ----------
Step 5 '英文语音（跟读 / 说话题要用）'
$voices = @()
try {
  Add-Type -AssemblyName System.Speech
  $syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = @($syn.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  $syn.Dispose()
} catch {}
if ($voices.Count -eq 0) {
  Warn '读不到系统语音（System.Speech 不可用）'
  Problem '取不到系统 TTS 音色：跟读/说话题会失败（一般是 Windows 精简版少了语音组件）'
} else {
  $en = @($voices | Where-Object { $_.Culture.Name -like 'en*' })
  if ($en.Count -gt 0) {
    Ok ('可用英文音色：' + (($en | ForEach-Object { $_.Name }) -join ' / '))
  } else {
    Warn ('只有 ' + (($voices | ForEach-Object { $_.Name }) -join ' / ') + '，没有英文音色')
    Info '跟读/说话题是把合成语音灌进麦克风，中文音色读英文评分会掉'
    Info '补法：设置 → 时间和语言 → 语言 → 添加语言 English (United States) → 勾「语音」→ 装完回来说一声'
    Problem '没有英文 TTS 音色：单选/填空/排序/配音不受影响，跟读和说话题会掉分或失败'
  }
}

# ---------- 6. 浏览器 ----------
Step 6 '浏览器'
$browsers = New-Object System.Collections.ArrayList
$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
if (-not $pf86) { $pf86 = $env:ProgramFiles }
$browserCands = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $pf86 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
)
foreach ($p in $browserCands) {
  if ($p -and (Test-Path $p)) { [void]$browsers.Add($p) }
}
if ($browsers.Count -gt 0) {
  Ok ((Split-Path $browsers[0] -Leaf) + '  ' + $browsers[0])
} else {
  Bad '没找到 Chrome / Edge'
  Problem '没有 Chromium 内核浏览器：装 Chrome 或 Edge（Win10/11 自带 Edge，被卸了就装回来）'
}

# ---------- 7. 项目文件 ----------
Step 7 '项目文件是否齐全'
$need = @('run-all.js', 'serve.py', 'ui.html', 'potato-ui.user.js', 'potato-farm.user.js', 'potato-watch.js',
          'dub.js', 'dub-hook.js', 'keyvault.js', 'cdp.js', 'version.json', 'assets/potato-report.pdf', 'docs/API-KEY.md')
$missing = New-Object System.Collections.ArrayList
foreach ($f in $need) {
  if (Test-Path (Join-Path $root $f)) { } else { [void]$missing.Add($f) }
}
if ($missing.Count -eq 0) { Ok ('核心文件齐了（' + $need.Count + ' 个）') }
else {
  Bad ('缺 ' + ($missing -join ', '))
  Problem '安装包不完整：重新解压一遍（要的是整个文件夹，不是单个 install.cmd）'
}

# ---------- 8. 首次配置 + 快捷方式 ----------
Step 8 '首次配置'
$ctrlPath = Join-Path $root 'control.json'
if (Test-Path $ctrlPath) {
  Ok 'control.json 已存在（保留你的设置和 Key）'
} elseif ($CheckOnly) {
  Info '没有 control.json（体检模式不写）'
} else {
  $ctrl = @{
    state = 'stopped'; maxSec = 3; delay = 900; rate = 4; guess = $true
    fillerText = 'This is my answer to the question above.'
    commentText = 'This is my answer to the question above.'
    maxFail = 8; pauseEvery = 0
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($ctrlPath, $ctrl, (New-Object System.Text.UTF8Encoding($false)))
  Ok '生成默认 control.json（主观题兜底内容是英文占位，可在控制台改）'
}
if (-not $CheckOnly -and -not $NoShortcut) {
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop '土豆刷课.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $sc = $sh.CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $root 'start-all.cmd'
    $sc.WorkingDirectory = $root
    $sc.IconLocation = 'shell32.dll,13'
    $sc.Description = 'U 校园自动化 · 一键开跑'
    $sc.Save()
    Ok ('桌面快捷方式：' + $lnk)
  } catch {
    Info ('桌面快捷方式没建成（不影响使用）：' + $_.Exception.Message)
  }
}

# ---------- 汇总 ----------
Say ''
Say ('=' * 52) 'DarkYellow'
if ($problems.Count -eq 0) {
  Say '  环境就绪！' 'Green'
  Say ('=' * 52) 'DarkYellow'
  Say ''
  Say '  接下来只做两件事：' 'Cyan'
  Say '    1. 双击 start-all.cmd（会自动开调试浏览器 + 本地服务 + 注入守护 + 控制台）'
  Say '    2. 在调试浏览器里登录 U 校园，进到课程内容页；控制台里填 DeepSeek API Key，点「开始」'
  Say ''
  Say '  只体检不装：doctor.cmd     卸载：uninstall.cmd     文档：docs\SETUP.md' 'Gray'
} else {
  Say ('  还有 ' + $problems.Count + ' 个问题：') 'Yellow'
  Say ('=' * 52) 'DarkYellow'
  $i = 1
  foreach ($p in $problems) { Say ('  ' + $i + '. ' + $p) 'Yellow'; $i++ }
  Say ''
  Say '  修完重新双击 install.cmd；只想看状态就双击 doctor.cmd。' 'Gray'
}
Say ''
Say ('  日志：' + $LOG) 'Gray'
SaveLog
if (-not $NonInteractive) { Read-Host '按回车关闭' } else { Say '(非交互模式，直接退出)' 'Gray' }
