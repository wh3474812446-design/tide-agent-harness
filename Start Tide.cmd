@echo off
cd /d "%~dp0"

rem Use the portable Node bundled by the installer if it exists, otherwise fall back to PATH.
if exist "%~dp0tools\node\node.exe" set "PATH=%~dp0tools\node;%PATH%"

rem If Tide is already running on 8787, just open the browser to it (no duplicate instance).
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest 'http://127.0.0.1:8787/api/state' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %ERRORLEVEL% EQU 0 (
  echo Tide is already running. Opening browser...
  start "" "http://127.0.0.1:8787"
  timeout /t 2 >nul
  goto :end
)

echo Starting Tide ^(frontend + backend in one server^)...
call npm run web:open
if errorlevel 1 (
  echo.
  echo Failed to start. Run the installer first, or check the error above.
  pause
)
:end
