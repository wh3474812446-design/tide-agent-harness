@echo off
rem Tide launcher. Hands off to the hidden supervisor (opens the UI in the
rem default browser, backend hosted in the background) and exits.
cd /d "%~dp0"
start "" wscript "%~dp0tools\Tide.vbs"
