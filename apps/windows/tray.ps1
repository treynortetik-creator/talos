<#
.SYNOPSIS
  Talos in the notification area (docs/WINDOWS-PLAN.md section 8, step 2): the keep-alive, and Talos's status at a glance.

.DESCRIPTION
  It is the keep-alive (keepalive.ps1, in a window you can see): it holds the Talos distro with one idle process only while
  the distro is cut off from Windows (`talos-wsl.sh hold`), starts it again if WSL stops it (retries at most 30 s apart),
  and tells you, once, when the hold is refused. It shares keepalive.ps1's single-instance lock and log, so the two never
  both run. install.ps1 registers it at logon (`-NoTray` keeps the hidden keepalive.ps1 instead).

  Every 30 s it asks the distro (`talos-wsl.sh status`) and shows green (running), amber (starting) or red (stopped, or
  not cut off from Windows), with the same in words in its menu. The menu also has "Open the log folder" and "Quit". Quit
  says what it means: Talos stops once Windows lets the distro go.
#>
[CmdletBinding()]
param([string]$Distro = 'talos')
$ErrorActionPreference = 'Continue'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'TalosWin.ps1')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$dir = Join-Path $env:LOCALAPPDATA 'Talos'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "keepalive-$Distro.log"
$tool = '/opt/talos-wsl/talos-wsl.sh'

function Log([string]$m) {
  # a small log, the keep-alive's: the last 200 lines
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $m
  # never throws (found on Titan, 2026-11-18: a log held open by another process killed the tray from a timer tick)
  Write-TalosLogLine $log $line
}

# The last defence (found on Titan, 2026-11-18): an exception that escapes a timer tick or a click handler is logged and the
# tray carries on, instead of the .NET "unhandled exception" dialog ending it. It must be set before the first form or
# NotifyIcon exists (the icons above are bitmaps only), so it stays above the NotifyIcon made below.
# The same error is logged at most once a minute (a timer that fails every 200 ms, or two that fail in turn, must not fill
# the log); after a minute it is logged again, so the same error hours later is not missed.
$script:caught = @{}
function Write-TrayError([string]$Said) {
  try {
    $now = Get-Date
    if ($script:caught.Count -gt 50) {
      foreach ($k in @($script:caught.Keys)) { if (($now - $script:caught[$k]).TotalSeconds -ge 60) { $script:caught.Remove($k) } }
    }
    if ($script:caught.ContainsKey($Said) -and ($now - $script:caught[$Said]).TotalSeconds -lt 60) { return }
    $script:caught[$Said] = $now
    Log $Said
  } catch { }
}
try {
  [Windows.Forms.Application]::SetUnhandledExceptionMode([Windows.Forms.UnhandledExceptionMode]::CatchException)
  [Windows.Forms.Application]::add_ThreadException({
      param($sender, $e)
      try { Write-TrayError "tray: an error in a handler was caught; the tray carries on ($($e.Exception.GetType().Name): $($e.Exception.Message))" } catch { }
    })
} catch { Log "tray: could not set the unhandled-exception guard ($($_.Exception.Message))" }

# One step of a handler, run so that a failure is logged (once a minute at most) and never leaves the handler: the timers and menu
# items below call their steps through it, one by one, so a step that keeps failing cannot stop the others.
function Invoke-TrayStep([string]$What, [scriptblock]$Body) {
  try { & $Body } catch {
    try { Write-TrayError "tray: $What failed ($($_.Exception.GetType().Name): $($_.Exception.Message))" } catch { }
  }
}

# the same lock as keepalive.ps1: one of the two per distro
# Waits up to 10 s for it (Fable R1-4 on edb035b3): install.ps1 stops the old one and starts this one, and the old one can
# still be letting go. A lock left by one that died is taken over. Still held after that: logged, and exit 1, so the logon
# task's restart (every minute) tries again rather than leaving no tray and no keep-alive until the next sign-in.
$mutex = New-Object Threading.Mutex($false, "Local\TalosKeepAlive-$Distro")
$got = $false
try { $got = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $got = $true }
if (-not $got) {
  Log "another tray or keep-alive for $Distro still holds the lock after 10 s; this one stops (exit 1: the task tries again)"
  exit 1
}
Stop-TalosStrayHolds $Distro

# ---- the icon: a dot in one of four colours ------------------------------------------------------------------------------
function Dot([Drawing.Color]$c) {
  $b = New-Object Drawing.Bitmap 16, 16
  $g = [Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object Drawing.SolidBrush $c), 1, 1, 14, 14)
  $g.DrawEllipse((New-Object Drawing.Pen ([Drawing.Color]::FromArgb(90, 0, 0, 0))), 1, 1, 13, 13)
  $g.Dispose()
  [Drawing.Icon]::FromHandle($b.GetHicon())
}
$icons = @{
  green = Dot ([Drawing.Color]::FromArgb(46, 160, 67))
  amber = Dot ([Drawing.Color]::FromArgb(219, 160, 18))
  red   = Dot ([Drawing.Color]::FromArgb(207, 34, 46))
  grey  = Dot ([Drawing.Color]::FromArgb(140, 140, 140))
}

$ni = New-Object Windows.Forms.NotifyIcon
$ni.Icon = $icons.grey
$ni.Text = 'Talos: starting'
$menu = New-Object Windows.Forms.ContextMenuStrip
$lineTalos = $menu.Items.Add('Talos: starting')
$lineWindows = $menu.Items.Add('Cut off from Windows: not checked yet')
$lineHold = $menu.Items.Add('Keep-alive: starting')
foreach ($l in $lineTalos, $lineWindows, $lineHold) { $l.Enabled = $false }
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$signIn = $menu.Items.Add('Sign in to Claude...')
# shown only while root says a launch waits for the owner's approval (status launch=pending; Fable R3-5 on a44344c2)
$approve = $menu.Items.Add('Approve this change...')
$approve.Visible = $false
$pair = $menu.Items.Add('Pair a phone...')
# greyed until the first status answer says the dot is green (Show-Status, Get-TalosPairItem)
$pair.Enabled = $false
# a window onto one thread's session, to answer what it asks (talos-app supervise attach --window); its list is read each time
# it opens (Start-SessionsRead), greyed until the supervisor runs cut off from Windows (Get-TalosSessionsItem)
$sessions = New-Object Windows.Forms.ToolStripMenuItem "Open a thread's session (once Talos is running)"
[void]$menu.Items.Add($sessions)
$sessions.Enabled = $false
[void]$sessions.DropDownItems.Add('Looking for threads...') # a placeholder, so the arrow shows
# "Start Talos" while the supervisor is down, "Restart Talos..." while it runs (Show-Status sets which)
$startItem = $menu.Items.Add('Start Talos')
$restoreItem = $menu.Items.Add('Restore last good setup...')
# root's copy of the kit talos built (talos-wsl.sh kit-update): what a start refusal names ("choose Update the kit")
$kitItem = $menu.Items.Add('Update the kit')
# talos-app doctor's checks in a window, in plain words, with the one fix that matters as a button (Show-Check)
$checkItem = $menu.Items.Add('Check Talos...')
$openLog = $menu.Items.Add('Open the log folder')
$quit = $menu.Items.Add('Quit')
$ni.ContextMenuStrip = $menu
$ni.Visible = $true

# ---- the keep-alive: one `hold` at a time, started again with a backoff --------------------------------------------------
$state = @{ hold = $null; err = $null; started = $null; next = Get-Date; wait = 5; told = $false; quitting = $false; shown = ''; lastTick = $null; iconColour = 'grey' }

function Start-Hold {
  $state.err = Join-Path $env:TEMP "talos-hold-$Distro-$PID.txt"
  Remove-Item -LiteralPath $state.err -ErrorAction SilentlyContinue
  # a start that fails is logged and backed off like a hold that ended (Fable R1-5 on edb035b3), never shown as holding
  try {
    $state.hold = Start-Process -FilePath $WslExe -ArgumentList @('-d', $Distro, '-u', 'root', '--exec', $tool, 'hold') `
      -WindowStyle Hidden -PassThru -RedirectStandardError $state.err -ErrorAction Stop
  } catch {
    $state.hold = $null
    Log "could not start the hold for $Distro ($($_.Exception.Message)); again in $($state.wait)s"
    $lineHold.Text = "Keep-alive: could not start; again in $($state.wait) s"
    $state.next = (Get-Date).AddSeconds($state.wait)
    $state.wait = [Math]::Min($state.wait * 2, 30)
    return
  }
  # its handle read now, or Windows PowerShell gives no exit code once it has ended (the log said "exit ")
  $null = $state.hold.Handle
  $state.started = Get-Date
  $lineHold.Text = 'Keep-alive: holding the distro'
}

# A tick far later than 2 s after the last one: Windows was asleep, and Talos with it. Said once, with the times, so she
# knows why her phone went quiet (a laptop with its lid closed, most often).
function Watch-Sleep {
  $now = Get-Date
  # lastTick moves first: a balloon that throws must not make every tick say "asleep" again
  $last = $state.lastTick
  $state.lastTick = $now
  if ($last -and ($now - $last).TotalSeconds -gt 90) {
    $from = $last.ToString('HH:mm'); $to = $now.ToString('HH:mm')
    Log "this PC was asleep from $($last.ToString('s')) to $($now.ToString('s')); Talos was offline"
    $lineSleep.Text = "Asleep: Talos was offline from $from to $to"
    $lineSleep.Visible = $true
    $ni.BalloonTipTitle = 'This PC was asleep'
    $ni.BalloonTipText = "Talos was offline from $from to $to, so your phone could not reach it. It is back now."
    $ni.BalloonTipIcon = [Windows.Forms.ToolTipIcon]::Info
    $ni.ShowBalloonTip(10000)
  }
}

function Watch-Hold {
  if ($state.quitting) { return }
  if ($null -eq $state.hold) {
    if ((Get-Date) -ge $state.next) { Start-Hold }
    return
  }
  if (-not $state.hold.HasExited) { return }
  # whatever fails below, the finally lets go of the dead hold, so the next tick starts a new one (not "holding" for ever)
  $ran = 0
  $refused = @()
  try {
  $ran = [int]((Get-Date) - $state.started).TotalSeconds
  $said = @()
  if (Test-Path -LiteralPath $state.err) { $said = @(Get-Content -LiteralPath $state.err | ForEach-Object { "$_" -replace "`0", '' }) }
  $refused = @($said | Where-Object { $_ -match '^refused: ' } | ForEach-Object { $_ -replace '^refused: (talos-wsl: )?', '' })
  if ($refused.Count -gt 0) {
    Log "the $Distro distro is not cut off from Windows, so it is not held (Talos does not run): $($refused -join '; ')"
    $lineHold.Text = "Keep-alive: refused: $($refused[0])"
    if (-not $state.told) {
      $ni.BalloonTipTitle = 'Talos is stopped'
      $ni.BalloonTipText = "Its WSL distro ($Distro) is not cut off from Windows: $($refused[0]). Restart it: wsl --terminate $Distro"
      $ni.BalloonTipIcon = [Windows.Forms.ToolTipIcon]::Warning
      $ni.ShowBalloonTip(10000)
      $state.told = $true
    }
  } else {
    Log "the $Distro distro let go after ${ran}s (exit $($state.hold.ExitCode)); starting it again in $($state.wait)s"
    $lineHold.Text = "Keep-alive: the distro let go; again in $($state.wait) s"
  }
  } finally {
    $state.hold = $null
    $state.next = (Get-Date).AddSeconds($state.wait)
    # at most 30 s between tries, back to 5 s once it held; a hold that lasted and ended without a refusal ends a refusal
    # streak, so the next refusal is told again
    if ($ran -lt 60) { $state.wait = [Math]::Min($state.wait * 2, 30) } else { $state.wait = 5; if ($refused.Count -eq 0) { $state.told = $false } }
    if ($lineHold.Text -eq 'Keep-alive: holding the distro') { $lineHold.Text = "Keep-alive: starting it again in $($state.wait) s" }
  }
}

# ---- the status, every 30 s ----------------------------------------------------------------------------------------------
# One short `wsl --exec ... status`, in a runspace of its own (Fable R1-3 on edb035b3): the menu and Quit never wait on it.
# It gets 8 s; then it is ended, and whatever it said by then still counts (`isolated=` comes first, at once, so a stalled
# supervisor query cannot hide a broken isolation). The UI only reads the finished result (Receive-Status, every 2 s).
$poll = @{ ps = $null; handle = $null }
$pollScript = {
  param([string]$Exe, [string]$Arguments)
  $p = New-Object Diagnostics.Process
  $p.StartInfo.FileName = $Exe
  $p.StartInfo.Arguments = $Arguments
  $p.StartInfo.UseShellExecute = $false
  $p.StartInfo.RedirectStandardOutput = $true
  $p.StartInfo.CreateNoWindow = $true
  try {
    [void]$p.Start()
    # line by line (Fable R2-7 on 3bd474e0): each line is kept as it comes, so the `isolated=` line written at once
    # survives a kill at 8 s whatever happens to the rest
    $lines = New-Object Collections.Generic.List[string]
    $next = $p.StandardOutput.ReadLineAsync()
    $until = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $until) {
      if (-not $next.Wait(200)) { continue }
      if ($null -eq $next.Result) { break }
      $lines.Add($next.Result)
      $next = $p.StandardOutput.ReadLineAsync()
    }
    # the whole tree, never the top process alone (the fleet rule, 2026-11-12)
    if (-not $p.HasExited) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /T /F /PID $p.Id 2>&1 | Out-Null }
    return ($lines -join "`n")
  } catch {
    return ''
  }
}
function Start-Status {
  if ($state.quitting -or $poll.ps) { return }
  $ps = [PowerShell]::Create()
  [void]$ps.AddScript($pollScript).AddArgument($WslExe).AddArgument("-d $Distro -u root --exec $tool status")
  $poll.handle = $ps.BeginInvoke()
  $poll.ps = $ps
}
function Receive-Status {
  if (-not $poll.ps -or -not $poll.handle.IsCompleted) { return }
  $text = ''
  try { $text = "$(@($poll.ps.EndInvoke($poll.handle)) | Select-Object -Last 1)" } catch { }
  $poll.ps.Dispose()
  $poll.ps = $null
  if (-not $state.quitting) { Show-Status $text }
}

# These write to the UI only when the value differs from what is showing: every icon write redraws the taskbar (a green dot
# must not blink every 30 s), and a menu item switched off and on again can close a list that is open under it.
function Set-TrayIcon([string]$Colour) {
  if ($state.iconColour -ne $Colour) { $ni.Icon = $icons[$Colour]; $state.iconColour = $Colour }
}
function Set-TrayText($Item, [string]$Text) { if ($Item.Text -ne $Text) { $Item.Text = $Text } }
function Set-TrayEnabled($Item, [bool]$On) { if ($Item.Enabled -ne $On) { $Item.Enabled = $On } }

function Show-Status([string]$text) {
  try {
    # the whole view is worked out first, with no write to the UI, so a failure here changes nothing on screen
    $v = Get-TalosTrayView $text
    $pairItem = Get-TalosPairItem $v
    $sessionsItem = Get-TalosSessionsItem $v
    # signed out, or the token expired or was revoked: the supervisor says main=signin, and the menu offers the sign-in
    $signInText = if ($v.Main -eq 'signin') { 'Sign in to Claude...' } else { 'Sign in to Claude again...' }
    $startText = if ($v.Supervisor -in 'active', 'activating', 'reloading') { 'Restart Talos...' } else { 'Start Talos' }
    $windowsText = switch ($v.Isolated) {
      'yes' { 'Cut off from Windows: yes' }
      'no' { 'Cut off from Windows: NO (Talos is being stopped)' }
      default { 'Cut off from Windows: not known (the distro did not answer)' }
    }
    $one = (($text -replace "`0", '') -split "`r?`n" | Where-Object { $_.Trim() }) -join ' '
    $tip = "Talos: $($v.Words)"
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $colour = "$($v.Colour)"
    if (-not $icons.ContainsKey($colour)) { throw "no icon for the colour '$colour'" }

    # then applied once. from root's own check (status launch=pending), never from talos's files (Fable R3-5 on a44344c2)
    Set-TrayText $signIn $signInText
    $approve.Visible = ($v.Launch -eq 'pending')
    # pairing only while the dot is green: a phone paired with no live bridge is left half-enrolled (Pantheon, 2026-11-12)
    Set-TrayText $pair $pairItem.Text; Set-TrayEnabled $pair ([bool]$pairItem.Enabled)
    Set-TrayText $sessions $sessionsItem.Text; Set-TrayEnabled $sessions ([bool]$sessionsItem.Enabled)
    Set-TrayText $startItem $startText
    Set-TrayText $lineWindows $windowsText
    Set-TrayText $lineTalos "Talos: $($v.Words)"
    # each change of what it shows goes in the log too, so "what did the tray say, and when" has an answer
    if ("$colour $($v.Words)" -ne $state.shown) {
      Log "tray: $colour, Talos $($v.Words) ($(if ($one) { $one } else { 'no answer' }))"
      $state.shown = "$colour $($v.Words)"
    }
    if ($ni.Text -ne $tip) { $ni.Text = $tip }
    Set-TrayIcon $colour
  } catch {
    # a view that could not be worked out or shown is "not known", never the green and "yes" of an older status
    try {
      Set-TrayIcon 'grey'
      Set-TrayText $lineWindows 'Cut off from Windows: not known (the distro did not answer)'
      Set-TrayEnabled $pair $false; Set-TrayEnabled $sessions $false
    } catch { }
    throw
  }
}

# ---- keeping the PC awake on AC power (Setup's checkbox, on by default) -----------------------------------------------------
# Not a power setting: while the tray runs on AC power it asks Windows not to sleep for idleness (SetThreadExecutionState,
# what a media player does), and stops asking on battery or when the choice is off. Nothing is changed, so nothing is left
# to put back: quitting the tray or uninstalling ends it. A closed lid, or the user choosing Sleep, still sleeps.
if (-not ('TalosTray.Power' -as [type])) {
  Add-Type -Namespace TalosTray -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
}
$settingsFile = Join-Path $dir 'settings.json'
function Update-StayAwake {
  $want = $false
  try { $want = [bool]((Get-Content -LiteralPath $settingsFile -Raw -ErrorAction Stop | ConvertFrom-Json).stayAwakeOnAc) } catch { }
  $onAc = [Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -eq [Windows.Forms.PowerLineStatus]::Online
  # ES_CONTINUOUS (0x80000000), with ES_SYSTEM_REQUIRED (0x1) while it should stay awake; the timers tick on this one
  # thread, so the request lives exactly as long as the tray does
  if ($want -and $onAc) { [void][TalosTray.Power]::SetThreadExecutionState([uint32]2147483649); $lineAwake.Text = 'Keeping this PC awake: yes (plugged in)' }
  else {
    [void][TalosTray.Power]::SetThreadExecutionState([uint32]2147483648)
    $lineAwake.Text = if ($want) { 'Keeping this PC awake: not on battery' } else { 'Keeping this PC awake: off' }
  }
}
$lineAwake = New-Object Windows.Forms.ToolStripMenuItem 'Keeping this PC awake: checking'
$lineAwake.Enabled = $false
$menu.Items.Insert(3, $lineAwake)
$lineSleep = New-Object Windows.Forms.ToolStripMenuItem 'Asleep'
$lineSleep.Enabled = $false
$lineSleep.Visible = $false
$menu.Items.Insert(4, $lineSleep)

# a process and everything it started, stopped together (the fleet rule, 2026-11-12: a group or tree, never the top one)
function Stop-TalosTree([int]$ProcessId) {
  & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /T /F /PID $ProcessId 2>&1 | Out-Null
}

# ---- "Sign in to Claude" ---------------------------------------------------------------------------------------------------
# A small window over `talos-wsl.sh signin` (signin.py in the distro). The distro sends the sign-in link; she opens it, signs
# in with her own Claude account, and pastes the code the page shows. The token itself never reaches Windows: the distro
# writes it, and this window only hears "signed_in" (Pantheon's rules, 2026-11-12). Nothing from the helper is logged but
# the event names; the code box is cleared as soon as the code is sent.
function Show-SignIn {
  $f = New-Object Windows.Forms.Form
  $f.Text = 'Sign in to Claude'
  $f.ClientSize = New-Object Drawing.Size(460, 250)
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
  $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $f.Font = New-Object Drawing.Font('Segoe UI', 10)
  $msg = New-Object Windows.Forms.Label
  $msg.SetBounds(16, 14, 428, 96)
  $msg.Text = 'Getting a sign-in link from Claude...'
  $f.Controls.Add($msg)
  $open = New-Object Windows.Forms.Button
  $open.Text = 'Open the sign-in page'; $open.SetBounds(16, 112, 200, 32); $open.Enabled = $false
  $f.Controls.Add($open)
  $box = New-Object Windows.Forms.TextBox
  $box.SetBounds(16, 160, 300, 28); $box.Enabled = $false
  $f.Controls.Add($box)
  $send = New-Object Windows.Forms.Button
  $send.Text = 'Sign in'; $send.SetBounds(326, 158, 118, 32); $send.Enabled = $false
  $f.Controls.Add($send)
  $f.AcceptButton = $send
  $close = New-Object Windows.Forms.Button
  $close.Text = 'Cancel'; $close.SetBounds(326, 206, 118, 32)
  $f.Controls.Add($close)

  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $WslExe
  $psi.Arguments = "-d $Distro -u root --exec $tool signin"
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $s = @{ p = $null; read = $null; url = $null; done = $false }
  try { $s.p = [Diagnostics.Process]::Start($psi) } catch { $msg.Text = "Talos could not start the sign-in: $($_.Exception.Message)"; [void]$f.ShowDialog(); return }
  [void]$s.p.StandardError.ReadToEndAsync()
  $s.read = $s.p.StandardOutput.ReadLineAsync()
  Log 'sign-in: started'

  $t = New-Object Windows.Forms.Timer
  $t.Interval = 200
  $t.add_Tick({
      while ($s.read -and $s.read.IsCompleted) {
        $raw = $s.read.Result
        if ($null -eq $raw) { $s.read = $null; break }
        $s.read = $s.p.StandardOutput.ReadLineAsync()
        $raw = ($raw -replace "`0", '').Trim()
        if (-not $raw.StartsWith('{')) { continue }
        try { $e = $raw | ConvertFrom-Json } catch { continue }
        # which failure, by signin.py's fixed id only (never a code, a link or its sentence; Pantheon, 2026-11-18)
        Log "sign-in: $(Format-TalosSignInLogLine $e)"
        switch ("$($e.event)") {
          'url' {
            # only a link to Claude's own sign-in pages is ever opened
            if ("$($e.url)" -cmatch '^https://(claude\.ai|claude\.com|[a-z0-9.-]*\.anthropic\.com)/[!#-&(-;=?-~]+$') {
              $s.url = "$($e.url)"
              $open.Enabled = $true
              $msg.Text = "1. Click Open the sign-in page, and sign in with your Claude account.`r`n2. Copy the code the page shows, paste it below, and click Sign in."
            }
          }
          'code' { $box.Enabled = $true; $send.Enabled = $true; [void]$box.Focus() }
          'signed_in' {
            $s.done = $true
            $msg.Text = 'You are signed in. Talos starts using Claude in a moment.'
            $open.Enabled = $false; $box.Enabled = $false; $send.Enabled = $false; $close.Text = 'Close'
            Start-Status
          }
          'error' {
            $msg.Text = "Not signed in: $($e.message)`r`n`r`nClose this and choose Sign in to Claude again: you get a new link and a new code."
            $open.Enabled = $false; $box.Enabled = $false; $send.Enabled = $false; $close.Text = 'Close'
          }
        }
      }
      if (-not $s.read -and -not $s.done -and $close.Text -eq 'Cancel') {
        $t.Stop()
        $msg.Text = 'The sign-in stopped before it finished. Close this and try again.'
        $box.Enabled = $false; $send.Enabled = $false; $close.Text = 'Close'
      }
    })
  $open.add_Click({ if ($s.url) { Start-Process -FilePath $s.url } })
  $send.add_Click({
      $code = $box.Text.Trim()
      $box.Text = ''
      if (-not $code) { return }
      $box.Enabled = $false; $send.Enabled = $false
      $msg.Text = 'Signing in...'
      try { $s.p.StandardInput.WriteLine($code); $s.p.StandardInput.Flush() } catch { }
      $code = $null
    })
  $close.add_Click({ $f.Close() })
  $f.add_FormClosed({
      $t.Stop()
      $box.Text = ''
      if ($s.p -and -not $s.p.HasExited) { Stop-TalosTree $s.p.Id }
      if (-not $s.done) { Log 'sign-in: closed before it finished' }
    })
  $t.Start()
  [void]$f.ShowDialog()
}
$signIn.add_Click({ Invoke-TrayStep 'the sign-in window' { Show-SignIn } })

# ---- "Approve this change" (Fable R2-4 on c9a60023) ----------------------------------------------------------------------
# Root works out how Talos starts Claude (launch-check) and this shows it, old -> new; a click approves exactly what was shown
# (launch-approve <that fingerprint>), and root refuses if it changed in between. Nothing here decides anything itself.
# root's answer from its stdout ONLY (Fable R4-1 on f1699c11): stderr is never mixed in, and never parsed
function Invoke-TalosRoot([string[]]$a) {
  $ErrorActionPreference = 'Continue'
  $out = ((& $WslExe @(@('-d', $Distro, '-u', 'root', '--exec', $tool) + $a) 2>$null | ForEach-Object { "$_" }) -join "`n") -replace "`0", ''
  New-Object PSObject -Property @{ Code = $LASTEXITCODE; Text = $out }
}
function Show-Approve {
  $f = New-Object Windows.Forms.Form
  $f.Text = 'Approve this change'
  $f.ClientSize = New-Object Drawing.Size(560, 330)
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
  $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $f.Font = New-Object Drawing.Font('Segoe UI', 10)
  $box = New-Object Windows.Forms.TextBox
  $box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'; $box.WordWrap = $true
  $box.SetBounds(16, 14, 528, 250)
  $f.Controls.Add($box)
  $ok = New-Object Windows.Forms.Button
  $ok.Text = 'Approve this change'; $ok.SetBounds(236, 280, 180, 34)
  $f.Controls.Add($ok)
  $no = New-Object Windows.Forms.Button
  $no.Text = 'Not now'; $no.SetBounds(426, 280, 118, 34)
  $f.Controls.Add($no)
  $f.CancelButton = $no
  $s = @{ fp = '' }
  $load = {
    $view = Format-TalosLaunchChange (Invoke-TalosRoot @('launch-check')).Text
    $box.Text = $view.Text
    $s.fp = if ($view.Ok -and $view.CanApprove) { $view.Fingerprint } else { '' }
    $ok.Enabled = [bool]$s.fp
  }
  & $load
  $ok.add_Click({
      if (-not $s.fp) { return }
      $r = Invoke-TalosRoot @('launch-approve', $s.fp)
      if ($r.Code -eq 0) {
        Log "launch approved by the owner ($($s.fp.Substring(0, 12)))"
        $box.Text = 'Approved. Talos starts Claude in a moment.'
        $ok.Enabled = $false; $no.Text = 'Close'
        Start-Status
      } else {
        Log 'launch approval refused: it changed again'
        & $load
        $box.Text = "It changed again while this window was open. Here is how it is now:`r`n`r`n" + $box.Text
      }
    })
  $no.add_Click({ $f.Close() })
  [void]$f.ShowDialog()
}
$approve.add_Click({ Invoke-TrayStep 'the approval window' { Show-Approve } })

# ---- "Pair a phone" ------------------------------------------------------------------------------------------------------
# A window over `talos-wsl.sh pair` (pair.py in the distro, running `talos-app enroll --json` in its own pty). It shows the
# link and its QR code; once the phone has used it, the four words, with Yes and No that only work after a moment (a click
# already on its way is not an answer; enroll also refuses a "y" within 500 ms). Only the event names are logged.
function Show-Pair {
  $f = New-Object Windows.Forms.Form
  $f.Text = 'Pair a phone'
  $f.ClientSize = New-Object Drawing.Size(480, 470)
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
  $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $f.Font = New-Object Drawing.Font('Segoe UI', 10)
  $msg = New-Object Windows.Forms.Label
  $msg.SetBounds(16, 12, 448, 64); $msg.Text = 'Starting the pairing...'
  $f.Controls.Add($msg)
  $pic = New-Object Windows.Forms.PictureBox
  $pic.SetBounds(130, 80, 220, 220); $pic.Visible = $false
  $f.Controls.Add($pic)
  $link = New-Object Windows.Forms.TextBox
  $link.ReadOnly = $true; $link.SetBounds(16, 310, 448, 26); $link.Visible = $false
  $f.Controls.Add($link)
  $words = New-Object Windows.Forms.Label
  $words.Font = New-Object Drawing.Font('Segoe UI', 18, [Drawing.FontStyle]::Bold)
  $words.TextAlign = 'MiddleCenter'; $words.SetBounds(16, 120, 448, 80); $words.Visible = $false
  $f.Controls.Add($words)
  $device = New-Object Windows.Forms.Label
  # the phone's own name: '&' is just a character here, never a keyboard-shortcut marker
  $device.UseMnemonic = $false
  $device.SetBounds(16, 205, 448, 24); $device.TextAlign = 'MiddleCenter'; $device.Visible = $false
  $f.Controls.Add($device)
  $yes = New-Object Windows.Forms.Button
  $yes.Text = 'Yes, they match'; $yes.SetBounds(90, 250, 150, 36); $yes.Visible = $false; $yes.Enabled = $false
  $f.Controls.Add($yes)
  $no = New-Object Windows.Forms.Button
  $no.Text = 'No'; $no.SetBounds(250, 250, 140, 36); $no.Visible = $false; $no.Enabled = $false
  $f.Controls.Add($no)
  $close = New-Object Windows.Forms.Button
  $close.Text = 'Cancel'; $close.SetBounds(346, 420, 118, 34)
  $f.Controls.Add($close)

  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $WslExe
  $psi.Arguments = "-d $Distro -u root --exec $tool pair"
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $s = @{ p = $null; read = $null; done = $false }
  $q = New-TalosPairState
  try { $s.p = [Diagnostics.Process]::Start($psi) } catch { $msg.Text = "Talos could not start the pairing: $($_.Exception.Message)"; [void]$f.ShowDialog(); return }
  [void]$s.p.StandardError.ReadToEndAsync()
  $s.read = $s.p.StandardOutput.ReadLineAsync()
  Log 'pair: started'

  $send = {
    param([string]$line)
    if (-not $line) { return }
    $yes.Enabled = $false; $no.Enabled = $false
    try { $s.p.StandardInput.WriteLine($line); $s.p.StandardInput.Flush() } catch { }
    Log "pair: answered $line"
  }
  $t = New-Object Windows.Forms.Timer
  $t.Interval = 150
  $t.add_Tick({
      # Yes and No work only 1.5 s after the words appear
      $armed = Test-TalosPairArmed $q (Get-Date)
      $yes.Enabled = $armed; $no.Enabled = $armed
      while ($s.read -and $s.read.IsCompleted) {
        $raw = $s.read.Result
        if ($null -eq $raw) { $s.read = $null; break }
        $s.read = $s.p.StandardOutput.ReadLineAsync()
        $raw = ($raw -replace "`0", '').Trim()
        if (-not $raw.StartsWith('{')) { continue }
        try { $e = $raw | ConvertFrom-Json } catch { continue }
        # once it has ended (Paired, Not paired, expired, stopped), nothing more is shown (Fable R6-5)
        if ($s.done) { continue }
        Log "pair: $(Format-TalosPairLogLine $e)"
        $text = Get-TalosPairText $e
        if ($text) { $msg.Text = $text }
        if ("$($e.event)" -eq 'warning') { $s.warn = $text }
        switch ("$($e.event)") {
          'link' {
            # the relay's host on its own line (Fable R5-1): pair.py checked the link is exactly the install's relay
            $link.Text = "$($e.link)"; $link.Visible = $true
            $msg.Text = "$($msg.Text)`r`nRelay: $($e.host)"
            # a warning came first (no key check, old relay): the link text must not wipe it
            if ($s.warn) { $msg.Text = "$($msg.Text)`r`n$($s.warn)" }
          }
          'qr' {
            $rows = @($e.rows)
            $n = $rows.Count
            if ($n -ge 21) {
              # the quiet zone ($quiet, never $q: that is the pairing's state; Fable R6-4)
              $quiet = 4; $scale = [Math]::Max(1, [Math]::Floor(220 / ($n + 2 * $quiet)))
              $size = ($n + 2 * $quiet) * $scale
              $bmp = New-Object Drawing.Bitmap $size, $size
              $g = [Drawing.Graphics]::FromImage($bmp)
              $g.Clear([Drawing.Color]::White)
              for ($y = 0; $y -lt $n; $y++) {
                $r = "$($rows[$y])"
                for ($x = 0; $x -lt $n -and $x -lt $r.Length; $x++) {
                  if ($r[$x] -eq '1') { $g.FillRectangle([Drawing.Brushes]::Black, ($x + $quiet) * $scale, ($y + $quiet) * $scale, $scale, $scale) }
                }
              }
              $g.Dispose()
              $pic.Image = $bmp; $pic.SizeMode = 'CenterImage'; $pic.Visible = $true
            } else {
              # too long to draw as a code (pair.py says reason too_long): the link is still there to open on the phone
              $msg.Text = "$($msg.Text)`r`nThe link is too long for a code here: open it on your iPhone instead (copy it from the box below)."
            }
          }
          'confirm' {
            if (-not (Set-TalosPairConfirm $q (Get-Date))) { continue }
            # the link and the code go: they are not to be used again
            $pic.Visible = $false; $link.Visible = $false
            $words.Text = Format-TalosPairWords $e
            $words.Visible = $true
            $device.Text = "Phone: $($e.device_name)"; $device.Visible = $true
            $yes.Visible = $true; $no.Visible = $true
          }
          { $_ -in 'pinned', 'not_pinned', 'used', 'expired', 'error' } {
            # "Paired" only after a confirm the person answered yes, here as in pair.py (Fable R5-2)
            if ("$($e.event)" -eq 'pinned' -and -not (Test-TalosPairPaired $q)) {
              $msg.Text = 'Pairing stopped: Talos reported a pairing nobody here agreed to. Start again.'
            }
            $s.done = $true
            $pic.Visible = $false; $link.Visible = $false; $words.Visible = $false; $device.Visible = $false
            $yes.Visible = $false; $no.Visible = $false; $close.Text = 'Close'
          }
          'answered' { if (-not $e.yes) { $s.done = $true; $words.Visible = $false; $device.Visible = $false; $yes.Visible = $false; $no.Visible = $false; $close.Text = 'Close' } }
        }
      }
      if (-not $s.read -and -not $s.done) {
        $t.Stop()
        $s.done = $true
        $msg.Text = 'Pairing stopped before it finished. Check that the icon is green, then start again.'
        $pic.Visible = $false; $link.Visible = $false; $yes.Visible = $false; $no.Visible = $false; $close.Text = 'Close'
      }
    })
  $yes.add_Click({ & $send (Get-TalosPairAnswer $q 'y' (Get-Date)) })
  $no.add_Click({ & $send (Get-TalosPairAnswer $q 'n' (Get-Date)) })
  $close.add_Click({ $f.Close() })
  $f.add_FormClosed({
      $t.Stop()
      # an open question is answered no; then the pairing is stopped (the link stays unused and expires)
      & $send (Get-TalosPairCloseAnswer $q)
      if ($s.p -and -not $s.p.HasExited) { Stop-TalosTree $s.p.Id }
      if (-not $s.done) { Log 'pair: closed before it finished' }
    })
  $t.Start()
  [void]$f.ShowDialog()
}
$pair.add_Click({ Invoke-TrayStep 'the pairing window' { Show-Pair } })

# ---- "Open a thread's session" -------------------------------------------------------------------------------------------
# The list, read as talos through the isolation gate, off the menu's own thread (Fable on 3b046779: a wait here froze the
# whole tray): the menu says "Looking for threads..." at once, and a short timer fills it in when the read is done. The read
# gives up after 15 s here (and 10 s inside the distro), and takes at most 64 KB. Each thread is one item: its name, greyed
# with "(not running)" when its session is not there.
$threadRead = @{ ps = $null; handle = $null; started = $null; shared = $null }
$threadTimer = New-Object Windows.Forms.Timer
$threadTimer.Interval = 200
function Start-SessionsRead {
  if ($threadRead.ps) { return } # one read at a time
  $sessions.DropDownItems.Clear()
  $m = $sessions.DropDownItems.Add('Looking for threads...'); $m.Enabled = $false
  # the read's process, for the timer to end if it runs past 15 s (a wsl.exe that never answers would hold the read for ever)
  $shared = [hashtable]::Synchronized(@{ proc = $null })
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
      param($exe, $argLine, $readerText, $shared)
      # Read-TalosBounded made again here: a script block is bound to the runspace that made it, never called from another
      $reader = [scriptblock]::Create($readerText)
      $psi = New-Object Diagnostics.ProcessStartInfo
      $psi.FileName = $exe; $psi.Arguments = $argLine
      $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
      $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $false
      $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
      try {
        $p = [Diagnostics.Process]::Start($psi)
        $shared.proc = $p
        # read first, then wait (Fable's fix check on 53faf74e): waiting first stalls a child whose answer outgrows the
        # pipe. The read ends at the child's end of output, or at 64 KB, where the child is ended.
        $text = & $reader $p.StandardOutput
        if (-not $p.WaitForExit(2000)) { try { $p.Kill() } catch { }; return $null }
        if ($p.ExitCode -ne 0) { return $null }
        return ($text -replace "`0", '')
      } catch { return $null }
    }).AddArgument($WslExe).AddArgument(((Get-TalosThreadListArgs $Distro) -join ' ')).AddArgument(${function:Read-TalosBounded}.ToString()).AddArgument($shared)
  $threadRead.ps = $ps
  $threadRead.shared = $shared
  $threadRead.started = Get-Date
  $threadRead.handle = $ps.BeginInvoke()
  $threadTimer.Start()
}
$threadTimer.add_Tick({
    if (-not $threadRead.ps) { $threadTimer.Stop(); return }
    $json = $null
    if (-not $threadRead.handle.IsCompleted) {
      if (((Get-Date) - $threadRead.started).TotalSeconds -lt 15) { return }
      # past 15 s: the read is given up, its process ended (which ends the read), and the menu says so
      try { $threadRead.shared.proc.Kill() } catch { }
      # BeginStop: never a wait on the menu's thread, whatever still holds the read
      try { [void]$threadRead.ps.BeginStop($null, $null) } catch { }
    } else {
      try { $json = @($threadRead.ps.EndInvoke($threadRead.handle)) | Select-Object -Last 1 } catch { }
    }
    $threadTimer.Stop()
    $threadRead.ps.Dispose(); $threadRead.ps = $null
    Invoke-TrayStep 'showing the thread list' { Show-SessionsMenu $json }
  })
function Show-SessionsMenu($json) {
  $sessions.DropDownItems.Clear()
  if ($null -eq $json) {
    $m = $sessions.DropDownItems.Add('Talos did not answer; try again in a moment'); $m.Enabled = $false
    return
  }
  $list = @(ConvertFrom-TalosThreadList $json)
  if ($list.Count -eq 0) {
    $m = $sessions.DropDownItems.Add('No thread has a session of its own'); $m.Enabled = $false
    return
  }
  foreach ($t in $list) {
    $i = Get-TalosThreadItem $t
    $m = $sessions.DropDownItems.Add($i.Text)
    $m.Enabled = $i.Enabled
    $m.Tag = $t.Id
    $m.add_Click({ param($s) Open-ThreadSession "$($s.Tag)" })
  }
}
function Open-ThreadSession([string]$Id) {
  try {
    # a console window of its own; the id is a thread id (Get-TalosAttachArgs throws on anything else)
    Start-Process -FilePath $WslExe -ArgumentList (Get-TalosAttachArgs $Distro $Id)
    Log "tray: opened the session of thread $Id"
  } catch {
    Log "tray: could not open the session of thread ${Id}: $($_.Exception.Message)"
  }
}
$sessions.add_DropDownOpening({ Invoke-TrayStep 'reading the thread list' { Start-SessionsRead } })

# ---- "Start Talos" / "Restart Talos" and "Restore last good setup" ---------------------------------------------------------
# Root's own verbs (talos-wsl.sh restart / restore), run as a process of their own behind a small window, so the menu never
# waits on them; their stdout is root's fixed words, and the words shown are Get-TalosRecoveryText's.
function Start-TalosRootVerb([string]$Verb, [string]$Title, [string]$Busy) {
  $f = New-Object Windows.Forms.Form
  $f.Text = $Title
  $f.ClientSize = New-Object Drawing.Size(420, 150)
  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
  $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
  $f.Font = New-Object Drawing.Font('Segoe UI', 10)
  $msg = New-Object Windows.Forms.Label
  $msg.SetBounds(16, 16, 388, 76); $msg.Text = $Busy
  $f.Controls.Add($msg)
  $close = New-Object Windows.Forms.Button
  $close.Text = 'Close'; $close.SetBounds(286, 104, 118, 32); $close.Enabled = $false
  $f.Controls.Add($close)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $WslExe
  $psi.Arguments = "-d $Distro -u root --exec $tool $Verb"
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $s = @{ p = $null; out = $null; at = Get-Date }
  try {
    $s.p = [Diagnostics.Process]::Start($psi)
    $s.out = $s.p.StandardOutput.ReadToEndAsync()
    [void]$s.p.StandardError.ReadToEndAsync()
  } catch {
    $msg.Text = "Talos could not run that: $($_.Exception.Message)"; $close.Enabled = $true
  }
  Log "$($Verb): started"
  $t = New-Object Windows.Forms.Timer
  $t.Interval = 300
  $t.add_Tick({
      if (-not $s.p) { $t.Stop(); return }
      # at most 2 minutes; then the whole tree is stopped (the fleet rule)
      if (-not $s.p.HasExited -and ((Get-Date) - $s.at).TotalSeconds -gt 120) { Stop-TalosTree $s.p.Id }
      if (-not $s.p.HasExited) { return }
      $t.Stop()
      $out = ''
      if ($s.out.Wait(2000)) { $out = "$($s.out.Result)" }
      $msg.Text = Get-TalosRecoveryText $Verb $out
      Log "$($Verb): $(Format-TalosRootVerbLogLine $out)"
      $close.Enabled = $true
      Start-Status
    })
  $close.add_Click({ $f.Close() })
  $f.add_FormClosed({
      $t.Stop()
      # closed while it still runs (the X): the whole tree stops, and the log says so (Fable R7-2 on 9612c7d7)
      if ($s.p -and -not $s.p.HasExited) { Stop-TalosTree $s.p.Id; Log "$($Verb): stopped (the window was closed)" }
    })
  $t.Start()
  [void]$f.ShowDialog()
}
$startItem.add_Click({
    if ($startItem.Text -like 'Restart*') {
      $a = [Windows.Forms.MessageBox]::Show("Restart Talos?`n`nTalos's main Claude session stops and starts fresh in a minute or so. Thread sessions carry on.",
        'Talos', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Question)
      if ($a -ne [Windows.Forms.DialogResult]::Yes) { return }
    }
    $state.restarted = Get-Date # Check Talos closes its window only when a restart really ran (not on No)
    Invoke-TrayStep 'the restart window' { Start-TalosRootVerb 'restart' $startItem.Text.TrimEnd('.') 'Starting Talos...' }
  })
$restoreItem.add_Click({
    $a = [Windows.Forms.MessageBox]::Show("Restore last good setup?`n`nThis puts back the agent's Claude Code settings from the last time Talos started cleanly (recent changes to them are undone), then restarts Talos.",
      'Talos', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Question)
    if ($a -ne [Windows.Forms.DialogResult]::Yes) { return }
    Invoke-TrayStep 'the restore window' { Start-TalosRootVerb 'restore' 'Restore last good setup' 'Putting back the last good setup...' }
  })

$kitItem.add_Click({ Invoke-TrayStep 'the kit update window' { Start-TalosRootVerb 'kit-update' 'Update the kit' 'Updating the kit...' } })

# ---- "Check Talos" ---------------------------------------------------------------------------------------------------------
# doctor --json read off the window's thread (a runspace, like the thread list), at most 64 KB, given up at 100 s; the window
# says "Checking Talos..." meanwhile. The one fix is a button: the relay key from root, or the tray's own Update the kit or
# Restart Talos (each with its own confirmation, as from the menu).
# A runspace stopped mid-run (given up, or the window closed) is disposed once its stop has finished, on the next Check:
# disposing it at once would wait on the stop, on the window's thread.
$script:checkStopping = New-Object Collections.ArrayList
function Stop-CheckRunspace($ps) {
  try { [void]$script:checkStopping.Add(@{ ps = $ps; ar = $ps.BeginStop($null, $null) }) } catch { }
}
function Show-Check {
  foreach ($x in @($script:checkStopping)) {
    if ($x.ar.IsCompleted) { try { $x.ps.Dispose() } catch { }; $script:checkStopping.Remove($x) }
  }
  $f = New-Object Windows.Forms.Form
  $f.Text = 'Check Talos'
  $f.ClientSize = New-Object Drawing.Size(720, 470)
  $f.StartPosition = 'CenterScreen'; $f.MinimizeBox = $false
  $f.Font = New-Object Drawing.Font('Segoe UI', 10)
  $sum = New-Object Windows.Forms.Label
  $sum.SetBounds(16, 12, 688, 64); $sum.Text = 'Checking Talos... (this can take a minute or two)'
  $list = New-Object Windows.Forms.ListView
  $list.SetBounds(16, 80, 688, 320); $list.View = 'Details'; $list.FullRowSelect = $true; $list.HeaderStyle = 'Nonclickable'
  [void]$list.Columns.Add('', 80); [void]$list.Columns.Add('Check', 200); [void]$list.Columns.Add('What it found', 400)
  $fix = New-Object Windows.Forms.Button
  $fix.SetBounds(16, 416, 220, 36); $fix.Visible = $false
  $close = New-Object Windows.Forms.Button
  $close.Text = 'Close'; $close.SetBounds(604, 416, 100, 36)
  $f.Controls.AddRange(@($sum, $list, $fix, $close))
  $close.add_Click({ $f.Close() })
  $s = @{ fix = $null; ps = $null; handle = $null; started = Get-Date; shared = [hashtable]::Synchronized(@{ proc = $null }) }
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
      param($exe, $argLine, $readerText, $shared)
      $reader = [scriptblock]::Create($readerText)
      $psi = New-Object Diagnostics.ProcessStartInfo
      $psi.FileName = $exe; $psi.Arguments = $argLine
      $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
      $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $false
      $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
      try {
        $p = [Diagnostics.Process]::Start($psi)
        $shared.proc = $p
        $text = & $reader $p.StandardOutput
        if (-not $p.WaitForExit(2000)) { try { $p.Kill() } catch { }; return $null }
        if ($p.ExitCode -ne 0) { return $null }
        return ($text -replace "`0", '')
      } catch { return $null }
    }).AddArgument($WslExe).AddArgument(((Get-TalosDoctorArgs $Distro) -join ' ')).AddArgument(${function:Read-TalosBounded}.ToString()).AddArgument($s.shared)
  $s.ps = $ps
  $s.handle = $ps.BeginInvoke()
  $t = New-Object Windows.Forms.Timer
  $t.Interval = 250
  $t.add_Tick({
      # second step, only when Talos could not look the server up: Windows' own lookup, off this window's thread (it
      # takes ~7 s even when it succeeds); the window lists the rows meanwhile and gives the answer when it is back
      if ($s.lookup) {
        $winOk = $false
        if (-not $s.lookupHandle.IsCompleted) {
          if (((Get-Date) - $s.lookupStarted).TotalSeconds -lt 20) { return }
          Stop-CheckRunspace $s.lookup
        } else {
          try { $winOk = [bool](@($s.lookup.EndInvoke($s.lookupHandle)) | Select-Object -Last 1) } catch { }
          $s.lookup.Dispose()
        }
        $s.lookup = $null
        $t.Stop()
        Set-CheckFix $s.rows $winOk
        return
      }
      $json = $null
      if (-not $s.handle.IsCompleted) {
        if (((Get-Date) - $s.started).TotalSeconds -lt 100) { return }
        try { $s.shared.proc.Kill() } catch { }
        Stop-CheckRunspace $s.ps
        $s.ps = $null # stopping: the window's close has nothing left to stop
      } else {
        try { $json = @($s.ps.EndInvoke($s.handle)) | Select-Object -Last 1 } catch { }
        $s.ps.Dispose()
      }
      $t.Stop()
      $rows = @(ConvertFrom-TalosDoctor $json)
      if ($rows.Count -eq 0) {
        $sum.Text = 'Talos did not answer the check. Make sure the dot is green or amber, then try again; if it stays like this, send the log folder to whoever helps you.'
        return
      }
      # problems first, then what to check, then what is fine: what matters is at the top, never below the fold
      foreach ($r in @(Sort-TalosDoctorRows $rows)) {
        $plain = Get-TalosDoctorPlain $r
        $it = New-Object Windows.Forms.ListViewItem (Get-TalosDoctorWord $r.Level)
        [void]$it.SubItems.Add($plain.Label); [void]$it.SubItems.Add($plain.Text)
        if ($r.Level -ceq 'FAIL') { $it.ForeColor = [Drawing.Color]::FromArgb(180, 20, 30) }
        elseif ($r.Level -ceq 'warn') { $it.ForeColor = [Drawing.Color]::FromArgb(150, 100, 0) }
        [void]$list.Items.Add($it)
      }
      # Talos could not look the server up: can Windows? Then it is WSL's own name lookup, not this PC's internet.
      # Asked of DNS itself (not Windows' cache or hosts file), so a PC that just went offline is not called online.
      $lookupHost = Get-TalosLookupFailHost $rows
      if (-not $lookupHost) { Set-CheckFix $rows $false; return }
      $s.rows = $rows
      $lk = [powershell]::Create()
      [void]$lk.AddScript({
          param($h)
          try { [bool](Resolve-DnsName -Name $h -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop | Where-Object { $_.IPAddress }) } catch { $false }
        }).AddArgument($lookupHost)
      $s.lookup = $lk
      $s.lookupStarted = Get-Date
      $s.lookupHandle = $lk.BeginInvoke()
      $sum.Text = 'Checking whether this PC can look up your server...'
      $t.Start()
    })
  function Set-CheckFix($rows, [bool]$winOk) {
    $s.fix = Get-TalosDoctorFix $rows $winOk
    $sum.Text = $s.fix.Text
    if ($s.fix.Kind -ne 'none') { $fix.Text = $s.fix.Button; $fix.Visible = $true }
  }
  $fix.add_Click({
      switch ($s.fix.Kind) {
        'relay-key' {
          $k = Get-TalosRelayKeyLine (Invoke-TalosRoot @('relay-key')).Text
          if (-not $k.Line) { $sum.Text = 'Talos could not read this PC''s key. Send the log folder to whoever helps you.' }
          elseif ($k.Changed) { $sum.Text = 'This PC''s key changed after Setup showed it, so it is not copied: the server may be right to turn it away. Send the log folder to whoever helps you.' }
          else {
            try {
              [Windows.Forms.Clipboard]::SetText($k.Line)
              $sum.Text = "Copied. In your server's settings (on Railway: the relay's Variables), paste it as the BRIDGE_PUBKEY line, then deploy again. Talos connects by itself once the server takes the key."
              $fix.Visible = $false
            } catch {
              $sum.Text = 'The clipboard is busy; press Copy the relay key again in a moment.'
            }
          }
        }
        # the tray's own item, with its own confirmation; this window's answer is then old, so it closes
        'restart' {
          $before = $state.restarted
          $startItem.PerformClick()
          if ($state.restarted -ne $before) { $f.Close() } # answered No: the window and its answer stay
        }
      }
    })
  # closed before the check finished: the check is ended too (its process, its runspace), never left running behind
  $f.add_FormClosed({
      $t.Stop()
      if ($s.ps -and -not $s.handle.IsCompleted) {
        try { $s.shared.proc.Kill() } catch { }
        Stop-CheckRunspace $s.ps
      }
      if ($s.lookup) { Stop-CheckRunspace $s.lookup }
    })
  $t.Start()
  [void]$f.ShowDialog()
}
$checkItem.add_Click({ Invoke-TrayStep 'the check window' { Show-Check } })

$openLog.add_Click({ Invoke-TrayStep 'opening the log folder' { Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList "`"$dir`"" } })
$quit.add_Click({
    $a = [Windows.Forms.MessageBox]::Show(
      "Quit the Talos tray?`n`nTalos stops once Windows lets its distro ($Distro) go, usually within a minute. It starts again at your next sign-in, or when you run the tray again.",
      'Talos', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Question)
    if ($a -ne [Windows.Forms.DialogResult]::Yes) { return }
    $state.quitting = $true
    Log "the tray was quit; the $Distro distro is no longer held"
    Invoke-TrayStep 'stopping the hold' { if ($state.hold -and -not $state.hold.HasExited) { & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /T /F /PID $state.hold.Id 2>&1 | Out-Null } }
    $ni.Visible = $false
    [Windows.Forms.Application]::Exit()
  })

$holdTimer = New-Object Windows.Forms.Timer
$holdTimer.Interval = 2000
$holdTimer.add_Tick({
    Invoke-TrayStep 'the sleep check' { Watch-Sleep }
    Invoke-TrayStep 'the keep-alive check' { Watch-Hold }
    Invoke-TrayStep 'reading the status' { Receive-Status }
  })
$statusTimer = New-Object Windows.Forms.Timer
$statusTimer.Interval = 30000
$statusTimer.add_Tick({
    Invoke-TrayStep 'asking for the status' { Start-Status }
    Invoke-TrayStep 'the stay-awake setting' { Update-StayAwake }
  })

Log "tray started for $Distro"
try {
  Start-Hold
  $holdTimer.Start()
  $statusTimer.Start()
  # the first status a moment after the hold starts the distro, not 30 s later
  $first = New-Object Windows.Forms.Timer
  $first.Interval = 3000
  $first.add_Tick({
      $first.Stop()
      Invoke-TrayStep 'asking for the first status' { Start-Status }
      Invoke-TrayStep 'the stay-awake setting' { Update-StayAwake }
    })
  $first.Start()
  [Windows.Forms.Application]::Run()
} finally {
  $holdTimer.Stop()
  $statusTimer.Stop()
  $ni.Visible = $false
  $ni.Dispose()
  $mutex.ReleaseMutex()
}
