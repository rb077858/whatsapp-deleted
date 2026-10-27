@echo off
title Al-Mahik
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run start.bat again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
if not exist "app\node_modules" (
  echo First run - installing packages, this takes a minute...
  pushd app
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    popd
    echo Package install failed.
    pause
    exit /b 1
  )
  popd
)
if not exist "data" mkdir data
set "DATA_DIR=%~dp0data"
set "PORT=3000"
echo Starting Al-Mahik on http://localhost:3000  (close this window to stop)
start "" /b powershell -NoProfile -Command "Start-Sleep 4; Start-Process 'http://localhost:3000/setup'"
cd app
node --disable-warning=ExperimentalWarning src\index.js
pause
