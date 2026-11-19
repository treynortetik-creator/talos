# scripts\ci-machines\titan\ci-switch.ps1, on Windows. Pester 3.4, the one Windows ships; no administrator:
#   powershell -ExecutionPolicy Bypass -Command "Invoke-Pester scripts\ci-machines\titan\tests"
# Only stubs run: the gh and wsl.exe runners record their calls and answer from a table; nothing real is started.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here '..\ci-switch.ps1')

# a stub runner: records every call in $calls (a list, so the scriptblock sees the same one); $answer takes the argument
# string and returns an object with ExitCode, Output and Error
function New-Stub($calls, $answer) {
  $c = $calls; $a = $answer
  { param($a1) [void]$c.Add(($a1 -join ' ')); & $a ($a1 -join ' ') }.GetNewClosure()
}
function Fail($code, $out) { [pscustomobject]@{ ExitCode = $code; Output = ''; Error = "$out" } }

# the repository's variables as `gh variable list --json name,value` shows them: $vars is name -> value. The knobs: ListFail,
# FailSet (names whose set fails), StopResult, StartResult, ActiveResult
function New-World($vars) {
  $w = @{ Vars = $vars; Calls = (New-Object Collections.Generic.List[string]); ListFail = $false; FailSet = @(); FailNonOff = @(); TermComplete = $null
    StopResult = [pscustomobject]@{ ExitCode = 0; Output = ''; Error = '' }
    StartResult = [pscustomobject]@{ ExitCode = 0; Output = ''; Error = '' }
    ActiveResult = [pscustomobject]@{ ExitCode = 0; Output = 'active'; Error = '' }
    HeldResult = [pscustomobject]@{ ExitCode = 0; Output = '123'; Error = '' }; Dir = ''; Snap = $null }
  $w.Gh = New-Stub $w.Calls ({
    param($line)
    if ($line -like 'variable list *') {
      if ($w.ListFail) { return [pscustomobject]@{ ExitCode = 1; Output = ''; Error = 'HTTP 401' } }
      $rows = @($w.Vars.Keys | ForEach-Object { @{ name = $_; value = $w.Vars[$_] } })
      # stderr has text of its own: only stdout is the JSON
      return [pscustomobject]@{ ExitCode = 0; Output = (ConvertTo-Json -InputObject $rows -Compress); Error = 'warning: a new gh version is out' }
    }
    if ($line -match '^variable set (\S+) --body (.*) --repo ') {
      if (($w.FailNonOff -contains $Matches[1]) -and $Matches[2] -ne 'off') { return [pscustomobject]@{ ExitCode = 1; Output = ''; Error = 'HTTP 500' } }
      if ($w.FailSet -contains $Matches[1]) { return [pscustomobject]@{ ExitCode = 1; Output = ''; Error = 'HTTP 500' } }
      $w.Vars[$Matches[1]] = $Matches[2]; return [pscustomobject]@{ ExitCode = 0; Output = ''; Error = '' }
    }
    if ($line -match '^variable delete (\S+) ') { $w.Vars.Remove($Matches[1]); return [pscustomobject]@{ ExitCode = 0; Output = ''; Error = '' } }
    [pscustomobject]@{ ExitCode = 1; Output = ''; Error = "unexpected: $line" }
  }.GetNewClosure())
  $w.Wsl = New-Stub $w.Calls ({
    param($line)
    # which state files exist at the first wsl call of a resume (a pause has made its own calls before: only read for resumes)
    if ($null -eq $w.Snap -and $w.Dir) { $w.Snap = @{ Paused = (Test-Path (Join-Path $w.Dir 'paused.json')); Resuming = (Test-Path (Join-Path $w.Dir 'resuming.json')) } }
    if ($line -like '*pgrep*') { return $w.HeldResult }
    if ($line -like '*systemctl --user stop*') { return $w.StopResult }
    if ($line -like '*systemctl --user start*') { return $w.StartResult }
    if ($line -like '*systemctl --user is-active actions-runner.service') { return $w.ActiveResult }
    if ($line -eq '--terminate talos-ci') { try { $w.TermComplete = (Get-Content (Join-Path $w.Dir 'paused.json') -Raw | ConvertFrom-Json).complete } catch { $w.TermComplete = $null }; return [pscustomobject]@{ ExitCode = 0; Output = ''; Error = '' } }
    [pscustomobject]@{ ExitCode = 1; Output = ''; Error = "unexpected: $line" }
  }.GetNewClosure())
  $w
}
function Invoke-TPause($w, $dir) { Suspend-TitanCi -Gh $w.Gh -Wsl $w.Wsl -Dir $dir }
function Invoke-TResume($w, $dir) { Resume-TitanCi -Gh $w.Gh -Wsl $w.Wsl -Dir $dir -ActiveWaitSec 0 -HeldWaitSec 0 }
function Find-TCall($w, $like) { $w.Calls.FindIndex([Predicate[string]] { param($x) $x -like $like }) }

Describe 'the gaming switch (Titan CI)' {
  $three = @('CI_TITAN_IMAGE', 'CI_TITAN_BROWSER', 'CI_TITAN_CHECK')

  It 'pause saves the real values, sets all three off, stops the runners, then terminates the distro' {
    $dir = Join-Path $TestDrive 'a'
    $w = New-World @{ CI_TITAN_IMAGE = 'on'; CI_TITAN_BROWSER = 'e2e-shadow'; CI_UNRELATED = 'keep' }
    $r = Invoke-TPause $w $dir
    $r.Ok | Should Be $true
    $j = Get-Content (Join-Path $dir 'paused.json') -Raw | ConvertFrom-Json
    $j.values.CI_TITAN_IMAGE | Should Be 'on'
    $j.values.CI_TITAN_BROWSER | Should Be 'e2e-shadow'
    $j.values.CI_TITAN_CHECK | Should Be $null
    foreach ($n in $three) { $w.Vars[$n] | Should Be 'off' }
    $w.Vars['CI_UNRELATED'] | Should Be 'keep'
    ($w.Calls -join "`n") | Should Match 'variable set CI_TITAN_IMAGE --body off --repo treynortetik-creator/talos-app'
    ((Find-TCall $w '*systemctl --user stop actions-runner.service actions-runner-b.service') -ge 0) | Should Be $true
    ((Find-TCall $w '--terminate talos-ci') -gt (Find-TCall $w '*systemctl --user stop*')) | Should Be $true
    Get-TitanCiPauseState $dir | Should Be 'paused'
    Test-Path (Join-Path $dir 'paused.json.tmp') | Should Be $false
  }

  It 'a second pause does not overwrite the saved values, and the variables stay off' {
    $dir = Join-Path $TestDrive 'b'
    $w = New-World @{ CI_TITAN_IMAGE = 'on'; CI_TITAN_BROWSER = 'e2e'; CI_TITAN_CHECK = 'shadow' }
    [void](Invoke-TPause $w $dir)
    $again = Invoke-TPause $w $dir
    $again.AlreadyPaused | Should Be $true
    $j = Get-Content (Join-Path $dir 'paused.json') -Raw | ConvertFrom-Json
    $j.values.CI_TITAN_IMAGE | Should Be 'on'
    $j.values.CI_TITAN_BROWSER | Should Be 'e2e'
    $j.values.CI_TITAN_CHECK | Should Be 'shadow'
    foreach ($n in $three) { $w.Vars[$n] | Should Be 'off' }
  }

  It 'resume restores the values exactly, deleting the one that was unset, and removes the saved file last' {
    $dir = Join-Path $TestDrive 'c'
    $w = New-World @{ CI_TITAN_IMAGE = 'on'; CI_TITAN_CHECK = 'shadow' }
    [void](Invoke-TPause $w $dir)
    $w.Vars['CI_TITAN_BROWSER'] | Should Be 'off'
    $w.Calls.Clear()
    $r = Invoke-TResume $w $dir
    $r.Ok | Should Be $true
    $w.Vars['CI_TITAN_IMAGE'] | Should Be 'on'
    $w.Vars['CI_TITAN_CHECK'] | Should Be 'shadow'
    $w.Vars.ContainsKey('CI_TITAN_BROWSER') | Should Be $false
    ($w.Calls -join "`n") | Should Match 'variable delete CI_TITAN_BROWSER --repo treynortetik-creator/talos-app'
    Test-Path (Join-Path $dir 'paused.json') | Should Be $false
    # the runner starts and reads active before any variable is restored
    $first = @($w.Calls | Where-Object { $_ -like '*systemctl*' -or $_ -like 'variable set*' -or $_ -like 'variable delete*' })
    $first[0] | Should Match 'systemctl --user start'
    $first[1] | Should Match 'is-active actions-runner.service'
    $first[2] | Should Match '^variable (set|delete)'
  }

  It 'restores a value with a space in it as one argument' {
    $dir = Join-Path $TestDrive 'sp'
    $w = New-World @{ CI_TITAN_IMAGE = 'on shadow' }
    [void](Invoke-TPause $w $dir)
    (Invoke-TResume $w $dir).Ok | Should Be $true
    $w.Vars['CI_TITAN_IMAGE'] | Should Be 'on shadow'
    (ConvertTo-CiArgString @('variable', 'set', 'X', '--body', 'on shadow')) | Should Be 'variable set X --body "on shadow"'
  }

  It 'puts the variables off before the stop' {
    $dir = Join-Path $TestDrive 'd'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    [void](Invoke-TPause $w $dir)
    $lastSet = $w.Calls.FindLastIndex([Predicate[string]] { param($x) $x -like 'variable set*' })
    ($lastSet -ge 0) | Should Be $true
    ($lastSet -lt (Find-TCall $w '*systemctl --user stop*')) | Should Be $true
  }

  It 'a failing stop still leaves the variables off, does not terminate the distro, and says which step failed' {
    $dir = Join-Path $TestDrive 'e'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    $w.StopResult = Fail 1 'Failed to connect to bus'
    $r = Invoke-TPause $w $dir
    $r.Ok | Should Be $false
    ($r.Failed -join ',') | Should Be 'stop runners'
    foreach ($n in $three) { $w.Vars[$n] | Should Be 'off' }
    (Find-TCall $w '--terminate*') | Should Be -1
    Get-TitanCiPauseState $dir | Should Be 'incomplete'
  }

  It 'a unit that is not there yet (runner b) is no failure, but another error is' {
    $dir = Join-Path $TestDrive 'f'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    $w.StopResult = Fail 5 'Failed to stop actions-runner-b.service: Unit actions-runner-b.service not loaded.'
    (Invoke-TPause $w $dir).Ok | Should Be $true
    $w.StopResult = Fail 1 ''
    (Invoke-TPause $w $dir).Ok | Should Be $false
    $w.StopResult = Fail 1 'There is no distribution with the supplied name.'
    (Invoke-TPause $w $dir).Ok | Should Be $false
  }

  It 'a failed set does not stop the runners; the pause says so and shows as incomplete' {
    $dir = Join-Path $TestDrive 'fs'
    $w = New-World @{ CI_TITAN_IMAGE = 'on'; CI_TITAN_CHECK = 'on' }
    $w.FailSet = @('CI_TITAN_BROWSER')
    $r = Invoke-TPause $w $dir
    $r.Ok | Should Be $false
    ($r.Failed -contains 'set CI_TITAN_BROWSER off') | Should Be $true
    ($r.Failed -contains 'stop runners') | Should Be $true
    (Find-TCall $w '*systemctl --user stop*') | Should Be -1
    (Find-TCall $w '--terminate*') | Should Be -1
    Get-TitanCiPauseState $dir | Should Be 'incomplete'
    # pause again once gh works: it finishes
    $w.FailSet = @()
    (Invoke-TPause $w $dir).Ok | Should Be $true
    Get-TitanCiPauseState $dir | Should Be 'paused'
    $j = Get-Content (Join-Path $dir 'paused.json') -Raw | ConvertFrom-Json
    $j.values.CI_TITAN_IMAGE | Should Be 'on'
  }

  It 'when gh cannot read the variables the pause still sets them off, marks the values unknown, and resume says nothing is restored' {
    $dir = Join-Path $TestDrive 'g'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    $w.ListFail = $true
    $r = Invoke-TPause $w $dir
    $r.Ok | Should Be $false
    ($r.Failed -contains 'read variables') | Should Be $true
    foreach ($n in $three) { $w.Vars[$n] | Should Be 'off' }
    $j = Get-Content (Join-Path $dir 'paused.json') -Raw | ConvertFrom-Json
    $j.unknown | Should Be $true
    $w.ListFail = $false
    $w.Calls.Clear()
    $rr = Invoke-TResume $w $dir
    $rr.Ok | Should Be $true
    $rr.Message | Should Match 'unknown'
    ($w.Calls -join "`n") | Should Not Match 'variable (set|delete)'
    foreach ($n in $three) { $w.Vars[$n] | Should Be 'off' }
  }

  It 'resume with a runner that does not start leaves the variables off and the saved file in place' {
    $dir = Join-Path $TestDrive 'h'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    [void](Invoke-TPause $w $dir)
    $w.StartResult = Fail 1 'Failed to start actions-runner.service: Unit is masked.'
    $w.ActiveResult = Fail 3 'inactive'
    $r = Invoke-TResume $w $dir
    $r.Ok | Should Be $false
    $w.Vars['CI_TITAN_IMAGE'] | Should Be 'off'
    Test-Path (Join-Path $dir 'paused.json') | Should Be $true
  }

  It 'a start where every unit is "not loaded" passes the start but not the active check: nothing is restored' {
    $dir = Join-Path $TestDrive 'nl'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    [void](Invoke-TPause $w $dir)
    $w.StartResult = Fail 5 "Failed to start actions-runner.service: Unit actions-runner.service not found.`nFailed to start actions-runner-b.service: Unit actions-runner-b.service not found."
    $w.ActiveResult = Fail 4 'inactive'
    $r = Invoke-TResume $w $dir
    $r.Ok | Should Be $false
    ($r.Failed -contains 'runner active') | Should Be $true
    $w.Vars['CI_TITAN_IMAGE'] | Should Be 'off'
    Test-Path (Join-Path $dir 'paused.json') | Should Be $true
  }

  It 'an empty, {} or corrupt paused.json restores nothing and deletes nothing' {
    foreach ($content in @('', '{}', '{ not json', '{"pausedAt":"x"}', '{"pausedAt":"x","values":{"CI_TITAN_IMAGE":"on"}}')) {
      $dir = Join-Path $TestDrive ('bad' + [Math]::Abs($content.GetHashCode()))
      New-Item -ItemType Directory -Force $dir | Out-Null
      [IO.File]::WriteAllText((Join-Path $dir 'paused.json'), $content)
      $w = New-World @{ CI_TITAN_IMAGE = 'off'; CI_TITAN_BROWSER = 'off'; CI_TITAN_CHECK = 'off' }
      Get-TitanCiPauseState $dir | Should Be 'unreadable'
      $r = Invoke-TResume $w $dir
      $r.Ok | Should Be $false
      ($w.Calls -join "`n") | Should Not Match 'variable (set|delete)'
      Test-Path (Join-Path $dir 'paused.json') | Should Be $true
      # and a pause does not overwrite it
      [void](Invoke-TPause $w $dir)
      [IO.File]::ReadAllText((Join-Path $dir 'paused.json')) | Should Be $content
    }
  }

  It 'a variable changed while paused is kept, and logged; the others are restored' {
    $dir = Join-Path $TestDrive 'ch'
    $w = New-World @{ CI_TITAN_IMAGE = 'on'; CI_TITAN_BROWSER = 'e2e'; CI_TITAN_CHECK = 'shadow' }
    [void](Invoke-TPause $w $dir)
    $w.Vars['CI_TITAN_IMAGE'] = 'shadow' # someone set it while paused
    $w.Vars.Remove('CI_TITAN_CHECK') # and someone deleted this one
    $r = Invoke-TResume $w $dir
    $r.Ok | Should Be $true
    $w.Vars['CI_TITAN_IMAGE'] | Should Be 'shadow'
    $w.Vars.ContainsKey('CI_TITAN_CHECK') | Should Be $false
    $w.Vars['CI_TITAN_BROWSER'] | Should Be 'e2e'
    (Get-Content (Join-Path $dir 'ci-switch.log') -Raw) | Should Match 'kept, changed while paused: now shadow'
  }

  It 'reads the state: paused or not, saved values, current values, with stderr kept out of the JSON' {
    $dir = Join-Path $TestDrive 'i'
    $w = New-World @{ CI_TITAN_CHECK = 'on' }
    $s = Get-TitanCiState -Gh $w.Gh -Dir $dir
    $s.Paused | Should Be $false
    $s.ReadOk | Should Be $true
    $s.Current['CI_TITAN_CHECK'] | Should Be 'on'
    $s.Current['CI_TITAN_IMAGE'] | Should Be $null
    [void](Invoke-TPause $w $dir)
    $p = Get-TitanCiState -Gh $w.Gh -Dir $dir
    $p.Paused | Should Be $true
    $p.Saved.Values['CI_TITAN_CHECK'] | Should Be 'on'
  }

  It 'a log file held by another process does not make the log, a pause or a resume throw' {
    $dir = Join-Path $TestDrive 'j'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $p = Join-Path $dir 'ci-switch.log'
    [IO.File]::WriteAllText($p, "old`r`n")
    $fs = [IO.File]::Open($p, 'Open', 'ReadWrite', 'None')
    try {
      { Write-CiSwitchLog 'while held' $dir } | Should Not Throw
      $w = New-World @{ CI_TITAN_IMAGE = 'on' }
      { [void](Invoke-TPause $w $dir) } | Should Not Throw
      { [void](Invoke-TResume $w $dir) } | Should Not Throw
    } finally { $fs.Dispose() }
    Write-CiSwitchLog 'after release' $dir
    [IO.File]::ReadAllText($p) | Should Match 'after release'
  }

  It 'never calls a real gh or wsl.exe: only the stubs run, with the full argument lists' {
    $dir = Join-Path $TestDrive 'k'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    [void](Invoke-TPause $w $dir)
    [void](Invoke-TResume $w $dir)
    $w.Calls.Count | Should BeGreaterThan 8
    foreach ($c in $w.Calls) { $c | Should Match '^(variable (list|set|delete) |--terminate talos-ci$|-d talos-ci -u talosci -- systemctl --user (stop|start|is-active) |-d talos-ci -u talosci -- pgrep )' }
  }

  It 'resume renames paused.json to resuming.json before it starts anything, and deletes resuming.json last' {
    $dir = Join-Path $TestDrive 'rn'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    [void](Invoke-TPause $w $dir)
    $w.Dir = $dir; $w.Snap = $null; $w.Calls.Clear()
    (Invoke-TResume $w $dir).Ok | Should Be $true
    $w.Snap.Paused | Should Be $false
    $w.Snap.Resuming | Should Be $true
    (Find-TCall $w '*pgrep*') | Should Be 0
    ((Find-TCall $w '*systemctl --user start*') -gt 0) | Should Be $true
    Test-Path (Join-Path $dir 'resuming.json') | Should Be $false
    Test-Path (Join-Path $dir 'paused.json') | Should Be $false
  }

  It 'a failure after the rename puts paused.json back and leaves the variables off' {
    foreach ($case in 'held', 'start', 'restore') {
      $dir = Join-Path $TestDrive "pb$case"
      $w = New-World @{ CI_TITAN_IMAGE = 'on' }
      [void](Invoke-TPause $w $dir)
      switch ($case) {
        'held' { $w.HeldResult = Fail 1 '' }
        'start' { $w.ActiveResult = Fail 3 'inactive' }
        'restore' { $w.FailNonOff = @('CI_TITAN_IMAGE') }
      }
      $w.Calls.Clear()
      $r = Invoke-TResume $w $dir
      $r.Ok | Should Be $false
      Test-Path (Join-Path $dir 'paused.json') | Should Be $true
      Test-Path (Join-Path $dir 'resuming.json') | Should Be $false
      Get-TitanCiPauseState $dir | Should Be 'paused'
      if ($case -eq 'held') { (Find-TCall $w '*systemctl*') | Should Be -1 }
      if ($case -ne 'restore') { $w.Vars['CI_TITAN_IMAGE'] | Should Be 'off' }
    }
  }

  It 'a resuming.json left by a crash: the tray shows it, Resume finishes it, Pause pauses again' {
    $dir = Join-Path $TestDrive 'st'
    $w = New-World @{ CI_TITAN_IMAGE = 'on'; CI_TITAN_CHECK = 'shadow' }
    [void](Invoke-TPause $w $dir)
    Move-Item (Join-Path $dir 'paused.json') (Join-Path $dir 'resuming.json')
    Get-TitanCiPauseState $dir | Should Be 'resuming'
    (Invoke-TResume $w $dir).Ok | Should Be $true
    $w.Vars['CI_TITAN_IMAGE'] | Should Be 'on'
    $w.Vars['CI_TITAN_CHECK'] | Should Be 'shadow'
    Get-TitanCiPauseState $dir | Should Be 'running'
    # the same left-over, then Pause
    $dir2 = Join-Path $TestDrive 'st2'
    $w2 = New-World @{ CI_TITAN_IMAGE = 'on' }
    [void](Invoke-TPause $w2 $dir2)
    Move-Item (Join-Path $dir2 'paused.json') (Join-Path $dir2 'resuming.json')
    $p = Invoke-TPause $w2 $dir2
    $p.Ok | Should Be $true
    $p.AlreadyPaused | Should Be $true
    Get-TitanCiPauseState $dir2 | Should Be 'paused'
    Test-Path (Join-Path $dir2 'resuming.json') | Should Be $false
    (Get-Content (Join-Path $dir2 'paused.json') -Raw | ConvertFrom-Json).values.CI_TITAN_IMAGE | Should Be 'on'
  }

  It 'writes complete:true only after all sets and the stop, and before the terminate' {
    $dir = Join-Path $TestDrive 'cm'
    $w = New-World @{ CI_TITAN_IMAGE = 'on' }
    $w.Dir = $dir
    (Invoke-TPause $w $dir).Ok | Should Be $true
    $w.TermComplete | Should Be $true
    # before the stop is done the file says complete:false
    $dir2 = Join-Path $TestDrive 'cm2'
    $w2 = New-World @{ CI_TITAN_IMAGE = 'on' }
    $w2.StopResult = Fail 1 'no bus'
    [void](Invoke-TPause $w2 $dir2)
    (Get-Content (Join-Path $dir2 'paused.json') -Raw | ConvertFrom-Json).complete | Should Be $false
  }

  It 'a partial restore failure sets all three off before paused.json goes back, and the distro is terminated' {
    $dir = Join-Path $TestDrive 'pr'
    $w = New-World @{ CI_TITAN_IMAGE = 'on'; CI_TITAN_BROWSER = 'e2e'; CI_TITAN_CHECK = 'shadow' }
    [void](Invoke-TPause $w $dir)
    $w.FailNonOff = @('CI_TITAN_BROWSER') # IMAGE is restored, then BROWSER fails
    $w.Dir = $dir; $w.TermComplete = $null; $w.Calls.Clear()
    $r = Invoke-TResume $w $dir
    $r.Ok | Should Be $false
    foreach ($n in $three) { $w.Vars[$n] | Should Be 'off' }
    $cj = Get-Content (Join-Path $dir 'paused.json') -Raw | ConvertFrom-Json
    $cj.complete | Should Be $true
    $cj.values.CI_TITAN_IMAGE | Should Be 'on'
    Test-Path (Join-Path $dir 'resuming.json') | Should Be $false
    $w.TermComplete | Should Be $true
    (Find-TCall $w '--terminate*') | Should BeGreaterThan (Find-TCall $w 'variable set CI_TITAN_CHECK --body off*')
  }

  It 'when the sets back to off fail too, paused.json goes back incomplete and the distro is not terminated' {
    $dir = Join-Path $TestDrive 'pf'
    $w = New-World @{ CI_TITAN_IMAGE = 'on'; CI_TITAN_BROWSER = 'e2e' }
    [void](Invoke-TPause $w $dir)
    $w.FailNonOff = @('CI_TITAN_IMAGE')
    $w.Calls.Clear()
    # IMAGE fails to restore; from then on every set fails, off included
    $w.FailSet = @('CI_TITAN_IMAGE')
    $r = Invoke-TResume $w $dir
    $r.Ok | Should Be $false
    (Get-Content (Join-Path $dir 'paused.json') -Raw | ConvertFrom-Json).complete | Should Be $false
    Get-TitanCiPauseState $dir | Should Be 'incomplete'
    (Find-TCall $w '--terminate*') | Should Be -1
  }

  It 'the keep-alive lets go only on a paused.json that parses and says complete:true' {
    $tk = $null; $er = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $here '..\keepalive-ci.ps1'), [ref]$tk, [ref]$er)
    $fn = $ast.Find({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Test-GamingPause' }, $true)
    ($null -ne $fn) | Should Be $true
    . ([scriptblock]::Create($fn.Extent.Text))
    $f = Join-Path $TestDrive 'ka.json'
    Test-GamingPause $f | Should Be $false # missing
    foreach ($case in @(@('', $false), @('{ nope', $false), @('{}', $false), @('{"pausedAt":"x","complete":false}', $false), @('{"pausedAt":"x","values":{}}', $false), @('{"pausedAt":"x","complete":true,"values":{}}', $true))) {
      [IO.File]::WriteAllText($f, $case[0])
      Test-GamingPause $f | Should Be $case[1]
    }
  }

  It 'keepalive-ci.ps1 does not hold the distro while paused.json exists: it checks every loop, before it starts sleep' {
    $src = Get-Content (Join-Path $here '..\keepalive-ci.ps1') -Raw
    $whileAt = $src.IndexOf('while ($true)')
    $checkAt = $src.IndexOf("'paused.json'")
    $sleepAt = $src.IndexOf('sleep infinity', $whileAt)
    ($whileAt -ge 0 -and $checkAt -gt $whileAt -and $sleepAt -gt $checkAt) | Should Be $true
    $src | Should Match 'Start-Sleep -Seconds 30\s+continue'
    # it looks at paused.json only: with just resuming.json present it holds the distro
    $src | Should Not Match 'resuming'
  }
}
