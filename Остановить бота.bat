@echo off
chcp 65001 >nul
rem Double-click to stop the bot and Caddy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo.
pause
