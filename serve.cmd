@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === U 校园自动化 / 本地服务（8787）===
python serve.py 8787
if errorlevel 1 (
  echo.
  echo 启动失败。请确认已安装 Python 并加入了 PATH。
  pause
)