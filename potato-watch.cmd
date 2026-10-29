@echo off
cd /d "%~dp0"
start "" /min node potato-watch.js %*
