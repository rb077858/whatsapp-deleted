# Installs Al-Mahik on a Windows PC:
#   %USERPROFILE%\al-mahik\start.bat   - first run installs packages, then starts the bot
#   %USERPROFILE%\al-mahik\update.bat  - downloads the latest version of the project
#   %USERPROFILE%\al-mahik\app\        - the code (replaced on every update)
#   %USERPROFILE%\al-mahik\data\       - WhatsApp sessions, database, settings (kept)
# Run with:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/rb077858/whatsapp-deleted/main/pc/install.ps1 | iex"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Join-Path $HOME 'al-mahik'
$App = Join-Path $Root 'app'
if (Test-Path -LiteralPath $App) {
  Write-Host "Al-Mahik is already installed in $Root - use update.bat there to update." -ForegroundColor Yellow
  Start-Process explorer.exe $Root
  return
}

Write-Host 'Downloading Al-Mahik...' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Root, (Join-Path $Root 'data') | Out-Null
# work inside the install folder, not %TEMP%: for a non-English user name Windows gives %TEMP%
# a short 8.3 path (C:\Users\0FBE~1\...) that Move-Item can't resolve
$tmp = Join-Path $Root '_download'
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'al-mahik.zip'
Invoke-WebRequest 'https://github.com/rb077858/whatsapp-deleted/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing
Expand-Archive -LiteralPath $zip -DestinationPath $tmp
Move-Item -LiteralPath (Join-Path $tmp 'whatsapp-deleted-main') -Destination $App
Copy-Item -LiteralPath (Join-Path $App 'pc\start.bat'), (Join-Path $App 'pc\update.bat') -Destination $Root -Force
Remove-Item -LiteralPath $tmp -Recurse -Force

# a shortcut on the desktop to the folder
try {
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Al-Mahik.lnk'))
  $lnk.TargetPath = $Root
  $lnk.Save()
} catch {}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install the LTS version (opening the download page), then run start.bat.' -ForegroundColor Yellow
  Start-Process 'https://nodejs.org/en/download'
}
Write-Host "Done! Installed in $Root - run start.bat there." -ForegroundColor Green
Start-Process explorer.exe $Root
