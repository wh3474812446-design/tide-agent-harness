@echo off
cd /d "%~dp0"
title Tide Installer

echo ============================================================
echo            Tide Local Agent Harness  -  Installer
echo ============================================================
echo.
echo This will: detect/install Node.js, install dependencies,
echo prepare config, create a desktop shortcut, then open the
echo web console.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo Done. Use the desktop Tide shortcut to launch from now on.
) else (
  echo Installer reported a problem ^(exit %EXITCODE%^). See the log above.
)
echo.
pause
