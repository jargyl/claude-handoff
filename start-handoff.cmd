@echo off
rem Double-click to start Claude Handoff (installs and builds on first run).
rem It keeps running in the background: open or quit it from its icon next to the clock.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Claude Handoff needs Node.js 20.11 or newer: https://nodejs.org
  pause
  exit /b 1
)
node scripts\start.mjs --background
if errorlevel 1 pause
