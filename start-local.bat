@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Please install Node.js 22.13 or newer: https://nodejs.org/
 pause
 exit /b 1
)
if not exist node_modules (
 call npm ci --cache .local\npm-cache --no-audit --no-fund
 if errorlevel 1 exit /b 1
)
call npm run local
pause
