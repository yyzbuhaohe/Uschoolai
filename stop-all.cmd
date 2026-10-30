@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title potato - stop all

echo This stops: run-all.js (answering), potato-watch.js (injector), serve.py (8787)
set /p ans=Continue? [y/N] 
if /i not "%ans%"=="y" (
  echo cancelled - nothing stopped.
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.Name -eq 'node.exe' -or $_.Name -eq 'python.exe') -and $_.CommandLine -match '(run-all|potato-watch|serve)\.(js|py)' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Host ('  stopped ' + $_.Name + ' ' + $_.ProcessId) } catch { Write-Host ('  cannot stop ' + $_.ProcessId) } }"

echo.
echo Done. The debug browser and the console tab can be closed by hand.
ping -n 5 127.0.0.1 >nul
