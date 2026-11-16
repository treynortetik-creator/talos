<#
.SYNOPSIS
  Keeps the talos-ci WSL distro running on Titan, so its GitHub Actions runner stays online. WSL stops a distro once no
  Windows process holds it, its systemd services and the runner with them; this holds it with one idle process and starts
  it again if WSL stops it anyway. The same design as Talos's own keep-alive (apps/windows/keepalive.ps1): a hidden logon
  task of the owner's, one copy at a time, retries at most 30 s apart, a short log. It never touches WSL's interop entry
  or anything else in the distro: it runs `sleep`.
#>
[CmdletBinding()]
param([string]$Distro = 'talos-ci')
$ErrorActionPreference = 'Continue'
$dir = Join-Path $env:LOCALAPPDATA 'Talos-CI'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "keepalive-$Distro.log"
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe' # by its full path: never a wsl.exe found first on PATH

function Log([string]$m) {
  # a small log: the last 200 lines
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $m
  $old = @()
  if (Test-Path $log) { $old = @(Get-Content $log -Tail 199) }
  Set-Content -Path $log -Value ($old + $line) -Encoding UTF8
}

$created = $false
$mutex = New-Object Threading.Mutex($true, "Local\TalosCIKeepAlive-$Distro", [ref]$created)
if (-not $created) { exit 0 }
Log "keep-alive started for $Distro"
$wait = 5
try {
  while ($true) {
    $start = Get-Date
    $said = (& $wsl -d $Distro --exec /bin/sleep infinity 2>&1 | ForEach-Object { "$_" -replace "`0", '' }) -join ' '
    $code = $LASTEXITCODE
    $ran = [int]((Get-Date) - $start).TotalSeconds
    $why = if ($said.Trim()) { ": $($said.Trim())" } else { '' }
    Log "the $Distro distro let go after ${ran}s (exit $code)$why; starting it again in ${wait}s"
    Start-Sleep -Seconds $wait
    # a distro that will not stay up is not hammered, but the runner is never down long for it: at most 30 s between
    # tries, back to 5 s once it holds
    if ($ran -lt 60) { $wait = [Math]::Min($wait * 2, 30) } else { $wait = 5 }
  }
} finally {
  $mutex.ReleaseMutex()
}
