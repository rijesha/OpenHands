# Provisions the Windows 11 golden image. Run INSIDE the guest as an administrator (user 'zide').
#   provision.ps1 -PublicKey "<contents of guest_ed25519.pub>" -Password "<zide password>" [-VsCodeVersion 1.105.0]
# Deliberately does NOT install git, python or node: host-tools installs must look like a clean user machine.
param(
    [Parameter(Mandatory)][string]$PublicKey,
    [Parameter(Mandatory)][string]$Password,
    [string]$User = 'zide',
    [string]$VsCodeVersion = 'latest'
)
$ErrorActionPreference = 'Stop'
$log = 'C:\zide-provision.log'; Start-Transcript -Path $log -Append | Out-Null

Write-Host '== OpenSSH Server'
# The Windows-capability route downloads through Windows Update and can hang indefinitely on a fresh install,
# so use Microsoft's official Win32-OpenSSH MSI from GitHub instead.
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $rel = Invoke-RestMethod 'https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest' -Headers @{ 'User-Agent' = 'zide-provision' }
    $asset = $rel.assets | Where-Object { $_.name -match 'OpenSSH-Win64.*\.msi$' } | Select-Object -First 1
    if (-not $asset) { throw 'No OpenSSH Win64 MSI asset found in the latest Win32-OpenSSH release' }
    $msi = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msi -UseBasicParsing
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010) { throw "OpenSSH MSI failed with exit code $($p.ExitCode)" }
}
Set-Service sshd -StartupType Automatic; Start-Service sshd
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
$ak = 'C:\ProgramData\ssh\administrators_authorized_keys'
Set-Content -Path $ak -Value $PublicKey -Encoding ascii
icacls $ak /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
if (-not (Get-NetFirewallRule -Name 'sshd-zide' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'sshd-zide' -DisplayName 'OpenSSH (zide)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

Write-Host '== Autologon, no sleep / lock'
$wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $wl AutoAdminLogon 1; Set-ItemProperty $wl DefaultUserName $User; Set-ItemProperty $wl DefaultPassword $Password
powercfg /change standby-timeout-ac 0; powercfg /change monitor-timeout-ac 0; powercfg /change hibernate-timeout-ac 0; powercfg /hibernate off
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Force | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' NoLockScreen 1 -Type DWord
# NoLockScreen is ignored on Pro: close every other path that locks the interactive session
# (a locked session cannot show VS Code or UAC to the tester).
powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /setactive SCHEME_CURRENT
$sys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
Set-ItemProperty $sys InactivityTimeoutSecs 0 -Type DWord
Set-ItemProperty $sys DisableLockWorkstation 1 -Type DWord
foreach ($k in 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel', 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop') {
    if (-not (Test-Path $k)) { New-Item -Path $k | Out-Null }
}
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' ScreenSaveActive 0 -Type String

Write-Host '== Defer Windows Update, no auto reboot, no tips'
$wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
New-Item -Path $wu -Force | Out-Null
Set-ItemProperty $wu NoAutoUpdate 1 -Type DWord; Set-ItemProperty $wu NoAutoRebootWithLoggedOnUsers 1 -Type DWord
$cdm = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent'
New-Item -Path $cdm -Force | Out-Null
Set-ItemProperty $cdm DisableSoftLanding 1 -Type DWord; Set-ItemProperty $cdm DisableWindowsConsumerFeatures 1 -Type DWord

Write-Host '== BitLocker / device encryption OFF (differencing children must not hit recovery)'
try { manage-bde -off C: | Out-Null } catch { Write-Warning $_ }
if (-not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\BitLocker')) { New-Item -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\BitLocker' | Out-Null }
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\BitLocker' PreventDeviceEncryption 1 -Type DWord

Write-Host '== VS Code (user installer, pinned)'
$url = if ($VsCodeVersion -eq 'latest') { 'https://update.code.visualstudio.com/latest/win32-x64-user/stable' }
       else { "https://update.code.visualstudio.com/$VsCodeVersion/win32-x64-user/stable" }
$exe = "$env:TEMP\vscode-user-setup.exe"
Invoke-WebRequest -Uri $url -OutFile $exe
# Install for the interactive user via a one-shot task so it lands in that user's profile.
$inst = "Start-Process -Wait '$exe' -ArgumentList '/VERYSILENT /NORESTART /MERGETASKS=!runcode'"
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -Command `"$inst`""
$p = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'ZideInstallVSCode' -Action $a -Principal $p -Force | Out-Null
Start-ScheduledTask -TaskName 'ZideInstallVSCode'
$code = "C:\Users\$User\AppData\Local\Programs\Microsoft VS Code\Code.exe"
for ($i = 0; $i -lt 120 -and -not (Test-Path $code); $i++) { Start-Sleep -Seconds 3 }
if (-not (Test-Path $code)) { throw 'VS Code did not install for the user' }
Unregister-ScheduledTask -TaskName 'ZideInstallVSCode' -Confirm:$false

Write-Host '== VS Code settings + argv.json'
$ud = "C:\Users\$User\AppData\Roaming\Code\User"; New-Item -ItemType Directory -Force $ud | Out-Null
Copy-Item "$PSScriptRoot\..\common\vscode-settings.json" "$ud\settings.json" -Force
$dotCode = "C:\Users\$User\.vscode"; New-Item -ItemType Directory -Force $dotCode | Out-Null
# Windows PowerShell's -Encoding utf8 writes a BOM that VS Code rejects: write without one.
[IO.File]::WriteAllText("$dotCode\argv.json", '{ "enable-crash-reporter": false }', (New-Object Text.UTF8Encoding $false))

Write-Host '== Work dirs + launcher task'
'C:\zide\in', 'C:\zide\run', 'C:\zide\bin', 'C:\zws' | ForEach-Object { New-Item -ItemType Directory -Force $_ | Out-Null }
Copy-Item "$PSScriptRoot\launch-vscode.ps1" 'C:\zide\bin\launch-vscode.ps1' -Force
foreach ($d in 'C:\zide', 'C:\zws') { icacls $d /grant "${User}:(OI)(CI)M" | Out-Null }
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\zide\bin\launch-vscode.ps1'
$pr = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'ZideLaunchVSCode' -Action $act -Principal $pr -Force | Out-Null

Write-Host "Provisioned. Next: run validate.ps1, shut the VM down, then 'ai-qa images seal'."
Stop-Transcript | Out-Null
