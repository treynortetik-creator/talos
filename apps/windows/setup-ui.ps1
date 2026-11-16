<#
.SYNOPSIS
  Talos Setup's window (docs/WINDOWS-PLAN.md section 8, "The no-terminal install"): what a basic user sees instead of a
  terminal. Setup.exe (scripts\windows-setup\build.ps1) unpacks it beside talos-setup.zip and the WSL installer, and runs
  it hidden; it shows one window.

  1. Unpacks the release into %LOCALAPPDATA%\Talos\setup (only you and SYSTEM on it, like bin): after a restart Windows
     runs Setup from there, and Setup's own temporary folder is gone by then.
  2. One page: what happens, the "keep this PC awake while it is plugged in" choice (on by default), "Set up Talos".
  3. Runs install.ps1 -Silent from that folder, hidden, and shows each step in words. A restart (WSL was just installed)
     is a page of its own, with "Restart now"; after she signs in again, Windows opens this window once more (-Resume) and
     it carries on.
  Nothing it shows or logs carries a secret: install.ps1 prints none (R1-5).
#>
[CmdletBinding()]
param(
  [switch]$Resume,
  # loads everything the window needs and exits 0, showing nothing (the tests: Setup.exe's files are enough to start it)
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# packed beside this script in Setup.exe (TalosWin.ps1 $TalosSetupPackFiles; Fable R2-1 on ebad65d5)
. (Join-Path $here 'TalosWin.ps1')
$talosHome = Join-Path $env:LOCALAPPDATA 'Talos'
$setupDir = Join-Path $talosHome 'setup'
$log = Join-Path $talosHome 'setup.log'
$settingsFile = Join-Path $talosHome 'settings.json'
$statusFile = Join-Path $talosHome 'setup-status.txt'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Log([string]$m) {
  try { Add-Content -LiteralPath $log -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $m) -Encoding UTF8 } catch { }
}

# ---- the release into %LOCALAPPDATA%\Talos\setup ------------------------------------------------------------------------
function Expand-TalosRelease {
  New-Item -ItemType Directory -Force -Path $talosHome | Out-Null
  if (Test-Path -LiteralPath $setupDir) { Remove-Item -LiteralPath $setupDir -Recurse -Force }
  New-Item -ItemType Directory -Path $setupDir | Out-Null
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $ErrorActionPreference = 'Continue'
  # her and SYSTEM, and Administrators may read (Fable R2-3 on ebad65d5): on a standard account the "Yes" is another
  # administrator's, and the elevated step, running as that account, has to read the msi in here
  & icacls.exe $setupDir /inheritance:r /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)RX' /q 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { throw "could not limit $setupDir to you (icacls exit $LASTEXITCODE)" }
  Expand-Archive -LiteralPath (Join-Path $here 'talos-setup.zip') -DestinationPath $setupDir
  $msi = Get-ChildItem -LiteralPath $here -Filter 'wsl.*.msi' | Select-Object -First 1
  if ($msi) {
    New-Item -ItemType Directory -Force -Path (Join-Path $setupDir 'wsl') | Out-Null
    Copy-Item -LiteralPath $msi.FullName -Destination (Join-Path $setupDir 'wsl')
  }
}

# ---- the window ----------------------------------------------------------------------------------------------------------
$form = New-Object Windows.Forms.Form
$form.Text = 'Talos Setup'
$form.ClientSize = New-Object Drawing.Size(520, 360)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Segoe UI', 10)

$title = New-Object Windows.Forms.Label
$title.Font = New-Object Drawing.Font('Segoe UI', 14)
$title.SetBounds(20, 16, 480, 32)
$form.Controls.Add($title)

$body = New-Object Windows.Forms.TextBox
$body.Multiline = $true
$body.ReadOnly = $true
$body.BorderStyle = 'None'
$body.BackColor = $form.BackColor
$body.TabStop = $false
$body.ScrollBars = 'Vertical'
$body.SetBounds(20, 56, 480, 156)
$form.Controls.Add($body)

$awake = New-Object Windows.Forms.CheckBox
$awake.Text = 'Keep this PC awake while it is plugged in'
$awake.Checked = $true
$awake.SetBounds(20, 222, 480, 24)
$form.Controls.Add($awake)
$awakeNote = New-Object Windows.Forms.Label
$awakeNote.Text = 'Talos answers your phone only while this PC is awake. Closing the lid, choosing Sleep, or running on battery still lets it sleep, and Talos stops until it wakes.'
$awakeNote.ForeColor = [Drawing.SystemColors]::GrayText
# three lines of it at 10 pt Segoe UI (rc13's agent-run: two lines cut it at "Talos stops until"); the button is at 310
$awakeNote.SetBounds(38, 246, 462, 60)
$form.Controls.Add($awakeNote)

$bar = New-Object Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 30
$bar.SetBounds(20, 222, 480, 18)
$bar.Visible = $false
$form.Controls.Add($bar)

$step = New-Object Windows.Forms.Label
$step.SetBounds(20, 248, 480, 48)
$form.Controls.Add($step)

$primary = New-Object Windows.Forms.Button
$primary.SetBounds(360, 310, 140, 32)
$form.Controls.Add($primary)
$form.AcceptButton = $primary
$secondary = New-Object Windows.Forms.Button
$secondary.SetBounds(210, 310, 140, 32)
$secondary.Visible = $false
$form.Controls.Add($secondary)

$script:proc = $null
$script:readTask = $null
$script:mode = 'welcome'
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200

function Show-Page([string]$t, [string]$b, [string]$button, [string]$second = '') {
  $body.Height = 156
  $title.Text = $t
  $body.Text = $b
  $primary.Text = $button
  $primary.Visible = [bool]$button
  $primary.Enabled = $true
  $secondary.Text = $second
  $secondary.Visible = [bool]$second
  $awake.Visible = $false
  $awakeNote.Visible = $false
  $bar.Visible = $false
}

function Start-Install {
  $script:mode = 'running'
  $v = Get-TalosSetupView @() $null $log
  Show-Page $v.Title $v.Body ''
  $bar.Visible = $true
  $step.Text = 'Getting ready'
  # the choice is the tray's to carry out (it asks Windows to stay awake while it runs on AC power; nothing to undo later)
  $settings = @{ stayAwakeOnAc = [bool]$awake.Checked } | ConvertTo-Json
  [IO.File]::WriteAllText($settingsFile, $settings, (New-Object Text.UTF8Encoding $false))
  Log "setup starting (resume=$Resume, stayAwakeOnAc=$($awake.Checked))"
  # what the window shows comes from this file alone, written by install.ps1 itself (Fable R1-3, R1-4 on f3575ba1)
  [IO.File]::WriteAllText($statusFile, '')

  $resumeWith = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $setupDir 'setup-ui.ps1')`" -Resume"
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $ps
  $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $setupDir 'install.ps1')`" -Silent -StatusFile `"$statusFile`" -ResumeWith `"$($resumeWith -replace '"', '\"')`""
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $script:proc = [Diagnostics.Process]::Start($psi)
  # its output (the distro's tools' too) is drained on threads of their own and goes to the log only, never to the window
  $script:outTask = $script:proc.StandardOutput.ReadToEndAsync()
  $script:errTask = $script:proc.StandardError.ReadToEndAsync()
  $timer.Start()
}

function Read-Status { @(Get-Content -LiteralPath $statusFile -Encoding UTF8 -ErrorAction SilentlyContinue) }

$timer.Add_Tick({
  if (-not $script:proc.HasExited) {
    $v = Get-TalosSetupView (Read-Status) $null $log
    if ($v.Step) { $step.Text = $v.Step }
    # the title and words follow too: an update is only known once install.ps1 has said so (rc14's real run: the page stayed
    # "Setting up Talos… 15 minutes" because only the step line was refreshed)
    if ($title.Text -cne $v.Title) { $title.Text = $v.Title }
    if ($body.Text -cne $v.Body) { $body.Text = $v.Body }
    return
  }
  $timer.Stop()
  $code = $script:proc.ExitCode
  # at most a few seconds each: a process it started (wslhost.exe) may still hold the pipe, and the window must not hang
  try { if ($script:outTask.Wait(3000) -and $script:outTask.Result) { Log ("install.ps1 said:`r`n" + ($script:outTask.Result -replace "`0", '')) } } catch { }
  try { if ($script:errTask.Wait(1000) -and $script:errTask.Result) { Log ("stderr:`r`n" + ($script:errTask.Result -replace "`0", '')) } } catch { }
  Log "install.ps1 exit $code"
  Finish-Install $code
})

function Finish-Install([int]$code) {
  $v = Get-TalosSetupView (Read-Status) $code $log
  $script:mode = $v.Mode
  switch ($v.Mode) {
    'done' {
      $script:pubkey = $v.Key
      Show-Page $v.Title $v.Body 'Close' $(if ($v.Key) { 'Copy the key' } else { '' })
      $body.Height = 186
      $step.Text = $v.Key
      if ($v.Key) { try { [IO.File]::WriteAllText((Join-Path $talosHome 'relay-key.txt'), "$($v.Key)`r`n") } catch { } }
      # done with it: the next Setup unpacks a fresh copy (bin holds what Talos runs from now on)
      try { Remove-Item -LiteralPath (Join-Path $setupDir 'wsl') -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
    'restart' { Show-Page $v.Title $v.Body 'Restart now' 'Later'; $step.Text = '' }
    default { Show-Page $v.Title $v.Body 'Close' 'Open the log'; $body.Height = 240; $step.Text = '' }
  }
}

# Cancel stops everything Setup started (Fable R1-5 on f3575ba1): install.ps1 and every process under it (its wsl.exe calls),
# then the Talos distro, if it is running and is one Talos made (so whatever setup-user.sh was doing in it ends too). A
# stopped distro is never started to check it: a start of an interop-off distro takes WSL's interop entry from the others.
function Stop-TalosSetupWork {
  $ErrorActionPreference = 'Continue'
  if ($script:proc -and -not $script:proc.HasExited) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /T /F /PID $script:proc.Id 2>&1 | Out-Null
  }
  $running = ((& $WslExe --list --running --quiet 2>$null) -join "`n") -replace "`0", '' -split "`n" | ForEach-Object { $_.Trim() }
  if ($running -contains 'talos' -and (Test-TalosDistro 'talos')) {
    & $WslExe -d talos -u root --exec /opt/talos-wsl/talos-wsl.sh give-back-interop 2>&1 | Out-Null
    & $WslExe --terminate talos 2>&1 | Out-Null
    Log 'stopped the talos distro'
  }
}

$primary.Add_Click({
  switch ($script:mode) {
    'welcome' { Start-Install }
    'restart' {
      Log 'restart chosen'
      $ErrorActionPreference = 'Continue'
      & (Join-Path $env:SystemRoot 'System32\shutdown.exe') /r /t 5 /c 'Talos Setup: restarting to finish installing WSL' 2>&1 | Out-Null
      $form.Close()
    }
    default { $form.Close() }
  }
})
$secondary.Add_Click({
  if ($script:mode -eq 'failed') { Start-Process -FilePath 'notepad.exe' -ArgumentList "`"$log`"" }
  elseif ($script:mode -eq 'done' -and $script:pubkey) { [Windows.Forms.Clipboard]::SetText($script:pubkey); $secondary.Text = 'Copied' }
  else { $form.Close() }
})
$form.Add_FormClosing({
  param($s, $e)
  if ($script:mode -eq 'running') {
    $a = [Windows.Forms.MessageBox]::Show('Talos Setup is still working. Stop it? Opening Talos Setup again later carries on.', 'Talos Setup', 'YesNo', 'Warning')
    if ($a -ne 'Yes') { $e.Cancel = $true; return }
    Log 'stopped by the user'
    Stop-TalosSetupWork
  }
})

if ($CheckOnly) { exit 0 }

$setupLock = New-Object Threading.Mutex($false, 'Local\TalosSetup')
$haveLock = $false
try { $haveLock = $setupLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $haveLock = $true }
if (-not $haveLock) {
  [Windows.Forms.MessageBox]::Show('Talos Setup is already open. Finish or close that window first.', 'Talos Setup', 'OK', 'Information') | Out-Null
  exit 0
}

try {
  if (-not $Resume) { Expand-TalosRelease }
} catch {
  Log "unpacking failed: $($_.Exception.Message)"
  [Windows.Forms.MessageBox]::Show("Talos Setup could not unpack itself: $($_.Exception.Message)", 'Talos Setup', 'OK', 'Error') | Out-Null
  exit 1
}

if ($Resume) {
  # carrying on after the restart: her choice was saved before it
  try { $awake.Checked = [bool]((Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json).stayAwakeOnAc) } catch { }
  $form.Add_Shown({ Start-Install })
} else {
  Show-Page 'Set up Talos on this PC' "Talos runs Claude on this PC so you can use it from your iPhone.`r`n`r`nSetup takes about 15 minutes and needs the internet. If this PC has never run WSL (the part of Windows Talos runs in), Windows asks once to allow changes, then needs one restart." 'Set up Talos'
  $awake.Visible = $true
  $awakeNote.Visible = $true
}
[void]$form.ShowDialog()
