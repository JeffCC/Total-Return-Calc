@echo off
cd /d "%~dp0"
set PY=
python --version >nul 2>&1 && set PY=python
if not defined PY ( py -3 --version >nul 2>&1 && set PY=py -3 )
if not defined PY (
  echo.
  echo [ERROR] Python not found.
  echo Please install Python 3.9+ from https://www.python.org/downloads/
  echo and CHECK "Add python.exe to PATH" during installation.
  echo.
  pause
  exit /b 1
)
%PY% -c "import requests" >nul 2>&1
if errorlevel 1 (
  echo Installing required package: requests ...
  %PY% -m pip install --user requests
)
echo.
echo Starting... the browser will open automatically.
echo Keep this window open while using. Close it to stop.
echo.
%PY% -X utf8 server.py
pause
