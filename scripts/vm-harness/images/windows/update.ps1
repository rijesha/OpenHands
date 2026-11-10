# Installs every available Windows update (one pass). Run as SYSTEM (scheduled task): the Windows Update COM API refuses installs from a network (SSH) logon.
# Writes progress to C:\zide\update.log and the final state to C:\zide\update.done ("reboot" | "clean" | "error ...").
$ErrorActionPreference = 'Stop'
$log = 'C:\zide\update.log'
New-Item -ItemType Directory -Force C:\zide | Out-Null
Remove-Item C:\zide\update.done -ErrorAction SilentlyContinue
function Log($m) { "$(Get-Date -Format s) $m" | Add-Content $log }
try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    Log 'searching'
    $found = $searcher.Search("IsInstalled=0 and IsHidden=0")
    Log "found $($found.Updates.Count) update(s)"
    if ($found.Updates.Count -eq 0) { Set-Content C:\zide\update.done 'clean'; return }
    $todo = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($u in $found.Updates) {
        Log "  $($u.Title) ($([math]::Round($u.MaxDownloadSize/1MB)) MB)"
        if (-not $u.EulaAccepted) { $u.AcceptEula() }
        [void]$todo.Add($u)
    }
    $dl = $session.CreateUpdateDownloader(); $dl.Updates = $todo
    Log 'downloading'; $dr = $dl.Download(); Log "download result $($dr.ResultCode)"
    $inst = $session.CreateUpdateInstaller(); $inst.Updates = $todo
    Log 'installing'; $ir = $inst.Install()
    Log "install result $($ir.ResultCode) rebootRequired=$($ir.RebootRequired)"
    for ($i = 0; $i -lt $todo.Count; $i++) { Log "  [$($ir.GetUpdateResult($i).ResultCode)] $($todo.Item($i).Title)" }
    Set-Content C:\zide\update.done $(if ($ir.RebootRequired) { 'reboot' } else { 'more' })
} catch {
    Log "ERROR $_"; Set-Content C:\zide\update.done "error $_"
}
