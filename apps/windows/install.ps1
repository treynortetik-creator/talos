<#
.SYNOPSIS
  Talos on Windows: its own WSL distro, Talos set up inside it, and the keep-alive (docs/WINDOWS-PLAN.md section 8).

.DESCRIPTION
  Run it from this clone, in Windows PowerShell (no administrator):
    powershell -ExecutionPolicy Bypass -File apps\windows\install.ps1 [-RelayUrl https://your-relay] [-DryRun]

  1. Checks git, Windows (build 19041 or later, x64) and WSL. With no WSL it asks once to run
     `wsl --install --no-distribution` as administrator; restart Windows, then run this again.
  2. Creates the distro (default `talos`) from Microsoft's own Ubuntu 24.04 image, as WSL 2, and marks it as Talos's. A
     distro of that name that Talos did not make is refused, never changed.
  3. As root inside it: wsl.conf (interop and automount off, systemd on, default user talos), the talos user, packages,
     the isolation unit (no WSLg, a private /mnt/wsl), linger. The distro restarts once so wsl.conf takes effect.
  4. As talos: this clone brought in as a git bundle (no credential enters the distro), Node, pnpm, bun and Claude Code
     (pinned, checked), ./install.sh, the supervisor's systemd unit.
  5. The keep-alive: a logon task for you (no administrator) that keeps the distro running (WSL stops an idle one). By
     default it is the tray (tray.ps1): Talos's status in the notification area, green, amber or red, with Quit. -NoTray
     keeps the hidden keep-alive (keepalive.ps1) instead. Either runs a copy in %LOCALAPPDATA%\Talos\bin that only you can
     change, never a file in this clone.
  No Windows folder is shared; add one per thread with add-folder.ps1. Running it again changes nothing that is right.
  Your other WSL distros are not touched; WSLg is turned off inside this one only.
#>
[CmdletBinding()]
param(
  [string]$Distro = 'talos',
  [string]$Location = (Join-Path $env:LOCALAPPDATA 'Talos\wsl'),
  [string]$RelayUrl = '',
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$NoKeepAlive,
  [switch]$NoTray,
  # Talos Setup (setup-ui.ps1) runs it this way: never a prompt (it asked her already), and after a restart Windows runs
  # -ResumeWith (Setup's window again) instead of this script in a console
  [switch]$Silent,
  [string]$ResumeWith = '',
  # Setup's window reads ONLY this file (Fable R1-3, R1-4 on f3575ba1): its steps, a failure and its details, and the relay
  # key, each a line `<kind><TAB><text>` written here by this script alone. What the distro prints passes through stdout to
  # the log and is never shown as a step, a failure or a key: interop and automount are off, so nothing in the distro can
  # write this Windows file.
  [string]$StatusFile = ''
)
$ErrorActionPreference = 'Stop'
if ($Silent) { $Yes = $true }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'TalosWin.ps1')
$taskName = "Talos keep-alive ($Distro)"
$talosHome = Join-Path $env:LOCALAPPDATA 'Talos'
$binDir = Join-Path $talosHome 'bin'
$script:step = 'the checks'
$newDistro = $false

function Status([string]$kind, [string]$text) {
  if (-not $StatusFile) { return }
  foreach ($l in ($text -split "`r?`n")) { [IO.File]::AppendAllText($StatusFile, "$kind`t$l`r`n", (New-Object Text.UTF8Encoding $false)) }
}
function Say([string]$m) { $script:step = $m; Write-Host "== $m"; Status 'step' $m }
# lines shown under a failure, in Setup's window too (the virtualization help, R1-4)
function Detail([string]$m) { Write-Host $m; Status 'detail' $m }
# a failure names the step, never a command line: those carry the origin URL and the files handed to root (R1-5)
function Fail([string]$m) { Write-Host "install: $m" -ForegroundColor Red; Status 'failed' $m; exit 1 }
# wsl.exe writes UTF-16 to a pipe; the NULs go
function WslOut([string[]]$a) {
  # stderr joined in, never thrown: in Windows PowerShell 5.1 a redirected native stderr line is an error record, and with
  # ErrorActionPreference Stop it would end the script (`wsl --status` writes to stderr when WSL is missing)
  $ErrorActionPreference = 'Continue'
  ((& $WslExe @a 2>&1 | ForEach-Object { "$_" }) -join "`n") -replace "`0", ''
}
# a root command's stdout only, never its stderr mixed in (Fable R4-1 on f1699c11): what install reads from the distro
function WslStdout([string[]]$a) {
  $ErrorActionPreference = 'Continue'
  ((& $WslExe @a 2>$null | ForEach-Object { "$_" }) -join "`n") -replace "`0", ''
}
# $okCodes: exits that are not a failure for this call (protect-add's 3, "restart the distro", which comes next anyway)
function Wsl([string[]]$a, [int[]]$okCodes = @(0)) {
  if ($DryRun) {
    # the program and its first argument, no more (R1-5)
    $i = [Array]::IndexOf($a, '--exec')
    $shown = if ($i -ge 0) { $a[0..([Math]::Min($i + 2, $a.Count - 1))] } else { $a }
    Write-Host "would run: wsl $($shown -join ' ')"
    return
  }
  & $WslExe @a
  if ($okCodes -notcontains $LASTEXITCODE) { Fail "$script:step failed (wsl exit $LASTEXITCODE)" }
}
# a file for root, handed over as an argument with its hash, never through a folder another user can write (R1-2)
function PutRoot([string]$file, [string]$linuxPath) {
  $p = ConvertTo-TalosRootPayload ([IO.File]::ReadAllText($file))
  # one Windows command line holds 32767 characters
  if ($p.Base64.Length -gt 30000) { Fail "$file is too large to hand over in one argument" }
  Wsl @('-d', $Distro, '-u', 'root', '--exec', '/bin/sh', '-c', $RootInstallSh, 'sh', $p.Base64, $linuxPath, $p.Sha256)
}

# ---- 1. the source, Windows and WSL --------------------------------------------------------------------------------------
# Talos Setup carries a pinned release (payload.json beside this script: the git bundle of one commit, and its SHA-256), so
# her PC needs no git and no clone. Without one, this runs from a git clone, as before.
try { $payload = Get-TalosPayload $here } catch { Fail "$($_.Exception.Message). Download Talos Setup again. Nothing was changed." }
if ($payload) {
  if (-not $RelayUrl) { $RelayUrl = $payload.RelayUrl }
  # the one relay URL rule (Test-TalosRelayUrl), after the one normalisation (ConvertTo-TalosRelayUrl), before anything is
  # changed (Fable R6-3, R7-3): root's relay-set does the same, and the bridge is set up with this same URL
  if ($RelayUrl) { $RelayUrl = ConvertTo-TalosRelayUrl $RelayUrl }
  if ($RelayUrl -and -not (Test-TalosRelayUrl $RelayUrl)) {
    Fail "The relay address $RelayUrl is not one Talos can use: it has to be https:// and a name such as relay.example.com, with no login (user@), ? or # in it. Nothing was changed."
  }
  Say "Talos $($payload.Version) ($($payload.Commit)), from Setup"
  # the one commit this Setup carries, in full: Setup's claim, before anything is installed. Its last screen says
  # "Installed" only when the distro's checkout is that commit (checked-out, below; Fable R1-2 on 0770142f)
  Status 'release' "$($payload.Version) $($payload.Commit)"
} else {
  # git first (R1-14): without it there is no bundle to bring in, and nothing should be created only to stop half way
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { Fail 'git is needed (https://git-scm.com). Nothing was changed.' }
  $ErrorActionPreference = 'Continue'
  $repo = (& git -C (Join-Path $here '..\..') rev-parse --show-toplevel 2>$null)
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0 -or -not $repo) { Fail 'run this from a git clone of talos-app, or from Talos Setup. Nothing was changed.' }
  $repo = Get-TalosFinalPath ($repo.Trim() -replace '/', '\')
  if ($RelayUrl) { $RelayUrl = ConvertTo-TalosRelayUrl $RelayUrl }
  if ($RelayUrl -and -not (Test-TalosRelayUrl $RelayUrl)) {
    Fail "-RelayUrl $RelayUrl is not one Talos can use: https:// and a name such as relay.example.com, with no login (user@), ? or # in it. Nothing was changed."
  }
}

$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) { Fail "Windows 10 version 2004 (build 19041) or later is needed; this is build $build." }
# x64 only (R1-13): the toolchain setup-user.sh pins is linux-x64
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { Fail "this is a $arch PC; Talos on Windows needs x64 for now. Nothing was changed." }
# WSL's mirrored networking shares this PC's localhost with every distro (R1-3): the distro would reach whatever listens on
# 127.0.0.1 here, and the other way round. Talos needs the default (NAT).
$wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
if ((Test-Path -LiteralPath $wslconfig) -and ((Get-Content -LiteralPath $wslconfig -Raw) -match '(?im)^\s*networkingMode\s*=\s*"?mirrored')) {
  Fail "$wslconfig sets networkingMode=mirrored, which shares this PC's localhost with every distro. Remove that line (or set it to nat), run: wsl --shutdown, then run this again. Nothing was changed."
}

# ---- WSL, and a PC with none (item 2 of the no-terminal plan) -------------------------------------------------------------
# What runs again after a restart: this same script, with the same choices, from where it is now (Setup's own folder).
$resumeArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"", '-Distro', $Distro, '-Location', "`"$Location`"", '-Yes')
if ($RelayUrl) { $resumeArgs += @('-RelayUrl', $RelayUrl) }
if ($NoTray) { $resumeArgs += '-NoTray' }
if ($NoKeepAlive) { $resumeArgs += '-NoKeepAlive' }
$resume = "`"$(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')`" $($resumeArgs -join ' ')"
if ($ResumeWith) { $resume = $ResumeWith }

$ready = Get-TalosWslReadiness
if ($ready -eq 'virtualization-off') {
  Detail $TalosVirtualizationHelp
  Fail 'Virtualization is turned off on this PC, so Talos cannot run yet. Nothing was changed.'
}
if ($ready -eq 'restart-pending') {
  Say 'Windows is waiting for a restart (an update, most likely). Restart the PC; Talos Setup carries on by itself after you sign in again.'
  if (-not $DryRun) { Set-TalosResume $resume }
  exit 3010
}
if ($ready -eq 'missing') {
  Say 'WSL is not on this PC. Installing it needs one "Yes" for administrator rights, then one restart.'
  # the installer Setup carries (no download); a clone without it falls back to Windows' own `wsl --install`
  $msi = Join-Path $here "wsl\$($TalosWslMsi.Name)"
  if ($DryRun) {
    Write-Host "would run as administrator: the WSL step (WSL $($TalosWslMsi.Version), Virtual Machine Platform), then ask for a restart"
    exit 0
  }
  if (-not $Yes -and (Read-Host 'Install WSL now? (y/N)') -notmatch '^[yY]') { Fail 'WSL is needed. Nothing was changed.' }
  New-Item -ItemType Directory -Force -Path $talosHome | Out-Null
  $wslLogs = Join-Path $env:ProgramData 'Talos-setup-*\setup-wsl.log'
  try {
    if (Test-Path -LiteralPath $msi) {
      # the one administrator step: its whole script in the command itself (Get-TalosEnableWslArguments), which copies the
      # msi into an admin-only folder, checks THAT copy against the pin and installs it (Fable R1-1 on f3575ba1)
      $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -Wait -PassThru `
        -ArgumentList (Get-TalosEnableWslArguments $msi)
      $code = $p.ExitCode
    } else {
      $p = Start-Process -FilePath $WslExe -ArgumentList '--install', '--no-distribution' -Verb RunAs -Wait -PassThru
      $code = if ($p.ExitCode -eq 0) { 3010 } else { $p.ExitCode }
    }
  } catch {
    # she said No to the administrator prompt
    Fail 'WSL was not installed: Windows did not get the administrator "Yes". Open Talos Setup again when you are ready. Nothing was changed.'
  }
  if ($code -ne 0 -and $code -ne 3010) { Fail "WSL could not be installed (code $code). The details are in $wslLogs." }
  Set-TalosResume $resume
  Say 'WSL is installed. Restart the PC now; Talos Setup carries on by itself after you sign in again.'
  exit 3010
}
$status = WslOut @('--status')
$version = WslOut @('--version')
if ($version -match 'WSL[^:]*:\s*(\d+)\.(\d+)') {
  if ([int]$Matches[1] -lt 2 -or ([int]$Matches[1] -eq 2 -and [int]$Matches[2] -lt 4)) {
    Fail "WSL $($Matches[1]).$($Matches[2]) is too old (2.4 or later names a distro). Run: wsl --update"
  }
}

# ---- 2. the distro --------------------------------------------------------------------------------------------------------
$have = (WslOut @('--list', '--quiet')) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($have -contains $Distro) {
  # one Talos made, or nothing is done to it (R1-7): an owner's own distro of that name is never rewritten
  if (-not $DryRun -and -not (Test-TalosDistro $Distro)) {
    Fail "a WSL distro named $Distro is there, and Talos did not make it. Nothing was changed. Use another name: -Distro talos2"
  }
  Say "the $Distro distro is there"
  # an update, said so in Setup's window ("Updating Talos", then "updated" or "up to date"), with the commit it ran before
  # (read as talos, only a full sha goes on; none when there is no checkout yet)
  if (-not $DryRun) {
    $was = "$(WslStdout @('-d', $Distro, '-u', 'talos', '--cd', '~', '--exec', '/usr/bin/git', '-C', 'talos-app', 'rev-parse', '--verify', 'HEAD'))".Trim()
    Status 'update' $(if ($was -cmatch $script:TalosCommitRule) { $was } else { '' })
  }
} else {
  # this run makes the distro: the only run in which root approves a launch (Fable R3-2 on a44344c2, below)
  $newDistro = $true
  Say "creating the $Distro distro (Ubuntu 24.04, WSL 2) in $Location"
  if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $Location | Out-Null }
  if ($DryRun) {
    Wsl @('--install', 'Ubuntu-24.04', '--name', $Distro, '--location', $Location, '--version', '2', '--no-launch')
  } else {
    $made = WslOut @('--install', 'Ubuntu-24.04', '--name', $Distro, '--location', $Location, '--version', '2', '--no-launch')
    if ($LASTEXITCODE -ne 0) {
      # the one failure a basic user can fix herself, in her words: virtualization off in the PC's firmware
      if (Test-TalosVirtualizationError $made) { Detail $TalosVirtualizationHelp; Fail 'Virtualization is turned off on this PC, so the Talos distro was not created.' }
      Fail "creating the $Distro distro failed (wsl exit $LASTEXITCODE)"
    }
  }
  # marked before anything else, so a run stopped half way can be run again
  Wsl @('-d', $Distro, '-u', 'root', '--exec', '/bin/sh', '-c', "mkdir -p /etc/talos-wsl && echo talos > $TalosMarker")
}

# ---- 3. as root ----------------------------------------------------------------------------------------------------------
Say 'the distro''s own settings (as root)'
PutRoot (Join-Path $here 'distro\talos-wsl.sh') '/opt/talos-wsl/talos-wsl.sh'
PutRoot (Join-Path $here 'distro\setup-user.sh') '/opt/talos-wsl/setup-user.sh'
# the tray's "Sign in to Claude" (the token is written inside the distro, never on Windows)
PutRoot (Join-Path $here 'distro\signin.py') '/opt/talos-wsl/signin.py'
# the tray's "Pair a phone" (talos-app enroll --json in a pty, inside the distro)
PutRoot (Join-Path $here 'distro\pair.py') '/opt/talos-wsl/pair.py'
# the owner's approval of how Talos starts Claude (launch-check / launch-approve; Hestia's contract), and the verbs below
# that it implements (relay-set): every file a root verb runs is in place before that verb (Fable R6-1 on fb7a8206)
PutRoot (Join-Path $here 'distro\launch.py') '/opt/talos-wsl/launch.py'
# root's sealed copy of the kit talos builds, its record and Claude Code's policy (talos-wsl.sh kit-update; the tray's "Update
# the kit"): run below, after setup-user.sh builds the kit and before the supervisor's first start
PutRoot (Join-Path $here 'distro\kit.py') '/opt/talos-wsl/kit.py'
# the relay URL pairing checks enroll's link against: root's own copy (Fable R5-1 on 5fc143ef), from Setup's payload or
# -RelayUrl, never from talos's bridge config. It already passed the same rule here (Test-TalosRelayUrl, at the start), so
# a refusal now is a real failure, and it stops the install (Fable R6-3).
if ($RelayUrl) {
  Wsl @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'relay-set', $RelayUrl)
} elseif (-not $DryRun) {
  # no address in this Setup: one set by an earlier one still counts (root's /etc/talos/relay, what pairing reads); with
  # none at all, Setup's window says pairing waits for a relay instead of showing a key nobody can use yet
  $ErrorActionPreference = 'Continue'
  & $WslExe -d $Distro -u root --exec /usr/bin/test -s /etc/talos/relay 2>$null | Out-Null
  $hasRelay = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = 'Stop'
  if (-not $hasRelay) { Status 'relay' 'none' }
}
Wsl @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'wsl-conf')
Wsl @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'root-setup')
# Talos's own files on this side are never shared into the distro (R1-1): this clone (the scripts the logon task and these
# installers come from) and %LOCALAPPDATA%\Talos (the copies the task runs, the distro's disk). An older share of one that is
# in use stays mounted until a restart (protect-add exits 3); the restart is the next step, and `isolation` after it refuses
# if one is still there (R3-1).
# From Setup there is no clone: Setup's own folder (where these scripts are) is the one kept out instead.
$source = if ($payload) { Get-TalosFinalPath $here } else { $repo }
Wsl @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'protect-add', $source) @(0, 3)
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $talosHome | Out-Null }
$talosHomeReal = if ($DryRun -and -not (Test-Path $talosHome)) { $talosHome } else { Get-TalosFinalPath $talosHome }
Wsl @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'protect-add', $talosHomeReal) @(0, 3)
Say 'restarting the distro so wsl.conf takes effect (systemd, no interop, no automount, no WSLg)'
Wsl @('--terminate', $Distro)
Wsl @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'root-setup')
# interop, the drives, WSLg and /mnt/wsl, checked inside (no quoted arguments: Windows PowerShell 5.1 drops their quotes)
Say 'checking the distro is cut off from Windows'
Wsl @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'isolation')

# ---- 4. as talos ---------------------------------------------------------------------------------------------------------
if ($payload) {
  Say 'Talos into the distro, from the release Setup carries'
  $origin = $payload.Origin
  if (-not $DryRun) {
    # checked again here, after any restart: a damaged or half-copied bundle never goes in (a corruption check; payload.json
    # sits beside it, so it is not a trust check: the trust is in the Setup.exe she downloaded)
    if (-not (Test-TalosPayloadBundle $payload)) { Fail "Setup's copy of Talos is damaged (its SHA-256 does not match). Download Talos Setup again." }
    New-Item -ItemType Directory -Force -Path "\\wsl.localhost\$Distro\var\tmp\talos-install" | Out-Null
    Copy-Item -LiteralPath $payload.Bundle "\\wsl.localhost\$Distro\var\tmp\talos-install\talos-src.bundle" -Force
  }
} else {
  Say 'this clone into the distro, as a git bundle'
  $ErrorActionPreference = 'Continue'
  $branch = "$(& git -C $repo rev-parse --abbrev-ref HEAD 2>$null)".Trim()
  $origin = Remove-TalosUrlLogin "$(& git -C $repo remote get-url origin 2>$null)".Trim()
  $ErrorActionPreference = 'Stop'
  $bundle = Join-Path $env:TEMP "talos-src-$PID.bundle"
  if (-not $DryRun) {
    $ErrorActionPreference = 'Continue'
    & git -C $repo bundle create $bundle HEAD $branch 2>&1 | Out-Null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { Fail 'git bundle failed' }
    # the bundle is the talos user's own input (it is cloned as talos), so a folder talos can write is fine for it
    New-Item -ItemType Directory -Force -Path "\\wsl.localhost\$Distro\var\tmp\talos-install" | Out-Null
    Copy-Item $bundle "\\wsl.localhost\$Distro\var\tmp\talos-install\talos-src.bundle" -Force
    Remove-Item $bundle -Force
  }
}
# The one approval install ever makes (Fable R3-2 on a44344c2): in the run that creates the distro, before setup-user.sh
# writes supervisor.json and starts the supervisor, root approves the launch it works out itself from root-only inputs
# (launch.py install_defaults: the talos home, and the Claude Code version pinned in root's copy of setup-user.sh). It is
# never the file talos wrote. setup-user.sh then writes exactly that launch. A later run, a distro made before approvals,
# or a run stopped half way approves nothing: the tray's "Approve this change" is the only way then.
if ($newDistro -and -not $DryRun) {
  Say 'approving how Talos starts Claude (a new distro only)'
  $ok = WslStdout @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'launch-approve-install')
  Write-Host "   $(($ok -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) -replace '^launch: ', '')"
}
Say 'Talos inside the distro (as talos)'
$userArgs = @('-d', $Distro, '-u', 'talos', '--cd', '~', '--exec', '/opt/talos-wsl/setup-user.sh', '--bundle', '/var/tmp/talos-install/talos-src.bundle', '--no-start')
if ($origin) { $userArgs += @('--origin', $origin) }
if ($RelayUrl) { $userArgs += @('--relay-url', $RelayUrl) }
Wsl $userArgs
# Root's copy of the kit setup-user.sh just built, before the supervisor first starts: on a Talos distro a thread session's
# permission hook comes only from root's sealed copy, checked against root's record, and Claude Code loads no other
# marketplace (WINDOWS-PLAN step 3). Its stdout is one fixed word; a refusal stops the install with the tray's own words.
if (-not $DryRun) {
  Say "root's copy of the kit (as root)"
  $kw = WslStdout @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'kit-update')
  $kword = @($kw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) | Select-Object -Last 1
  if (@('kit-updated', 'kit-current', 'kit-policy-updated') -notcontains $kword) { Fail (Get-TalosRecoveryText 'kit-update' $kw) }
  Write-Host '   the kit is in place'
}
Say 'starting Talos (as talos)'
Wsl @('-d', $Distro, '-u', 'talos', '--cd', '~', '--exec', '/opt/talos-wsl/setup-user.sh', '--only-start')
# the commit the checkout really is now (Fable R1-2 on 0770142f): a re-install over a newer ~/talos-app leaves it ahead of
# the bundle (fetch, then merge --ff-only, changes nothing). Read as talos, and only a full sha goes on.
if ($payload -and -not $DryRun) {
  $head = (WslStdout @('-d', $Distro, '-u', 'talos', '--cd', '~', '--exec', '/usr/bin/git', '-C', 'talos-app', 'rev-parse', '--verify', 'HEAD')).Trim()
  if ($head -cmatch $script:TalosCommitRule) { Status 'checked-out' $head }
}
# This PC's relay key (Fable R1-3 on f3575ba1): from root (`relay-key`), which reads the bridge's key file as talos and keeps
# the key the FIRST install saw in a root-only file. Never from the install's general output, which talos's tools print.
if (-not $DryRun) {
  $rk = WslStdout @('-d', $Distro, '-u', 'root', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'relay-key')
  $rkLines = @($rk -split "`n" | ForEach-Object { $_.Trim() })
  $key = $rkLines | Where-Object { $_ -match '^BRIDGE_PUBKEY=[A-Za-z0-9_-]{43}$' } | Select-Object -First 1
  if (-not $key) {
    # never a silent "set up" with no key (Fable R2-4 on ebad65d5): she is told, and the owner knows what to look at
    Status 'detail' "This PC's relay key could not be read, so it is not shown here. Talos runs, but your iPhone cannot pair until the key reaches whoever runs your relay; the setup log has the details."
  }
  if ($key) {
    Status 'relay-key' $key
    if ($rkLines -contains 'changed') {
      Status 'detail' "This PC's bridge key is no longer the one Talos was installed with. The key shown is the install's; the bridge will not reach the relay until that is looked into."
    }
  }
}


# ---- 5. the keep-alive -------------------------------------------------------------------------------------------------
# The scripts the owner runs later, and the one the logon task runs, are copies in %LOCALAPPDATA%\Talos\bin with only the
# owner (and SYSTEM) on the folder's ACL (R1-1): a logon task pointing into a clone would run whatever that clone holds.
Say "Talos's Windows scripts into $binDir"
if ($DryRun) {
  Write-Host "would copy tray.ps1, keepalive.ps1, add-folder.ps1, uninstall.ps1 and TalosWin.ps1 to $binDir, readable and writable by you only, and add the Start menu entry 'Remove Talos and its data'"
} else {
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $ErrorActionPreference = 'Continue'
  & icacls.exe $binDir /inheritance:r /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' /q 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { Fail "could not limit $binDir to you (icacls exit $LASTEXITCODE)" }
  foreach ($f in 'tray.ps1', 'keepalive.ps1', 'add-folder.ps1', 'uninstall.ps1', 'TalosWin.ps1') {
    Copy-Item -LiteralPath (Join-Path $here $f) -Destination (Join-Path $binDir $f) -Force
  }
  # Everything in it, files from an earlier install included, keeps only what it inherits from the folder (R2-7): an
  # explicit entry a copied or older file brought along would let someone else change it.
  $ErrorActionPreference = 'Continue'
  & icacls.exe "$binDir\*" /reset /T /q 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { Fail "could not reset the files in $binDir to the folder's ACL (icacls exit $LASTEXITCODE)" }
  $stray = Get-ChildItem -LiteralPath $binDir -Recurse -Force | Where-Object { @((Get-Acl -LiteralPath $_.FullName).Access | Where-Object { -not $_.IsInherited }).Count -gt 0 }
  if ($stray) { Fail "$($stray[0].FullName) still has its own ACL entries" }
  # the folder itself (R3-10): nothing inherited from above, and no one but you and SYSTEM on it
  $acl = Get-Acl -LiteralPath $binDir
  $who = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  $extra = @($who | Where-Object { $_ -ne $me -and $_ -ne 'S-1-5-18' })
  if (-not $acl.AreAccessRulesProtected -or $extra.Count -gt 0 -or @($acl.Access | Where-Object { $_.IsInherited }).Count -gt 0) {
    Fail "$binDir is open to more than you and SYSTEM ($($extra -join ', ')); nothing was registered"
  }
  # the clickable way to remove Talos later (she has no terminal): this user's Start menu, running bin\uninstall.ps1
  # a failure here never stops the install: uninstall makes the entry again whenever it keeps the distro
  try {
    $lnk = New-TalosRemoveShortcut -BinDir $binDir -Distro $Distro
    Write-Host "   Start menu: $([IO.Path]::GetFileNameWithoutExtension($lnk))"
  } catch {
    Write-Host "   could not add the Start menu entry to remove Talos later: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
if ($NoKeepAlive) {
  Say 'no keep-alive (-NoKeepAlive): the distro stops when no window holds it, and Talos with it'
} else {
  # the tray is the keep-alive with a face (step 2); -NoTray keeps the hidden one. Same task name either way, so a second
  # install switches between them and uninstall.ps1 removes whichever it is.
  $kind = if ($NoTray) { 'keepalive.ps1' } else { 'tray.ps1' }
  Say "the keep-alive ($(if ($NoTray) { 'hidden' } else { 'the tray' })): logon task '$taskName'"
  $ka = Join-Path $binDir $kind
  if ($DryRun) {
    Write-Host "would register a logon task running: powershell -WindowStyle Hidden -File `"$ka`" -Distro $Distro"
  } else {
    # the one running now, tray or hidden, gives way to the new one
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ka`" -Distro $Distro"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
  }
}
# a resume left from before a restart has done its work
if (-not $DryRun) { Clear-TalosResume }
Say "done. Talos runs in the $Distro distro."
Status 'done' 'done'
# through `run` (R4-1): it starts only while the distro is cut off from Windows (a Windows-side command gets no login check)
Write-Host "   Sign in to Claude Code once:  wsl -d $Distro --exec /opt/talos-wsl/talos-wsl.sh run -- claude"
Write-Host "   (interop is off, so it prints a sign-in link instead of opening a browser: open it, then paste the code back)"
Write-Host "   Share a Windows folder with a thread:  & '$binDir\add-folder.ps1' 'C:\path\to\folder' [-ReadOnly]"
Write-Host "   (a folder shared read-write can be changed by the thread, its .git\hooks included: see add-folder.ps1)"
