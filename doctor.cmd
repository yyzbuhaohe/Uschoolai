@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo   Environment check only - nothing will be installed or changed.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -CheckOnly %*
