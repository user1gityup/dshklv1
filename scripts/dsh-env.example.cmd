@echo off
REM ---------------------------------------------------------------------
REM Paths the DSH launcher needs. Copy this file to dsh-env.cmd, edit the
REM values, and leave the copy uncommitted - it names directories on your
REM machine and nobody else's.
REM
REM Only DSH_ROOT is required. Each proxy directory you leave unset simply
REM turns its seat off: the launcher will not start a proxy it has not been
REM told where to find, and will say so rather than failing quietly.
REM ---------------------------------------------------------------------

REM Your DeepSeek Harness checkout - the directory holding apps\ and packages\.
set "DSH_ROOT=C:\path\to\deepseek-harness"

REM Free Claude Code checkout, for the `free-claude` council seat.
REM https://github.com/Alishahryar1/free-claude-code
REM Leave unset if you are not running that seat.
set "FCC_DIR="

REM This repository's proxies\openrouter-free directory, for the
REM `openrouter-free` council seat. Leave unset if you are not running it.
set "ORFREE_DIR="

REM Where the launcher keeps its own state: logs, ownership markers, status
REM files. Defaults to %USERPROFILE%\.dsh, which is also DSH's own home.
set "DSH_HOME=%USERPROFILE%\.dsh"
