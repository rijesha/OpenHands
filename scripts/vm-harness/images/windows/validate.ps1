# Run INSIDE the Windows guest before sealing. Exit code 0 only if every check passes.
$fails = @(); function Check($n, $ok, $d = '') { if ($ok) { "PASS  $n $d" } else { "FAIL  $n $d"; $script:fails += $n } }
$User = 'zide'
Check 'sshd running' ((Get-Service sshd).Status -eq 'Running')
Check 'authorized key present' (Test-Path 'C:\ProgramData\ssh\administrators_authorized_keys')
Check 'VS Code installed' (Test-Path "C:\Users\$User\AppData\Local\Programs\Microsoft VS Code\Code.exe")
Check 'VS Code settings' (Test-Path "C:\Users\$User\AppData\Roaming\Code\User\settings.json")
Check 'launcher task' ($null -ne (Get-ScheduledTask -TaskName ZideLaunchVSCode -ErrorAction SilentlyContinue))
Check 'work dirs' ((Test-Path 'C:\zide\in') -and (Test-Path 'C:\zws'))
$bl = (manage-bde -status C: 2>&1 | Out-String)
Check 'BitLocker fully decrypted' ($bl -match 'Fully Decrypted') ($bl -replace '\s+', ' ' | Select-String -Pattern 'Conversion Status:\s*\w[\w ]*' | ForEach-Object { $_.Matches[0].Value })
Check 'autologon' ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').AutoAdminLogon -eq '1')
foreach ($t in 'git', 'node', 'python', 'uv', 'west') {
    $c = Get-Command $t -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*\WindowsApps\*' }
    Check "$t absent (clean user machine)" ($null -eq $c)
}
Check 'winget available' ($null -ne (Get-Command winget -ErrorAction SilentlyContinue) -or (Test-Path "C:\Users\$User\AppData\Local\Microsoft\WindowsApps\winget.exe"))
$d = Get-CimInstance Win32_VideoController | Select-Object -First 1
"INFO  resolution: $($d.CurrentHorizontalResolution)x$($d.CurrentVerticalResolution)"
if ($fails.Count) { Write-Host "`n$($fails.Count) check(s) failed"; exit 1 } else { Write-Host "`nAll checks passed" }
