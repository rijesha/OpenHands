# Hyper-V helpers for the OpenHands VM harness (ported from the zephyr-ide ai-qa tool).
# Requires membership in "Hyper-V Administrators" (or elevation).
# Desktop I/O (Msvm_* WMI) was verified against real Windows 11 and Ubuntu guests; mouse scrolling is still unverified.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:WmiNs = 'root\virtualization\v2'

function Assert-Path([string]$Path) { [System.IO.Path]::GetFullPath($Path) }

function Test-VmhHost {
    param([string]$Root)
    $problems = @()
    if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { $problems += 'Hyper-V PowerShell module not installed' }
    else {
        try { $null = Get-VM -ErrorAction Stop } catch { $problems += 'Not permitted to manage Hyper-V: add this user to the "Hyper-V Administrators" group, then sign out and in' }
        try { $null = Get-VMSwitch -Name 'Default Switch' -ErrorAction Stop } catch { $problems += 'Hyper-V "Default Switch" not found' }
    }
    $freeGB = 0
    if ($Root) {
        $letter = [System.IO.Path]::GetPathRoot((Assert-Path $Root)).Substring(0, 1)
        $drive = Get-PSDrive -Name $letter -ErrorAction SilentlyContinue
        if ($drive) { $freeGB = [math]::Round($drive.Free / 1GB, 1) } else { $problems += "Drive for root '$Root' not found" }
    }
    $os = Get-CimInstance Win32_OperatingSystem
    [pscustomobject]@{
        ok = ($problems.Count -eq 0); problems = $problems
        freeDiskGB = $freeGB; freeRamMB = [int]($os.FreePhysicalMemory / 1KB)
    }
}

function New-VmhGoldenVm {
    param(
        [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][ValidateSet('windows', 'ubuntu')][string]$Os,
        [Parameter(Mandatory)][string]$IsoPath, [Parameter(Mandatory)][string]$Root,
        [int]$MemoryMB = 8192, [int]$Cpus = 4, [int]$DiskGB = 80
    )
    $build = Assert-Path (Join-Path $Root 'images\build')
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    $vhd = Join-Path $build "$Name.vhdx"
    New-VHD -Path $vhd -SizeBytes ($DiskGB * 1GB) -Dynamic | Out-Null
    $vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes ($MemoryMB * 1MB) -VHDPath $vhd -Path $build -SwitchName 'Default Switch'
    Set-VM -VM $vm -ProcessorCount $Cpus -StaticMemory -CheckpointType Disabled -SmartPagingFilePath $build -SnapshotFileLocation $build
    Enable-VMIntegrationService -VM $vm -Name 'Guest Service Interface'
    $template = if ($Os -eq 'windows') { 'MicrosoftWindows' } else { 'MicrosoftUEFICertificateAuthority' }
    Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate $template
    if ($Os -eq 'windows') {
        Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
        Enable-VMTPM -VM $vm
    }
    # Verify on Gen2: single fixed resolution so screenshot pixels map 1:1 to input coordinates.
    Set-VMVideo -VM $vm -HorizontalResolution 1280 -VerticalResolution 800 -ResolutionType Single
    $dvd = Add-VMDvdDrive -VM $vm -Path $IsoPath -Passthru
    Set-VMFirmware -VM $vm -FirstBootDevice $dvd
    [pscustomobject]@{ name = $Name; vhdx = $vhd }
}

function New-VmhRunVm {
    param(
        [Parameter(Mandatory)][string]$RunId, [Parameter(Mandatory)][ValidateSet('windows', 'ubuntu')][string]$Os,
        [Parameter(Mandatory)][string]$Role, [Parameter(Mandatory)][string]$ParentVhdx,
        [Parameter(Mandatory)][string]$Root, [int]$MemoryMB = 8192, [int]$Cpus = 4
    )
    $dir = Assert-Path (Join-Path $Root "vms\$RunId\$Os-$Role")
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $name = "vmh-$RunId-$Os-$Role"
    $disk = Join-Path $dir 'disk.vhdx'
    New-VHD -Path $disk -ParentPath $ParentVhdx -Differencing | Out-Null
    $vm = New-VM -Name $name -Generation 2 -MemoryStartupBytes ($MemoryMB * 1MB) -VHDPath $disk -Path $dir -SwitchName 'Default Switch'
    Set-VM -VM $vm -ProcessorCount $Cpus -StaticMemory -CheckpointType Disabled -SmartPagingFilePath $dir -SnapshotFileLocation $dir
    Enable-VMIntegrationService -VM $vm -Name 'Guest Service Interface'
    $template = if ($Os -eq 'windows') { 'MicrosoftWindows' } else { 'MicrosoftUEFICertificateAuthority' }
    Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate $template
    if ($Os -eq 'windows') { Set-VMKeyProtector -VM $vm -NewLocalKeyProtector; Enable-VMTPM -VM $vm }
    Set-VMVideo -VM $vm -HorizontalResolution 1280 -VerticalResolution 800 -ResolutionType Single
    # Stable MAC derived from the VM name so ARP lookup works as an IP fallback.
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($name))
    $mac = '00155D' + (($hash[0..2] | ForEach-Object { $_.ToString('X2') }) -join '')
    Set-VMNetworkAdapter -VMName $name -StaticMacAddress $mac
    [pscustomobject]@{ name = $name; vmId = $vm.Id.ToString(); dir = $dir; diskPath = $disk; mac = $mac }
}

function Get-VmhVmIp {
    param([Parameter(Mandatory)][string]$Name, [int]$TimeoutSec = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $ips = (Get-VMNetworkAdapter -VMName $Name).IPAddresses | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notlike '169.254.*' }
        if ($ips) { return @($ips)[0] }
        Start-Sleep -Seconds 2
    }
    # Fallback: ARP table lookup by the VM's static MAC.
    $mac = ((Get-VMNetworkAdapter -VMName $Name).MacAddress -replace '(..)(?!$)', '$1-')
    $n = Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.LinkLayerAddress -ieq $mac -and $_.State -ne 'Unreachable' }
    if ($n) { return @($n)[0].IPAddress }
    throw "No IP found for VM '$Name' within ${TimeoutSec}s"
}

function Get-VmhVmId { param([Parameter(Mandatory)][string]$Name) [pscustomobject]@{ vmId = (Get-VM -Name $Name).Id.ToString() } }

function Get-VmhVmState {
    param([Parameter(Mandatory)][string]$Name)
    $v = Get-VM -Name $Name -ErrorAction SilentlyContinue
    if ($v) { $v.State.ToString() } else { 'Missing' }
}

function Get-VmhRunVms {
    # All run VMs (named vmh-*), oldest first. Used by the orphan sweep.
    Get-VM -Name 'vmh-*' -ErrorAction SilentlyContinue | Sort-Object CreationTime | ForEach-Object {
        $disk = (Get-VMHardDiskDrive -VM $_ | Select-Object -First 1).Path
        [pscustomobject]@{ name = $_.Name; state = $_.State.ToString(); memoryMB = [int]($_.MemoryAssigned / 1MB); created = $_.CreationTime.ToString('o'); dir = $(if ($disk) { Split-Path $disk -Parent } else { '' }) }
    }
}

function Remove-VmhRunVm {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Dir)
    $d = Assert-Path $Dir
    $vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
    if ($vm) {
        if ($vm.State -ne 'Off') { Stop-VM -Name $Name -TurnOff -Force }
        Remove-VM -Name $Name -Force
    }
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
}

function Save-VmhSnapshot {
    # Turns a run VM into a reusable image: the VM is powered off and removed, its differencing disk (a child of the
    # image it booted from) is moved to Dest and made read-only, and the run folder is cleaned up.
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][string]$Dest)
    $d = Assert-Path $Dir
    $target = Assert-Path $Dest
    if (Test-Path $target) { throw "Snapshot disk already exists: $target" }
    $vm = Get-VM -Name $Name -ErrorAction Stop
    $disk = (Get-VMHardDiskDrive -VM $vm | Select-Object -First 1).Path
    if ($vm.State -ne 'Off') { Stop-VM -Name $Name -TurnOff -Force }
    Remove-VM -Name $Name -Force
    Move-Item -LiteralPath $disk -Destination $target
    Set-ItemProperty -LiteralPath $target -Name IsReadOnly -Value $true
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
    [pscustomobject]@{ vhdx = $target; sizeBytes = (Get-Item -LiteralPath $target).Length }
}

# ---------------------------------------------------------------- desktop I/O (WMI) ----

function Get-VmhComputerSystem([string]$VmId) {
    Get-CimInstance -Namespace $script:WmiNs -ClassName Msvm_ComputerSystem -Filter "Name='$VmId'"
}

function Get-VmhThumbnail {
    # Returns the raw RGB565 frame as base64; the Node side converts it to PNG (src/hyperv/rgb565.ts).
    param([Parameter(Mandatory)][string]$VmId, [int]$Width = 1280, [int]$Height = 800)
    $svc = Get-CimInstance -Namespace $script:WmiNs -ClassName Msvm_VirtualSystemManagementService
    $settings = Get-CimAssociatedInstance -InputObject (Get-VmhComputerSystem $VmId) -ResultClassName Msvm_VirtualSystemSettingData |
        Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
    $r = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{
        TargetSystem = $settings; WidthPixels = [uint16]$Width; HeightPixels = [uint16]$Height }
    if ($r.ReturnValue -ne 0) { throw "GetVirtualSystemThumbnailImage failed: $($r.ReturnValue)" }
    [Convert]::ToBase64String([byte[]]$r.ImageData)
}

function Get-VmhKeyboard([string]$VmId) {
    Get-CimAssociatedInstance -InputObject (Get-VmhComputerSystem $VmId) -ResultClassName Msvm_Keyboard | Select-Object -First 1
}

function Send-VmhKeys {
    param([Parameter(Mandatory)][string]$VmId, [string]$Text, [uint32[]]$Press, [uint32[]]$Release, [uint32[]]$Type)
    $kb = Get-VmhKeyboard $VmId
    if ($Text) { $null = Invoke-CimMethod -InputObject $kb -MethodName TypeText -Arguments @{ asciiText = $Text } }
    foreach ($k in $Press) { $null = Invoke-CimMethod -InputObject $kb -MethodName PressKey -Arguments @{ keyCode = $k } }
    foreach ($k in $Type) { $null = Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = $k } }
    foreach ($k in $Release) { $null = Invoke-CimMethod -InputObject $kb -MethodName ReleaseKey -Arguments @{ keyCode = $k } }
}

function Send-VmhChars {
    # Types printable ASCII one key at a time (TypeKey with US-layout virtual-key codes, Shift for upper case and symbols).
    # Msvm_Keyboard.TypeText garbled text on the Ubuntu guest (spike S1 follow-up), while TypeKey/PressKey were reliable.
    param([Parameter(Mandatory)][string]$VmId, [Parameter(Mandatory)][string]$Text, [int]$DelayMs = 25)
    $kb = Get-VmhKeyboard $VmId
    $oem = @{ ';' = 0xBA; '=' = 0xBB; ',' = 0xBC; '-' = 0xBD; '.' = 0xBE; '/' = 0xBF; '`' = 0xC0; '[' = 0xDB; '\' = 0xDC; ']' = 0xDD; "'" = 0xDE }
    $shiftOem = @{ ':' = ';'; '+' = '='; '<' = ','; '_' = '-'; '>' = '.'; '?' = '/'; '~' = '`'; '{' = '['; '|' = '\'; '}' = ']'; '"' = "'" }
    $shiftNum = @{ ')' = '0'; '!' = '1'; '@' = '2'; '#' = '3'; '$' = '4'; '%' = '5'; '^' = '6'; '&' = '7'; '*' = '8'; '(' = '9' }
    foreach ($ch in $Text.ToCharArray()) {
        $c = [string]$ch; $shift = $false; $vk = $null
        if ($c -cmatch '^[a-z]$') { $vk = [int][char]$c.ToUpper() }
        elseif ($c -cmatch '^[A-Z]$') { $vk = [int][char]$c; $shift = $true }
        elseif ($c -match '^[0-9]$') { $vk = [int][char]$c }
        elseif ($c -eq ' ') { $vk = 0x20 }
        elseif ($shiftNum.ContainsKey($c)) { $vk = [int][char]$shiftNum[$c]; $shift = $true }
        elseif ($shiftOem.ContainsKey($c)) { $vk = $oem[$shiftOem[$c]]; $shift = $true }
        elseif ($oem.ContainsKey($c)) { $vk = $oem[$c] }
        else { throw "unsupported character: '$c'" }
        if ($shift) { $null = Invoke-CimMethod -InputObject $kb -MethodName PressKey -Arguments @{ keyCode = [uint32]0x10 } }
        $null = Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = [uint32]$vk }
        if ($shift) { $null = Invoke-CimMethod -InputObject $kb -MethodName ReleaseKey -Arguments @{ keyCode = [uint32]0x10 } }
        if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
    }
}

function Send-VmhMouse {
    # UNVERIFIED (S1): Msvm_SyntheticMouse method names/units. Use the spike to confirm before relying on this.
    param([Parameter(Mandatory)][string]$VmId, [Parameter(Mandatory)][int]$X, [Parameter(Mandatory)][int]$Y,
          [ValidateSet('none', 'left', 'right', 'middle')][string]$Button = 'none', [int]$Count = 1,
          [int]$Width = 1280, [int]$Height = 800)
    $mouse = Get-CimAssociatedInstance -InputObject (Get-VmhComputerSystem $VmId) -ResultClassName Msvm_SyntheticMouse | Select-Object -First 1
    # S1 result: SetAbsolutePosition takes RAW PIXELS of the guest framebuffer (scaling to 0..65535 clamped the pointer to the bottom-right).
    $null = Invoke-CimMethod -InputObject $mouse -MethodName SetAbsolutePosition -Arguments @{ HorizontalPosition = [int]$X; VerticalPosition = [int]$Y }
    if ($Button -ne 'none') {
        # S1 result: ButtonIndex is 1-based (0 returns 32773 "invalid parameter"): 1 = left, 2 = right, 3 = middle.
        $idx = @{ left = 1; right = 2; middle = 3 }[$Button]
        for ($i = 0; $i -lt $Count; $i++) {
            $r = Invoke-CimMethod -InputObject $mouse -MethodName ClickButton -Arguments @{ ButtonIndex = [uint32]$idx }
            if ($r.ReturnValue -ne 0) { throw "ClickButton($idx) failed: $($r.ReturnValue)" }
            if ($i -lt $Count - 1) { Start-Sleep -Milliseconds 80 }
        }
    }
}

function Send-VmhScroll {
    # UNVERIFIED (S1 follow-up): sign/units of SetScrollPosition's delta (one wheel notch is probably 120).
    param([Parameter(Mandatory)][string]$VmId, [Parameter(Mandatory)][int]$Delta)
    $mouse = Get-CimAssociatedInstance -InputObject (Get-VmhComputerSystem $VmId) -ResultClassName Msvm_SyntheticMouse | Select-Object -First 1
    $r = Invoke-CimMethod -InputObject $mouse -MethodName SetScrollPosition -Arguments @{ ScrollPositionDelta = [int]$Delta }
    if ($r.ReturnValue -ne 0) { throw "SetScrollPosition failed: $($r.ReturnValue)" }
}


Export-ModuleMember -Function Save-VmhSnapshot, New-VmhGoldenVm, Send-VmhChars, Get-VmhVmState, Get-VmhRunVms, Send-VmhScroll, Get-VmhVmId, Test-VmhHost, New-VmhRunVm, Get-VmhVmIp, Remove-VmhRunVm, Get-VmhThumbnail, Send-VmhKeys, Send-VmhMouse
