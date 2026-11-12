@echo off
setlocal
cd /d "%~dp0"
title Escola de Governo - Gestao de Capacitacoes
set "CAP_RUNTIME=%~dp0runtime\node.exe"
if exist "%CAP_RUNTIME%" goto run
if not defined CODEX_MCP_NODE_PATH goto cached
set "CAP_RUNTIME=%CODEX_MCP_NODE_PATH%"
if exist "%CAP_RUNTIME%" goto run
:cached
set "CAP_RUNTIME=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%CAP_RUNTIME%" goto run
set "CAP_RUNTIME=node.exe"
:run
"%CAP_RUNTIME%" -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)" >nul 2>&1
if errorlevel 1 (
  echo O iniciador precisa do Node.js 24 ou do executavel da pasta runtime do ZIP.
  pause
  exit /b 1
)
"%CAP_RUNTIME%" demo.mjs
if errorlevel 1 pause
