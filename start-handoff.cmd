@echo off
rem Double-click to start Claude Handoff (installs and builds on first run).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Claude Handoff needs Node.js 20.11 or newer: https://nodejs.org
  pause
  exit /b 1
)
call npm start
if errorlevel 1 pause
