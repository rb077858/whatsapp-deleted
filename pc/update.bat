@echo off
title Al-Mahik - update
cd /d "%~dp0"
rem run a copy of the updater, because the app folder (where it lives) gets replaced
copy /y "app\pc\update.ps1" "_update.ps1" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_update.ps1" -Root "%~dp0."
del "_update.ps1" >nul 2>nul
pause
