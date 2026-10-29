@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   正在启动环境安装向导...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"