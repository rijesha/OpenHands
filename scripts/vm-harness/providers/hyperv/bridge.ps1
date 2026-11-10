# Long-lived JSON-lines RPC loop. One request per stdin line: {"id":1,"cmd":"Get-VmhVmIp","args":{...}}
# One response per stdout line:  {"id":1,"ok":true,"result":...}  or  {"id":1,"ok":false,"error":"..."}
# Only module functions on the allowlist can be called.
param([string]$Module = (Join-Path $PSScriptRoot 'VmHarnessHyperV.psm1'))
$ErrorActionPreference = 'Stop'
Import-Module $Module -Force
$allow = @('Send-VmhChars', 'Get-VmhVmState', 'Get-VmhRunVms', 'Send-VmhScroll', 'Get-VmhVmId', 'Test-VmhHost', 'New-VmhRunVm', 'New-VmhGoldenVm', 'Get-VmhVmIp', 'Remove-VmhRunVm', 'Get-VmhThumbnail', 'Send-VmhKeys', 'Send-VmhMouse', 'Save-VmhSnapshot',
           'Start-VM', 'Stop-VM', 'Remove-VM')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        if ($allow -notcontains $req.cmd) { throw "Command not allowed: $($req.cmd)" }
        $splat = @{}
        if ($req.args) { $req.args.PSObject.Properties | ForEach-Object { $splat[$_.Name] = $_.Value } }
        $result = & $req.cmd @splat
        @{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Depth 6 -Compress
    }
    catch {
        @{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
}
