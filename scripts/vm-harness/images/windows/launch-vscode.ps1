# Runs on the interactive desktop (via scheduled task ZideLaunchVSCode). Reads C:\zide\run\launch.json:
#   { "workspace": "C:\\zws", "cdpPort": 9333, "extraArgs": ["--skip-welcome"] }
$ErrorActionPreference = 'Stop'
$cfg = Get-Content 'C:\zide\run\launch.json' -Raw | ConvertFrom-Json
$code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
$args = @("--remote-debugging-port=$($cfg.cdpPort)") + @($cfg.extraArgs) + @($cfg.workspace)
Start-Process -FilePath $code -ArgumentList $args
