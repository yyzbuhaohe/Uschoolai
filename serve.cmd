@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title potato - local service 8787

call :portopen 8787
if "%OPEN%"=="1" (
  echo [i] Port 8787 is already serving - one instance is enough.
  echo     Open http://127.0.0.1:8787/ in the browser.
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

set "PY="
if exist "%~dp0py.path" set /p PY=<"%~dp0py.path"
if defined PY if not exist "%PY%" set "PY="

rem py launcher knows about every installed CPython (3.12 first, then 3.11/3.10)
if not defined PY call :trypy 3.12
if not defined PY call :trypy 3.11
if not defined PY call :trypy 3.10

rem last resort: the usual install folders
if not defined PY call :trypath "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY call :trypath "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PY call :trypath "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
if not defined PY call :trypath "%ProgramFiles%\Python312\python.exe"
if not defined PY call :trypath "%ProgramFiles%\Python311\python.exe"

if not defined PY (
  echo [X] No usable Python found.
  echo     Double-click install.cmd ^(it installs Python 3.12 + faster-whisper^), then run me again.
  pause
  exit /b 1
)

echo Using: %PY%
"%PY%" -c "import faster_whisper" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] This Python has no faster-whisper.
  echo     Listening / sorting / dubbing questions will fail; choice and blank ones still work.
  echo     Fix: close this, double-click doctor.cmd, then install.cmd, then run me again.
  echo.
)

"%PY%" serve.py 8787
if errorlevel 1 (
  echo.
  echo [X] Service exited with an error. Run doctor.cmd for a full check.
  pause
)
exit /b 0

:trypy
set "TF=%TEMP%\potato-py.txt"
if exist "%TF%" del "%TF%" >nul 2>&1
py -%1 -c "import sys;print(sys.executable)" > "%TF%" 2>nul
if exist "%TF%" set /p PY=<"%TF%"
if exist "%TF%" del "%TF%" >nul 2>&1
if defined PY if not exist "%PY%" set "PY="
exit /b 0

:trypath
if exist %1 set "PY=%~1"
exit /b 0

:portopen
set "OPEN=0"
for /f %%R in ('powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%1);$c.Close();'1'}catch{'0'}"') do set "OPEN=%%R"
exit /b 0
