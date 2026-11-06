@echo off
chcp 65001 >nul
setlocal
rem 依次尝试：DSH_CLI 环境变量 → 默认安装位置 → PATH 里的 dsh
set "DSH=%DSH_CLI%"
if not defined DSH if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" set "DSH=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
if not defined DSH for /f "delims=" %%i in ('where dsh.cmd 2^>nul') do set "DSH=%%i"
echo ============================================
echo  卸载 dsh-ding 提示音插件
echo ============================================
if not defined DSH (
  echo [错误] 找不到 DSH CLI。请手动执行：
  echo   dsh plugin --profile desktop remove dsh-ding
  pause
  exit /b 1
)
call "%DSH%" plugin --profile desktop remove dsh-ding
if errorlevel 1 (
  echo.
  echo [失败] 卸载没有成功，请检查上面的输出。
  pause
  exit /b 1
)
echo.
echo [完成] 已卸载；若窗口里还能看到「提示音」，完全退出并重新打开一次即可。
pause
