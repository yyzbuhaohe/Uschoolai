@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title potato - start all

echo ==================================
echo   potato launcher
echo ==================================
if not exist "serve.cmd" (
  echo [X] serve.cmd not found - run this from the project folder.
  pause
  exit /b 1
)

call :portopen 9222
if "%OPEN%"=="1" (
  echo [1/4] debug browser already listening on 9222 - reuse it
) else (
  echo [1/4] opening debug browser ...
  call "%~dp0start-chrome.cmd" /q
)

call :portopen 8787
if "%OPEN%"=="1" (
  echo [2/4] local service already listening on 8787 - reuse it
) else (
  echo [2/4] starting local service ...
  start "potato-serve" /min cmd /c call "%~dp0serve.cmd"
  call :waitport 8787 40
)

echo [3/4] starting injector ...
start "potato-watch" /min cmd /c call "%~dp0potato-watch.cmd"

call :portopen 8787
if "%OPEN%"=="1" (
  echo [4/4] opening console ...
  start "" "http://127.0.0.1:8787/"
) else (
  echo [!] the local service did not come up. Close this, run doctor.cmd, read the log.
)

echo.
echo   In the debug browser : log in to U Campus, open a course content page
echo   In the console       : paste your DeepSeek API key, set sections, press Start
echo   To stop everything   : stop-all.cmd
echo.
if /i not "%1"=="/q" pause
exit /b 0

:portopen
set "OPEN=0"
for /f %%R in ('powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%1);$c.Close();'1'}catch{'0'}"') do set "OPEN=%%R"
exit /b 0

:waitport
set /a _n=0
:waitloop
call :portopen %1
if "%OPEN%"=="1" exit /b 0
set /a _n+=1
if %_n% GEQ %2 exit /b 1
ping -n 2 127.0.0.1 >nul
goto waitloop
