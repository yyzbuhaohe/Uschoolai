@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Chrome 136+ only allows remote debugging with a separate profile dir.
rem Old script used C:\chrome-debug: a normal (non-admin) user cannot create
rem a folder in the drive root, so the browser silently fell back to the
rem default profile and port 9222 never opened. Use LOCALAPPDATA instead.
set "PORT=9222"
set "PROFILE=%LOCALAPPDATA%\potato-debug\chrome"

set "CHROME="
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe") do (
  if not defined CHROME if exist "%%~P" set "CHROME=%%~P"
)
if not defined CHROME (
  echo [X] Chrome not found.
  echo     Use open-edge-debug.cmd to run with Edge instead.
  pause
  exit /b 1
)

call :portopen %PORT%
if "%OPEN%"=="1" (
  echo Debug port %PORT% is already listening - reuse the running window.
) else (
  echo Starting Chrome with remote debugging ...
  echo   profile : %PROFILE%
  echo   port    : %PORT%
  if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1
  start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --remote-allow-origins=* --no-first-run --no-default-browser-check --disable-features=Translate,MediaRouter
  call :waitport %PORT% 25
)

call :portopen %PORT%
if "%OPEN%"=="1" (
  echo [OK] CDP %PORT% ready.
) else (
  echo [X] Port %PORT% still closed.
  echo     Close every Chrome window of this profile and run this file again.
  echo     Also check that no other program is using %PORT%.
  pause
  exit /b 1
)

echo.
echo Next: log in to U Campus in THIS window, open a course page, keep it open.
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
