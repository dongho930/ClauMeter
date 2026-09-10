@echo off
rem ClauMeter statusLine bridge for Claude Code on Windows (registered automatically by main.js).
rem Runs the bundled ClauMeter.exe as plain Node via ELECTRON_RUN_AS_NODE, so no separate Node.js
rem install is needed. Expected layout: <install dir>\resources\app.asar.unpacked\<this file>.
rem Keep this file ASCII-only: cmd.exe reads batch files in the OEM code page.
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\ClauMeter.exe" "%~dp0statuslineBridge.js"
