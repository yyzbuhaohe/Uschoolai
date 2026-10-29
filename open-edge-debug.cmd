@echo off
chcp 65001 >nul
cd /d "%~dp0"

set EDGE="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist %EDGE% set EDGE="C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist %EDGE% (
  echo 没找到 Edge
  pause
  exit /b 1
)

start "" %EDGE% --remote-debugging-port=9222 --user-data-dir=C:\edge-debug --no-first-run
timeout /t 3 >nul
curl -s http://127.0.0.1:9222/json/version | more
pause