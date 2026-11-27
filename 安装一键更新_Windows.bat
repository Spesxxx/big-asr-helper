@echo off
chcp 65001 >nul
setlocal

set "DIR=%~dp0"
set "HOST_BAT=%DIR%updater\native_host_win.bat"
set "HOST_NAME=com.spesxxx.big_asr_updater"
set "EXT_ID=piamoojicmlhbikgnddghckmigmkojja"
set "MANIFEST_DIR=%LOCALAPPDATA%\BigAsrUpdater"
set "MANIFEST_PATH=%MANIFEST_DIR%\%HOST_NAME%.json"

if not exist "%MANIFEST_DIR%" mkdir "%MANIFEST_DIR%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$obj = @{ name='%HOST_NAME%'; description='Big ASR Helper 1-Click Auto Updater'; path='%HOST_BAT%'; type='stdio'; allowed_origins=@('chrome-extension://%EXT_ID%/') }; " ^
  "$obj | ConvertTo-Json | Set-Content -Path '%MANIFEST_PATH%' -Encoding UTF8"

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

echo.
echo ======================================================
echo [OK] 一键自动更新注册成功！
echo 现在回到 Chrome 打开标注页，以后有新版本直接点面板里的
echo 「一键更新」就会自动覆盖并重启扩展，无需再手动解压！
echo ======================================================
echo.
pause
