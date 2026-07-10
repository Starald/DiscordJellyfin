# Stop the bot and Caddy.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dist*index.js*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Write-Host 'Bot and Caddy stopped.' -ForegroundColor Yellow
