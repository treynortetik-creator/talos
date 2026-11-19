<#
.SYNOPSIS
  A tray icon for Titan's gaming switch (ci-switch.ps1): "Pause Titan CI (gaming)" sends Titan's work back to Lemnos and stops
  the runner services; "Resume Titan CI" starts them and puts the repository variables back. One copy at a time. The pause and
  the resume run on a background runspace, so the menu never hangs while gh and wsl.exe work. Run it hidden:
    powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ci-tray.ps1
  It is not registered to start at logon (docs/CI-MACHINES.md, "Titan's gaming switch", says how).
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Continue'
$switchFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'ci-switch.ps1'
. $switchFile

$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\TalosCITray', [ref]$created)
if (-not $created) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# before any control exists: an error in a handler is logged and the tray goes on
[System.Windows.Forms.Application]::SetUnhandledExceptionMode('CatchException')
[System.Windows.Forms.Application]::add_ThreadException({
    param($sender, $e)
    Write-CiSwitchLog "tray: unhandled error on the UI thread: $($e.Exception.Message)"
  })
[AppDomain]::CurrentDomain.add_UnhandledException({
    param($sender, $e)
    Write-CiSwitchLog "tray: unhandled error: $($e.ExceptionObject)"
  })

$script:work = $null # the running pause or resume: @{ Ps; Handle; Action }
$script:icons = @{}

function New-CiDotIcon([string]$Color) {
  $bmp = New-Object Drawing.Bitmap 16, 16
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([Drawing.Color]::Transparent)
  $brush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromName($Color))
  $g.FillEllipse($brush, 1, 1, 14, 14)
  $brush.Dispose(); $g.Dispose()
  $h = $bmp.GetHicon()
  $icon = [Drawing.Icon]::FromHandle($h)
  $script:icons[$Color] = @{ Icon = $icon; Handle = $h }
  $bmp.Dispose()
  $icon
}

function Show-CiState([string]$State) {
  # State: running, paused or working
  switch ($State) {
    'paused' { $text = 'Titan CI: paused for gaming'; $color = 'Orange' }
    'resuming' { $text = 'Titan CI: resuming... (unfinished: Resume or Pause)'; $color = 'Gold' }
    'incomplete' { $text = 'Titan CI: pause incomplete, pause again'; $color = 'Red' }
    'unreadable' { $text = 'Titan CI: paused.json unreadable, see the log'; $color = 'Red' }
    'working' { $text = 'Titan CI: working...'; $color = 'Gray' }
    default { $text = 'Titan CI: running'; $color = 'Green' }
  }
  $status.Text = $text
  $tray.Text = $text
  if (-not $script:icons.ContainsKey($color)) { [void](New-CiDotIcon $color) }
  $tray.Icon = $script:icons[$color].Icon
  $busy = ($State -eq 'working')
  # pause stays on while paused: it is safe to repeat, and finishes a pause that did not complete
  $pause.Enabled = (-not $busy)
  $resume.Enabled = (-not $busy) -and ($State -ne 'running')
}

function Get-CiTrayState {
  # from the saved-state file only: cheap, no gh call on the UI thread
  Get-TitanCiPauseState
}

function Start-CiWork([string]$Action) {
  if ($script:work) { return }
  Show-CiState 'working'
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
      param($file, $action)
      . $file
      if ($action -eq 'pause') { Suspend-TitanCi } else { Resume-TitanCi }
    }).AddArgument($switchFile).AddArgument($Action)
  $script:work = @{ Ps = $ps; Handle = $ps.BeginInvoke(); Action = $Action }
  Write-CiSwitchLog "tray: $Action asked"
}

$tray = New-Object Windows.Forms.NotifyIcon
$menu = New-Object Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add('Titan CI: running'); $status.Enabled = $false
[void]$menu.Items.Add('-')
$pause = $menu.Items.Add('Pause Titan CI (gaming)')
$resume = $menu.Items.Add('Resume Titan CI')
[void]$menu.Items.Add('-')
$openLog = $menu.Items.Add('Open the log')
$quit = $menu.Items.Add('Quit')
$tray.ContextMenuStrip = $menu

$pause.Add_Click({
    try { Start-CiWork 'pause' } catch { Write-CiSwitchLog "tray: pause click: $($_.Exception.Message)" }
  })
$resume.Add_Click({
    try { Start-CiWork 'resume' } catch { Write-CiSwitchLog "tray: resume click: $($_.Exception.Message)" }
  })
$openLog.Add_Click({
    try {
      $log = Join-Path (Get-TitanCiDir) 'ci-switch.log'
      if (-not (Test-Path -LiteralPath $log)) { Write-CiSwitchLog 'tray: log opened' }
      [void][Diagnostics.Process]::Start('notepad.exe', ('"{0}"' -f $log))
    } catch { Write-CiSwitchLog "tray: open log click: $($_.Exception.Message)" }
  })
$quit.Add_Click({
    try {
      if ($script:work) {
        # the pause or resume ends within a minute or two (gh and wsl.exe have time limits); quitting now would cut it off
        $tray.ShowBalloonTip(4000, 'Titan CI', 'Still working; quit when it is done.', 'Info')
        return
      }
      $tray.Visible = $false
      [Windows.Forms.Application]::Exit()
    } catch { Write-CiSwitchLog "tray: quit click: $($_.Exception.Message)" }
  })

# a timer on the UI thread notices a finished pause or resume, and reads the state file now and then
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 700
$ticks = 0
$timer.Add_Tick({
    try {
      if ($script:work) {
        if ($script:work.Handle.IsCompleted) {
          $w = $script:work; $script:work = $null
          $res = $null
          try { $res = @($w.Ps.EndInvoke($w.Handle) | Select-Object -Last 1)[0] } catch { Write-CiSwitchLog "tray: $($w.Action) failed: $($_.Exception.Message)" }
          $w.Ps.Dispose()
          Show-CiState (Get-CiTrayState)
          $msg = if ($res) { $res.Message } else { "$($w.Action) failed, see the log" }
          $icon = if ($res -and $res.Ok) { 'Info' } else { 'Warning' }
          $tray.ShowBalloonTip(5000, 'Titan CI', $msg, $icon)
        }
      } else {
        $ticks++
        if ($ticks -ge 40) { $ticks = 0; Show-CiState (Get-CiTrayState) }
      }
    } catch { Write-CiSwitchLog "tray: timer: $($_.Exception.Message)" }
  })

Show-CiState (Get-CiTrayState)
$tray.Visible = $true
$timer.Start()
Write-CiSwitchLog 'tray started'
try {
  [Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  foreach ($k in $script:icons.Keys) { try { $script:icons[$k].Icon.Dispose() } catch { } }
  $mutex.ReleaseMutex()
  Write-CiSwitchLog 'tray stopped'
}
