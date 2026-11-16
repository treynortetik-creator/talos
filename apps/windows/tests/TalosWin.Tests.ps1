# apps\windows\TalosWin.ps1, on Windows (R1-10). Pester 3.4, the one Windows ships; no administrator:
#   powershell -ExecutionPolicy Bypass -Command "Invoke-Pester apps\windows\tests"
# The root handover is also run for real, in a WSL distro as root, writing only under /tmp/talos-pester-<pid> there:
# TALOS_PESTER_DISTRO names it (default Ubuntu); with no such distro those tests are skipped and say so.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here '..\TalosWin.ps1')

Describe "what Setup's window shows, from install.ps1's own status lines only (Fable R1-3, R1-4 on f3575ba1)" {
  $T = "`t"
  It 'shows the virtualization help itself when that is why it stopped, not a generic failure' {
    $lines = @("step${T}checking WSL") + @($TalosVirtualizationHelp -split "`r?`n" | ForEach-Object { "detail${T}$_" }) +
      @("failed${T}Virtualization is turned off on this PC, so Talos cannot run yet. Nothing was changed.")
    $v = Get-TalosSetupView $lines 1 'C:\log.txt'
    $v.Mode | Should Be 'failed'
    $v.Body | Should Match 'Virtualization is turned off on this PC'
    $v.Body | Should Match 'Intel VT-x'
    $v.Body | Should Match 'F2, F10, F12'
    $v.Body | Should Match ([regex]::Escape('C:\log.txt'))
  }
  It 'takes the relay key from a relay-key line only, never from a step, a detail or anything else' {
    $k = 'BRIDGE_PUBKEY=' + ('A' * 43)
    $planted = 'BRIDGE_PUBKEY=' + ('Z' * 43)
    $lines = @("step${T}$planted", "detail${T}$planted", $planted, "   bridge: $planted", "relay-key${T}$k", "done${T}done")
    $v = Get-TalosSetupView $lines 0
    $v.Key | Should Be $k
    $v.Step | Should Be $k
    (Get-TalosSetupView @("step${T}$planted", "done${T}done") 0).Key | Should Be ''
    (Get-TalosSetupView @("relay-key${T}BRIDGE_PUBKEY=short") 0).Key | Should Be ''
  }
  It 'says plainly when the bridge key no longer matches the one the install kept' {
    $k = 'BRIDGE_PUBKEY=' + ('A' * 43)
    $v = Get-TalosSetupView @("relay-key${T}$k", "detail${T}This PC's bridge key is no longer the one Talos was installed with.") 0
    $v.Body | Should Match 'no longer the one Talos was installed with'
  }
  It 'shows only the steps install.ps1 wrote while it runs; lines from anything else are ignored' {
    $v = Get-TalosSetupView @("step${T}one", '== a step the distro printed', "install: a failure the distro printed", "step${T}starting Talos (as talos)") $null
    $v.Mode | Should Be 'running'
    $v.Step | Should Be 'Starting Talos'
    $f = Get-TalosSetupView @('install: a failure the distro printed') 1
    $f.Body | Should Not Match 'the distro printed'
    $f.Body | Should Match 'Setup stopped \(code 1\)'
  }
  It 'says "Installed" only for the commit really checked out, on success (Pantheon 2026-11-12, Fable R1-2 on 0770142f)' {
    $sha = 'a2eb36a75a72987af9ef5fc3bcc66ec2b7c9fb5d'
    $other = 'b' * 40
    (Get-TalosSetupView @("release${T}0.0.1-test $sha", "checked-out${T}$sha", "done${T}done") 0).Body |
      Should Match "\r\n\r\nInstalled: Talos 0\.0\.1-test, commit $sha\z"
    # a re-install over a newer checkout: never "Installed" for the payload's sha
    $v = (Get-TalosSetupView @("release${T}0.0.1-test $sha", "checked-out${T}$other", "done${T}done") 0).Body
    $v | Should Not Match 'Installed:'
    $v | Should Match "Setup was for Talos 0\.0\.1-test, commit $sha, but this PC runs commit $other"
    (Get-TalosSetupView @("release${T}0.0.1-test $sha", "done${T}done") 0).Body | Should Match 'could not be read\.\z'
    # a failure is never "Installed", even one after the checkout
    $f = (Get-TalosSetupView @("release${T}0.0.1-test $sha", "checked-out${T}$sha", "failed${T}it broke") 1).Body
    $f | Should Not Match 'Installed:'
    $f | Should Match "\r\n\r\nSetup was for Talos 0\.0\.1-test, commit $sha\.\z"
  }
  It 'reads the release and checked-out lines only in exactly their shape' {
    $sha = 'a2eb36a75a72987af9ef5fc3bcc66ec2b7c9fb5d'
    foreach ($bad in "0.0.1 $($sha.Substring(0, 12))", "0.0.1 $sha extra", "a b $sha", "0.0.1 $($sha.ToUpper())", "0.0.1 <b>$sha",
      ('v' * 41) + " $sha", "-x $sha") {
      (Get-TalosSetupView @("release${T}$bad", "checked-out${T}$sha", "done${T}done") 0).Body | Should Not Match 'Installed:|Setup was for'
    }
    (Get-TalosSetupView @("step${T}release 0.0.1 $sha", "done${T}done") 0).Body | Should Not Match 'Installed:'
    (Get-TalosSetupView @("release${T}0.0.1 $sha", "checked-out${T}$($sha.ToUpper())", "done${T}done") 0).Body | Should Not Match 'Installed:'
  }
  It 'holds a payload to the same version and commit rules as the screen' {
    $dir = Join-Path $TestDrive 'pl'; New-Item -ItemType Directory -Force $dir | Out-Null
    $ok = @{ version = 'v' * 40; commit = 'a' * 40; bundle = 'talos-src.bundle'; bundleSha256 = 'c' * 64 }
    [IO.File]::WriteAllText((Join-Path $dir 'payload.json'), ($ok | ConvertTo-Json))
    (Get-TalosPayload $dir).Version | Should Be ('v' * 40)
    foreach ($bad in @(@{ version = 'v' * 41 }, @{ commit = 'A' * 40 }, @{ version = '-1' })) {
      $j = $ok.Clone(); foreach ($k in $bad.Keys) { $j[$k] = $bad[$k] }
      [IO.File]::WriteAllText((Join-Path $dir 'payload.json'), ($j | ConvertTo-Json))
      { Get-TalosPayload $dir } | Should Throw 'not one Talos Setup wrote'
    }
  }
  It 'asks for the restart on 3010' {
    (Get-TalosSetupView @() 3010).Mode | Should Be 'restart'
  }
}

Describe "Setup's window in plain words: an update said as one, no relay said plainly (rc13's agent-run)" {
  $T = "`t"
  $sha = 'a2eb36a75a72987af9ef5fc3bcc66ec2b7c9fb5d'
  $old = 'b' * 40
  $k = 'BRIDGE_PUBKEY=' + ('A' * 43)
  It "shows each of install.ps1's steps in words, never the log's" {
    # every step install.ps1 says, as it says them (install.ps1 Say)
    $steps = @{
      "Talos 0.1.0-rc13 ($sha), from Setup" = 'Getting ready'
      'the talos distro is there' = 'Checking what this PC already has'
      'creating the talos distro (Ubuntu 24.04, WSL 2) in C:\x' = 'Making a space for Talos on this PC (a few minutes)'
      "the distro's own settings (as root)" = 'Preparing that space'
      'restarting the distro so wsl.conf takes effect (systemd, no interop, no automount, no WSLg)' = 'Restarting it'
      'checking the distro is cut off from Windows' = 'Checking Talos is kept apart from your files'
      'Talos into the distro, from the release Setup carries' = 'Copying Talos in'
      'approving how Talos starts Claude (a new distro only)' = 'Getting Claude ready'
      'Talos inside the distro (as talos)' = 'Installing Talos (the longest step)'
      "root's copy of the kit (as root)" = 'Finishing the install'
      'starting Talos (as talos)' = 'Starting Talos'
      "Talos's Windows scripts into C:\Users\x\AppData\Local\Talos\bin" = 'Adding the Talos icon by the clock'
      "the keep-alive (the tray): logon task 'Talos keep-alive (talos)'" = 'Making Talos start when you sign in to Windows'
      'done. Talos runs in the talos distro.' = 'Done'
    }
    foreach ($s in $steps.Keys) { Get-TalosSetupStepWords $s | Should Be $steps[$s] }
    # the ones already written for her are shown as they are
    Get-TalosSetupStepWords 'WSL is not on this PC. Installing it needs one "Yes" for administrator rights, then one restart.' |
      Should Match '^WSL is not on this PC'
    # anything unknown: a plain word, never the log's text
    Get-TalosSetupStepWords 'mounting /mnt/wsl tmpfs (as root)' | Should Be 'Working'
    $src = Get-Content (Join-Path $here '..\install.ps1') -Raw
    # a '' inside a single-quoted string is one ' (the distro''s own settings)
    foreach ($m in [regex]::Matches($src, "(?m)^\s*Say '((?:[^']|'')+)'")) {
      Get-TalosSetupStepWords ($m.Groups[1].Value -replace "''", "'") | Should Not Be 'Working'
    }
    # the double-quoted ones carry values, so they are in the table above with sample values; a new one has to be added
    # there too (this count fails until it is: Fable on 5e649388)
    ([regex]::Matches($src, '(?m)^\s*Say "')).Count | Should Be 7
    Get-TalosSetupStepWords 'no keep-alive (-NoKeepAlive): the distro stops when no window holds it, and Talos with it' | Should Be 'Finishing'
  }
  It 'says "Updating Talos" while it runs over an install that was there, with the settings kept' {
    $v = Get-TalosSetupView @("update${T}$old", "step${T}the talos distro is there") $null
    $v.Title | Should Be 'Updating Talos'
    $v.Body | Should Match 'settings, your conversations and your paired iPhone are kept'
    $v.Body | Should Not Match '15 minutes|allow changes'
    (Get-TalosSetupView @("step${T}creating the talos distro (Ubuntu 24.04, WSL 2) in C:\x") $null).Title | Should Be 'Setting up Talos'
  }
  It 'ends an update with "updated" and what was kept, or "up to date" when nothing changed' {
    $v = Get-TalosSetupView @("release${T}0.1.0-rc13 $sha", "update${T}$old", "checked-out${T}$sha", "relay-key${T}$k", "done${T}done") 0
    $v.Title | Should Be 'Talos is updated'
    $v.Body | Should Match '^Talos is updated to 0\.1\.0-rc13 and running again\. Your settings, your conversations and your paired iPhone were kept\.'
    $v.Body | Should Not Match 'nothing to send'
    $v.Body | Should Match "Installed: Talos 0\.1\.0-rc13, commit $sha\z"
    $v.Key | Should Be $k
    $u = Get-TalosSetupView @("release${T}0.1.0-rc13 $sha", "update${T}$sha", "checked-out${T}$sha", "done${T}done") 0
    $u.Title | Should Be 'Talos is up to date'
    $u.Body | Should Match 'nothing needed to change'
    # an "update" with no commit before is an install stopped half way, run again: a first install, nothing "kept"
    $r = Get-TalosSetupView @("release${T}0.1.0-rc13 $sha", "update${T}", "checked-out${T}$sha", "done${T}done") 0
    $r.Title | Should Be 'Talos is set up'
    $r.Body | Should Not Match 'kept'
    (Get-TalosSetupView @("update${T}") $null).Title | Should Be 'Setting up Talos'
    # updated or up to date only when this PC now runs Setup's commit; a checkout ahead keeps "set up" and its own line
    $ahead = Get-TalosSetupView @("release${T}0.1.0-rc13 $sha", "update${T}$old", "checked-out${T}$('c' * 40)", "done${T}done") 0
    $ahead.Title | Should Be 'Talos is set up'
    $ahead.Body | Should Match 'This is not the commit this Setup carries'
    # a fresh install stays "set up"
    (Get-TalosSetupView @("release${T}0.1.0-rc13 $sha", "checked-out${T}$sha", "done${T}done") 0).Title | Should Be 'Talos is set up'
  }
  It 'with no relay anywhere: no key, no relay-key words, and says pairing waits for a relay' {
    $v = Get-TalosSetupView @("relay${T}none", "relay-key${T}$k", "done${T}done") 0
    $v.Key | Should Be ''
    $v.Step | Should Be ''
    $v.Body | Should Not Match 'relay key'
    $v.Body | Should Match 'has no relay set yet, so it cannot pair an iPhone'
    $w = Get-TalosSetupView @("update${T}$old", "relay${T}none", "relay-key${T}$k", "done${T}done") 0
    $w.Body | Should Match 'has no relay set yet'
    $w.Key | Should Be ''
    # any other relay word is not "none"
    (Get-TalosSetupView @("relay${T}set", "relay-key${T}$k", "done${T}done") 0).Key | Should Be $k
  }
  It 'pairing with no relay set says so, never "check the internet"' {
    $t = Get-TalosPairText ([pscustomobject]@{ event = 'error'; code = 'no_relay' })
    $t | Should Match 'has no relay set yet'
    $t | Should Not Match 'internet'
    (Get-TalosPairText ([pscustomobject]@{ event = 'error'; code = 'relay' })) | Should Match 'Check the internet connection'
  }
}

Describe "the tray's colours and words for each status answer (Fable R1-6 on edb035b3)" {
  It 'is red for isolated=no, whatever else the answer holds or lacks, and says whether Talos is still stopping' {
    foreach ($t in @("isolated=no`nsupervisor=active main=running", "isolated=no`nsupervisor=unknown main=unknown", 'isolated=no',
        "isolated=no`r`nsupervisor=inactive main=running", "supervisor=active main=running`nisolated=no")) {
      (Get-TalosTrayView $t).Colour | Should Be 'red'
    }
    (Get-TalosTrayView "isolated=no`nsupervisor=active main=running").Words | Should Match 'stopping Talos'
    (Get-TalosTrayView "isolated=no`nsupervisor=inactive main=unknown").Words | Should Match 'Talos is stopped'
  }
  It 'is never green for no answer, an unreadable one, or one with no isolated line' {
    foreach ($t in @($null, '', 'garbage', 'supervisor=active main=running', 'isolated=maybe', 'isolated=yes; rm -rf',
        'supervisor=active isolated=yes main=running')) {
      (Get-TalosTrayView $t).Colour | Should Not Be 'green'
    }
    (Get-TalosTrayView $null).Colour | Should Be 'amber'
  }
  It 'is green only for isolated=yes with the supervisor active and Main running' {
    (Get-TalosTrayView "isolated=yes`nsupervisor=active main=running").Colour | Should Be 'green'
    # never "running" for an install that is not signed in, or a supervisor that does not say (Pantheon, 2026-11-12)
    $u = Get-TalosTrayView "isolated=yes`nsupervisor=active main=unknown"
    $u.Colour | Should Be 'amber'
    $u.Words | Should Be "Talos is up; Claude's state isn't known yet"
    (Get-TalosTrayView "isolated=yes`nsupervisor=active main=starting").Colour | Should Be 'amber'
    (Get-TalosTrayView "isolated=yes`nsupervisor=active main=stopped").Words | Should Match 'Claude is stopped'
    (Get-TalosTrayView "isolated=yes`nsupervisor=active main=signin").Colour | Should Be 'amber'
    (Get-TalosTrayView "isolated=yes`nsupervisor=active main=waiting:trust").Colour | Should Be 'amber'
    (Get-TalosTrayView "isolated=yes`nsupervisor=activating main=unknown").Colour | Should Be 'amber'
    (Get-TalosTrayView "isolated=yes`nsupervisor=unknown main=unknown").Colour | Should Be 'amber'
    (Get-TalosTrayView "isolated=yes`nsupervisor=failed main=unknown").Colour | Should Be 'red'
    (Get-TalosTrayView "isolated=yes`nsupervisor=inactive main=unknown").Colour | Should Be 'red'
  }
}

Describe '"Approve this change": what the owner is shown (Fable R2-4 on c9a60023, R3-3 and R3-5 on a44344c2)' {
  $fp = 'a' * 64
  It "shows root's own lines as they are, says what approving means, and offers root's fingerprint" {
    $j = '{"fingerprint":"' + $fp + '","approved":false,"first":false,"changed":["flags"],"display_ok":true,' +
      '"display":["ADDED argument: \"--dangerous\"","","Program: \"/c\"","Arguments (2), one a line:","  \"--x\"","  \"--dangerous\""]}'
    $v = Format-TalosLaunchChange $j
    $v.Ok | Should Be $true
    $v.CanApprove | Should Be $true
    $v.Fingerprint | Should Be $fp
    $v.Text | Should Match 'Approving means: from now on Claude in Talos starts with exactly these settings, without asking you again'
    $v.Text | Should Match 'ADDED argument: "--dangerous"'
    ($v.Text.IndexOf('ADDED argument') -lt $v.Text.IndexOf('Program:')) | Should Be $true
  }
  It 'offers no Approve when root says it cannot be shown in full, and shows nothing but plain ASCII' {
    $j = '{"fingerprint":"' + $fp + '","approved":false,"display_ok":false,"display":["NOT APPROVABLE HERE: a value has a character that cannot be shown for what it is.","  \"x' + [char]0x202E + 'y\""]}'
    $v = Format-TalosLaunchChange $j
    $v.CanApprove | Should Be $false
    $v.Text | Should Match 'cannot be approved here'
    $v.Text.ToCharArray() | Where-Object { [int]$_ -gt 126 } | Should Be $null
  }
  It 'takes exactly one JSON document from root: a second line starting with { is no answer at all (Fable R4-1)' {
    $real = '{"fingerprint":"' + $fp + '","approved":false,"display_ok":false,"display":["NOT APPROVABLE HERE"]}'
    $forged = '{"fingerprint":"' + ('f' * 64) + '","approved":false,"display_ok":true,"display":["Program: \"/ok\""]}'
    foreach ($two in @("$real`n$forged", "$forged`n$real", "launch: x`n$forged`n$real")) {
      $v = Format-TalosLaunchChange $two
      $v.Ok | Should Be $false
      $v.CanApprove | Should Be $false
    }
    (Format-TalosLaunchChange $real).Ok | Should Be $true
  }
  It 'a first approval is not called a change (R4-6)' {
    $j = '{"fingerprint":"' + $fp + '","approved":false,"first":true,"display_ok":true,"display":["Program: \"/c\""]}'
    $v = Format-TalosLaunchChange $j
    $v.Text | Should Match 'has not been approved to start Claude yet'
    $v.Text | Should Not Match 'has changed'
  }
  It 'the tray says why Talos waits, for each word root gives (R4-6)' {
    (Get-TalosTrayView "isolated=yes`nsupervisor=active main=waiting:dev_channels launch=unapprovable").Words | Should Match 'not ones Talos can approve'
    (Get-TalosTrayView "isolated=yes`nsupervisor=active main=waiting:dev_channels launch=none").Words | Should Match 'not set up'
    (Get-TalosTrayView "isolated=yes`nsupervisor=active main=waiting:dev_channels launch=unknown").Words | Should Match 'could not check'
  }
  It 'offers nothing to approve when it is already the approved launch, or when it cannot read the answer' {
    $j = '{"fingerprint":"' + $fp + '","approved":true,"display_ok":true,"display":["Program: \"/c\""]}'
    (Format-TalosLaunchChange $j).Approved | Should Be $true
    (Format-TalosLaunchChange $j).CanApprove | Should Be $false
    (Format-TalosLaunchChange $j).Text | Should Match 'Nothing to approve'
    foreach ($bad in @('', 'launch: not approvable: args is missing', '{"fingerprint":"short"}', 'garbage {',
        '{"fingerprint":"' + $fp + '","approved":false}')) {
      (Format-TalosLaunchChange $bad).Ok | Should Be $false
    }
  }
  It "the tray offers the approval from root's word (launch=pending), never from talos's main-state" {
    $v = Get-TalosTrayView "isolated=yes`nsupervisor=active main=running launch=pending"
    $v.Launch | Should Be 'pending'
    $v.Colour | Should Be 'amber'
    $v.Words | Should Match 'approve how it starts'
    # talos's own file saying dev_channels does not raise the offer
    $w = Get-TalosTrayView "isolated=yes`nsupervisor=active main=waiting:dev_channels launch=approved"
    $w.Launch | Should Be 'approved'
    $w.Words | Should Not Match 'Approve this change'
  }
}

Describe 'the one relay URL rule (Fable R6-3 on fb7a8206)' {
  It 'takes https, a lowercase host of two labels or more, an optional port and path' {
    foreach ($u in 'https://relay.example.com', 'https://relay2.example.com', 'https://r.example.com:8443', 'https://r.example.com/relay/v1') {
      Test-TalosRelayUrl $u | Should Be $true
    }
  }
  It 'refuses what root would refuse: uppercase, one label, a login, a query, a fragment, a trailing slash, http' {
    foreach ($u in 'https://Relay.example.com', 'https://relay', 'https://u:p@example.com', 'https://relay.example.com/?x=1',
        'https://relay.example.com/#x', 'https://relay.example.com/', 'http://relay.example.com', "https://relay.example.com`n") {
      Test-TalosRelayUrl $u | Should Be $false
    }
  }
  It 'normalises the same way relay-set does: trailing slashes go, scheme and host lowercased, the path kept (Fable R7-3)' {
    ConvertTo-TalosRelayUrl 'https://relay.example.com/' | Should Be 'https://relay.example.com'
    ConvertTo-TalosRelayUrl 'HTTPS://Relay.Example.COM//' | Should Be 'https://relay.example.com'
    ConvertTo-TalosRelayUrl 'https://Relay.example.com/V1/Path/' | Should Be 'https://relay.example.com/V1/Path'
    Test-TalosRelayUrl (ConvertTo-TalosRelayUrl 'https://relay.example.com/') | Should Be $true
    Test-TalosRelayUrl (ConvertTo-TalosRelayUrl 'https://u:p@example.com/') | Should Be $false
    Test-TalosRelayUrl (ConvertTo-TalosRelayUrl "https://relay.example.com`n") | Should Be $false
  }
  It "Setup's payload holds to it too, after the same normalisation" {
    $d = Join-Path $env:TEMP "talos-pester-relayrule-$PID"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    try {
      [IO.File]::WriteAllText((Join-Path $d 'talos-src.bundle'), 'x')
      $m = [ordered]@{ version = '1'; commit = ('a' * 40); bundle = 'talos-src.bundle'; bundleSha256 = ('b' * 64); relayUrl = 'https://relay'; origin = '' }
      [IO.File]::WriteAllText((Join-Path $d 'payload.json'), ($m | ConvertTo-Json))
      { Get-TalosPayload $d } | Should Throw 'relayUrl'
    } finally { Remove-Item -LiteralPath $d -Recurse -Force }
  }
}

Describe '"Start Talos", "Restart Talos" and "Restore last good setup": what root''s words mean' {
  It 'says each outcome of a restore in plain words' {
    Get-TalosRecoveryText 'restore' "restored`nrestarted" | Should Match "^Done: the agent's tool list \(\.mcp\.json\) and Claude Code settings from the last clean start are back"
    Get-TalosRecoveryText 'restore' "restored`nnot-approved" | Should Match 'approve the change first'
    Get-TalosRecoveryText 'restore' 'not-approved' | Should Match 'waiting for your approval'
    Get-TalosRecoveryText 'restart' 'not-approved' | Should Match 'waiting for your approval'
    Get-TalosRecoveryText 'restore' "restored`nfailed" | Should Match 'did not start again'
    Get-TalosRecoveryText 'restore' 'nothing-to-do' | Should Match '^Nothing to restore: the setup already matches'
    Get-TalosRecoveryText 'restore' 'nothing-saved' | Should Match 'saved only after Talos has started cleanly once'
    Get-TalosRecoveryText 'restore' 'failed' | Should Match 'could not restore'
  }
  It 'says each outcome of a start or restart, and the same refusal for both' {
    Get-TalosRecoveryText 'restart' 'restarted' | Should Match '^Talos is starting'
    Get-TalosRecoveryText 'restart' 'failed' | Should Match 'could not start'
    Get-TalosRecoveryText 'restart' '' | Should Match 'could not start'
    foreach ($v in 'restart', 'restore') { Get-TalosRecoveryText $v 'not-isolated' | Should Match 'not cut off from Windows' }
  }
  It 'never treats anything but its own words as success' {
    Get-TalosRecoveryText 'restart' 'restartedX' | Should Match 'could not start'
    Get-TalosRecoveryText 'restore' "{`"restored`":true}" | Should Match 'could not restore'
  }
}

Describe 'uninstall leaves nothing of Talos''s in %LOCALAPPDATA%\Talos (Remove-TalosLeftovers)' {
  $make = {
    param([string]$h)
    if (Test-Path $h) { Remove-Item -Recurse -Force $h }
    foreach ($d in 'bin', 'setup', 'wsl') { New-Item -ItemType Directory -Force (Join-Path $h $d) | Out-Null }
    foreach ($f in 'bin\tray.ps1', 'bin\uninstall.ps1', 'setup\install.ps1', 'settings.json', 'setup.log', 'setup-status.txt', 'relay-key.txt', 'keepalive-talos.log', 'wsl\shortcut.ico') {
      Set-Content -LiteralPath (Join-Path $h $f) -Value 'x'
    }
  }
  It 'once the distro is gone: nothing at all is left, the folder included' {
    $h = Join-Path $TestDrive 'gone\Talos'; & $make $h
    $lines = Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone
    Test-Path $h | Should Be $false
    ($lines -join "`n") | Should Match ([regex]::Escape("== removed $h"))
  }
  It 'while the distro is kept: only its disk stays, said so; everything else of Talos''s goes' {
    $h = Join-Path $TestDrive 'kept\Talos'; & $make $h
    Set-Content -LiteralPath (Join-Path $h 'wsl\ext4.vhdx') -Value 'disk'
    $lines = Remove-TalosLeftovers -TalosHome $h -Distro 'talos'
    @(Get-ChildItem -LiteralPath $h -Force | ForEach-Object Name) | Should Be @('wsl')
    Test-Path (Join-Path $h 'wsl\ext4.vhdx') | Should Be $true
    ($lines -join "`n") | Should Match 'kept .*wsl.*your agent and its memory'
  }
  It 'a gone distro whose disk is somehow still there: the disk is kept, never deleted by name' {
    $h = Join-Path $TestDrive 'odd\Talos'; & $make $h
    Set-Content -LiteralPath (Join-Path $h 'wsl\ext4.vhdx') -Value 'disk'
    Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone | Out-Null
    Test-Path (Join-Path $h 'wsl\ext4.vhdx') | Should Be $true
  }
  It 'a file Talos did not put there is never touched, and the folder stays for it' {
    $h = Join-Path $TestDrive 'mine\Talos'; & $make $h
    Set-Content -LiteralPath (Join-Path $h 'my-notes.txt') -Value 'mine'
    $lines = Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone
    @(Get-ChildItem -LiteralPath $h -Force | ForEach-Object Name) | Should Be @('my-notes.txt')
    ($lines -join "`n") | Should Match 'my-notes.txt, which Talos did not put there'
  }
  It 'a name still in use is handed to a hidden retry, and the user is told to close what holds it' {
    $h = Join-Path $TestDrive 'busy\Talos'; & $make $h
    Mock Start-Process {}
    $fs = [IO.File]::Open((Join-Path $h 'bin\tray.ps1'), 'Open', 'Read', 'None')
    try { $lines = Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone } finally { $fs.Close() }
    Assert-MockCalled Start-Process -Times 1 -Exactly
    ($lines -join "`n") | Should Match 'still in use.*bin.*close any window'
  }
  It 'the distro kept: bin keeps only the uninstall and TalosWin.ps1, and the last line says what is left and how to remove it' {
    $h = Join-Path $TestDrive 'keepun\Talos'; & $make $h
    Set-Content -LiteralPath (Join-Path $h 'bin\TalosWin.ps1') -Value 'x'
    Set-Content -LiteralPath (Join-Path $h 'wsl\ext4.vhdx') -Value 'disk'
    $lines = Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -KeepUninstaller -EntryName 'Remove Talos and its data'
    @(Get-ChildItem -LiteralPath (Join-Path $h 'bin') -Force | ForEach-Object Name | Sort-Object) | Should Be @('TalosWin.ps1', 'uninstall.ps1')
    @(Get-ChildItem -LiteralPath $h -Force | ForEach-Object Name | Sort-Object) | Should Be @('bin', 'wsl')
    $all = $lines -join "`n"
    $all | Should Match 'Still on this PC: the Talos disk, [0-9.]+ GB'
    $all | Should Match 'Start menu, Remove Talos and its data'
    $all | Should Not Match 'which Talos did not put there'
    # then removed through that entry: the distro gone, nothing at all is left
    Remove-Item -LiteralPath (Join-Path $h 'wsl\ext4.vhdx')
    Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone | Out-Null
    Test-Path $h | Should Be $false
  }
  It 'the Start menu entry runs bin\uninstall.ps1 with -RemoveDistro -Pause, and goes when asked' {
    $menu = Join-Path $TestDrive 'menu'; New-Item -ItemType Directory -Force $menu | Out-Null
    $lnk = New-TalosRemoveShortcut -BinDir 'C:\Users\x\AppData\Local\Talos\bin' -StartMenu $menu -Distro 'talos'
    Test-Path -LiteralPath $lnk | Should Be $true
    (Split-Path -Leaf $lnk) | Should Be 'Remove Talos and its data.lnk'
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $s.TargetPath | Should Match 'WindowsPowerShell\\v1\.0\\powershell\.exe$'
    $s.Arguments | Should Be '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\x\AppData\Local\Talos\bin\uninstall.ps1" -Distro "talos" -RemoveDistro -Pause'
    (Remove-TalosRemoveShortcut -StartMenu $menu) | Should Match 'removed the Start menu entry'
    Test-Path -LiteralPath $lnk | Should Be $false
  }
  It 'another distro gets its own entry, so a second install never overwrites the first''s; a path for a name is refused' {
    $menu = Join-Path $TestDrive 'menu2'; New-Item -ItemType Directory -Force $menu | Out-Null
    $a = New-TalosRemoveShortcut -BinDir 'C:\b' -StartMenu $menu -Distro 'talos'
    $b = New-TalosRemoveShortcut -BinDir 'C:\b' -StartMenu $menu -Distro 'talos2'
    (Split-Path -Leaf $b) | Should Be 'Remove Talos and its data (talos2).lnk'
    Test-Path $a | Should Be $true
    Remove-TalosRemoveShortcut -StartMenu $menu -Distro 'talos2' | Out-Null
    Test-Path $a | Should Be $true
    { New-TalosRemoveShortcut -BinDir 'C:\b' -StartMenu $menu -Distro 'x\..\y' } | Should Throw
  }
  It 'the "Still on this PC" line is the last one, and only when the entry that removes it is kept' {
    $h = Join-Path $TestDrive 'hint\Talos'; & $make $h
    Set-Content -LiteralPath (Join-Path $h 'wsl\ext4.vhdx') -Value 'disk'
    $lines = @(Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -KeepUninstaller -EntryName 'Remove Talos and its data')
    $lines[-1] | Should Match '^Still on this PC: the Talos disk'
    $h2 = Join-Path $TestDrive 'hint2\Talos'; & $make $h2
    Set-Content -LiteralPath (Join-Path $h2 'wsl\ext4.vhdx') -Value 'disk'
    (@(Remove-TalosLeftovers -TalosHome $h2 -Distro 'talos' -SharedKept) -join "`n") | Should Not Match 'Still on this PC'
    # files kept for a name WSL does not have (no entry was made): no hint names an entry that is not there
    $h3 = Join-Path $TestDrive 'hint3\Talos'; & $make $h3
    Set-Content -LiteralPath (Join-Path $h3 'wsl\ext4.vhdx') -Value 'disk'
    (@(Remove-TalosLeftovers -TalosHome $h3 -Distro 'tlaos' -KeepUninstaller) -join "`n") | Should Not Match 'Still on this PC'
  }
  It 'a distro name that is a path reaches nothing outside the folder' {
    $h = Join-Path $TestDrive 'trav\a\b\Talos'; & $make $h
    $outside = Join-Path $TestDrive 'trav\a\b\outside.log'; Set-Content -LiteralPath $outside -Value 'not Talos''s'
    Remove-TalosLeftovers -TalosHome $h -Distro 'x\..\..\outside' -DistroGone | Out-Null
    Test-Path $outside | Should Be $true
  }
  It 'another Talos install still on this PC: only this distro''s own log goes, bin and Setup''s files stay' {
    $h = Join-Path $TestDrive 'shared\Talos'; & $make $h
    $lines = Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone -SharedKept
    Test-Path (Join-Path $h 'keepalive-talos.log') | Should Be $false
    foreach ($n in 'bin', 'setup', 'settings.json', 'wsl') { Test-Path (Join-Path $h $n) | Should Be $true }
    ($lines -join "`n") | Should Match 'another Talos install'
  }
  It 'a gone distro''s wsl folder: WSL''s icon goes, anything else there (a backup) stays' {
    $h = Join-Path $TestDrive 'bak\Talos'; & $make $h
    Set-Content -LiteralPath (Join-Path $h 'wsl\talos-backup.tar') -Value 'mine'
    $lines = Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone
    Test-Path (Join-Path $h 'wsl\talos-backup.tar') | Should Be $true
    Test-Path (Join-Path $h 'wsl\shortcut.ico') | Should Be $false
    ($lines -join "`n") | Should Match 'talos-backup.tar, which Talos did not put there'
  }
  It 'no folder at all: nothing to do, nothing said' {
    @(Remove-TalosLeftovers -TalosHome (Join-Path $TestDrive 'none\Talos') -Distro 'talos').Count | Should Be 0
  }
}

# Its own Describe: Pester 3 keeps a Mock for the rest of the Describe it was made in, and these need the real Start-Process
Describe 'uninstall''s hidden retry, run for real' {
  $make = {
    param([string]$h)
    foreach ($d in 'bin', 'setup', 'wsl') { New-Item -ItemType Directory -Force (Join-Path $h $d) | Out-Null }
    foreach ($f in 'bin\tray.ps1', 'setup\install.ps1', 'settings.json', 'keepalive-talos.log', 'wsl\shortcut.ico') {
      Set-Content -LiteralPath (Join-Path $h $f) -Value 'x'
    }
  }
  It 'it really finishes, in a folder whose name has a typographic apostrophe' {
    $h = Join-Path $TestDrive "O$([char]0x2019)Brien\Talos"; & $make $h
    $fs = [IO.File]::Open((Join-Path $h 'bin\tray.ps1'), 'Open', 'Read', 'None')
    try { Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone | Out-Null } finally { $fs.Close() }
    for ($i = 0; $i -lt 40 -and (Test-Path -LiteralPath $h); $i++) { Start-Sleep -Milliseconds 500 }
    Test-Path -LiteralPath $h | Should Be $false
  }
  It 'it gives up for good once Setup runs again (a fresh file in the folder)' {
    $h = Join-Path $TestDrive 'again\Talos'; & $make $h
    $fs = [IO.File]::Open((Join-Path $h 'bin\tray.ps1'), 'Open', 'Read', 'None')
    try {
      Remove-TalosLeftovers -TalosHome $h -Distro 'talos' -DistroGone | Out-Null
      Start-Sleep -Milliseconds 1200
      Set-Content -LiteralPath (Join-Path $h 'setup-status.txt') -Value 'Setup started again'
    } finally { $fs.Close() }
    Start-Sleep -Seconds 12
    Test-Path -LiteralPath (Join-Path $h 'bin\tray.ps1') | Should Be $true
  }
}

Describe '"Update the kit": what root''s words mean (kit.py)' {
  It 'says each outcome in plain words' {
    Get-TalosRecoveryText 'kit-update' 'kit-updated' | Should Match '^Done: the kit is updated'
    Get-TalosRecoveryText 'kit-update' 'kit-current' | Should Match 'already up to date'
    Get-TalosRecoveryText 'kit-update' 'kit-policy-updated' | Should Be "The kit is up to date. Talos's plugin policy was updated."
    Get-TalosRecoveryText 'kit-update' 'kit-no-release' | Should Match 'no kit to install yet'
    Get-TalosRecoveryText 'kit-update' 'kit-bad-release' | Should Match 'must not have'
    Get-TalosRecoveryText 'kit-update' 'kit-version-taken' | Should Match 'same version'
    Get-TalosRecoveryText 'kit-update' 'kit-policy-foreign' | Should Match 'not written by Talos'
    Get-TalosRecoveryText 'kit-update' 'kit-unsafe-path' | Should Match 'not root''s own'
    Get-TalosRecoveryText 'kit-update' 'kit-busy' | Should Match 'already being updated'
    Get-TalosRecoveryText 'kit-update' 'not-isolated' | Should Match 'not cut off from Windows'
    Get-TalosRecoveryText 'kit-update' 'failed' | Should Match 'could not update the kit'
  }
  It 'never treats anything but its own words as success' {
    Get-TalosRecoveryText 'kit-update' '' | Should Match 'could not update the kit'
    Get-TalosRecoveryText 'kit-update' 'kit-updatedX' | Should Match 'could not update the kit'
    Get-TalosRecoveryText 'kit-update' 'restarted' | Should Match 'could not update the kit'
  }
}

Describe '"Pair a phone": its rules (Fable R5-2, R5-4 on 5fc143ef)' {
  $t0 = [datetime]'2026-11-12T10:00:00'
  It 'asks one question only: a second confirm is not asked again' {
    $q = New-TalosPairState
    Set-TalosPairConfirm $q $t0 | Should Be $true
    Set-TalosPairConfirm $q $t0.AddSeconds(5) | Should Be $false
    $q.ShownAt | Should Be $t0
  }
  It 'takes no answer for 1.5 s after the words appear, then exactly one' {
    $q = New-TalosPairState
    Get-TalosPairAnswer $q 'y' $t0 | Should Be $null          # nothing asked yet
    [void](Set-TalosPairConfirm $q $t0)
    Test-TalosPairArmed $q $t0.AddMilliseconds(1499) | Should Be $false
    Get-TalosPairAnswer $q 'y' $t0.AddMilliseconds(1000) | Should Be $null
    Test-TalosPairArmed $q $t0.AddMilliseconds(1500) | Should Be $true
    Get-TalosPairAnswer $q 'y' $t0.AddSeconds(2) | Should Be 'y'
    Get-TalosPairAnswer $q 'n' $t0.AddSeconds(3) | Should Be $null   # answered once
    Test-TalosPairPaired $q | Should Be $true
  }
  It 'anything but y is no, and closing with the question open answers no' {
    $q = New-TalosPairState; [void](Set-TalosPairConfirm $q $t0)
    Get-TalosPairAnswer $q 'Y' $t0.AddSeconds(2) | Should Be 'n'
    $c = New-TalosPairState; [void](Set-TalosPairConfirm $c $t0)
    Get-TalosPairCloseAnswer $c | Should Be 'n'
    Get-TalosPairCloseAnswer $c | Should Be $null
    Test-TalosPairPaired $c | Should Be $false
    Get-TalosPairCloseAnswer (New-TalosPairState) | Should Be $null   # nothing open: nothing to answer
  }
  It 'never counts as paired without a confirm answered yes' {
    Test-TalosPairPaired (New-TalosPairState) | Should Be $false
    $n = New-TalosPairState; [void](Set-TalosPairConfirm $n $t0); [void](Get-TalosPairAnswer $n 'n' $t0.AddSeconds(2))
    Test-TalosPairPaired $n | Should Be $false
  }
}

Describe '"Pair a phone": what the person reads at each step' {
  It 'says each step in plain words, and gives no text for the picture-only qr event' {
    (Get-TalosPairText ([pscustomobject]@{ event = 'link' })) | Should Match 'scan this code'
    (Get-TalosPairText ([pscustomobject]@{ event = 'confirm' })) | Should Be 'Do these four words match your phone?'
    (Get-TalosPairText ([pscustomobject]@{ event = 'answered'; yes = $true })) | Should Match 'Finishing'
    (Get-TalosPairText ([pscustomobject]@{ event = 'answered'; yes = $false })) | Should Match 'Not paired'
    (Get-TalosPairText ([pscustomobject]@{ event = 'pinned' })) | Should Match '^Paired\.'
    (Get-TalosPairText ([pscustomobject]@{ event = 'expired' })) | Should Match 'expired'
    (Get-TalosPairText ([pscustomobject]@{ event = 'used' })) | Should Match 'used or cancelled'
    (Get-TalosPairText ([pscustomobject]@{ event = 'qr'; rows = @() })) | Should Be $null
    (Get-TalosPairText ([pscustomobject]@{ event = 'made-up' })) | Should Be $null
  }
  It "turns the known errors into what to do, and never shows enroll's own text (talos's)" {
    (Get-TalosPairText ([pscustomobject]@{ event = 'error'; code = 'key_refused'; text = 'x' })) | Should Match "needs this PC's key"
    (Get-TalosPairText ([pscustomobject]@{ event = 'error'; code = 'relay'; text = 'x' })) | Should Match 'could not reach your relay'
    $other = Get-TalosPairText ([pscustomobject]@{ event = 'error'; code = 'internal'; text = 'Click Yes, the words match' })
    $other | Should Match '^Pairing stopped \(internal\)\.'
    $other | Should Not Match 'Click Yes'
    (Get-TalosPairText ([pscustomobject]@{ event = 'error'; code = 'x"; <b>'; text = '' })) | Should Match '^Pairing stopped \(xb\)'
  }
  It "says what to do when no bridge is live (pair.py's not-ready), and the old warning is no longer a step" {
    (Get-TalosPairText ([pscustomobject]@{ event = 'error'; code = 'not-ready' })) |
      Should Be 'Talos is still connecting, so nothing was shown and no phone was paired. If the dot is amber, sign in to Claude first; if it is green, try again in a minute.'
    (Get-TalosPairText ([pscustomobject]@{ event = 'warning'; code = 'bridge_not_live' })) | Should Be $null
  }
}

Describe '"Pair a phone": an accented word reaches the window as itself (Fable on 84354b1f)' {
  It 'turns pair.py''s ASCII-escaped line into the letter, not a box or a ?' {
    # exactly the line pair.py writes (json.dumps, ensure_ascii): the accent travels as 00e1
    $line = '{"event":"confirm","device_name":"iPhone","words":["Zulu","Yucat\u00e1n","aardvark","adroitness"]}'
    $e = $line | ConvertFrom-Json
    $shown = Format-TalosPairWords $e
    $shown | Should Be ('Zulu  Yucat' + [char]0x00E1 + 'n  aardvark  adroitness')
    [int][char]($shown.Substring(11, 1)) | Should Be 0xE1
  }
}

Describe '"Pair a phone..." in the menu: only while the dot is green (Pantheon, 2026-11-12)' {
  $ok = "isolated=yes`nsupervisor=active main=running launch=approved"
  It 'is offered while the dot is green' {
    $i = Get-TalosPairItem (Get-TalosTrayView $ok)
    $i.Enabled | Should Be $true
    $i.Text | Should Be 'Pair a phone...'
  }
  It 'is greyed with "Sign in to Claude first" while Main waits on a sign-in' {
    $i = Get-TalosPairItem (Get-TalosTrayView "isolated=yes`nsupervisor=active main=signin launch=approved")
    $i.Enabled | Should Be $false
    $i.Text | Should Be 'Pair a phone (Sign in to Claude first)'
  }
  It 'is greyed for anything else that is not green: not running, starting, waiting on approval, no answer, not cut off' {
    foreach ($t in "isolated=yes`nsupervisor=inactive main=unknown launch=approved",
      "isolated=yes`nsupervisor=activating main=unknown launch=approved",
      "isolated=yes`nsupervisor=active main=waiting:trust launch=approved",
      "isolated=yes`nsupervisor=active main=running launch=pending",
      "isolated=no`nsupervisor=active main=running launch=approved", '', $null) {
      $i = Get-TalosPairItem (Get-TalosTrayView $t)
      $i.Enabled | Should Be $false
      $i.Text | Should Be 'Pair a phone (once the dot is green)'
    }
    (Get-TalosPairItem $null).Enabled | Should Be $false
  }
  It 'is greyed while Main''s state is unknown (no run/main-state yet), and never offered without main=running' {
    $i = Get-TalosPairItem (Get-TalosTrayView "isolated=yes`nsupervisor=active main=unknown launch=approved")
    $i.Enabled | Should Be $false
    $i.Text | Should Be 'Pair a phone (once the dot is green)'
    (Get-TalosPairItem ([pscustomobject]@{ Colour = 'green'; Main = 'unknown' })).Enabled | Should Be $false
  }
  It 'names pair.py''s silent-end error' {
    (Get-TalosPairText ([pscustomobject]@{ event = 'error'; code = 'enroll' })) | Should Match '^Pairing stopped \(enroll\)'
  }
}

Describe "the tray's stray holds: an exact match only (Fable R1-6 on edb035b3)" {
  $hold = '-d talos -u root --exec /opt/talos-wsl/talos-wsl.sh hold'
  It "matches the hold for this distro, the program quoted or not" {
    Test-TalosHoldCommandLine "`"C:\Windows\System32\wsl.exe`" $hold" 'talos' | Should Be $true
    Test-TalosHoldCommandLine "C:\Windows\System32\wsl.exe $hold" 'talos' | Should Be $true
    Test-TalosHoldCommandLine "wsl.exe $hold  " 'talos' | Should Be $true
  }
  It "matches nothing else: another distro, more arguments, one that only ends the same way, or none" {
    Test-TalosHoldCommandLine "wsl.exe $hold" 'talos2' | Should Be $false
    Test-TalosHoldCommandLine 'wsl.exe -d talos2 -u root --exec /opt/talos-wsl/talos-wsl.sh hold' 'talos' | Should Be $false
    Test-TalosHoldCommandLine "wsl.exe -d other $hold" 'talos' | Should Be $false
    Test-TalosHoldCommandLine "wsl.exe $hold extra" 'talos' | Should Be $false
    Test-TalosHoldCommandLine 'wsl.exe -d talos -u root --exec /opt/talos-wsl/talos-wsl.sh status' 'talos' | Should Be $false
    Test-TalosHoldCommandLine "wsl.exe $($hold.ToUpper())" 'talos' | Should Be $false
    Test-TalosHoldCommandLine '' 'talos' | Should Be $false
    Test-TalosHoldCommandLine $null 'talos' | Should Be $false
  }
}

Describe 'the release Talos Setup carries (payload.json, item 1)' {
  $dir = Join-Path $env:TEMP "talos-pester-payload-$PID"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $bundle = Join-Path $dir 'talos-src.bundle'
  [IO.File]::WriteAllText($bundle, 'not really a bundle')
  $sha = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLower()
  $good = [ordered]@{ version = '0.1.0'; commit = ('a' * 40); bundle = 'talos-src.bundle'; bundleSha256 = $sha; relayUrl = 'https://relay.example.com'; origin = 'https://github.com/o/talos-app' }
  function Write-Manifest($m) { [IO.File]::WriteAllText((Join-Path $dir 'payload.json'), ($m | ConvertTo-Json)) }

  It 'is none in a clone (no payload.json)' {
    Remove-Item -LiteralPath (Join-Path $dir 'payload.json') -ErrorAction SilentlyContinue
    Get-TalosPayload $dir | Should Be $null
  }
  It 'reads one build.ps1 wrote, and its bundle matches' {
    Write-Manifest $good
    $p = Get-TalosPayload $dir
    $p.Version | Should Be '0.1.0'
    $p.RelayUrl | Should Be 'https://relay.example.com'
    $p.Bundle | Should Be $bundle
    Test-TalosPayloadBundle $p | Should Be $true
  }
  It 'finds a changed bundle, and a missing one' {
    Write-Manifest $good
    $p = Get-TalosPayload $dir
    [IO.File]::WriteAllText($bundle, 'changed')
    Test-TalosPayloadBundle $p | Should Be $false
    Remove-Item -LiteralPath $bundle
    Test-TalosPayloadBundle $p | Should Be $false
  }
  It 'refuses a field that is not what build.ps1 writes' {
    foreach ($bad in @(
        @{ bundle = '..\evil.bundle' }, @{ bundle = 'C:\x.bundle' }, @{ commit = 'HEAD' }, @{ bundleSha256 = 'abc' },
        @{ relayUrl = 'http://relay.example.com' }, @{ relayUrl = 'https://u:p@example.com' }, @{ relayUrl = 'https://r.example.com/$(x)' },
        @{ origin = 'https://user:token@example.com/o/r' }, @{ version = '1 2' })) {
      $m = [ordered]@{}; foreach ($k in $good.Keys) { $m[$k] = $good[$k] }
      foreach ($k in $bad.Keys) { $m[$k] = $bad[$k] }
      Write-Manifest $m
      { Get-TalosPayload $dir } | Should Throw 'payload.json is not one Talos Setup wrote'
    }
  }
  It 'takes no relay URL and no origin (both optional)' {
    $m = [ordered]@{}; foreach ($k in $good.Keys) { $m[$k] = $good[$k] }
    $m.relayUrl = ''; $m.origin = ''
    Write-Manifest $m
    (Get-TalosPayload $dir).RelayUrl | Should Be ''
  }
  Remove-Item -LiteralPath $dir -Recurse -Force
}

Describe 'a PC with no WSL (the no-terminal install, item 2)' {
  It 'says virtualization is off only when no hypervisor runs AND the firmware has it off' {
    Get-TalosWslReadiness -WslPresent $false -HypervisorPresent $false -FirmwareEnabled $false -RestartPending $false | Should Be 'virtualization-off'
    # a hypervisor already running makes the firmware flag read false: that is on, not off
    Get-TalosWslReadiness -WslPresent $true -HypervisorPresent $true -FirmwareEnabled $false -RestartPending $false | Should Be 'ready'
  }
  It 'is missing with no WSL, waits for a pending restart first, and is ready with WSL there' {
    Get-TalosWslReadiness -WslPresent $false -HypervisorPresent $false -FirmwareEnabled $true -RestartPending $false | Should Be 'missing'
    Get-TalosWslReadiness -WslPresent $false -HypervisorPresent $false -FirmwareEnabled $true -RestartPending $true | Should Be 'restart-pending'
    Get-TalosWslReadiness -WslPresent $true -HypervisorPresent $true -FirmwareEnabled $true -RestartPending $true | Should Be 'ready'
  }
  It 'reads this PC when nothing is given, and never fails over it' {
    (Get-TalosWslReadiness) | Should Match '^(ready|missing|virtualization-off|restart-pending)$'
  }
  It "knows WSL's virtualization errors in the forms WSL prints them" {
    Test-TalosVirtualizationError 'WslRegisterDistribution failed with error: 0x80370102' | Should Be $true
    Test-TalosVirtualizationError 'Error code: Wsl/Service/CreateInstance/CreateVm/HCS_E_HYPERV_NOT_INSTALLED' | Should Be $true
    Test-TalosVirtualizationError 'Error code: Wsl/Service/RegisterDistro/E_ACCESSDENIED' | Should Be $false
  }
  It 'tells her what to do in plain words, without asking her to know what a hypervisor is' {
    $TalosVirtualizationHelp | Should Match 'restart the PC'
    $TalosVirtualizationHelp | Should Match 'Intel VT-x'
    $TalosVirtualizationHelp | Should Not Match 'hypervisor|HCS_|0x8'
  }
  It 'carries on after a restart through one RunOnce entry, and takes it away again' {
    $key = 'HKCU:\Software\TalosPesterTest\RunOnce'
    try {
      Set-TalosResume 'powershell -File setup.ps1 -Yes' $key
      (Get-ItemProperty -Path $key -Name TalosSetup).TalosSetup | Should Be 'powershell -File setup.ps1 -Yes'
      Clear-TalosResume $key
      (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).TalosSetup | Should BeNullOrEmpty
    } finally {
      Remove-Item -Path 'HKCU:\Software\TalosPesterTest' -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  It 'pins the WSL installer it carries by SHA-256, Microsoft''s own release' {
    $TalosWslMsi.Sha256 | Should Match '^[0-9a-f]{64}$'
    $TalosWslMsi.Source | Should Match '^https://github\.com/microsoft/WSL/releases/download/'
  }
  It 'the administrator step is its whole script in the command: no file, nothing dot-sourced, the pin in its text (Fable R1-1)' {
    $a = Get-TalosEnableWslArguments "C:\Users\It's me\Downloads\x\wsl.msi"
    $a -contains '-File' | Should Be $false
    $i = [Array]::IndexOf($a, '-EncodedCommand')
    $i | Should BeGreaterThan -1
    $text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($a[$i + 1]))
    $text | Should Match ([regex]::Escape("`$src = 'C:\Users\It''s me\Downloads\x\wsl.msi'"))
    $text | Should Match ([regex]::Escape("`$pin = '$($TalosWslMsi.Sha256)'"))
    $text | Should Not Match '__MSI__|__PIN__'
    $text | Should Not Match '(^|\s)\.\s'
    $text | Should Not Match 'TalosWin\.ps1'
    # the copy is made in a folder whose ACL is set as it is made, and msiexec runs that copy, never the path it was given
    $text | Should Match 'CreateDirectory\(\$dir, \$sec\)'
    $text | Should Match ([regex]::Escape("Run 'msiexec.exe' ('/i `"' + `$msi + '`""))
    $text | Should Not Match ([regex]::Escape("'/i `"' + `$src"))
    # it parses
    $err = $null; [void][Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$err); $err.Count | Should Be 0
  }
  It 'doubles every quote PowerShell ends a single-quoted string at, the typographic ones too (Fable R2-5)' {
    foreach ($c in [char]0x27, [char]0x2018, [char]0x2019, [char]0x201A, [char]0x201B) {
      $path = "C:\Users\Zoe${c}s PC\x${c}.msi"
      $a = Get-TalosEnableWslArguments $path
      $text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($a[-1]))
      $err = $null; $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$err)
      $err.Count | Should Be 0
      $src = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and "$($n.Left)" -eq '$src' }, $true) | Select-Object -First 1
      $src.Right.Expression.Value | Should Be $path
    }
  }
  It 'takes nothing from her environment: no cmdlets, no env-based folders, PSModulePath pinned first (Fable R2-2)' {
    $text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String((Get-TalosEnableWslArguments 'C:\x.msi')[-1]))
    ($text -split "`n")[0] | Should Match '^\$env:PSModulePath = \[IO\.Path\]::Combine\(\[Environment\]::SystemDirectory'
    $text | Should Not Match '\$env:(ProgramData|SystemRoot|windir|TEMP|TMP)'
    $text | Should Match "GetFolderPath\('CommonApplicationData'\)"
    $text | Should Match 'SetOwner\(\$admins\)'
    $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$null)
    $cmds = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() } | Sort-Object -Unique)
    # only its own two functions are called; nothing a module path could supply
    $cmds | Should Be @('Run', 'Say')
  }
  It "Setup.exe's own files are enough to start its window (Fable R2-1)" {
    $dir = Join-Path $env:TEMP "talos-pester-pack-$PID"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    try {
      foreach ($f in $TalosSetupPackFiles) {
        if ($f -eq 'talos-setup.zip') { [IO.File]::WriteAllText((Join-Path $dir $f), '') } else { Copy-Item (Join-Path $here "..\$f") $dir }
      }
      & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'setup-ui.ps1') -CheckOnly
      $LASTEXITCODE | Should Be 0
      # and without TalosWin.ps1 it would not start: the check is real
      Remove-Item (Join-Path $dir 'TalosWin.ps1')
      & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'setup-ui.ps1') -CheckOnly 2>$null
      $LASTEXITCODE | Should Not Be 0
    } finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
  }
  It 'build.ps1 packs from that one list' {
    $b = Get-Content -Raw (Join-Path $here '..\..\..\scripts\windows-setup\build.ps1') -ErrorAction SilentlyContinue
    if (-not $b) { return }
    $b | Should Match ([regex]::Escape('$files = @($TalosSetupPackFiles) + $TalosWslMsi.Name'))
    $b | Should Match ([regex]::Escape('foreach ($f in $TalosSetupPackFiles)'))
  }
  It 'refuses to do anything when it is not elevated (exit 2), before it makes a folder or reads the msi' {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin) { return }
    $before = @(Get-ChildItem -LiteralPath $env:ProgramData -Filter 'Talos-setup-*' -ErrorAction SilentlyContinue).Count
    & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') (Get-TalosEnableWslArguments 'C:\nothing\here.msi')
    $LASTEXITCODE | Should Be 2
    @(Get-ChildItem -LiteralPath $env:ProgramData -Filter 'Talos-setup-*' -ErrorAction SilentlyContinue).Count | Should Be $before
  }
}

Describe "root's side of the handover, run in a distro (R2-8)" {
  $d = if ($env:TALOS_PESTER_DISTRO) { $env:TALOS_PESTER_DISTRO } else { 'Ubuntu' }
  $have = (((& $WslExe --list --quiet) -join "`n") -replace "`0", '') -split "`n" | ForEach-Object { $_.Trim() }
  $none = $have -notcontains $d
  if ($none) { Write-Warning "no WSL distro named ${d}: the handover tests are skipped (set TALOS_PESTER_DISTRO)" }
  $dir = "/tmp/talos-pester-$PID"
  function RootRun([string[]]$a) {
    $ErrorActionPreference = 'Continue'
    $out = (& $WslExe -d $d -u root --exec @a 2>&1 | ForEach-Object { "$_" }) -join "`n"
    New-Object PSObject -Property @{ Code = $LASTEXITCODE; Out = $out }
  }
  function Hand($b64, $path, $sha) { RootRun @('/bin/sh', '-c', $RootInstallSh, 'sh', $b64, $path, $sha) }
  function There($path) { (RootRun @('/usr/bin/test', '-e', $path)).Code -eq 0 }

  It 'installs the file, root-owned and 755, when the hash matches' -Skip:$none {
    $p = ConvertTo-TalosRootPayload "#!/bin/sh`necho handed over`n"
    (Hand $p.Base64 "$dir/ok.sh" $p.Sha256).Code | Should Be 0
    (RootRun @('/usr/bin/stat', '-c', '%U:%G %a', "$dir/ok.sh")).Out | Should Be 'root:root 755'
    (RootRun @("$dir/ok.sh")).Out | Should Be 'handed over'
  }
  It 'installs nothing, and fails, when the hash is wrong' -Skip:$none {
    $p = ConvertTo-TalosRootPayload "#!/bin/sh`necho never`n"
    (Hand $p.Base64 "$dir/bad.sh" ('0' * 64)).Code | Should Not Be 0
    There "$dir/bad.sh" | Should Be $false
    There "$dir/bad.sh.tmp" | Should Be $false
  }
  It 'installs nothing for other bytes under the right hash (a file changed on the way)' -Skip:$none {
    $good = ConvertTo-TalosRootPayload "#!/bin/sh`necho the real one`n"
    $evil = ConvertTo-TalosRootPayload "#!/bin/sh`necho swapped`n"
    (Hand $evil.Base64 "$dir/swap.sh" $good.Sha256).Code | Should Not Be 0
    There "$dir/swap.sh" | Should Be $false
  }
  It 'leaves a file already there as it was when the new one fails its hash' -Skip:$none {
    $p = ConvertTo-TalosRootPayload "#!/bin/sh`necho first`n"
    (Hand $p.Base64 "$dir/keep.sh" $p.Sha256).Code | Should Be 0
    $q = ConvertTo-TalosRootPayload "#!/bin/sh`necho second`n"
    (Hand $q.Base64 "$dir/keep.sh" $p.Sha256).Code | Should Not Be 0
    (RootRun @("$dir/keep.sh")).Out | Should Be 'first'
  }
  if (-not $none) { RootRun @('/bin/rm', '-rf', $dir) | Out-Null }
}

Describe 'the file handed to root (R1-2)' {
  It 'is the LF bytes of the file, and the hash is theirs' {
    $p = ConvertTo-TalosRootPayload "#!/bin/sh`r`necho hi`r`n"
    $bytes = ConvertFrom-TalosRootPayload $p.Base64
    [Text.Encoding]::UTF8.GetString($bytes) | Should Be "#!/bin/sh`necho hi`n"
    # checked against Windows' own hashing of the same bytes, not the function's
    $f = Join-Path $env:TEMP "talos-pester-$PID.bin"
    [IO.File]::WriteAllBytes($f, $bytes)
    try { $p.Sha256 | Should Be (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() } finally { Remove-Item $f }
    $p.Sha256 | Should Match '^[0-9a-f]{64}$'
  }
  It 'goes through a root shell that has no quote marks for Windows PowerShell 5.1 to drop' {
    $RootInstallSh | Should Not Match "[`"']"
    $RootInstallSh | Should Match 'sha256sum'
    $RootInstallSh | Should Match '-o root -g root'
  }
  It 'fits on one Windows command line for the scripts install.ps1 hands over' {
    foreach ($f in 'talos-wsl.sh', 'setup-user.sh') {
      $text = [IO.File]::ReadAllText((Join-Path $here "..\distro\$f"))
      (ConvertTo-TalosRootPayload $text).Base64.Length | Should BeLessThan 30001
    }
  }
}

Describe 'a git URL, printed or handed over (R1-5)' {
  It 'keeps no login' {
    Remove-TalosUrlLogin 'https://alex:secret@example.com/a/b.git' | Should Be 'https://example.com/a/b.git'
    Remove-TalosUrlLogin 'https://x-access-token@example.com/a/b.git' | Should Be 'https://example.com/a/b.git'
    Remove-TalosUrlLogin 'https://example.com/a/b.git' | Should Be 'https://example.com/a/b.git'
    Remove-TalosUrlLogin 'git@example.com:a/b.git' | Should Be 'git@example.com:a/b.git'
  }
}

Describe 'the folder add-folder.ps1 shares (R1-4)' {
  $base = Join-Path $env:TEMP "talos-pester-$PID"
  $real = Join-Path $base 'real\projects\atlas'
  New-Item -ItemType Directory -Force -Path $real | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $base 'elsewhere\inner') | Out-Null
  # junctions need no administrator
  New-Item -ItemType Junction -Path (Join-Path $base 'via') -Target (Join-Path $base 'real') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $base 'real\projects\jump') -Target (Join-Path $base 'elsewhere') | Out-Null
  New-Item -ItemType File -Path (Join-Path $base 'a-file.txt') | Out-Null

  It 'is the real folder, as Windows resolves it' {
    $r = Resolve-TalosShareFolder $real
    $r | Should Be (Get-TalosFinalPath $real)
    $r | Should Match '\\real\\projects\\atlas$'
    $r | Should Match '^[A-Z]:\\'
    Resolve-TalosShareFolder "$real\" | Should Be $r
  }
  It 'is refused with a junction in a middle part of the path, not only the last' {
    { Resolve-TalosShareFolder (Join-Path $base 'via\projects\atlas') } | Should Throw 'link, junction'
  }
  It 'is refused when the folder itself is a junction' {
    { Resolve-TalosShareFolder (Join-Path $base 'real\projects\jump') } | Should Throw 'link, junction'
    { Resolve-TalosShareFolder (Join-Path $base 'real\projects\jump\inner') } | Should Throw 'link, junction'
  }
  It 'is refused for a file, a missing path and a network path' {
    { Resolve-TalosShareFolder (Join-Path $base 'a-file.txt') } | Should Throw 'not a folder'
    { Resolve-TalosShareFolder (Join-Path $base 'nothing-here') } | Should Throw 'not a folder'
    { Resolve-TalosShareFolder '\\localhost\C$\Windows' } | Should Throw
  }
  It 'resolves an 8.3 short name to the long one (where the drive keeps short names)' {
    $long = Join-Path $base 'A Long Folder Name'
    New-Item -ItemType Directory -Force -Path $long | Out-Null
    $short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($long).ShortPath
    if ($short -ne $long) { Resolve-TalosShareFolder $short | Should Be (Get-TalosFinalPath $long) }
    (Get-TalosFinalPath $long) | Should Match 'A Long Folder Name$'
  }

  # junctions first, so removing the tree never follows one
  Get-ChildItem -LiteralPath $base -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
    ForEach-Object { [IO.Directory]::Delete($_.FullName) }
  Remove-Item -LiteralPath $base -Recurse -Force
}

Describe "Open a thread's session (the tray's list of threads, and the window it opens)" {
  It 'keeps only thread ids, cleans the names, says not running unless the JSON says true, and doubles &' {
    $json = '{"threads":[' +
      '{"id":"trip","name":"Trip & Rome","running":true},' +
      '{"id":"plain","name":"","running":false},' +
      '{"id":"Bad","name":"upper case","running":true},' +
      '{"id":"x; rm -rf ~","name":"injection","running":true},' +
      '{"id":"../up","name":"path","running":true},' +
      '{"id":"ctl","name":"a\u0007b\u001b[31mc","running":"true"},' +
      '{"id":"long","name":"' + ('n' * 60) + '","running":true}]}'
    $l = @(ConvertFrom-TalosThreadList $json)
    ($l | ForEach-Object { $_.Id }) -join ',' | Should Be 'trip,plain,ctl,long'
    $l[0].Name | Should Be 'Trip && Rome'
    $l[0].Running | Should Be $true
    $l[1].Name | Should Be 'plain'
    $l[2].Name | Should Be 'ab[31mc'
    $l[2].Running | Should Be $false # the string "true" is not true
    $l[3].Name | Should Be (('n' * 37) + '...')
  }
  It 'reads nothing from what is not the list: not JSON, no threads, null, an empty answer' {
    foreach ($bad in 'not json', '{}', '{"threads":null}', '', '[1,2]', '{"threads":[1,"a",null]}') {
      @(ConvertFrom-TalosThreadList $bad).Count | Should Be 0
    }
  }
  It 'lists 30 threads at most' {
    $many = '{"threads":[' + ((1..40 | ForEach-Object { '{"id":"t' + $_ + '","name":"T","running":true}' }) -join ',') + ']}'
    @(ConvertFrom-TalosThreadList $many).Count | Should Be 30
  }
  It 'shows a running thread by its name, and one not running greyed with "(not running)"' {
    $on = Get-TalosThreadItem ([pscustomobject]@{ Id = 'trip'; Name = 'Trip'; Running = $true })
    $on.Enabled | Should Be $true
    $on.Text | Should Be 'Trip'
    $off = Get-TalosThreadItem ([pscustomobject]@{ Id = 'trip'; Name = 'Trip'; Running = $false })
    $off.Enabled | Should Be $false
    $off.Text | Should Be 'Trip (not running)'
  }
  It 'refuses an id that is not a thread id, and a distro name that is not one' {
    foreach ($bad in 'Trip', 'a b', 'x;y', '../x', '', "a`nb", ('a' * 33), '1abc') {
      { Get-TalosAttachArgs 'talos' $bad } | Should Throw
    }
    { Get-TalosAttachArgs 'tal os' 'trip' } | Should Throw
    { Get-TalosThreadListArgs 'a;b' } | Should Throw
  }
  It 'offers the menu item whenever the supervisor runs cut off from Windows, green or not: a thread can need her while Main does not' {
    foreach ($t in "isolated=yes`nsupervisor=active main=running launch=approved",
      "isolated=yes`nsupervisor=active main=waiting:trust launch=approved",
      "isolated=yes`nsupervisor=active main=signin launch=approved",
      "isolated=yes`nsupervisor=active main=running launch=pending",
      "isolated=yes`nsupervisor=reloading main=running launch=approved") {
      $i = Get-TalosSessionsItem (Get-TalosTrayView $t)
      $i.Enabled | Should Be $true
      $i.Text | Should Be "Open a thread's session..."
    }
    foreach ($t in "isolated=yes`nsupervisor=inactive main=unknown launch=approved", "isolated=yes`nsupervisor=activating main=unknown launch=approved",
      "isolated=no`nsupervisor=active main=running launch=approved", '') {
      $g = Get-TalosSessionsItem (Get-TalosTrayView $t)
      $g.Enabled | Should Be $false
      $g.Text | Should Be "Open a thread's session (once Talos is running)"
    }
  }
}

Describe "Open a thread's session: Fable's cases on 3b046779" {
  It 'refuses an id with a trailing newline (a $ in the pattern would let it through)' {
    { Get-TalosAttachArgs 'talos' "trip`n" } | Should Throw
    @(ConvertFrom-TalosThreadList '{"threads":[{"id":"trip\n","name":"T","running":true}]}').Count | Should Be 0
  }
  It 'never cuts a name in half a character' {
    $name = ('a' * 36) + [char]::ConvertFromUtf32(0x1F600) + ('b' * 10)
    $t = Get-TalosMenuText $name 'x'
    $t | Should Be (('a' * 36) + '...')
  }
  It 'runs the CLI as the supervisor unit does (bun, cli.ts, TALOS_APP_HOME), with a time limit for the list' {
    $cli = '/usr/bin/env TALOS_APP_HOME=/home/talos/.config/talos/app PATH=/home/talos/.bun/bin:/home/talos/.local/bin:/usr/local/bin:/usr/bin:/bin /home/talos/.bun/bin/bun --no-env-file /home/talos/talos-app/apps/bridge/src/cli.ts'
    (Get-TalosThreadListArgs 'talos') -join ' ' |
      Should Be "-d talos -u talos --cd ~ --exec /opt/talos-wsl/talos-wsl.sh run -- /usr/bin/timeout 10 $cli supervise threads --json"
    (Get-TalosAttachArgs 'talos' 'trip') -join ' ' |
      Should Be "-d talos -u talos --cd ~ --exec /opt/talos-wsl/talos-wsl.sh run -- $cli supervise attach trip --window"
  }
  It 'reads at most 64 KB of the answer' {
    $big = New-Object IO.StreamReader (New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes('x' * 200000)))
    (Read-TalosBounded $big).Length | Should Be 65536
    $small = New-Object IO.StreamReader (New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes('{"threads":[]}')))
    Read-TalosBounded $small | Should Be '{"threads":[]}'
  }
}

Describe "Check Talos (doctor --json in a window, and the one fix that matters)" {
  $row = { param($l, $n, $d) [pscustomobject]@{ Level = $l; Name = $n; Detail = $d } }
  It 'runs doctor --json as talos through the gate, for the agent folder Setup made, with a 90 s limit' {
    (Get-TalosDoctorArgs 'talos') -join ' ' |
      Should Be '-d talos -u talos --cd ~ --exec /opt/talos-wsl/talos-wsl.sh run -- /usr/bin/timeout 90 /usr/bin/env TALOS_APP_HOME=/home/talos/.config/talos/app PATH=/home/talos/.bun/bin:/home/talos/.local/bin:/usr/local/bin:/usr/bin:/bin /home/talos/.bun/bin/bun --no-env-file /home/talos/talos-app/apps/bridge/src/cli.ts doctor --json --agent-dir /home/talos/talos-agent'
    { Get-TalosDoctorArgs 'a b' } | Should Throw
  }
  It 'keeps only the three levels, cleans and cuts the text, and reads nothing from what is not the rows' {
    $json = '{"checks":[{"level":"ok","name":"bun version","detail":"1.4.4"},{"level":"FAIL","name":"relay URL","detail":"not\u0007 set"},' +
      '{"level":"fail","name":"wrong case","detail":"x"},{"level":"warn","name":"","detail":"no name"},{"level":"warn","name":"long","detail":"' + ('d' * 500) + '"}]}'
    $r = @(ConvertFrom-TalosDoctor $json)
    ($r | ForEach-Object { $_.Name }) -join ',' | Should Be 'bun version,relay URL,long'
    $r[1].Detail | Should Be 'not  set'
    $r[2].Detail.Length | Should Be 400
    foreach ($bad in 'not json', '{}', '{"checks":null}', '', '{"checks":[1,"a",null]}') { @(ConvertFrom-TalosDoctor $bad).Count | Should Be 0 }
  }
  It 'says each level in plain words' {
    (Get-TalosDoctorWord 'ok') | Should Be 'OK'
    (Get-TalosDoctorWord 'warn') | Should Be 'Check'
    (Get-TalosDoctorWord 'FAIL') | Should Be 'Problem'
  }
  It 'picks the one fix: the refused key first, then the link to the phone down; never the kit; none when healthy' {
    $key = & $row 'FAIL' 'relay accepts this Mac' 'The relay turned away this Mac''s key.'
    $kit = & $row 'warn' 'kit files' 'changed since install: Update the kit'
    $ok = & $row 'ok' 'bun version' '1.4.4'
    (Get-TalosDoctorFix @($ok, $kit, $key)).Kind | Should Be 'relay-key'
    (Get-TalosDoctorFix @($ok, $kit, $key)).Button | Should Be 'Copy the relay key'
    (Get-TalosDoctorFix @($ok, $kit)).Kind | Should Be 'none' # a changed kit is a warning to read, never a button
    foreach ($d in 'no status.json: no bridge has run here', 'the bridge is not running (pid 9 is gone)', 'status.json stopped updating 3 min ago') {
      (Get-TalosDoctorFix @($ok, (& $row 'warn' 'live bridge (status.json)' $d))).Kind | Should Be 'restart'
    }
    # live but not connected: it retries by itself, and a relay outage is not fixed by a restart
    (Get-TalosDoctorFix @($ok, (& $row 'warn' 'live bridge (status.json)' 'live (pid 9) but not connected to the relay'))).Kind | Should Be 'none'
    # an opening talos wrote further in does not count
    (Get-TalosDoctorFix @($ok, (& $row 'warn' 'live bridge (status.json)' 'x the bridge is not running'))).Kind | Should Be 'none'
    $h = Get-TalosDoctorFix @($ok)
    $h.Kind | Should Be 'none'
    $h.Text | Should Be 'Talos looks healthy.'
    (Get-TalosDoctorFix @($ok, (& $row 'FAIL' 'relay URL' 'not set'))).Text | Should Match '^Talos found 1 problem;'
  }
  It 'words the rows it knows itself, and reads "this Mac" as this PC in the rest' {
    (Get-TalosDoctorPlain (& $row 'FAIL' 'relay accepts this Mac' 'x')).Label | Should Be 'Server accepts this PC'
    (Get-TalosDoctorPlain (& $row 'FAIL' 'relay URL' 'TALOS_APP_RELAY_URL is not set')).Text | Should Be "Not set yet: run Talos Setup with your server's address."
    (Get-TalosDoctorPlain (& $row 'warn' 'live bridge (status.json)' 'no status.json: x')).Text | Should Be 'Not running.'
    (Get-TalosDoctorPlain (& $row 'warn' 'live bridge (status.json)' 'live (pid 9) but not connected')).Text | Should Match 'keeps trying by itself'
    (Get-TalosDoctorPlain (& $row 'ok' 'home dir mode' 'this Mac keeps it at 700')).Text | Should Be 'this PC keeps it at 700'
  }
  It 'knows doctor''s own row names and openings (apps/bridge/src): a rename there cannot drop a fix without this failing' {
    $root = Join-Path $here '..\..\..'
    $checks = Get-Content (Join-Path $root 'apps\bridge\src\doctor-checks.ts') -Raw
    $cli = Get-Content (Join-Path $root 'apps\bridge\src\cli-main.ts') -Raw
    foreach ($n in "'relay accepts this Mac'", "'relay /healthz'", "'relay URL'", "'live bridge (status.json)'") { $checks.Contains($n) | Should Be $true }
    (Get-Content (Join-Path $root 'apps\bridge\src\doctor-mods.ts') -Raw).Contains("'kit files'") | Should Be $true
    foreach ($p in $TalosBridgeDown) { $cli.Contains("text: ``$p") -or $cli.Contains("text: '$p") | Should Be $true }
  }
  It 'copies only a key line root gave, and not one that changed since Setup showed it' {
    $k = 'BRIDGE_PUBKEY=' + ('A' * 43)
    (Get-TalosRelayKeyLine "$k`n").Line | Should Be $k
    (Get-TalosRelayKeyLine "$k`n").Changed | Should Be $false
    (Get-TalosRelayKeyLine "$k`nchanged`n").Changed | Should Be $true
    foreach ($bad in 'BRIDGE_PUBKEY=short', "BRIDGE_PUBKEY=$('A' * 43)x", "x`n$k", '', 'no bridge key yet') { (Get-TalosRelayKeyLine $bad).Line | Should Be $null }
  }
}

Describe "Check Talos: the window's order" {
  It 'lists problems first, then what to check, then what is fine, each in doctor''s order' {
    $r = @('ok a', 'warn b', 'FAIL c', 'ok d', 'FAIL e') | ForEach-Object { $l, $n = $_ -split ' '; [pscustomobject]@{ Level = $l; Name = $n; Detail = '' } }
    (@(Sort-TalosDoctorRows $r) | ForEach-Object { $_.Name }) -join ',' | Should Be 'c,e,b,a,d'
  }
}

Describe "Check Talos: WSL can't look the server up while Windows is online" {
  $row = { param($l, $n, $d) [pscustomobject]@{ Level = $l; Name = $n; Detail = $d } }
  It 'finds the host in doctor''s lookup failure, and only in a lookup failure' {
    (Get-TalosLookupFailHost @((& $row 'FAIL' 'relay /healthz' 'getaddrinfo ENOTFOUND relay.example.com'))) | Should Be 'relay.example.com'
    (Get-TalosLookupFailHost @((& $row 'FAIL' 'relay /healthz' 'getaddrinfo EAI_AGAIN my-relay.up.railway.app'))) | Should Be 'my-relay.up.railway.app'
    foreach ($d in 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?', 'healthz -> 502', 'ENOTFOUND', 'ENOTFOUND ../x', 'ENOTFOUND a b') {
      (Get-TalosLookupFailHost @((& $row 'FAIL' 'relay /healthz' $d))) | Should Be $null
    }
    (Get-TalosLookupFailHost @((& $row 'ok' 'relay /healthz' 'ENOTFOUND relay.example.com'))) | Should Be $null
  }
  It 'says what it is only when Windows itself looked the host up, and promises nothing it has not seen work' {
    $rows = @((& $row 'FAIL' 'relay /healthz' 'getaddrinfo ENOTFOUND relay.example.com'), (& $row 'warn' 'live bridge (status.json)' 'live (pid 9) but not connected'))
    $f = Get-TalosDoctorFix $rows $true
    $f.Kind | Should Be 'none'
    $f.Text | Should Be "This PC is online, but Talos's Linux part can't look up your server's address (a Windows networking problem). If you use a VPN, try turning it off. Restarting the PC may fix it; if it doesn't, tell whoever set up Talos for you."
    (Get-TalosDoctorFix $rows $false).Text | Should Match '^Talos found 1 problem;'
    (Get-TalosDoctorPlain $rows[0]).Text | Should Be "No: Talos can't look up your server's address."
    (Get-TalosDoctorPlain (& $row 'FAIL' 'relay /healthz' 'ECONNREFUSED')).Text | Should Be "No: Talos cannot reach your server. Check this PC's internet connection."
  }
  It 'a refused key still comes first' {
    $rows = @((& $row 'FAIL' 'relay accepts this Mac' 'x'), (& $row 'FAIL' 'relay /healthz' 'getaddrinfo ENOTFOUND relay.example.com'))
    (Get-TalosDoctorFix $rows $true).Kind | Should Be 'relay-key'
  }
}
