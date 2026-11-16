# Talos on Windows: start Talos in WSL when the owner logs in (docs/windows/README.md). A draft: nothing runs it, and it has
# not been installed on a real machine yet. With the owner's OK, run it in PowerShell as the owner (no admin):
#   powershell -ExecutionPolicy Bypass -File docs\windows\talos-logon-task.ps1 [-Distro Ubuntu] [-WhatIf]
#   powershell -ExecutionPolicy Bypass -File docs\windows\talos-logon-task.ps1 -Remove
# It registers one task for this user only. The task opens the distro by name (never the default distro, which on a machine
# with Docker Desktop is docker-desktop), starts the Talos supervisor's systemd user unit, and keeps one WSL process alive so
# WSL does not stop the distro when no window is open. conhost --headless keeps a console window from flashing up.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Distro = 'Ubuntu',
  [string]$Unit = 'talos-supervisor.service',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$name = 'Talos (WSL)'
$user = "$env:USERDOMAIN\$env:USERNAME"

if ($Remove) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    if ($PSCmdlet.ShouldProcess($name, 'Unregister')) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  }
  return
}

$installed = (& wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($installed -notcontains $Distro) { throw "WSL has no distro named '$Distro' (it has: $($installed -join ', '))" }

# The unit is started, not enabled at boot: lingering (loginctl enable-linger) keeps it running once started.
$inside = "systemctl --user start $Unit; exec sleep infinity"
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
  -Argument "--headless $env:WINDIR\System32\wsl.exe -d $Distro --exec /bin/sh -lc `"$inside`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

if ($PSCmdlet.ShouldProcess($name, "Register (wsl -d $Distro, $Unit)")) {
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Starts Talos in WSL ($Distro) at logon and keeps the distro running." -Force | Out-Null
  Write-Output "Registered '$name'. It runs at your next logon; to start it now: Start-ScheduledTask -TaskName '$name'"
}
