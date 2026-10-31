@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title potato - rollback last update

if not exist ".bak-update\LATEST.txt" (
  echo [X] No backup found: .bak-update\LATEST.txt is missing.
  echo     Nothing has been updated on this copy, or the backup folder was deleted.
  ping -n 4 127.0.0.1 >nul
  exit /b 1
)

set /p TS=<.bak-update\LATEST.txt
if "%TS%"=="" (
  echo [X] .bak-update\LATEST.txt is empty.
  ping -n 4 127.0.0.1 >nul
  exit /b 1
)
if not exist ".bak-update\%TS%" (
  echo [X] Backup folder not found: .bak-update\%TS%
  ping -n 4 127.0.0.1 >nul
  exit /b 1
)

echo ==================================
echo   rollback update %TS%
echo ==================================
echo This copies the files from .bak-update\%TS% back over this folder.
echo Files that the update ADDED will stay (this script only restores, never deletes).
echo Stop the serve window first, or serve.py may keep the old file handles.
echo.
set /p ans=Continue? [y/N] 
if /i not "%ans%"=="y" (
  echo cancelled - nothing changed.
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

xcopy /E /I /Y ".bak-update\%TS%\*" "%CD%\." >nul
if errorlevel 1 (
  echo [!] Some files could not be restored. Close serve.cmd / the console tab and run this again.
  ping -n 6 127.0.0.1 >nul
  exit /b 1
)

echo.
echo Done. Restart serve.cmd, then check /api/state: build should be back to the old number.
ping -n 5 127.0.0.1 >nul
exit /b 0
