@echo off
cd /d "%~dp0"
node client\src\index.js --open
if errorlevel 1 pause
