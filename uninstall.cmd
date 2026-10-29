@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   正在启动卸载向导...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
