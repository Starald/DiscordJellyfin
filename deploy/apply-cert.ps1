# Attach your own TLS certificate (from a .p12 / .pfx) to ds.starald.ru.
#
#   powershell -ExecutionPolicy Bypass -File deploy\apply-cert.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\apply-cert.ps1 -Revert   # back to Let's Encrypt
#
# Converts the .p12 to PEM (deploy\certs\), points Caddy at it, and reloads Caddy.
# Re-run whenever you renew the certificate.

param(
  [string]$Pfx,
  [string]$PfxPassword,
  [switch]$Revert
)

$ErrorActionPreference = 'Stop'
$certDir    = Join-Path $PSScriptRoot 'certs'
$tlsSnippet = Join-Path $certDir 'ds-tls.caddy'
$fullchain  = Join-Path $certDir 'fullchain.pem'
$keyFile    = Join-Path $certDir 'key.pem'
$caddyfile  = Join-Path $PSScriptRoot 'Caddyfile'

function Find-Exe([string]$name, [string[]]$candidates) {
  $cmd = (Get-Command $name -ErrorAction SilentlyContinue).Source
  if ($cmd) { return $cmd }
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return $null
}

function Write-NoBom([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

$caddy = Find-Exe 'caddy' @(
  "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\caddy.exe"
)
function Reload-Caddy {
  if ($caddy) {
    & $caddy reload --config $caddyfile
    Write-Host "Caddy reloaded."
  } else {
    Write-Host "caddy not found in PATH. Reload manually: caddy reload --config `"$caddyfile`""
  }
}

New-Item -ItemType Directory -Force $certDir | Out-Null

if ($Revert) {
  Write-NoBom $tlsSnippet "# Auto Let's Encrypt (reverted from custom cert).`n"
  Reload-Caddy
  Write-Host "Done: ds.starald.ru is back on automatic Let's Encrypt."
  return
}

$openssl = Find-Exe 'openssl' @(
  'C:\Program Files\Git\usr\bin\openssl.exe',
  'C:\Program Files\Git\mingw64\bin\openssl.exe'
)
if (-not $openssl) { throw "openssl not found (install Git for Windows)." }

if (-not $Pfx) { $Pfx = Read-Host "Path to .p12 / .pfx file" }
if (-not (Test-Path $Pfx)) { throw "File not found: $Pfx" }

if (-not $PfxPassword) {
  $sec  = Read-Host "Password for the .p12" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $PfxPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
}

function Convert-Pfx([bool]$legacy) {
  $extra = @(); if ($legacy) { $extra = @('-legacy') }
  & $openssl pkcs12 -in $Pfx -nokeys  -out $fullchain -passin "pass:$PfxPassword" $extra
  & $openssl pkcs12 -in $Pfx -nocerts -nodes -out $keyFile -passin "pass:$PfxPassword" $extra
  return ((Test-Path $fullchain) -and (Test-Path $keyFile) -and
          ((Get-Item $fullchain).Length -gt 0) -and ((Get-Item $keyFile).Length -gt 0))
}

$ok = Convert-Pfx $false
if (-not $ok) { $ok = Convert-Pfx $true }   # old PKCS#12 (RC2/3DES) -> -legacy
if (-not $ok) { throw "Failed to extract cert/key. Wrong password or incompatible .p12." }

Write-Host "OK: PEM written to $certDir"
Write-Host "--- Certificate ---"
& $openssl x509 -in $fullchain -noout -subject -enddate -ext subjectAltName

$fc = ($fullchain -replace '\\', '/')
$kf = ($keyFile   -replace '\\', '/')
Write-NoBom $tlsSnippet "tls $fc $kf`n"
Reload-Caddy

Write-Host ""
Write-Host "Done: ds.starald.ru now serves your certificate."
Write-Host "Revert to Let's Encrypt:  powershell -File `"$PSCommandPath`" -Revert"
