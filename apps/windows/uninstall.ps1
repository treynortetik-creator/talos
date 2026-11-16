<#
.SYNOPSIS
  Stops Talos on Windows (docs/WINDOWS-PLAN.md section 8). Always: the keep-alive logon task. If the distro is one Talos made
  (it holds Talos's marker), it is stopped. Only with -RemoveDistro, after you type its name: the distro and everything in it
  (the agent folder, its memory, the bridge's keys) are deleted for good. A distro without the marker is never stopped or
  deleted (R1-7), whatever its name. Windows folders you shared are never touched: they were only mounted.
  Last, what Talos put in %LOCALAPPDATA%\Talos goes too, this script's own folder included (Remove-TalosLeftovers): the
  distro's disk there stays as long as the distro does, and a file Talos did not put there is never touched. While the
  distro is kept, bin keeps only uninstall.ps1 and TalosWin.ps1, and the Start menu entry "Remove Talos and its data" (which
  runs them with -RemoveDistro -Pause) stays: the Windows user has no terminal, so that is how she finishes later. Once the
  distro is gone, the entry goes too and nothing is left.
  -Pause: wait for Enter at the end (the Start menu entry's own window, so what was done can be read).
#>
[CmdletBinding()]
param(
  [string]$Distro = 'talos',
  [switch]$RemoveDistro,
  [switch]$Pause
)
function Exit-Talos([int]$Code) {
  if ($Pause) { [void](Read-Host 'Press Enter to close this window') }
  exit $Code
}
# an error that ends it is said, and the Start menu window waits for it to be read too
trap {
  Write-Host "== stopped: $($_.Exception.Message)" -ForegroundColor Yellow
  Exit-Talos 1
}
$ErrorActionPreference = 'Stop'
$uninstallFrom = Split-Path -Parent $PSCommandPath
. (Join-Path $uninstallFrom 'TalosWin.ps1')
# never this script's own folder as the working one: it is removed at the end
Set-Location -LiteralPath $env:TEMP
# a distro name, never a path: it names a log and a logon task below
if ($Distro -cnotmatch $TalosDistroName -or $Distro -match '\.\.') {
  Write-Host "== '$Distro' is not a distro name: nothing was changed" -ForegroundColor Yellow
  Exit-Talos 64
}
$taskName = "Talos keep-alive ($Distro)"
# another Talos install on this PC (its own keep-alive task) still uses bin and Setup's files: they stay
$otherTalos = @(Get-ScheduledTask -TaskName 'Talos keep-alive (*)' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -ne $taskName })
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "== removed the logon task '$taskName'"
} else {
  Write-Host "== no logon task '$taskName'"
}
# what Talos Setup left: a pending resume now; its unpacked copy, the stay-awake choice and the rest at the end
# (Remove-TalosLeftovers), only once it is known whether another Talos install still uses them. The tray's request to stay
# awake ended with the tray; no power setting was ever changed, so there is none to put back.
Clear-TalosResume
$talosHome = Join-Path $env:LOCALAPPDATA 'Talos'
# The last step, whatever happened before it (Fable R3 on a44344c2, the owner's promise): the owner's other WSL distros can
# still run Windows programs. WSL's one VM-wide entry for them is checked, and given back if it is gone, through WSL's own
# system distro (Restore-TalosWslInterop), which touches none of the owner's distros and starts none.
function Confirm-TalosInterop {
  if (Restore-TalosWslInterop) {
    Write-Host '== your other WSL distros can still run Windows programs'
  } else {
    Write-Host "== could not check that your other WSL distros can still run Windows programs. If one says 'Exec format error', run: wsl --shutdown" -ForegroundColor Yellow
  }
}
# every way out that is not a refusal: the interop check, then what Talos put in %LOCALAPPDATA%\Talos
function Complete-TalosUninstall([switch]$DistroGone, [switch]$SharedKept) {
  Confirm-TalosInterop
  $keep = $SharedKept -or $otherTalos.Count -gt 0
  # A disk still there means a distro still there, whatever was said before (a failed --unregister, a mistyped name after a
  # plain uninstall removed the keep-alive task): the way to remove it stays. Only a gone disk lets the uninstall go.
  $disk = Test-Path -LiteralPath (Join-Path $talosHome 'wsl\ext4.vhdx')
  $kept = -not $keep -and (-not $DistroGone -or $disk)
  # the entry is made only for a distro that is really there: a name WSL does not have (a typo while the disk is there) keeps
  # the files, and whatever entry the real distro already has, but makes none of its own
  $entry = ''
  if ($kept) {
    # the uninstall that runs from the entry is this one: its two files put in bin when they differ (an older install's
    # copy, or none at all), then the entry made for this distro
    $bin = Join-Path $talosHome 'bin'
    $from = $uninstallFrom
    try {
      if (-not (Test-Path -LiteralPath $bin)) {
        # made again (an older uninstall removed it): only this user and SYSTEM on it, as Setup makes it
        New-Item -ItemType Directory -Path $bin | Out-Null
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        & icacls.exe $bin /inheritance:r /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' /q 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not limit $bin to you (icacls exit $LASTEXITCODE)" }
      }
      foreach ($f in $TalosUninstallerFiles) {
        $src = Join-Path $from $f; $dst = Join-Path $bin $f
        if ((Resolve-Path -LiteralPath $from).Path -ne (Resolve-Path -LiteralPath $bin).Path -and
            (-not (Test-Path -LiteralPath $dst) -or (Get-FileHash -LiteralPath $src).Hash -ne (Get-FileHash -LiteralPath $dst).Hash)) {
          Copy-Item -LiteralPath $src -Destination $dst -Force
        }
      }
      if (-not $DistroGone) {
        $lnk = New-TalosRemoveShortcut -BinDir $bin -Distro $Distro
        $entry = [IO.Path]::GetFileNameWithoutExtension($lnk)
      }
    } catch {
      Write-Host "== could not make the Start menu entry: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  Remove-TalosLeftovers -TalosHome $talosHome -Distro $Distro -DistroGone:($DistroGone -and -not $disk) -SharedKept:$keep -KeepUninstaller:$kept -EntryName $entry |
    ForEach-Object { Write-Host $_ }
  # this distro is gone (WSL deleted it, or never had it): its own entry goes, whatever other install remains
  if ($DistroGone) { Remove-TalosRemoveShortcut -Distro $Distro | ForEach-Object { Write-Host $_ } }
  Exit-Talos 0
}
$have = @(((& $WslExe --list --quiet) -join "`n") -replace "`0", '' -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
# WSL said nothing (it failed, or it is not there): which distros exist is not known, so Talos's shared files stay
if (-not $have.Count) { Write-Host "== WSL did not list any distro"; Complete-TalosUninstall -SharedKept }
# a name that is not there: a typo while the real install is still here keeps the shared files, because that install's own
# keep-alive task is there ($otherTalos). A distro's name says nothing about whether it is Talos's (a CI runner's
# "talos-ci" is not: found on Titan's rc4 run), so names are never used for that.
if ($have -notcontains $Distro) { Write-Host "== there is no $Distro distro"; Complete-TalosUninstall -DistroGone }
if (-not (Test-TalosDistro $Distro)) {
  Write-Host "== the $Distro distro is not one Talos made (no $TalosMarker in it): left as it is" -ForegroundColor Yellow
  Exit-Talos 1
}
$ErrorActionPreference = 'Continue'
# The check above starts the distro if it was stopped, and WSL takes its one VM-wide interop entry away when a distro with
# interop off starts. The boot unit gives it back, but a stop this soon can beat it: the owner's other distros would be left
# with "Exec format error" for every .exe. So it is given back first, by root inside this distro (only if it is missing).
& $WslExe -d $Distro -u root --exec /opt/talos-wsl/talos-wsl.sh give-back-interop 2>&1 | Out-Null
& $WslExe --terminate $Distro 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
Write-Host "== stopped the $Distro distro"
if ($RemoveDistro) {
  Write-Host "This deletes the $Distro distro and everything in it, for good: the agent folder, its memory, the bridge's keys."
  if ((Read-Host "Type $Distro to delete it") -ne $Distro) { Write-Host '== kept the distro'; Complete-TalosUninstall }
  $ErrorActionPreference = 'Continue'
  & $WslExe --unregister $Distro 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) {
    Write-Host "== WSL could not delete the $Distro distro (exit $code): it is kept, and so is the way to remove it" -ForegroundColor Yellow
    Complete-TalosUninstall
  }
  Write-Host "== deleted the $Distro distro"
  Complete-TalosUninstall -DistroGone
}
Complete-TalosUninstall
