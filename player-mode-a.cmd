@echo off
chcp 65001 >nul
setlocal
taskkill /F /IM run.exe >nul 2>&1
taskkill /F /IM mpv.exe >nul 2>&1
timeout /t 2 /nobreak >nul
py -3 "%~dp0player_mode.py" a || python "%~dp0player_mode.py" a
echo.
echo Mode A applied: external mpv.exe reading mpv-lazy portable_config.
echo Restart jellyfin-mpv-shim to take effect.
timeout /t 4 /nobreak >nul
