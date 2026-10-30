@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title potato - injector
if not exist "logs" mkdir "logs" >nul 2>&1

set "NODE="
if exist "%~dp0node.path" set /p NODE=<"%~dp0node.path"
if defined NODE if not exist "%NODE%" set "NODE="
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE set "NODE=node"

"%NODE%" -e "process.exit(typeof WebSocket===typeof Function?0:1)" >nul 2>&1
if errorlevel 1 (
  echo [X] This Node has no global WebSocket - it must be 22 or newer.
  echo     Run doctor.cmd to see the exact fix.
  pause
  exit /b 1
)

echo Injector running - keep this window open while the bot works.
echo.
"%NODE%" potato-watch.js %*
echo.
echo Injector stopped. Recent lines: logs\potato-watch.log
pause
