@echo off
chcp 65001 >nul
setlocal
rem 依次尝试：DSH_CLI 环境变量 → 默认安装位置 → PATH 里的 dsh
set "DSH=%DSH_CLI%"
if not defined DSH if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" set "DSH=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
if not defined DSH for /f "delims=" %%i in ('where dsh.cmd 2^>nul') do set "DSH=%%i"
echo ============================================
echo  安装 dsh-ding 提示音插件到 desktop 配置档
echo ============================================
if not defined DSH (
  echo [错误] 找不到 DSH CLI。请手动执行：
  echo   dsh plugin --profile desktop add "%~dp0dsh-ding"
  echo 或先设置环境变量 DSH_CLI 指向 dsh.cmd
  pause
  exit /b 1
)
call "%DSH%" plugin --profile desktop add "%~dp0dsh-ding"
if errorlevel 1 (
  echo.
  echo [失败] 安装没有成功，请检查上面的输出。
  pause
  exit /b 1
)
echo.
echo [完成] 已安装到 desktop 配置档。
echo   - 若窗口里已出现「提示音」，去 设置 - 提示音 试听；
echo   - 若没有出现，请完全退出并重新打开 DeepSeek Harness。
pause
