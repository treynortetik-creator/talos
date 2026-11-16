<#
.SYNOPSIS
  Keeps the Talos WSL distro running (docs/WINDOWS-PLAN.md section 8). WSL stops a distro once no Windows process holds it,
  its systemd services and Talos with it; this holds it with one idle process and starts it again if WSL stops it anyway.
  install.ps1 runs it at logon, hidden, as a task of yours. One copy runs per distro: a second one waits up to 10 s for the first to let go, then exits 1.

  It holds the distro only while the distro is cut off from Windows (`talos-wsl.sh hold`, R3-2): when it is not, the hold
  ends at once and says why, and this logs that and tells you with a Windows notification, once until it holds again (R3-7).
#>
[CmdletBinding()]
param([string]$Distro = 'talos')
$ErrorActionPreference = 'Continue'
$dir = Join-Path $env:LOCALAPPDATA 'Talos'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "keepalive-$Distro.log"
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe' # by its full path (R1-11): never a wsl.exe found first on PATH

function Log([string]$m) {
  # a small log: the last 200 lines
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $m
  $old = @()
  if (Test-Path $log) { $old = @(Get-Content $log -Tail 199) }
  Set-Content -Path $log -Value ($old + $line) -Encoding UTF8
}

# A Windows notification, with Windows PowerShell's own app id (no module, no install); a failure to show one is logged.
function Notify([string]$title, [string]$text) {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $t = $xml.GetElementsByTagName('text')
    $null = $t.Item(0).AppendChild($xml.CreateTextNode($title))
    $null = $t.Item(1).AppendChild($xml.CreateTextNode($text))
    $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch {
    Log "could not show a notification: $($_.Exception.Message)"
  }
}

# the lock the tray shares: waited for up to 10 s (the one before can still be letting go), taken over when its holder
# died, and if still held, logged and exit 1, so the logon task's restart tries again (Fable R1-4 on edb035b3)
$mutex = New-Object Threading.Mutex($false, "Local\TalosKeepAlive-$Distro")
$got = $false
try { $got = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $got = $true }
if (-not $got) {
  Log "another keep-alive or tray for $Distro still holds the lock after 10 s; this one stops (exit 1: the task tries again)"
  exit 1
}
# a hold left by a keep-alive or tray that is gone would keep the distro held for good: the lock holder owns the hold
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'TalosWin.ps1')
Stop-TalosStrayHolds $Distro
Log "keep-alive started for $Distro"
$wait = 5
$told = $false
try {
  while ($true) {
    $start = Get-Date
    $said = New-Object Collections.Generic.List[string]
    # root: the check reads what only the distro's own setup decides; the hold itself is one idle `sleep`
    & $wsl -d $Distro -u root --exec /opt/talos-wsl/talos-wsl.sh hold 2>&1 | ForEach-Object { $said.Add(("$_" -replace "`0", '')) }
    $code = $LASTEXITCODE
    $ran = [int]((Get-Date) - $start).TotalSeconds
    $refused = @($said | Where-Object { $_ -match '^refused: ' } | ForEach-Object { $_ -replace '^refused: (talos-wsl: )?', '' })
    if ($refused.Count -gt 0) {
      Log "the $Distro distro is not cut off from Windows, so it is not held (Talos does not run): $($refused -join '; ')"
      if (-not $told) {
        Notify 'Talos is stopped' "Its WSL distro ($Distro) is not cut off from Windows: $($refused[0]). Restart it: wsl --terminate $Distro"
        $told = $true
      }
    } else {
      Log "the $Distro distro let go after ${ran}s (exit $code); starting it again in ${wait}s"
    }
    Start-Sleep -Seconds $wait
    # a distro that will not stay up is not hammered, but Talos is never down long for it (R1-15): at most 30 s between
    # tries, back to 5 s once it holds. A hold that lasted and ended without a refusal is the end of a refusal streak, so
    # the next one is told again; one that lasted and then was refused (hold checks while it holds) was just told (R5-5).
    if ($ran -lt 60) { $wait = [Math]::Min($wait * 2, 30) } else { $wait = 5; if ($refused.Count -eq 0) { $told = $false } }
  }
} finally {
  $mutex.ReleaseMutex()
}
