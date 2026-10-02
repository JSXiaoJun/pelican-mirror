@echo off
rem Keep this file pure ASCII: cmd.exe parses .bat files in the OEM code page, so non-ASCII text breaks commands.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [start] Node.js not found. Please install the LTS version from https://nodejs.org
  pause
  exit /b 1
)
chcp 65001 >nul
node -v
node server\index.js
echo.
echo [start] Server stopped. See the messages above.
pause
