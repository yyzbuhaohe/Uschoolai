@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=9222"
set "PROFILE=%LOCALAPPDATA%\potato-debug\edge"

set "EDGE="
for %%P in ("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe") do (
  if not defined EDGE if exist "%%~P" set "EDGE=%%~P"
)
if not defined EDGE (
  echo [X] Edge not found.
  echo     Use start-chrome.cmd to run with Chrome instead.
  pause
  exit /b 1
)

call :portopen %PORT%
if "%OPEN%"=="1" (
  echo Debug port %PORT% is already listening - reuse the running window.
) else (
  echo Starting Edge with remote debugging ...
  echo   profile : %PROFILE%
  echo   port    : %PORT%
  if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1
  start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --remote-allow-origins=* --no-first-run --no-default-browser-check --disable-features=Translate,MediaRouter
  call :waitport %PORT% 25
)

call :portopen %PORT%
if "%OPEN%"=="1" (
  echo [OK] CDP %PORT% ready.
) else (
  echo [X] Port %PORT% still closed. Close all Edge windows and try again.
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
