@echo off
setlocal
cd /d "%~dp0"

title AniTube Chromium Helper

echo.
echo Iniciando AniTube Chromium Helper...
echo.

if not exist "node_modules" (
  echo Instalando dependencias na primeira execucao...
  call npm install
  if errorlevel 1 (
    echo.
    echo Falha ao instalar dependencias. Verifique se o Node.js esta instalado.
    pause
    exit /b 1
  )
)

call npm start

echo.
echo Processo finalizado.
pause
