@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   U Campus automation - environment setup
echo   (close this window if it says  environment ready )
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 2 pause
