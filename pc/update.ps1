# Replaces app\ with the latest version from GitHub. data\ is never touched.
# Installed packages are kept when package-lock.json did not change.
param([Parameter(Mandatory)] [string]$Root)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = (Resolve-Path $Root).Path
$App = Join-Path $Root 'app'
$zip = Join-Path $env:TEMP 'al-mahik.zip'
$tmp = Join-Path $env:TEMP ('al-mahik-' + [guid]::NewGuid())

Write-Host 'Downloading the latest version...' -ForegroundColor Cyan
Invoke-WebRequest 'https://github.com/rb077858/whatsapp-deleted/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $tmp
$New = Join-Path $tmp 'whatsapp-deleted-main'

$lock = 'package-lock.json'
$sameLock = (Test-Path (Join-Path $App $lock)) -and
  ((Get-FileHash (Join-Path $App $lock)).Hash -eq (Get-FileHash (Join-Path $New $lock)).Hash)
if ($sameLock -and (Test-Path (Join-Path $App 'node_modules'))) {
  Move-Item (Join-Path $App 'node_modules') (Join-Path $New 'node_modules')
}

try {
  if (Test-Path $App) { Remove-Item $App -Recurse -Force }
} catch {
  Write-Host 'Could not replace the app folder - close the Al-Mahik window (start.bat) and run update.bat again.' -ForegroundColor Red
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Move-Item $New $App
Copy-Item (Join-Path $App 'pc\start.bat'), (Join-Path $App 'pc\update.bat') $Root -Force
Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $App 'node_modules'))) {
  Write-Host 'Packages changed - installing...' -ForegroundColor Cyan
  Push-Location $App
  npm ci --omit=dev --no-audit --no-fund
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Write-Host 'Package install failed.' -ForegroundColor Red; exit 1 }
}
Write-Host 'Updated! Run start.bat.' -ForegroundColor Green
