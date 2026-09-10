@echo off
cd /d "%~dp0"
echo working dir: %cd%
echo.
"node_modules\electron\dist\electron.exe" .
echo.
echo ==== copy any error above and send it back ====
pause
