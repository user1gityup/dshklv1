@echo off
title DSH - rebuild
setlocal

if exist "%~dp0dsh-env.cmd" call "%~dp0dsh-env.cmd"

if not defined DSH_ROOT (
  echo.
  echo   DSH_ROOT is not set. Copy dsh-env.example.cmd to dsh-env.cmd first.
  echo.
  pause
  exit /b 1
)

cd /d "%DSH_ROOT%" || (
  echo.
  echo   DSH_ROOT does not exist: %DSH_ROOT%
  echo.
  pause
  exit /b 1
)

echo Rebuilding DSH. This takes several minutes; leave it alone.
echo.
call pnpm.cmd install
if errorlevel 1 goto failed
call pnpm.cmd run build
if errorlevel 1 goto failed

echo.
echo Build finished. Launching...
timeout /t 2 >nul
call "%~dp0launch-dsh.cmd"
exit /b 0

:failed
echo.
echo   Build failed - see the output above. Press any key to close.
pause >nul
exit /b 1
