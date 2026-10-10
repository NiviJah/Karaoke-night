@echo off
rem Karaoke Night - Windows start file
rem The songs folder is chosen on the TV screen the first time you run it (press S on the TV to change it later).
rem Optional: to force a folder from here instead, remove "rem " from the next line and edit the path.
rem set "SONG_DIR=E:\Karaoke"
set "PORT=8080"

rem %%~dp0 means "the folder this .bat file is in", so the app always starts from its own folder.
cd /d "%~dp0"
node server.js
pause
