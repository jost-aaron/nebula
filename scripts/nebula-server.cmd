@echo off
where pwsh >nul 2>nul
if errorlevel 1 (
  echo nebula-server: error: PowerShell 7 is required. Install it with: winget install Microsoft.PowerShell 1>&2
  exit /b 1
)
pwsh -NoLogo -NoProfile -File "%~dp0nebula-server.ps1" %*
exit /b %errorlevel%
