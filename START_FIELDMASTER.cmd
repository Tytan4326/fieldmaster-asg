@echo off
setlocal
title Fieldmaster Server
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
set "PORT=8080"
set "NODE_ENV=development"
set "ADMIN_CALLSIGN=GAME-MASTER"
set "ADMIN_PASSWORD=2468"
set "JWT_SECRET=fieldmaster-local-only-secret-change-before-internet"
set "DATA_FILE=%~dp0data\local-state.json"

if not exist "node_modules\express\package.json" (
  echo Instalowanie wymaganych skladnikow...
  call "C:\Program Files\nodejs\npm.cmd" install
  if errorlevel 1 goto :error
)

echo.
echo =====================================================
echo  FIELDMASTER DZIALA: http://localhost:8080/?view=admin
echo  PIN ADMINA: 2468
echo  Zamkniecie tego okna zatrzyma serwer.
echo =====================================================
echo.
start "" /b powershell.exe -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8080/?view=admin'"
"C:\Program Files\nodejs\node.exe" server\index.js
goto :eof

:error
echo.
echo Instalacja nie powiodla sie. Sprawdz polaczenie z internetem.
pause
