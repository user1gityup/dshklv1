@echo off
title DSH - seat verification
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

echo Verifying the council's CLI seats. Spends one short round on each free seat
echo whose binary resolves. Pass --paid to include the subscription seats.
echo.

node --import tsx/esm "%~dp0verify-seats.mjs" %*
set CODE=%ERRORLEVEL%

echo.
if "%CODE%"=="0" (
  echo   All checks passed.
) else (
  echo   Something failed - see the FAIL lines above.
)
echo   Press any key to close.
pause >nul
exit /b %CODE%
