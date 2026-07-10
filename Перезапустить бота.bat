@echo off
chcp 65001 >nul
rem Double-click to rebuild and restart the bot + Caddy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart.ps1"
echo.
pause
