<#
.SYNOPSIS
  The gaming switch for Titan's CI runners: functions only, to be dot-sourced (by ci-tray.ps1, and by the Pester tests).
  Suspend-TitanCi sends Titan's work back to Lemnos (the three CI_TITAN_* repository variables go off), stops the runner
  services and lets WSL free the distro; Resume-TitanCi starts the runner again and puts the variables back as they were.
  Nothing here runs by itself. Every call to gh or wsl.exe goes through a runner scriptblock that a test can replace: it takes
  the argument array and returns an object with ExitCode, Output (stdout only) and Error (stderr). The default runners start
  the real programs, with no window.
#>

function Get-TitanCiConfig {
  # the repository, the three variables ci_plan (scripts/ci-runner.sh) reads for Titan, and the runner units
  @{
    Repo   = 'treynortetik-creator/talos-app'
    Vars   = @('CI_TITAN_IMAGE', 'CI_TITAN_BROWSER', 'CI_TITAN_CHECK')
    Units  = @('actions-runner.service', 'actions-runner-b.service')
    Main   = 'actions-runner.service' # must exist and be active; runner b may not be added yet
    Distro = 'talos-ci'
    User   = 'talosci'
  }
}

function Get-TitanCiDir {
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = [IO.Path]::GetTempPath() }
  Join-Path $base 'Talos-CI'
}

function Write-CiSwitchLog {
  # never throws: another process may hold the file, and a log line is never worth a crash
  param([string]$Message, [string]$Dir)
  try {
    if (-not $Dir) { $Dir = Get-TitanCiDir }
    New-Item -ItemType Directory -Force -Path $Dir -ErrorAction Stop | Out-Null
    $log = Join-Path $Dir 'ci-switch.log'
    $line = '{0} {1}{2}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $Message, "`r`n"
    # a small log: past 200 KB, the last 200 lines
    if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 200KB)) {
      $keep = @(Get-Content -LiteralPath $log -Tail 199 -ErrorAction Stop)
      [IO.File]::WriteAllText($log, ((($keep + $line.TrimEnd()) -join "`r`n") + "`r`n"))
    } else {
      [IO.File]::AppendAllText($log, $line)
    }
  } catch {
    # nothing to do: the caller goes on
  }
}

function ConvertTo-CiArgString([string[]]$Arguments) {
  # one command line for Windows PowerShell 5.1's ProcessStartInfo (no ArgumentList there)
  ($Arguments | ForEach-Object {
      if ($_ -eq '') { '""' }
      elseif ($_ -match '[\s"]') { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
      else { $_ }
    }) -join ' '
}

function Invoke-CiNative {
  # runs one program with no window and a time limit. Output is stdout only (a caller may parse it); Error is stderr. NULs are
  # taken out, as wsl.exe writes UTF-16 for its own messages. A program that cannot start is exit 127.
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSec = 90)
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = ConvertTo-CiArgString $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['GH_PROMPT_DISABLED'] = '1'
    $p = [Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      try { $p.Kill() } catch { }
      return [pscustomobject]@{ ExitCode = 124; Output = ''; Error = "timed out after ${TimeoutSec}s" }
    }
    $p.WaitForExit()
    [pscustomobject]@{ ExitCode = $p.ExitCode; Output = (($out.Result -replace "`0", '').Trim()); Error = (($err.Result -replace "`0", '').Trim()) }
  } catch {
    [pscustomobject]@{ ExitCode = 127; Output = ''; Error = "could not start ${Exe}: $($_.Exception.Message)" }
  }
}

function Resolve-TitanGhPath {
  # gh by its full path, found once with Get-Command; $null when there is none
  if (-not $script:TitanGhPath) {
    $gh = Get-Command gh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($gh) { $script:TitanGhPath = $gh.Source }
  }
  $script:TitanGhPath
}

function Invoke-TitanGh([string[]]$Arguments) {
  $path = Resolve-TitanGhPath
  if (-not $path) { return [pscustomobject]@{ ExitCode = 127; Output = ''; Error = 'gh.exe was not found' } }
  Invoke-CiNative -Exe $path -Arguments $Arguments
}

function Invoke-TitanWsl([string[]]$Arguments) {
  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe' # by its full path: never a wsl.exe found first on PATH
  # a stop can wait for a running job to end: up to 150 s
  Invoke-CiNative -Exe $wsl -Arguments $Arguments -TimeoutSec 150
}

function Join-CiOutput($r) { (("$($r.Output)", "$($r.Error)") | Where-Object { $_ } ) -join ' | ' }

function New-CiStep([string]$Name, [bool]$Ok, [string]$Detail) {
  [pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }
}

function Get-CiRunnerGh($Gh, [string]$Dir) {
  if ($Gh) { return $Gh }
  $p = Resolve-TitanGhPath
  Write-CiSwitchLog $(if ($p) { "gh: $p" } else { 'gh: gh.exe was not found' }) $Dir
  { param($a) Invoke-TitanGh $a }
}
function Get-CiRunnerWsl($Wsl) { if ($Wsl) { $Wsl } else { { param($a) Invoke-TitanWsl $a } } }

function Save-CiSaved([string]$Dir, [string]$PausedAt, $Values, [bool]$Unknown, [bool]$Complete) {
  # through a temp file and a rename, so a reader never sees half a file. Throws when it cannot.
  New-Item -ItemType Directory -Force -Path $Dir -ErrorAction Stop | Out-Null
  $vals = [ordered]@{}
  foreach ($n in (Get-TitanCiConfig).Vars) { if (-not $Unknown) { $vals[$n] = $Values[$n] } }
  $json = [ordered]@{ pausedAt = $PausedAt; unknown = $Unknown; complete = $Complete; values = $vals } | ConvertTo-Json
  $f = Join-Path $Dir 'paused.json'
  $tmp = "$f.tmp"
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $f) { [IO.File]::Replace($tmp, $f, [NullString]::Value) } else { [IO.File]::Move($tmp, $f) }
}

function Read-CiSaved([string]$Dir, [string]$Name = 'paused.json') {
  # $null when nothing is saved. Otherwise Values (name -> value or $null), PausedAt, Unknown (the values could not be read at
  # pause: nothing to restore), Complete, and Error (set when the file is not one this wrote: nothing may be restored from it).
  $f = Join-Path $Dir $Name
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  $values = @{}
  try {
    $j = Get-Content -LiteralPath $f -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($null -eq $j -or $null -eq $j.pausedAt -or "$($j.pausedAt)" -eq '' -or $null -eq $j.values) { throw 'it has no pausedAt and values' }
    $unknown = ($j.unknown -eq $true)
    if (-not $unknown) {
      foreach ($n in (Get-TitanCiConfig).Vars) {
        if ($j.values.PSObject.Properties.Name -notcontains $n) { throw "it has no value for $n" }
        $values[$n] = $j.values.$n
      }
    }
    [pscustomobject]@{ Values = $values; PausedAt = "$($j.pausedAt)"; Unknown = $unknown; Complete = ($j.complete -ne $false); Error = '' }
  } catch {
    [pscustomobject]@{ Values = @{}; PausedAt = ''; Unknown = $false; Complete = $false; Error = "$Name cannot be used: $($_.Exception.Message)" }
  }
}

function Get-TitanCiPauseState {
  # for the tray, from the file only: running, paused, incomplete (a pause that did not finish) or unreadable
  param([string]$Dir)
  if (-not $Dir) { $Dir = Get-TitanCiDir }
  $s = Read-CiSaved $Dir
  # only resuming.json: a resume under way, or one that a crash left (Resume finishes it, Pause pauses again)
  if (-not $s -and (Test-Path -LiteralPath (Join-Path $Dir 'resuming.json'))) { return 'resuming' }
  if (-not $s) { return 'running' }
  if ($s.Error) { return 'unreadable' }
  if (-not $s.Complete) { return 'incomplete' }
  'paused'
}

function Get-TitanCiState {
  # Paused: a saved-state file exists. Saved: what it holds. Current: the three variables now (name -> value, $null when
  # unset), read with one `gh variable list`; ReadOk is false (and Error says why) when gh could not answer. Only stdout is parsed.
  param([scriptblock]$Gh, [string]$Dir)
  if (-not $Dir) { $Dir = Get-TitanCiDir }
  $Gh = Get-CiRunnerGh $Gh $Dir
  $cfg = Get-TitanCiConfig
  $saved = Read-CiSaved $Dir
  $current = @{}; $ok = $false; $err = ''
  $r = & $Gh @('variable', 'list', '--repo', $cfg.Repo, '--json', 'name,value')
  if ($r.ExitCode -ne 0) { $err = "gh variable list failed (exit $($r.ExitCode)): $(Join-CiOutput $r)" }
  else {
    try {
      $rows = @(); foreach ($o in @($r.Output | ConvertFrom-Json)) { $rows += @($o) }
      foreach ($n in $cfg.Vars) { $current[$n] = $null }
      foreach ($row in $rows) { if ($cfg.Vars -contains $row.name) { $current[$row.name] = "$($row.value)" } }
      $ok = $true
    } catch { $err = "gh variable list gave no JSON: $($_.Exception.Message)" }
  }
  [pscustomobject]@{ Paused = [bool]$saved; Saved = $saved; Current = $current; ReadOk = $ok; Error = $err }
}

function Test-CiUnitsResult($r) {
  # systemctl stop/start with several units goes on past one that is not loaded (a runner-b that is not added yet) and then
  # exits 5, printing "Unit ... not loaded." for it. That alone is no failure; any other line, or no line at all, is. (Start
  # is checked again by Test-CiRunnerActive: a missing actions-runner.service must not pass.)
  if ($r.ExitCode -eq 0) { return (New-CiStep 'units' $true '') }
  $all = Join-CiOutput $r
  $lines = @($all -split "`r?`n| \| " | Where-Object { $_.Trim() })
  $other = @($lines | Where-Object { $_ -notmatch 'not loaded|not-found|not found|could not be found|does not exist' })
  if ($lines.Count -gt 0 -and $other.Count -eq 0) { return (New-CiStep 'units' $true 'a unit that is not there was skipped') }
  New-CiStep 'units' $false "exit $($r.ExitCode): $all"
}

function Invoke-CiUnits([string]$Verb, [scriptblock]$Wsl) {
  $cfg = Get-TitanCiConfig
  $a = @('-d', $cfg.Distro, '-u', $cfg.User, '--', 'systemctl', '--user', $Verb) + $cfg.Units
  Test-CiUnitsResult (& $Wsl $a)
}

function Test-CiRunnerActive([scriptblock]$Wsl, [int]$Tries = 5, [int]$WaitSec = 3) {
  # the main runner unit must read "active" (the distro may take a few seconds to boot); runner b may be missing
  $cfg = Get-TitanCiConfig
  $a = @('-d', $cfg.Distro, '-u', $cfg.User, '--', 'systemctl', '--user', 'is-active', $cfg.Main)
  $seen = ''
  for ($i = 1; $i -le $Tries; $i++) {
    $r = & $Wsl $a
    $seen = Join-CiOutput $r
    if ($r.ExitCode -eq 0 -and "$($r.Output)" -match '(?m)^active\s*$') { return (New-CiStep 'runner active' $true "$($cfg.Main) is active") }
    if ($i -lt $Tries -and $WaitSec -gt 0) { Start-Sleep -Seconds $WaitSec }
  }
  New-CiStep 'runner active' $false "$($cfg.Main) is not active: $seen"
}

function Complete-CiResult([string]$What, $Steps, [bool]$Already, [string]$Dir, [string]$Note) {
  $failed = @($Steps | Where-Object { -not $_.Ok } | ForEach-Object { $_.Name })
  $msg = if ($failed.Count -eq 0) { "$What done" } else { "$What partly failed, steps that failed: $($failed -join ', ')" }
  if ($Note) { $msg = "$msg. $Note" }
  foreach ($s in $Steps) { Write-CiSwitchLog ('  {0}: {1} {2}' -f $s.Name, $(if ($s.Ok) { 'ok' } else { 'FAILED' }), $s.Detail) $Dir }
  Write-CiSwitchLog $msg $Dir
  [pscustomobject]@{ Ok = ($failed.Count -eq 0); AlreadyPaused = $Already; Steps = @($Steps); Failed = $failed; Message = $msg }
}

function Suspend-TitanCi {
  # gaming on. The variables go off first, even when they could not be read or saved (the file then says "unknown"). The
  # runners are stopped only when all three are off: a stopped runner with a variable on makes Lemnos wait every run. Then the
  # distro is terminated, so its memory is freed once WSL idles (WSL frees the VM only when every distro is idle).
  param([scriptblock]$Gh, [scriptblock]$Wsl, [string]$Dir)
  if (-not $Dir) { $Dir = Get-TitanCiDir }
  $Gh = Get-CiRunnerGh $Gh $Dir; $Wsl = Get-CiRunnerWsl $Wsl
  $cfg = Get-TitanCiConfig
  $steps = New-Object Collections.ArrayList
  Write-CiSwitchLog 'pause started' $Dir
  # a resume that did not finish: its saved values come back as paused.json, and this pause goes on from them
  $back = Restore-CiPaused $Dir -MarkIncomplete
  if ($back) {
    # stop here: going on would save the current values (after a crashed resume, maybe "off") beside resuming.json, and the next
    # pause would delete resuming.json, the only copy of the real ones. Nothing has been changed yet.
    [void]$steps.Add((New-CiStep 'unfinished resume' $false "$back; nothing changed, pause again"))
    return (Complete-CiResult 'pause' $steps $false $Dir '')
  }
  $state = Get-TitanCiState -Gh $Gh -Dir $Dir
  $already = $state.Paused
  $pausedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
  if ($already) {
    # a second pause must not save "off" over the real values
    [void]$steps.Add((New-CiStep 'save' $true 'already paused, saved values kept'))
  } else {
    if (-not $state.ReadOk) { [void]$steps.Add((New-CiStep 'read variables' $false "values unknown, marked so: $($state.Error)")) }
    try {
      Save-CiSaved $Dir $pausedAt $state.Current (-not $state.ReadOk) $false
      [void]$steps.Add((New-CiStep 'save' $true $(if ($state.ReadOk) { 'values saved' } else { 'saved as unknown' })))
    } catch { [void]$steps.Add((New-CiStep 'save' $false "nothing saved: $($_.Exception.Message)")) }
  }
  $setsOk = $true
  foreach ($n in $cfg.Vars) {
    $r = & $Gh @('variable', 'set', $n, '--body', 'off', '--repo', $cfg.Repo)
    if ($r.ExitCode -ne 0) { $setsOk = $false }
    [void]$steps.Add((New-CiStep "set $n off" ($r.ExitCode -eq 0) $(if ($r.ExitCode -eq 0) { 'off' } else { "exit $($r.ExitCode): $(Join-CiOutput $r)" })))
  }
  if (-not $setsOk) {
    [void]$steps.Add((New-CiStep 'stop runners' $false 'skipped: a variable is not off, and a stopped runner would make Lemnos wait every run'))
  } else {
    $s = Invoke-CiUnits 'stop' $Wsl
    [void]$steps.Add((New-CiStep 'stop runners' $s.Ok $s.Detail))
    if ($s.Ok) {
      # complete:true goes into the file only now (all sets and the stop done), and before the terminate: the keep-alive lets go
      # of the distro only on a complete file, and must not start it again in the window after the terminate
      $marked = $false
      if ($already -and $state.Saved.Error) {
        [void]$steps.Add((New-CiStep 'mark complete' $false 'the saved file cannot be used, left as it is; the keep-alive keeps holding the distro'))
      } else {
        try {
          if ($already) { Save-CiSaved $Dir $state.Saved.PausedAt $state.Saved.Values $state.Saved.Unknown $true }
          else { Save-CiSaved $Dir $pausedAt $state.Current (-not $state.ReadOk) $true }
          $marked = $true
        } catch { [void]$steps.Add((New-CiStep 'mark complete' $false "not terminating the distro: $($_.Exception.Message)")) }
      }
      if ($marked) {
        $t = & $Wsl @('--terminate', $cfg.Distro)
        [void]$steps.Add((New-CiStep 'terminate distro' ($t.ExitCode -eq 0) $(if ($t.ExitCode -eq 0) { 'WSL frees its memory once every distro is idle' } else { "exit $($t.ExitCode): $(Join-CiOutput $t)" })))
      }
    }
  }
  Complete-CiResult 'pause' $steps $already $Dir ''
}

function Restore-CiPaused([string]$Dir, [switch]$MarkIncomplete) {
  # resuming.json goes back to paused.json (a failed resume, or a pause over a resume that never finished); when both exist the
  # paused.json is the newer and stays. Returns an empty string, or what went wrong. -MarkIncomplete (a pause over a resume that
  # never finished): the file put back says complete:false, because that resume may have started the runners and set variables
  # back on. Until this pause has set them off and stopped the runners again, the tray shows "incomplete" and the keep-alive
  # keeps holding the distro; the pause writes complete:true itself once its stop is done.
  $pf = Join-Path $Dir 'paused.json'; $rf = Join-Path $Dir 'resuming.json'
  try {
    if (Test-Path -LiteralPath $rf) {
      if (Test-Path -LiteralPath $pf) { Remove-Item -LiteralPath $rf -Force -ErrorAction Stop }
      else {
        $s = $null
        if ($MarkIncomplete) { $s = Read-CiSaved $Dir 'resuming.json' }
        if ($s -and -not $s.Error) {
          # paused.json is written complete:false first (a temp file and a rename), and only then does resuming.json go: no
          # reader ever sees a complete:true copy, and a failed write leaves resuming.json, the only copy of the values, alone
          Save-CiSaved $Dir $s.PausedAt $s.Values $s.Unknown $false
          Remove-Item -LiteralPath $rf -Force -ErrorAction Stop
        } else { [IO.File]::Move($rf, $pf) } # an unreadable one goes back as it is: the tray shows it as unreadable
      }
    }
    ''
  } catch { "paused.json could not be put back: $($_.Exception.Message)" }
}

function Wait-CiDistroHeld([scriptblock]$Wsl, [int]$WaitSec, [int]$PollSec) {
  # the keep-alive holds talos-ci with `sleep infinity` once paused.json is gone (its next loop, at most 30 s). This call itself
  # starts the distro, which is fine now: the check is that the keep-alive's process is there.
  $cfg = Get-TitanCiConfig
  $a = @('-d', $cfg.Distro, '-u', $cfg.User, '--', 'pgrep', '-f', '^/bin/sleep infinity$')
  $t0 = Get-Date; $seen = ''
  while ($true) {
    $r = & $Wsl $a
    if ($r.ExitCode -eq 0) { return (New-CiStep 'distro held' $true 'the keep-alive holds talos-ci') }
    $seen = Join-CiOutput $r
    if (((Get-Date) - $t0).TotalSeconds -ge $WaitSec) { break }
    if ($PollSec -gt 0) { Start-Sleep -Seconds $PollSec }
  }
  New-CiStep 'distro held' $false "the keep-alive did not hold talos-ci within ${WaitSec}s: $seen"
}

function Resume-TitanCi {
  # gaming off, in steps. 1: paused.json is renamed to resuming.json, so the keep-alive (which checks paused.json only) holds the
  # distro again. 2: wait until it does. 3: start the runner, which must read active. 4: each variable that still reads "off" goes
  # back exactly (a saved value is set, an unset one deleted); one changed while paused is kept. 5: resuming.json is deleted.
  # A failure from step 2 on puts paused.json back: the variables stay off and the keep-alive lets go again.
  param([scriptblock]$Gh, [scriptblock]$Wsl, [string]$Dir, [int]$ActiveWaitSec = 3, [int]$HeldWaitSec = 60)
  if (-not $Dir) { $Dir = Get-TitanCiDir }
  $Gh = Get-CiRunnerGh $Gh $Dir; $Wsl = Get-CiRunnerWsl $Wsl
  $cfg = Get-TitanCiConfig
  $pf = Join-Path $Dir 'paused.json'; $rf = Join-Path $Dir 'resuming.json'
  $steps = New-Object Collections.ArrayList
  $note = ''
  Write-CiSwitchLog 'resume started' $Dir
  $had = $false
  $stop = $false
  $restoreBegan = $false
  if (Test-Path -LiteralPath $pf) {
    $had = $true
    try {
      # a resuming.json left by a crash, with a newer paused.json beside it, is the older: paused.json wins
      if (Test-Path -LiteralPath $rf) { Remove-Item -LiteralPath $rf -Force -ErrorAction Stop }
      [IO.File]::Move($pf, $rf)
      [void]$steps.Add((New-CiStep 'hold' $true 'paused.json renamed to resuming.json'))
    } catch {
      [void]$steps.Add((New-CiStep 'hold' $false "paused.json not renamed, nothing started: $($_.Exception.Message)"))
      $stop = $true
    }
  } elseif (Test-Path -LiteralPath $rf) {
    $had = $true
    [void]$steps.Add((New-CiStep 'hold' $true 'finishing a resume that did not end'))
  }
  $saved = $null
  if (-not $stop -and $had) {
    $saved = Read-CiSaved $Dir 'resuming.json'
    if ($saved.Error) {
      [void]$steps.Add((New-CiStep 'restore variables' $false "$($saved.Error); nothing changed, nothing started"))
      $stop = $true
    }
  }
  if (-not $stop -and $had) {
    $h = Wait-CiDistroHeld $Wsl $HeldWaitSec ([Math]::Max($ActiveWaitSec, 0))
    [void]$steps.Add($h)
    if (-not $h.Ok) { $stop = $true }
  }
  if (-not $stop) {
    $s = Invoke-CiUnits 'start' $Wsl
    [void]$steps.Add((New-CiStep 'start runners' $s.Ok $s.Detail))
    $a = Test-CiRunnerActive $Wsl 5 $ActiveWaitSec
    [void]$steps.Add($a)
    if (-not ($s.Ok -and $a.Ok)) {
      [void]$steps.Add((New-CiStep 'restore variables' $false 'skipped, the runner is not up; variables stay off'))
      $stop = $true
    }
  }
  if (-not $stop) {
    if (-not $had) {
      [void]$steps.Add((New-CiStep 'restore variables' $true 'nothing saved, variables left as they are'))
    } elseif ($saved.Unknown) {
      $note = 'The values were unknown at the pause, so the variables stay off: set them by hand.'
      [void]$steps.Add((New-CiStep 'restore variables' $true 'nothing to restore (values were unknown)'))
    } else {
      $now = Get-TitanCiState -Gh $Gh -Dir $Dir
      if (-not $now.ReadOk) {
        [void]$steps.Add((New-CiStep 'restore variables' $false "cannot see the variables, nothing changed: $($now.Error)"))
        $stop = $true
      } else {
        $restoreBegan = $true
        foreach ($n in $cfg.Vars) {
          $v = $saved.Values[$n]
          $cur = $now.Current[$n]
          if ($cur -ne 'off') {
            # changed while paused (by someone else): kept
            $shown = if ($null -eq $cur) { 'unset' } else { $cur }
            [void]$steps.Add((New-CiStep "restore $n" $true "kept, changed while paused: now $shown"))
            continue
          }
          if ($null -eq $v) {
            $r = & $Gh @('variable', 'delete', $n, '--repo', $cfg.Repo)
            # deleting one that is already gone is the state wanted
            $ok = ($r.ExitCode -eq 0) -or ((Join-CiOutput $r) -match 'Not Found|404|could not find')
            $detail = if ($ok) { 'unset' } else { "exit $($r.ExitCode): $(Join-CiOutput $r)" }
          } else {
            $r = & $Gh @('variable', 'set', $n, '--body', "$v", '--repo', $cfg.Repo)
            $ok = ($r.ExitCode -eq 0)
            $detail = if ($ok) { "restored $v" } else { "exit $($r.ExitCode): $(Join-CiOutput $r)" }
          }
          if (-not $ok) { $stop = $true }
          [void]$steps.Add((New-CiStep "restore $n" $ok $detail))
        }
      }
    }
  }
  if ($had) {
    if ($stop) {
      # a failure after the rename: the variables go back off, paused.json goes back, and the keep-alive lets go again. After a
      # restore that began, all three are set off first (one may be on already); if one of those sets fails, the file goes back
      # incomplete, so the keep-alive keeps holding the distro and the runners stay up.
      $offOk = $true
      if ($restoreBegan) {
        foreach ($n in $cfg.Vars) {
          $r = & $Gh @('variable', 'set', $n, '--body', 'off', '--repo', $cfg.Repo)
          if ($r.ExitCode -ne 0) { $offOk = $false }
          [void]$steps.Add((New-CiStep "reset $n off" ($r.ExitCode -eq 0) $(if ($r.ExitCode -eq 0) { 'off' } else { "exit $($r.ExitCode): $(Join-CiOutput $r)" })))
        }
      }
      $bad = Restore-CiPaused $Dir
      [void]$steps.Add((New-CiStep 'put paused.json back' ($bad -eq '') $(if ($bad) { $bad } else { 'the pause stands' })))
      if ($restoreBegan -and $bad -eq '' -and $saved -and -not $saved.Error) {
        try { Save-CiSaved $Dir $saved.PausedAt $saved.Values $saved.Unknown $offOk }
        catch { [void]$steps.Add((New-CiStep 'mark paused.json' $false $_.Exception.Message)) }
      }
      # the pause stands and the file is complete: free the memory (the keep-alive lets go of the distro now)
      $back = Read-CiSaved $Dir
      if ($bad -eq '' -and $back -and -not $back.Error -and $back.Complete) {
        $t = & $Wsl @('--terminate', $cfg.Distro)
        [void]$steps.Add((New-CiStep 'terminate distro' ($t.ExitCode -eq 0) $(if ($t.ExitCode -eq 0) { 'WSL frees its memory once every distro is idle' } else { "exit $($t.ExitCode): $(Join-CiOutput $t)" })))
      }
    } else {
      try { Remove-Item -LiteralPath $rf -Force -ErrorAction Stop; [void]$steps.Add((New-CiStep 'remove saved file' $true '')) }
      catch { [void]$steps.Add((New-CiStep 'remove saved file' $false $_.Exception.Message)) }
    }
  }
  Complete-CiResult 'resume' $steps $had $Dir $note
}
