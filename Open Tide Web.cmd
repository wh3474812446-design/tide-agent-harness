@echo off
cd /d "%~dp0"
npm run web:open
if errorlevel 1 pause
