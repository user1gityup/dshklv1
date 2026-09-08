@echo off
title DSH
setlocal

REM Paths come from dsh-env.cmd, which you create by copying
REM dsh-env.example.cmd. Nothing here names a machine.
if exist "%~dp0dsh-env.cmd" call "%~dp0dsh-env.cmd"

if not defined DSH_ROOT (
  echo.
  echo   DSH_ROOT is not set.
  echo   Copy dsh-env.example.cmd to dsh-env.cmd and point DSH_ROOT at your
  echo   DeepSeek Harness checkout.
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

if not exist "apps\web\dist\index.html" (
  echo.
  echo   The web bundle is missing - DSH has not been built yet.
  echo   Run rebuild-dsh.cmd once, or by hand:
  echo.
  echo       cd "%DSH_ROOT%"
  echo       pnpm install
  echo       pnpm run build
  echo.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------------
REM Local proxies.
REM
REM The free council seats point at localhost and fail loudly when nothing
REM is listening - deliberately, because a silent fallback would spend the
REM paid subscription. So DSH starts the proxies itself rather than
REM depending on anyone remembering to.
REM
REM Started only when the port is free, and stopped again only if this
REM session started them. A proxy launched by hand is left alone.
REM Startup, health checks and cleanup are all in dsh-session.cjs.
REM ---------------------------------------------------------------------

echo.
echo Starting DSH... your browser will open on its own.
echo Close this window to stop the server.
echo.

node "%~dp0dsh-session.cjs" %*
set CODE=%ERRORLEVEL%

if not "%CODE%"=="0" (
  echo.
  echo   DSH exited with code %CODE%.
  echo   The lines above say why. Press any key to close.
  pause >nul
)
exit /b %CODE%
