# Rebuild and (re)start the bot + Caddy as hidden background processes.
$ErrorActionPreference = 'Continue'
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')
Set-Location $PSScriptRoot

Write-Host '== Build ==' -ForegroundColor Cyan
npm run build
if (-not $?) { Write-Host 'Build failed - not restarting.' -ForegroundColor Red; exit 1 }

Write-Host '== Stopping old processes ==' -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dist*index.js*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 2

Write-Host '== Starting bot + Caddy ==' -ForegroundColor Cyan
$node = 'C:\Program Files\nodejs\node.exe'
Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'dist\index.js' `
  -WorkingDirectory $PSScriptRoot `
  -RedirectStandardOutput "$PSScriptRoot\bot.out.log" -RedirectStandardError "$PSScriptRoot\bot.err.log"

$caddy = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\caddy.exe"
if (-not (Test-Path $caddy)) { $caddy = 'caddy' }
Start-Process -WindowStyle Hidden -FilePath $caddy -ArgumentList 'run', '--config', "$PSScriptRoot\deploy\Caddyfile"

Start-Sleep -Seconds 4
$bot = (Get-NetTCPConnection -State Listen -LocalPort 8730 -ErrorAction SilentlyContinue | Measure-Object).Count
$cad = (Get-NetTCPConnection -State Listen -LocalPort 80, 443 -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host ("Bot listeners: {0}  |  Caddy listeners: {1}/2" -f $bot, $cad) -ForegroundColor Green
Write-Host 'Done. Panel: https://ds.starald.ru'
