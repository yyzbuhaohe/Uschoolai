@echo off
chcp 65001 >nul
cd /d "%~dp0"

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% (
  echo 没找到 Chrome，试试 Edge 版 open-edge-debug.cmd
  pause
  exit /b 1
)

echo 正在启动调试版 Chrome ...
echo 用户目录: C:\chrome-debug
echo 调试端口: 9222
echo.

start "" %CHROME% --remote-debugging-port=9222 --user-data-dir=C:\chrome-debug --no-first-run --no-default-browser-check

timeout /t 3 >nul
echo 验证:
curl -s http://127.0.0.1:9222/json/version | more
echo.
echo 如果上面出现 JSON，说明端口通了。
pause