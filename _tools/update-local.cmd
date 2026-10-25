@echo off
rem Manual run: double-click this file.
rem Automatic daily run: install the Windows task once via
rem   powershell -ExecutionPolicy Bypass -File "%~dp0register-task.ps1"
rem ASCII only on purpose: cmd.exe reads this file in the OEM codepage.

setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-local.ps1" %*
set "code=%errorlevel%"

echo.
if "%code%"=="0" (
    echo Done. Details: _tools\update-local.log
) else (
    echo Update FAILED. Details: _tools\update-local.log
)
pause
exit /b %code%
