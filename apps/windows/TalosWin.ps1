<#
  What install.ps1, add-folder.ps1 and uninstall.ps1 share (docs/WINDOWS-PLAN.md section 8), dot-sourced by each. Kept apart
  so apps\windows\tests\TalosWin.Tests.ps1 (Pester 3.4, the one Windows ships) can test it without a distro.
#>

# wsl.exe by its full path (R1-11): a wsl.exe earlier on PATH, or in the current folder, is never the one run
$script:WslExe = Join-Path $env:SystemRoot 'System32\wsl.exe'
# a file in the distro that says Talos made it (R1-7): a distro without it is never set up, stopped or deleted by these scripts
$script:TalosMarker = '/etc/talos-wsl/marker'

# ---- a PC with no WSL (the no-terminal install, item 2) ------------------------------------------------------------------
# The WSL installer Setup carries, so a PC with no WSL downloads nothing for it: Microsoft's own release, pinned. 2.7.11 is
# the version every Windows step was tested on (WSL 3.x is a major version: one live run of the checklist before moving).
$script:TalosWslMsi = @{
  Version = '2.7.11'
  Name    = 'wsl.2.7.11.0.x64.msi'
  Sha256  = 'a611ddacee689d2fb1fb5319e58af7f3998864d86cdce632eadd8e61614a0f9d'
  Source  = 'https://github.com/microsoft/WSL/releases/download/2.7.11/wsl.2.7.11.0.x64.msi'
}

<#
  The one administrator step (Fable R1-1 on f3575ba1). It takes nothing after her "Yes" from a place she (or anything
  running as her) can write:
  - The script is this text, passed as -EncodedCommand: no file is read once it is elevated, nothing is dot-sourced, and the
    pin is in the text itself.
  - It takes nothing from her environment (Fable R2-2 on ebad65d5): an elevated process inherits her HKCU\Environment, so
    %ProgramData%, %SystemRoot% and PSModulePath could point anywhere. Its first line pins PSModulePath to Windows' own
    modules folder, its folders come from [Environment]::GetFolderPath / SystemDirectory, and it calls .NET, not cmdlets
    (none to load from a module path).
  - It makes a NEW folder under the common application data folder whose ACL and owner are set as it is created
    (Directory.CreateDirectory with a DirectorySecurity: owner Administrators; Administrators and SYSTEM full, Users read;
    nothing inherited), so there is no moment anyone else could write in it.
  - It copies the msi into that folder, hashing the very bytes it writes, and refuses a copy that does not match the pin.
  - msiexec then runs THAT copy, and dism (Virtual Machine Platform). Both by full path. Its log stays in that folder.
  Exit: 0 done; 3010 done, a restart is needed; 1 refused or failed; 2 not elevated.
  __MSI__ is replaced by the msi's path (single quotes doubled), __PIN__ by the pinned SHA-256.
#>
$script:TalosEnableWslScript = @'
$env:PSModulePath = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\Modules')
$ErrorActionPreference = 'Stop'
$src = '__MSI__'
$pin = '__PIN__'
$sys = [Environment]::SystemDirectory
$me = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 2 }
$admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$dir = [IO.Path]::Combine([Environment]::GetFolderPath('CommonApplicationData'), 'Talos-setup-' + [Guid]::NewGuid().ToString('N'))
$sec = [Security.AccessControl.DirectorySecurity]::new()
$sec.SetOwner($admins)
$sec.SetAccessRuleProtection($true, $false)
$inh = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($sid in 'S-1-5-32-544', 'S-1-5-18') {
  $sec.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', $inh, 'None', 'Allow'))
}
$sec.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'ReadAndExecute', $inh, 'None', 'Allow'))
[void][IO.Directory]::CreateDirectory($dir, $sec)
$log = [IO.Path]::Combine($dir, 'setup-wsl.log')
function Say([string]$m) { [IO.File]::AppendAllText($log, [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ssK') + ' ' + $m + "`r`n") }
function Run([string]$exe, [string]$arguments) {
  $psi = [Diagnostics.ProcessStartInfo]::new([IO.Path]::Combine($sys, $exe), $arguments)
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  return $p.ExitCode
}
try {
  $msi = [IO.Path]::Combine($dir, 'wsl.msi')
  $in = [IO.File]::Open($src, 'Open', 'Read', 'Read')
  $out = [IO.File]::Open($msi, 'CreateNew', 'Write', 'None')
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $buf = [byte[]]::new(1048576)
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { [void]$sha.TransformBlock($buf, 0, $n, $null, 0); $out.Write($buf, 0, $n) }
    [void]$sha.TransformFinalBlock($buf, 0, 0)
    $got = [BitConverter]::ToString($sha.Hash).Replace('-', '').ToLowerInvariant()
  } finally { $in.Dispose(); $out.Dispose(); $sha.Dispose() }
  if ($got -ne $pin) { Say "refused: the WSL installer is not the one Talos pins (SHA-256 $got)"; [IO.File]::Delete($msi); exit 1 }
  $restart = $false
  Say 'installing WSL'
  $code = Run 'msiexec.exe' ('/i "' + $msi + '" /qn /norestart /l*v "' + $log + '.msi.txt"')
  switch ($code) { 0 { } 3010 { $restart = $true } 1638 { Say 'WSL is already installed' } default { Say "msiexec exit $code"; exit 1 } }
  try { [IO.File]::Delete($msi) } catch { }
  Say 'turning on Virtual Machine Platform'
  $code = Run 'dism.exe' '/online /enable-feature /featurename:VirtualMachinePlatform /all /norestart /quiet'
  switch ($code) { 0 { } 3010 { $restart = $true } default { Say "dism exit $code"; exit 1 } }
  if ($restart) { Say 'done; a restart is needed'; exit 3010 }
  Say 'done'
  exit 0
} catch {
  try { Say ('failed: ' + $_.Exception.Message) } catch { }
  exit 1
}
'@
# What Setup.exe carries beside the msi (Fable R2-1 on ebad65d5): setup-ui.ps1 dot-sources TalosWin.ps1 from its own folder
# before it unpacks anything, so TalosWin.ps1 is packed too. build.ps1 and the tests use this one list.
$script:TalosSetupPackFiles = @('setup-ui.ps1', 'TalosWin.ps1', 'talos-setup.zip')

# the elevated step's arguments for powershell.exe: -EncodedCommand of that text, with the msi's path and the pin in it
function Get-TalosEnableWslArguments([string]$Msi) {
  # PowerShell ends a single-quoted string at ' and at the typographic quotes U+2018, U+2019, U+201A and U+201B too (a
  # profile folder like "Zoe's PC" with a curly apostrophe): each is doubled, which PowerShell reads as one (R2-5)
  $q = $Msi
  foreach ($c in [char]0x27, [char]0x2018, [char]0x2019, [char]0x201A, [char]0x201B) { $q = $q.Replace([string]$c, [string]$c + [string]$c) }
  $text = $script:TalosEnableWslScript.Replace('__MSI__', $q).Replace('__PIN__', $script:TalosWslMsi.Sha256)
  @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand',
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($text)))
}

<#
  The step line under Setup's progress bar, in plain words (the agent-run of rc13 found install.ps1's own words, written for
  the log, such as "restarting the distro so wsl.conf takes effect (systemd, no interop…)", shown to her as they were).
  install.ps1 keeps its words for the log; the window shows these. A step this table does not know shows "Working", never
  the log's words.
#>
function Get-TalosSetupStepWords([string]$Step) {
  $t = "$Step".Trim()
  $plain = @(
    @('^Talos \S+ \([0-9a-f]{40}\), from Setup$', 'Getting ready'),
    @('^WSL is not on this PC', $t),
    @('^WSL is installed\. Restart', $t),
    @('^Windows is waiting for a restart', $t),
    @('^the \S+ distro is there$', 'Checking what this PC already has'),
    @('^creating the \S+ distro', 'Making a space for Talos on this PC (a few minutes)'),
    @("^the distro's own settings", 'Preparing that space'),
    @('^restarting the distro', 'Restarting it'),
    @('^checking the distro is cut off from Windows', 'Checking Talos is kept apart from your files'),
    @('^Talos into the distro|^this clone into the distro', 'Copying Talos in'),
    @('^approving how Talos starts Claude', 'Getting Claude ready'),
    @('^Talos inside the distro', 'Installing Talos (the longest step)'),
    @("^root's copy of the kit", 'Finishing the install'),
    @('^starting Talos', 'Starting Talos'),
    @("^Talos's Windows scripts into", 'Adding the Talos icon by the clock'),
    @('^the keep-alive', 'Making Talos start when you sign in to Windows'),
    @('^no keep-alive', 'Finishing'),
    @('^done\.', 'Done')
  )
  foreach ($p in $plain) { if ($t -match $p[0]) { return $p[1] } }
  if ($t -eq '') { return '' }
  'Working'
}

<#
  What Setup's window shows (Fable R1-3, R1-4 on f3575ba1), worked out from install.ps1's status file alone: its lines are
  `<kind><TAB><text>`, written by install.ps1 itself (step, detail, failed, relay-key, done). $Code is install.ps1's exit,
  or $null while it runs. Returns Mode (running, done, restart, failed), Title, Body, Step and Key. Nothing the distro
  prints reaches it: install.ps1's stdout goes to the log only.
#>
function Get-TalosSetupView([string[]]$Lines, $Code, [string]$Log = 'the setup log') {
  $step = ''; $failed = ''; $key = ''; $relVer = ''; $relSha = ''; $ran = ''; $details = New-Object Collections.Generic.List[string]
  $update = $false; $was = ''; $noRelay = $false
  foreach ($l in $Lines) {
    if ($l -notmatch "^(step|detail|failed|relay-key|release|checked-out|done|update|relay)`t(.*)$") { continue }
    $kind = $Matches[1]; $text = $Matches[2]
    switch ($kind) {
      # an install that was already there (install.ps1, "the distro is there"): this run is an update; the commit it ran
      # before, when it could be read
      # only with the commit it ran: an install stopped half way (no checkout yet) run again is still a first install, and
      # nothing of hers is there yet to be "kept" (Fable on 5e649388)
      'update' { if ($text -cmatch $script:TalosCommitRule) { $update = $true; $was = $text } }
      # no relay address anywhere (not in Setup, not set before): nothing can pair yet, so no relay-key words
      'relay' { if ($text -eq 'none') { $noRelay = $true } }
      # the payload's version and its one commit, in full (install.ps1, before anything is installed): Setup's claim only
      'release' {
        $p = "$text" -split ' '
        if ($p.Count -eq 2 -and $p[0] -cmatch $script:TalosVersionRule -and $p[1] -cmatch $script:TalosCommitRule) { $relVer = $p[0]; $relSha = $p[1] }
      }
      # the commit the distro's checkout really is, read after setup-user.sh (Fable R1-2 on 0770142f)
      'checked-out' { if ($text -cmatch $script:TalosCommitRule) { $ran = $text } }
      'step' { $step = Get-TalosSetupStepWords $text }
      'detail' { $details.Add($text) }
      'failed' { $failed = $text }
      'relay-key' { if ($text -match '^BRIDGE_PUBKEY=[A-Za-z0-9_-]{43}$') { $key = $text } }
    }
  }
  $more = ($details -join "`r`n").Trim()
  if ($null -eq $Code) {
    if ($update) {
      return New-Object PSObject -Property @{ Mode = 'running'; Title = 'Updating Talos'; Step = $step; Key = ''
        Body = "This takes a few minutes. Your settings, your conversations and your paired iPhone are kept. You can use the PC meanwhile." }
    }
    return New-Object PSObject -Property @{ Mode = 'running'; Title = 'Setting up Talos'; Step = $step; Key = ''
      Body = "This takes about 15 minutes and needs the internet. You can use the PC meanwhile; keep it plugged in and awake.`r`n`r`nIf Windows asks whether to allow changes to your PC, choose Yes: that is the one step that installs WSL, the part of Windows Talos runs in." }
  }
  if ($Code -eq 0) {
    if ($noRelay) { $key = '' }
    $next = 'Next: sign in to Claude, then pair your iPhone, both from that icon.'
    if ($key) { $next = "Before your iPhone can pair, this PC's relay key (below) goes to whoever runs your relay. Then sign in to Claude and pair, both from that icon." }
    if ($noRelay) { $next = "This Talos has no relay set yet, so it cannot pair an iPhone. Whoever set up Talos for you adds the relay; until then you can sign in to Claude from that icon." }
    $title = 'Talos is set up'
    $body = "Talos now runs on this PC, and starts by itself when you sign in to Windows. Its icon is by the clock (you may need the ^ arrow to see it).`r`n`r`n$next"
    # "updated" or "up to date" only when this PC now runs the commit this Setup carries; anything else keeps the plain
    # "set up" page and its own line about the commit (Fable on 5e649388)
    if ($update -and (-not $relSha -or $ran -ceq $relSha)) {
      # the same commit as before: nothing new came in; a new one: updated, and what she had is still there
      if ($was -and $ran -and $was -ceq $ran) {
        $title = 'Talos is up to date'
        $body = "This PC already had this version of Talos, so nothing needed to change. Your settings were kept, and Talos is running."
      } else {
        $title = 'Talos is updated'
        $body = "Talos is updated$(if ($relVer) { " to $relVer" }) and running again. Your settings, your conversations and your paired iPhone were kept."
      }
      if ($noRelay) { $body += "`r`n`r`n$next" }
    }
    if ($more) { $body += "`r`n`r`n$more" }
    # "Installed" only for the commit really checked out; anything else says plainly what it is (Fable R1-2)
    if ($relSha) {
      $body += "`r`n`r`n" + $(if ($ran -ceq $relSha) { "Installed: Talos $relVer, commit $relSha" }
        elseif ($ran) { "Setup was for Talos $relVer, commit $relSha, but this PC runs commit $ran (it already had another one). This is not the commit this Setup carries." }
        else { "Setup was for Talos $relVer, commit $relSha. The commit this PC runs could not be read." })
    }
    return New-Object PSObject -Property @{ Mode = 'done'; Title = $title; Body = $body; Step = $key; Key = $key }
  }
  if ($Code -eq 3010) {
    return New-Object PSObject -Property @{ Mode = 'restart'; Title = 'Restart to carry on'; Step = ''; Key = ''
      Body = "Windows needs one restart to finish turning on WSL.`r`n`r`nSave anything you have open, then restart. When you sign in again, Talos Setup opens by itself and carries on." }
  }
  $why = if ($failed) { $failed } else { "Setup stopped (code $Code)." }
  $body = $why
  if ($more) { $body += "`r`n`r`n$more" }
  $body += "`r`n`r`nWhat happened is in $Log. Opening Talos Setup again carries on from where it stopped."
  if ($relSha) { $body += "`r`n`r`nSetup was for Talos $relVer, commit $relSha." }
  New-Object PSObject -Property @{ Mode = 'failed'; Title = 'Talos could not be set up'; Body = $body; Step = ''; Key = '' }
}

# What she reads when virtualization is off in the PC's firmware: plain words, no jargon she has to look up first.
$script:TalosVirtualizationHelp = @'
This PC has its virtualization setting turned off, and Talos needs it.
To turn it on: restart the PC and open its setup screen as it starts (often by pressing F2, F10, F12, Esc or Delete; the
first screen usually says which). Find the setting called Virtualization, Intel VT-x, Intel Virtualization Technology,
SVM or AMD-V, turn it on, then save and exit. When Windows is back, open Talos Setup again.
Your PC maker's support page has the exact steps: search for your PC's model and "enable virtualization".
'@

# Windows waiting on a restart already (an update, a feature): a new feature or WSL install would not take effect until then.
function Test-TalosRestartPending {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )
  foreach ($k in $keys) { if (Test-Path -LiteralPath $k) { return $true } }
  return $false
}

<#
  Whether WSL can run Talos here, and if not, why: ready | missing | virtualization-off | restart-pending. Each input can be
  given (the tests do); left out, it is read from this PC. Virtualization counts as on when a hypervisor already runs (the
  firmware flag then reads false: Windows owns it) or when the firmware says it is enabled.
#>
function Get-TalosWslReadiness {
  param($WslPresent, $HypervisorPresent, $FirmwareEnabled, $RestartPending)
  if ($null -eq $WslPresent) {
    $ErrorActionPreference = 'Continue'
    & $script:WslExe --status 2>&1 | Out-Null
    $WslPresent = ($LASTEXITCODE -eq 0)
  }
  if ($null -eq $HypervisorPresent) { $HypervisorPresent = [bool](Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).HypervisorPresent }
  if ($null -eq $FirmwareEnabled) {
    $FirmwareEnabled = [bool](@(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue) | Where-Object { $_.VirtualizationFirmwareEnabled } | Select-Object -First 1)
  }
  if ($null -eq $RestartPending) { $RestartPending = Test-TalosRestartPending }
  if (-not $HypervisorPresent -and -not $FirmwareEnabled) { return 'virtualization-off' }
  if ($WslPresent -and $HypervisorPresent) { return 'ready' }
  if ($RestartPending) { return 'restart-pending' }
  if ($WslPresent) { return 'ready' }
  return 'missing'
}

# An error from WSL that means virtualization is off (the distro cannot start a VM), in any of the forms WSL prints it.
function Test-TalosVirtualizationError([string]$Text) {
  $Text -match '0x80370102|HCS_E_HYPERV_NOT_INSTALLED|0x80370114|virtualization|Virtual Machine Platform'
}

<#
  Carry on by itself after a restart: one HKCU RunOnce entry (Windows runs it once at the next sign-in of this user, then
  removes it). No administrator, and nothing left behind: the entry is gone once it has run, or when Setup finishes.
#>
$script:TalosRunOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
function Set-TalosResume([string]$Command, [string]$Key = $script:TalosRunOnceKey) {
  if (-not (Test-Path -LiteralPath $Key)) { New-Item -Path $Key -Force | Out-Null }
  New-ItemProperty -Path $Key -Name 'TalosSetup' -Value $Command -PropertyType String -Force | Out-Null
}
function Clear-TalosResume([string]$Key = $script:TalosRunOnceKey) {
  Remove-ItemProperty -Path $Key -Name 'TalosSetup' -ErrorAction SilentlyContinue
}

<#
  The release Talos Setup carries (item 1 of the no-terminal plan): payload.json beside install.ps1, written by
  scripts/windows-setup/build.ps1, naming one commit and the git bundle of it with its SHA-256. $null when there is no
  payload.json (a run from a clone); a throw when there is one and anything in it is not what build.ps1 writes.
#>
<#
  The relay URL rule, ONE for every side (Fable R6-3 on fb7a8206): Setup's payload.json, install.ps1's -RelayUrl, root's
  relay-set (launch.py) and pair.py's check all hold to exactly this. https, a lowercase host of two labels or more, an
  optional port and path; no login, query, fragment or trailing slash.
#>
$script:TalosRelayRule = '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*\z'
# \z, never $: in .NET $ also matches before a trailing newline
function Test-TalosRelayUrl([string]$Url) { [bool]("$Url" -cmatch $script:TalosRelayRule) }
# one rule each for a payload's version and a commit, case-sensitive, in Get-TalosPayload and Setup's last screen alike
$script:TalosVersionRule = '^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}\z'
$script:TalosCommitRule = '^[0-9a-f]{40}\z'
# The same normalisation launch.py's relay-set makes before it checks (Fable R7-3 on 9612c7d7): trailing slashes go, and
# the scheme and host are lowercased (a path keeps its case). Then the rule above decides.
function ConvertTo-TalosRelayUrl([string]$Url) {
  $u = "$Url".TrimEnd('/')
  if ($u -match '^([A-Za-z]+://)([^/]*)(.*)$') { $u = $Matches[1].ToLowerInvariant() + $Matches[2].ToLowerInvariant() + $Matches[3] }
  return $u
}

function Get-TalosPayload([string]$Dir) {
  $f = Join-Path $Dir 'payload.json'
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  $j = [IO.File]::ReadAllText($f) | ConvertFrom-Json
  $bad = @()
  if ("$($j.version)" -cnotmatch $script:TalosVersionRule) { $bad += 'version' }
  if ("$($j.commit)" -cnotmatch $script:TalosCommitRule) { $bad += 'commit' }
  if ("$($j.bundle)" -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.bundle$') { $bad += 'bundle' }
  if ("$($j.bundleSha256)" -notmatch '^[0-9a-f]{64}$') { $bad += 'bundleSha256' }
  # https only, no login in it, and no character a command line or a shell could read as more than a URL
  $relay = if ("$($j.relayUrl)") { ConvertTo-TalosRelayUrl "$($j.relayUrl)" } else { '' }
  if ($relay -and -not (Test-TalosRelayUrl $relay)) { $bad += 'relayUrl' }
  if ("$($j.origin)" -and "$($j.origin)" -notmatch '^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$') { $bad += 'origin' }
  if ($bad.Count) { throw "payload.json is not one Talos Setup wrote ($($bad -join ', '))" }
  New-Object PSObject -Property @{
    Version = "$($j.version)"; Commit = "$($j.commit)"; Bundle = (Join-Path $Dir "$($j.bundle)")
    BundleSha256 = "$($j.bundleSha256)"; RelayUrl = $relay; Origin = "$($j.origin)"
  }
}
# whether the bundle is the one payload.json names, byte for byte: a check against a damaged or half-copied file, not a
# trust check (payload.json sits beside the bundle in the same folder; the trust is in the Setup.exe she downloaded) (R1-7)
function Test-TalosPayloadBundle($Payload) {
  if (-not (Test-Path -LiteralPath $Payload.Bundle)) { return $false }
  (Get-FileHash -LiteralPath $Payload.Bundle -Algorithm SHA256).Hash.ToLower() -eq $Payload.BundleSha256
}

if (-not ('TalosWin.FinalPath' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace TalosWin {
  public static class FinalPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
    // the path Windows itself resolves a folder to: links, junctions, subst drives and 8.3 names all followed. null if it
    // cannot be opened. FILE_FLAG_BACKUP_SEMANTICS (0x02000000) is what opens a folder; access 0 reads nothing in it.
    public static string Of(string path) {
      using (SafeFileHandle h = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
        if (h.IsInvalid) return null;
        StringBuilder sb = new StringBuilder(32768);
        uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
        if (n == 0 || n >= sb.Capacity) return null;
        return sb.ToString();
      }
    }
  }
}
'@
}

<#
  The folder to share, as Windows resolves it, or a throw that says why not (R1-4). Refused: not a folder; a link, junction
  or other reparse point in ANY part of the path (C:\Users\you\Projects as a junction to C:\Windows passes a check of the
  last part alone); a network folder. What is returned is the real path (8.3 names and subst drives resolved), and that is
  what talos-wsl.sh then checks against its own refusals.
#>
function Resolve-TalosShareFolder([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item -or -not $item.PSIsContainer) { throw "not a folder: $Path" }
  $full = $item.FullName.TrimEnd('\')
  if ($full -match '^\\\\') { throw 'a network folder is not shared' }
  # every part from the drive down: C:\Users, C:\Users\you, C:\Users\you\Projects, ...
  $parts = $full -split '\\'
  for ($i = 1; $i -lt $parts.Count; $i++) {
    $at = ($parts[0..$i] -join '\')
    $p = Get-Item -LiteralPath $at -Force -ErrorAction SilentlyContinue
    if (-not $p) { throw "cannot read $at" }
    if ($p.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$at is a link, junction or cloud placeholder; share the real folder it points to instead"
    }
  }
  return Get-TalosFinalPath $full
}

# C:\x as Windows resolves it (links, subst, 8.3 names followed), on a drive, or a throw
function Get-TalosFinalPath([string]$Path) {
  $final = [TalosWin.FinalPath]::Of($Path)
  if (-not $final) { throw "Windows cannot resolve $Path" }
  if ($final -match '^\\\\\?\\UNC\\') { throw 'a network folder is not shared' }
  $final = $final -replace '^\\\\\?\\', ''
  if ($final -notmatch '^[A-Za-z]:\\') { throw "$Path resolves to $final, which is not a folder on a drive" }
  return $final.TrimEnd('\')
}

<#
  A file for root inside the distro, with nothing in between that the talos user (or anyone) could swap (R1-2): its bytes
  (LF line ends), gzipped, as base64, and the SHA-256 of the bytes themselves. install.ps1 hands both to a root shell as
  arguments; root decodes, unzips, checks the hash and installs it root-owned. No file is left where another user could
  write first. Gzipped so the scripts fit on one Windows command line (32767 characters): talos-wsl.sh is 27 KB.
#>
function ConvertTo-TalosRootPayload([string]$Text) {
  $bytes = (New-Object Text.UTF8Encoding $false).GetBytes(($Text -replace "`r`n", "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
  $out = New-Object IO.MemoryStream
  $gz = New-Object IO.Compression.GZipStream($out, [IO.Compression.CompressionMode]::Compress)
  $gz.Write($bytes, 0, $bytes.Length)
  $gz.Close()
  New-Object PSObject -Property @{ Base64 = [Convert]::ToBase64String($out.ToArray()); Sha256 = $hash }
}
# the bytes back from a payload, as root's side reads them (for the tests)
function ConvertFrom-TalosRootPayload([string]$Base64) {
  $in = New-Object IO.MemoryStream(, [Convert]::FromBase64String($Base64))
  $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
  $out = New-Object IO.MemoryStream
  $gz.CopyTo($out)
  $gz.Close()
  , $out.ToArray()
}
# root's side of it: $1 the base64, $2 where it goes, $3 the hash. No quote marks at all: Windows PowerShell 5.1 drops them
# from native arguments. The paths it is given have no spaces.
$script:RootInstallSh = 'mkdir -p ${2%/*} && printf %s $1 | base64 -d | gzip -dc > $2.tmp && [ $(sha256sum < $2.tmp | cut -c1-64) = $3 ] && install -m 755 -o root -g root $2.tmp $2; r=$?; rm -f $2.tmp; exit $r'

# a git URL without its login (R1-5): https://user:token@host/x.git is https://host/x.git; nothing these scripts print, or
# hand to the distro, carries a secret
function Remove-TalosUrlLogin([string]$Url) { $Url -replace '^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@', '$1' }

# A `hold` left running by a keep-alive or tray that is gone (its task stopped, its PowerShell killed: the wsl.exe it started
# outlives it). The one holding the single-instance lock calls this first: the lock means no other keep-alive is alive, so
# any hold for this distro is a leftover, and one would keep the distro held after Quit. Only exactly that command line.
<#
  What the tray shows for one answer of `talos-wsl.sh status` (Fable R1-1, R1-2, R1-6 on edb035b3): its colour, the words,
  and what it read. The answer is two lines, `isolated=<yes|no>` first, then `supervisor=<word> main=<state>`; $null or
  anything else is no answer.
  - isolated=no is red whatever else the answer holds or lacks; the root side is stopping the agent then, and the words say
    which: "stopping Talos" while systemd still has the supervisor up, "Talos is stopped" after.
  - With no isolated line at all, it is amber ("not answering"), never green.
  - Green only for isolated=yes, supervisor=active and main=running with the launch approved. main=unknown (the
    supervisor says nothing of Claude) is amber, "Talos is up; Claude's state isn't known yet" (Pantheon, 2026-11-12).
#>
function Get-TalosTrayView([string]$Text) {
  $iso = 'unknown'; $sup = 'unknown'; $main = 'unknown'; $launch = 'unknown'
  foreach ($l in @("$Text" -split "`r?`n")) {
    $l = ($l -replace "`0", '').Trim()
    if ($l -match '^isolated=(yes|no)$') { $iso = $Matches[1] }
    elseif ($l -match '^supervisor=([a-z]+) main=([a-z_:]+)( launch=([a-z]+))?$') {
      $sup = $Matches[1]; $main = $Matches[2]; if ($Matches[4]) { $launch = $Matches[4] }
    }
  }
  $up = $sup -in 'active', 'activating', 'deactivating', 'reloading'
  if ($iso -eq 'no') {
    $c = 'red'; $w = if ($up) { 'not cut off from Windows: stopping Talos' } else { 'not cut off from Windows: Talos is stopped' }
  } elseif ($iso -ne 'yes') {
    $c = 'amber'; $w = 'the distro is not answering'
  } else {
    switch ($sup) {
      'active' {
        if ($main -eq 'signin') { $c = 'amber'; $w = 'not signed in to Claude (choose Sign in to Claude)' }
        elseif ($launch -eq 'pending') { $c = 'amber'; $w = 'waiting for you to approve how it starts (choose Approve this change)' }
        elseif ($launch -eq 'unapprovable') { $c = 'amber'; $w = 'waiting: its launch settings are not ones Talos can approve' }
        elseif ($launch -eq 'none') { $c = 'amber'; $w = 'waiting: Talos is not set up to start Claude yet (run Talos Setup again)' }
        elseif ($main -eq 'waiting:dev_channels') { $c = 'amber'; $w = 'waiting to start: Talos could not check its launch settings' }
        elseif ($main -like 'waiting:*') { $c = 'amber'; $w = 'starting (Claude is answering its first questions)' }
        # green only when the supervisor says Main runs (Pantheon, 2026-11-12): never "running" for an install that is
        # not signed in, or one whose supervisor does not say how Claude is
        elseif ($main -eq 'running') { $c = 'green'; $w = 'running' }
        elseif ($main -eq 'starting') { $c = 'amber'; $w = 'starting Claude' }
        elseif ($main -eq 'stopped') { $c = 'amber'; $w = 'Talos is up; Claude is stopped (choose Restart Talos)' }
        else { $c = 'amber'; $w = "Talos is up; Claude's state isn't known yet" }
      }
      { $_ -in 'activating', 'reloading' } { $c = 'amber'; $w = 'starting' }
      'failed' { $c = 'red'; $w = 'failed (the log folder has the keep-alive log)' }
      { $_ -in 'inactive', 'deactivating' } { $c = 'red'; $w = 'stopped' }
      default { $c = 'amber'; $w = 'not known (Talos did not answer in time)' }
    }
  }
  New-Object PSObject -Property @{ Colour = $c; Words = $w; Isolated = $iso; Supervisor = $sup; Main = $main; Launch = $launch }
}

<#
  "Pair a phone..." in the tray, from the same view the dot comes from (Pantheon, 2026-11-12): offered only while the dot is
  green AND the supervisor says Main is running (main=running), so its bridge can pin a phone. Otherwise it is greyed, and
  says why: "Sign in to Claude first" while Main waits on a sign-in, "once the dot is green" for anything else. pair.py
  refuses on its own too (not-ready).
#>
function Get-TalosPairItem($View) {
  if ($View -and $View.Colour -eq 'green' -and $View.Main -eq 'running') {
    return New-Object PSObject -Property @{ Enabled = $true; Text = 'Pair a phone...' }
  }
  $why = if ($View -and $View.Main -eq 'signin') { 'Sign in to Claude first' } else { 'once the dot is green' }
  New-Object PSObject -Property @{ Enabled = $false; Text = "Pair a phone ($why)" }
}

# ---- "Open a thread's session" (tray.ps1) ----------------------------------------------------------------------------------
# The threads come from `talos-app supervise threads --json`, run as talos through talos-wsl.sh's isolation gate. That is
# talos's output, so it is read strictly: an id that is not a thread id is dropped, a name loses its control characters, is
# cut to 40 characters and has its & doubled (a menu would take it as a shortcut key), and only a JSON true is "running".
# Only an id that passed goes back into a command line, and only as one argument of wsl.exe; a name never does.
# \z, not $: $ also matches before a final newline (Fable on 3b046779)
$script:TalosThreadIdPattern = '^[a-z][a-z0-9_]{0,31}\z'
# The CLI as the supervisor's own unit runs it (talos-supervisor.service: bun, the checkout's cli.ts, TALOS_APP_HOME), not
# the talos-app wrapper: install.sh writes that only once the bridge has its relay address (a Setup built without one has
# none), and the wrapper is `#!/usr/bin/env bun`, which `wsl --exec`'s PATH would not find either (Fable on 3b046779).
# --no-env-file: a .env in talos's home is never read. The list also gets a time limit inside the distro.
$script:TalosAppRun = @('/usr/bin/timeout', '10', '/usr/bin/env', 'TALOS_APP_HOME=/home/talos/.config/talos/app',
  'PATH=/home/talos/.bun/bin:/home/talos/.local/bin:/usr/local/bin:/usr/bin:/bin', '/home/talos/.bun/bin/bun', '--no-env-file',
  '/home/talos/talos-app/apps/bridge/src/cli.ts')
function Get-TalosMenuText([string]$Name, [string]$Fallback) {
  $n = ($Name -replace '[\p{Cc}\p{Cf}]', '').Trim()
  if (-not $n) { $n = $Fallback }
  if ($n.Length -gt 40) {
    $cut = 37
    if ([char]::IsHighSurrogate($n[$cut - 1])) { $cut-- } # never half a character
    $n = $n.Substring(0, $cut) + '...'
  }
  $n -replace '&', '&&'
}
# callers take it as @(ConvertFrom-TalosThreadList ...): no list is an empty array, one thread an array of one
function ConvertFrom-TalosThreadList([string]$Json) {
  $items = @()
  try { $o = $Json | ConvertFrom-Json -ErrorAction Stop } catch { return @() }
  if (-not $o -or $o -isnot [PSCustomObject] -or -not ($o.PSObject.Properties.Name -contains 'threads')) { return @() }
  foreach ($t in @($o.threads)) {
    if ($items.Count -ge 30) { break }
    if (-not $t -or $t -isnot [PSCustomObject]) { continue }
    $id = "$($t.id)"
    if ($id -cnotmatch $script:TalosThreadIdPattern) { continue }
    $items += New-Object PSObject -Property @{ Id = $id; Name = (Get-TalosMenuText "$($t.name)" $id); Running = ($t.running -is [bool] -and $t.running) }
  }
  $items
}
function Get-TalosThreadItem($Thread) {
  if ($Thread.Running) { return New-Object PSObject -Property @{ Enabled = $true; Text = $Thread.Name } }
  New-Object PSObject -Property @{ Enabled = $false; Text = "$($Thread.Name) (not running)" }
}
# Offered whenever the supervisor runs in a distro cut off from Windows: the list and the window need only it and tmux, not
# Main. A thread can wait on her while Main does not (Main on a dialog, or starting): the bridge's notice that names this
# item must always find it there (Hestia, on the green-only rule, 2026-11-14).
function Get-TalosSessionsItem($View) {
  if ($View -and $View.Isolated -eq 'yes' -and $View.Supervisor -in 'active', 'reloading') {
    return New-Object PSObject -Property @{ Enabled = $true; Text = "Open a thread's session..." }
  }
  New-Object PSObject -Property @{ Enabled = $false; Text = "Open a thread's session (once Talos is running)" }
}
# wsl.exe's arguments for the window onto one thread's session (talos-app supervise attach --window: the thread's name and how
# to leave in its title and first line). Start-Process joins them with spaces, so none may hold one: the distro name is
# checked here, the id is a thread id, the rest is fixed.
function Get-TalosAttachArgs([string]$Distro, [string]$Id) {
  if ($Id -cnotmatch $script:TalosThreadIdPattern) { throw "'$Id' is not a thread id" }
  if ($Distro -cnotmatch $TalosDistroName) { throw "'$Distro' is not a distro name" }
  # no time limit for the window itself: it stays open as long as she looks
  @('-d', $Distro, '-u', 'talos', '--cd', '~', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'run', '--') + $script:TalosAppRun[2..($script:TalosAppRun.Count - 1)] + @('supervise', 'attach', $Id, '--window')
}
function Get-TalosThreadListArgs([string]$Distro) {
  if ($Distro -cnotmatch $TalosDistroName) { throw "'$Distro' is not a distro name" }
  @('-d', $Distro, '-u', 'talos', '--cd', '~', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'run', '--') + $script:TalosAppRun + @('supervise', 'threads', '--json')
}
# ---- "Check Talos" (tray.ps1) --------------------------------------------------------------------------------------------------
# `doctor --json` as talos through the isolation gate, for the agent folder Setup made, at most 90 s inside the distro. Its
# rows are talos's output: only the three levels doctor has are kept, the name and detail lose their control characters
# and are cut, and at most 80 rows are shown. The one fix that matters is chosen from the rows, in this order: the server
# turned this PC's key away (copy the key root kept at the first install), the kit (Update the kit), Talos not running
# (Restart Talos). The key itself never comes from these rows: Copy the relay key asks root (talos-wsl.sh relay-key).
function Get-TalosDoctorArgs([string]$Distro) {
  if ($Distro -cnotmatch $TalosDistroName) { throw "'$Distro' is not a distro name" }
  @('-d', $Distro, '-u', 'talos', '--cd', '~', '--exec', '/opt/talos-wsl/talos-wsl.sh', 'run', '--', '/usr/bin/timeout', '90') +
    $script:TalosAppRun[2..($script:TalosAppRun.Count - 1)] + @('doctor', '--json', '--agent-dir', '/home/talos/talos-agent')
}
function Get-TalosCleanText([string]$Text, [int]$Max) {
  $t = ($Text -replace '[\p{Cc}\p{Cf}]', ' ').Trim()
  if ($t.Length -gt $Max) {
    $cut = $Max - 3
    if ([char]::IsHighSurrogate($t[$cut - 1])) { $cut-- }
    $t = $t.Substring(0, $cut) + '...'
  }
  $t
}
# callers take it as @(ConvertFrom-TalosDoctor ...)
function ConvertFrom-TalosDoctor([string]$Json) {
  $rows = @()
  try { $o = $Json | ConvertFrom-Json -ErrorAction Stop } catch { return @() }
  if (-not $o -or $o -isnot [PSCustomObject] -or -not ($o.PSObject.Properties.Name -contains 'checks')) { return @() }
  foreach ($c in @($o.checks)) {
    if ($rows.Count -ge 80) { break }
    if (-not $c -or $c -isnot [PSCustomObject]) { continue }
    $level = "$($c.level)"
    if ($level -cnotin 'ok', 'warn', 'FAIL') { continue }
    $name = Get-TalosCleanText "$($c.name)" 80
    if (-not $name) { continue }
    $rows += New-Object PSObject -Property @{ Level = $level; Name = $name; Detail = (Get-TalosCleanText "$($c.detail)" 400) }
  }
  $rows
}
# FAIL rows, then warn, then ok, each in doctor's own order
function Sort-TalosDoctorRows($Rows) {
  $rows = @($Rows)
  @($rows | Where-Object { $_.Level -ceq 'FAIL' }) + @($rows | Where-Object { $_.Level -ceq 'warn' }) + @($rows | Where-Object { $_.Level -ceq 'ok' })
}
# a level in plain words, for the window
function Get-TalosDoctorWord([string]$Level) {
  switch -CaseSensitive ($Level) { 'ok' { 'OK' } 'warn' { 'Check' } 'FAIL' { 'Problem' } default { '?' } }
}
# The doctor rows the window words itself (apps/bridge/src/doctor-checks.ts and cli-main.ts describeBridge; a Pester test pins
# these names and openings to that source): the link to the phone, by the state its detail opens with.
$script:TalosBridgeRow = 'live bridge (status.json)'
$script:TalosBridgeDown = @('no status.json', 'the bridge is not running', 'status.json stopped updating')
function Test-TalosBridgeDown($Row) {
  if (-not $Row -or $Row.Name -ne $script:TalosBridgeRow -or $Row.Level -ceq 'ok') { return $false }
  foreach ($p in $script:TalosBridgeDown) { if ($Row.Detail.StartsWith($p, [StringComparison]::Ordinal)) { return $true } }
  $false
}
# a row in the window's own words where it knows the row, else doctor's (with "this Mac" read as this PC)
function Get-TalosDoctorPlain($Row) {
  $ok = $Row.Level -ceq 'ok'
  switch ($Row.Name) {
    'relay accepts this Mac' {
      return New-Object PSObject -Property @{ Label = 'Server accepts this PC'; Text = $(if ($ok) { 'Yes.' } else { "No: your server turned away this PC's key." }) }
    }
    'relay /healthz' {
      $t = if ($ok) { 'Yes.' } elseif (Get-TalosLookupFailHost @($Row)) { "No: Talos can't look up your server's address." } else { "No: Talos cannot reach your server. Check this PC's internet connection." }
      return New-Object PSObject -Property @{ Label = 'Server reachable'; Text = $t }
    }
    'relay URL' {
      return New-Object PSObject -Property @{ Label = 'Server address'; Text = $(if ($ok) { 'Set.' } else { "Not set yet: run Talos Setup with your server's address." }) }
    }
    'kit files' {
      return New-Object PSObject -Property @{ Label = 'Agent folder files'; Text = $(if ($ok) { 'As Talos installed them.' } else { 'Some changed since Talos installed them. If you did not change them, send the log folder to whoever helps you.' }) }
    }
  }
  if ($Row.Name -eq $script:TalosBridgeRow) {
    $t = if ($ok) { 'Running.' } elseif (Test-TalosBridgeDown $Row) { 'Not running.' }
    elseif ($Row.Detail -like '*was replaced by another bridge*') { 'Another copy of Talos with the same key took this link over; only the newest one gets your messages.' }
    else { 'Running, not connected to your server yet; it keeps trying by itself.' }
    return New-Object PSObject -Property @{ Label = 'Link to your phone'; Text = $t }
  }
  New-Object PSObject -Property @{ Label = ($Row.Name -replace '\bthis Mac\b', 'this PC'); Text = ($Row.Detail -replace '\bthis Mac\b', 'this PC') }
}
# The one fix that matters, from the rows: the server turned this PC's key away (copy root's key), or the link to the phone is
# down (Restart Talos, with its own confirmation). Never the kit: its only doctor row says the agent folder changed, which
# a kit update does not fix, and root seals only what talos built (Fable on fd5d3aae).
# The server's host when doctor's relay row failed to LOOK IT UP (getaddrinfo ENOTFOUND/EAI_AGAIN <host>), not to reach it: the
# case where WSL's own DNS has stopped while Windows is online (seen on Titan, 2026-11-14). Only a plain host name.
function Get-TalosLookupFailHost($Rows) {
  foreach ($r in @($Rows)) {
    if (-not $r -or $r.Level -cne 'FAIL' -or $r.Name -ne 'relay /healthz') { continue }
    if ($r.Detail -cmatch '(?:ENOTFOUND|EAI_AGAIN)\s+([A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+)\b') {
      return $Matches[1]
    }
  }
  $null
}
# The one fix that matters (see above). $WindowsResolves: Windows itself looked up the host Talos could not (the tray asks
# Windows, Resolve-DnsName): then it is WSL's own name lookup that stopped, and only what is known to help is said.
function Get-TalosDoctorFix($Rows, [bool]$WindowsResolves = $false) {
  $rows = @($Rows)
  $fail = @($rows | Where-Object { $_.Level -ceq 'FAIL' })
  if ($rows | Where-Object { $_.Level -ceq 'FAIL' -and $_.Name -eq 'relay accepts this Mac' }) {
    return New-Object PSObject -Property @{ Kind = 'relay-key'; Button = 'Copy the relay key'
      Text = "Your server turned away this PC's key, so your phone cannot reach Talos. Copy the key, set it as BRIDGE_PUBKEY in your server's settings (on Railway: the relay's Variables), and deploy again." }
  }
  if ($WindowsResolves -and (Get-TalosLookupFailHost $rows)) {
    return New-Object PSObject -Property @{ Kind = 'none'; Button = ''
      Text = "This PC is online, but Talos's Linux part can't look up your server's address (a Windows networking problem). If you use a VPN, try turning it off. Restarting the PC may fix it; if it doesn't, tell whoever set up Talos for you." }
  }
  if ($rows | Where-Object { Test-TalosBridgeDown $_ }) {
    return New-Object PSObject -Property @{ Kind = 'restart'; Button = 'Restart Talos...'; Text = "Talos's link to your phone is not running. Restart Talos to start it again." }
  }
  $words = if ($fail.Count -eq 0) { 'Talos looks healthy.' } else { "Talos found $($fail.Count) problem$(if ($fail.Count -ne 1) { 's' }); the lines below say which. If you need help, send them with the log folder." }
  New-Object PSObject -Property @{ Kind = 'none'; Button = ''; Text = $words }
}
# root's relay-key answer: the key line Setup first showed, and whether talos's own key has changed since (then it is not
# copied as a fix: it would not match what the bridge now uses). Anything else is no key.
function Get-TalosRelayKeyLine([string]$Text) {
  $lines = @(($Text -replace "`0", '') -split "`r?`n" | Where-Object { $_.Trim() })
  $key = if ($lines.Count -ge 1 -and $lines[0] -cmatch '^BRIDGE_PUBKEY=[A-Za-z0-9_-]{43}\z') { $lines[0] } else { $null }
  New-Object PSObject -Property @{ Line = $key; Changed = ($lines -ccontains 'changed') }
}

# talos's answer, at most 64 KB of it (the list of 30 threads is far less): read in pieces, never all of a runaway output
function Read-TalosBounded([IO.StreamReader]$Reader, [int]$Max = 65536) {
  $buf = New-Object char[] 8192
  $sb = New-Object Text.StringBuilder
  while ($sb.Length -lt $Max) {
    $n = $Reader.Read($buf, 0, [Math]::Min($buf.Length, $Max - $sb.Length))
    if ($n -le 0) { break }
    [void]$sb.Append($buf, 0, $n)
  }
  $sb.ToString()
}

# whether a wsl.exe command line is exactly the hold for this distro: the program (quoted or not), then those arguments and
# nothing else (Fable R1-6 on edb035b3: an exact match, not one that only ends the same way)
function Test-TalosHoldCommandLine([string]$CommandLine, [string]$Distro) {
  if (-not $CommandLine) { return $false }
  $rest = $CommandLine.Trim() -replace '^("[^"]*"|\S+)\s+', ''
  return ($rest -ceq "-d $Distro -u root --exec /opt/talos-wsl/talos-wsl.sh hold")
}

<#
  What "Approve this change" shows (Fable R2-4 on c9a60023, R3-3 and R3-5 on a44344c2), from root's `talos-wsl.sh
  launch-check` JSON. The lines are root's own (launch.py display): each argument on its own line, quoted, every character
  a person could not see for what it is written out, added and removed arguments first. They are shown as they are, never
  rebuilt here from the values. Approve is offered only when root says they could be shown in full (display_ok) and the
  launch is not approved yet, and only for the fingerprint root worked out (root refuses any other).
  Returns Ok, Approved, CanApprove, Fingerprint and Text; Ok is false for an answer it cannot read.
#>
function Format-TalosLaunchChange([string]$Json) {
  $c = $null
  # exactly one JSON document, and nothing else that looks like one (Fable R4-1): more than one line starting with { is no
  # answer at all, never "the last one"
  $docs = @("$Json" -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })
  if ($docs.Count -eq 1) { try { $c = $docs[0] | ConvertFrom-Json } catch { } }
  if (-not $c -or "$($c.fingerprint)" -notmatch '^[0-9a-f]{64}$' -or $null -eq $c.display) {
    return New-Object PSObject -Property @{ Ok = $false; Approved = $false; CanApprove = $false; Fingerprint = ''
      Text = 'Talos could not read how it starts Claude. Try again in a minute.' }
  }
  # root writes ASCII only (escaped); anything else in a line is not shown
  $lines = @($c.display | ForEach-Object { "$_" -replace '[^\x20-\x7e]', '?' })
  $head = if ($c.approved) {
    'Nothing to approve: Talos starts Claude exactly as you approved before.'
  } elseif (-not $c.display_ok) {
    'This cannot be approved here: part of it cannot be shown in full. Ask whoever set this PC up.'
  } elseif ($c.first) {
    # nothing approved yet (a first install that stopped before its approval, R4-6): not "changed"
    "Talos has not been approved to start Claude yet. Approve only if you expected this (you just set up Talos, for example).`r`nApproving means: from now on Claude in Talos starts with exactly these settings, without asking you again."
  } else {
    "How Talos starts Claude has changed. Approve only if you expected this (an update you ran, for example).`r`nApproving means: from now on Claude in Talos starts with exactly these settings, without asking you again."
  }
  New-Object PSObject -Property @{
    Ok = $true; Approved = [bool]$c.approved; CanApprove = ((-not $c.approved) -and [bool]$c.display_ok)
    Fingerprint = "$($c.fingerprint)"; Text = ($head + "`r`n`r`n" + ($lines -join "`r`n"))
  }
}

# signin.py's failure ids (its WHY set; a test holds the two equal): the only part of a sign-in failure the log keeps
$script:TalosSignInWhy = @('no_user', 'no_claude', 'no_link', 'code_wait', 'not_a_code', 'no_answer', 'unreadable', 'not_saved',
  'offline', 'not_accepted', 'expired', 'other')

# The list entry that equals $x character for character, or $null. PowerShell's -ccontains is case-sensitive but not
# ordinal (a soft hyphen inside "link" still matches), and the line returns the entry, never the input (Pantheon, 2026-11-18).
function Find-TalosLogWord([string[]]$List, [string]$x) {
  foreach ($w in $List) { if ([string]::Equals($w, $x, [StringComparison]::Ordinal)) { return $w } }
  return $null
}

# What the tray log says for one sign-in event: the event's name, and for an error which fixed failure it was. Never the
# code, the link or any sentence: an id that is not on the list is logged as "unknown" (Pantheon, 2026-11-18).
function Format-TalosSignInLogLine($e) {
  # only signin.py's own event names are logged; any other name is "unknown"
  $ev = Find-TalosLogWord @('url', 'code', 'signed_in', 'error') "$($e.event)"
  if (-not $ev) { return 'unknown' }
  if ($ev -ne 'error') { return $ev }
  $why = Find-TalosLogWord $script:TalosSignInWhy "$($e.why)"
  if ($why) { return "error ($why)" }
  return 'error (unknown)'
}

# pair.py's error codes for the log: its ERROR_CODES, the three it sends itself (not-ready, enroll, link), and the ones
# Get-TalosPairText names
$script:TalosPairErrorCodes = @('usage', 'key_refused', 'relay', 'no_relay', 'bad_words', 'internal', 'not-ready', 'enroll', 'link')

# What the tray log says for one "Pair a phone" event: pair.py's own event name, and for an error which fixed code it was.
# Never the link, the code, the words or any sentence: anything else is logged as "unknown" (Pantheon, 2026-11-18).
function Format-TalosPairLogLine($e) {
  # only pair.py's own event names are logged; any other name is "unknown"
  $ev = Find-TalosLogWord @('link', 'qr', 'confirm', 'answered', 'pinned', 'not_pinned', 'used', 'expired', 'error', 'warning') "$($e.event)"
  if (-not $ev) { return 'unknown' }
  if ($ev -ne 'error') { return $ev }
  $code = Find-TalosLogWord $script:TalosPairErrorCodes "$($e.code)"
  if ($code) { return "error ($code)" }
  return 'error (unknown)'
}

# root's fixed words, from talos-wsl.sh (restart, restore) and kit.py (kit-update); the only words the root-verb log keeps
$script:TalosRootWords = @('restored', 'restarted', 'not-approved', 'nothing-saved', 'nothing-to-do', 'not-isolated', 'failed',
  'not-root', 'kit-updated', 'kit-policy-updated', 'kit-current', 'kit-no-release', 'kit-bad-release', 'kit-version-taken',
  'kit-policy-foreign', 'kit-unsafe-path', 'kit-busy')

# What the tray log says for a root verb's output: each word root knows, once and in the list's order, then one "unknown" if
# any other word came, so no link, code or letter of wsl.exe's own text reaches the log (Pantheon, 2026-11-18).
function Format-TalosRootVerbLogLine([string]$Out) {
  $words = @(("$Out" -replace "`0", '') -split '\s+' | Where-Object { $_ })
  $seen = @{}
  $unknown = $false
  foreach ($t in $words) {
    $w = Find-TalosLogWord $script:TalosRootWords $t
    if ($w) { $seen[$w] = $true } else { $unknown = $true }
  }
  # each known word at most once, in the list's own order (not the input's), then one "unknown" if any word was not root's:
  # the line is never longer than the list plus one, and the distro chooses neither count nor order (Opus review, 2026-11-18)
  $line = @($script:TalosRootWords | Where-Object { $seen[$_] })
  if ($unknown) { $line += 'unknown' }
  return ($line -join ' ')
}

<#
  What "Pair a phone" says for each event pair.py passes on (talos-app enroll --json, Cyclops's contract in docs/bridge.md),
  in plain words: $null for an event that only changes the picture (qr). Fields were already checked and cleaned by pair.py
  inside the distro; the error text is still cut short here.
#>
function Format-TalosPairWords($e) {
  # the four words as the window shows them; pair.py sends them ASCII-escaped ("Yucat\u00e1n"), and ConvertFrom-Json
  # gives back the letter itself (Fable on 84354b1f)
  return (@($e.words) -join '  ')
}

function Get-TalosPairText($e) {
  switch ("$($e.event)") {
    'link' { return "On your iPhone, open the Talos app and scan this code, or open the link below on the phone. It works once, for 10 minutes." }
    # pair.py passes only these two warning codes (the no-live-bridge one ends the pairing there); anything else shows nothing
    'warning' {
      switch ("$($e.code)") {
        'no_fp' { return 'This code has no key check for the Talos app. A browser can still use the link; for the app, start again.' }
        'old_relay' { return 'Your relay is older than the Talos app needs. A browser can still use the link.' }
        default { return $null }
      }
    }
    'confirm' { return 'Do these four words match your phone?' }
    'answered' { if ($e.yes) { return 'Thanks. Finishing the pairing...' } else { return 'Not paired: the words did not match, or you said No. Start again if you want to pair.' } }
    'pinned' { return 'Paired. Your iPhone can now reach Talos.' }
    'not_pinned' { return "Your answer was saved, but Talos's connection did not finish the pairing within a minute. Check that the icon is green, then start again." }
    'used' { return 'That pairing link was used or cancelled somewhere else. Start again if you still want to pair.' }
    'expired' { return 'The link expired (10 minutes). Start again when your phone is ready.' }
    'error' {
      $why = switch ("$($e.code)") {
        'key_refused' { "The relay turned this PC's key away. Whoever runs your relay needs this PC's key first." }
        'relay' { 'Talos could not reach your relay. Check the internet connection, then start again.' }
        # no relay set on this PC at all (pair.py: no /etc/talos/relay of root's): nothing the internet would fix
        'no_relay' { 'This Talos has no relay set yet, so it cannot pair a phone. Whoever set up Talos for you adds the relay; then pair from here.' }
        'link' { 'Pairing stopped: the pairing link did not point at your relay, so it was not shown. Tell whoever set this PC up.' }
        # pair.py's own end when enroll says no bridge is live: nothing was shown, so no phone is half-paired
        # a green dot means Claude's input box is up, not that the bridge is on the relay yet (Fable R1-1 on 0770142f)
        'not-ready' { "Talos is still connecting, so nothing was shown and no phone was paired. If the dot is amber, sign in to Claude first; if it is green, try again in a minute." }
        # nothing from enroll's own text is shown (it is talos's): a fixed sentence and the code only
        default { $code = "$($e.code)" -replace '[^a-z_]', ''; "Pairing stopped ($code). Start again; if it keeps stopping, the log folder has the details." }
      }
      return $why
    }
    default { return $null }
  }
}

<#
  "Pair a phone"'s rules, apart from the window so Pester can hold them (Fable R5-4 on 5fc143ef):
  - one question only: a second `confirm` is not asked again;
  - Yes and No do nothing until 1.5 s after the words appear (a click already on its way is not an answer);
  - one answer only;
  - closing the window with the question open answers no;
  - "Paired" only after a confirm the person answered yes (Fable R5-2).
#>
function New-TalosPairState { @{ Confirmed = $false; ShownAt = $null; Answered = $false; Answer = $null } }
function Set-TalosPairConfirm($State, [datetime]$Now) {
  if ($State.Confirmed) { return $false }
  $State.Confirmed = $true; $State.ShownAt = $Now
  return $true
}
function Test-TalosPairArmed($State, [datetime]$Now) {
  [bool]($State.Confirmed -and -not $State.Answered -and $State.ShownAt -and ($Now - $State.ShownAt).TotalMilliseconds -ge 1500)
}
# the line to send for a click, or $null when the click is not an answer (too soon, or already answered)
function Get-TalosPairAnswer($State, [string]$Choice, [datetime]$Now) {
  if (-not (Test-TalosPairArmed $State $Now)) { return $null }
  $State.Answered = $true
  $State.Answer = if ($Choice -ceq 'y') { 'y' } else { 'n' }
  return $State.Answer
}
function Get-TalosPairCloseAnswer($State) {
  if ($State.Confirmed -and -not $State.Answered) { $State.Answered = $true; $State.Answer = 'n'; return 'n' }
  return $null
}
function Test-TalosPairPaired($State) { [bool]($State.Confirmed -and $State.Answer -ceq 'y') }

<#
  What "Start Talos" / "Restart Talos" and "Restore last good setup" say for root's fixed words (talos-wsl.sh restart and
  restore print one word a line, never talos's own text). $Text is the verb's stdout.
#>
<#
  What uninstall.ps1 removes from %LOCALAPPDATA%\Talos at its end: everything Talos put there, by name, and nothing else.
  bin (the tray, the keep-alive and uninstall itself), Setup's unpacked copy, its settings, logs and status files, the relay
  key note. The distro's disk (wsl\) stays while the distro does: it is the owner's agent and its memory. A file Talos did not
  put there is never touched, and the folder is removed only when it ends up empty. A name still in use (a window open in
  bin, say) is removed by a hidden PowerShell that retries for up to 10 minutes once this one ends, and only while it is the
  same one: anything made after this uninstall began (Setup run again) is never touched.
  -SharedKept: another Talos install on this PC still uses bin and Setup's files (another keep-alive task), or WSL could not
  say which distros there are: only this distro's own log goes.
#>
$script:TalosHomeLeftovers = @('bin', 'setup', 'settings.json', 'setup.log', 'setup-status.txt', 'relay-key.txt')
# What stays in bin while the distro is kept (Pantheon: the Windows user has no terminal, so the way to finish later is a
# Start menu entry that runs this uninstall again, with -RemoveDistro): the uninstall and the file it loads
$script:TalosUninstallerFiles = @('uninstall.ps1', 'TalosWin.ps1')
$script:TalosRemoveShortcutName = 'Remove Talos and its data.lnk'
function Get-TalosStartMenuDir { [Environment]::GetFolderPath('Programs') }
# one entry per distro: the usual one plainly named, another distro's with its name (a second install never overwrites it)
function Get-TalosRemoveShortcutName([string]$Distro = 'talos') {
  if ($Distro -eq 'talos') { return $script:TalosRemoveShortcutName }
  "Remove Talos and its data ($Distro).lnk"
}

<#
  The Start menu entry "Remove Talos and its data": this user's own Start menu (no administrator), running the copy of
  uninstall.ps1 in bin with -RemoveDistro -Pause in a window of its own, so the typed name and what was done can be read.
  Setup makes it; uninstall keeps it while the distro is kept, and removes it with the rest once nothing is left.
#>
function New-TalosRemoveShortcut([string]$BinDir, [string]$StartMenu = (Get-TalosStartMenuDir), [string]$Distro = 'talos') {
  if ($Distro -cnotmatch $script:TalosDistroName -or $Distro -match '\.\.') { throw "'$Distro' is not a distro name" }
  $lnk = Join-Path $StartMenu (Get-TalosRemoveShortcutName $Distro)
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $ps
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $BinDir 'uninstall.ps1')`" -Distro `"$Distro`" -RemoveDistro -Pause"
  $s.WorkingDirectory = $env:USERPROFILE
  $s.Description = 'Removes Talos from this PC, its distro included (it asks you to type the name first)'
  $s.Save()
  $lnk
}
function Remove-TalosRemoveShortcut([string]$StartMenu = (Get-TalosStartMenuDir), [string]$Distro = 'talos') {
  $lnk = Join-Path $StartMenu (Get-TalosRemoveShortcutName $Distro)
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; "== removed the Start menu entry '$([IO.Path]::GetFileNameWithoutExtension($lnk))'" }
}
# a distro name as WSL takes it: never a path (Fable on the uninstall change: `-Distro ..\..\x` reached outside the folder)
$script:TalosDistroName = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z'
function Remove-TalosLeftovers([string]$TalosHome, [string]$Distro, [switch]$DistroGone, [switch]$SharedKept, [switch]$KeepUninstaller, [string]$EntryName = '') {
  $lines = @()
  $hint = $null
  if (-not (Test-Path -LiteralPath $TalosHome)) { return $lines }
  $began = [DateTime]::UtcNow
  $names = @()
  if (-not $SharedKept) { $names += @($script:TalosHomeLeftovers | Where-Object { -not $KeepUninstaller -or $_ -ne 'bin' }) }
  # the distro is kept: bin keeps only the uninstall and the file it loads (the Start menu entry runs them); the rest goes
  if ($KeepUninstaller -and -not $SharedKept) {
    $bin = Join-Path $TalosHome 'bin'
    if (Test-Path -LiteralPath $bin) {
      $names += @(Get-ChildItem -LiteralPath $bin -Force | Where-Object { $script:TalosUninstallerFiles -notcontains $_.Name } | ForEach-Object { "bin\$($_.Name)" })
    }
  }
  if ($Distro -cmatch $script:TalosDistroName -and $Distro -notmatch '\.\.') { $names += "keepalive-$Distro.log" }
  $later = @()
  foreach ($n in $names) {
    $p = Join-Path $TalosHome $n
    if (-not (Test-Path -LiteralPath $p)) { continue }
    try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop; $lines += "== removed $p" } catch { $later += $p }
  }
  $wsl = Join-Path $TalosHome 'wsl'
  if (Test-Path -LiteralPath $wsl) {
    # once the distro is gone WSL has deleted its disk; WSL's own icon is all it leaves. Only that goes, by name, and the folder
    # only if that leaves it empty: anything else there (a `wsl --export` backup) is the owner's
    if ($DistroGone -and -not $SharedKept -and -not (Test-Path -LiteralPath (Join-Path $wsl 'ext4.vhdx'))) {
      Remove-Item -LiteralPath (Join-Path $wsl 'shortcut.ico') -Force -ErrorAction SilentlyContinue
      if (-not @(Get-ChildItem -LiteralPath $wsl -Force).Count) {
        try { Remove-Item -LiteralPath $wsl -Force -ErrorAction Stop; $lines += "== removed $wsl" } catch { $later += $wsl }
      } else {
        $lines += "== kept $wsl`: it holds $((Get-ChildItem -LiteralPath $wsl -Force | ForEach-Object Name) -join ', '), which Talos did not put there"
      }
    } elseif (Test-Path -LiteralPath (Join-Path $wsl 'ext4.vhdx')) {
      $gb = [Math]::Round((Get-Item -LiteralPath (Join-Path $wsl 'ext4.vhdx') -Force).Length / 1GB, 1)
      $lines += "== kept $wsl`: the Talos disk (your agent and its memory)"
      # said last, and only naming an entry that was really made (-EntryName: the distro kept by this uninstall)
      if ($KeepUninstaller -and $EntryName) {
        $hint = "Still on this PC: the Talos disk, $gb GB, in $wsl. To remove it later: Start menu, $EntryName."
      }
    }
  }
  if ($later.Count -gt 0) {
    # the paths as base64 (no quoting of a name can break the command), each removed only while it is older than this
    # uninstall: Setup run again in the meantime makes new ones, which are never touched
    $b64 = ($later + $TalosHome | ForEach-Object { "'" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) + "'" }) -join ','
    # It gives up for good the moment Setup's settings or status file is newer than this uninstall (Setup writes them first
    # thing): a reinstall copies into an existing bin, so bin's own age cannot tell, and copied files keep their old times.
    $retry = @'
$cut = [DateTime]::FromBinary(__CUT__)
$all = @(__PATHS__) | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) }
$home_ = $all[-1]; $p = @($all[0..($all.Count - 2)])
for ($i = 0; $i -lt 120; $i++) {
  # only the two files Setup writes first: the distro's disk and a log are written by WSL and the keep-alive, not by Setup
  if (@('settings.json', 'setup-status.txt' | ForEach-Object { Get-Item -LiteralPath (Join-Path $home_ $_) -Force -ErrorAction SilentlyContinue } | Where-Object { $_.LastWriteTimeUtc -gt $cut -or $_.CreationTimeUtc -gt $cut }).Count) { exit 0 }
  $p = @($p | Where-Object { Test-Path -LiteralPath $_ })
  if (-not $p.Count) { break }
  foreach ($x in $p) {
    if ((Split-Path -Leaf $x) -eq 'wsl') {
      if (-not (Test-Path -LiteralPath (Join-Path $x 'ext4.vhdx')) -and -not @(Get-ChildItem -LiteralPath $x -Force).Count) { Remove-Item -LiteralPath $x -Force -ErrorAction SilentlyContinue }
    } else { Remove-Item -LiteralPath $x -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Seconds 5
}
if ((Test-Path -LiteralPath $home_) -and -not @(Get-ChildItem -LiteralPath $home_ -Force).Count) { Remove-Item -LiteralPath $home_ -Force }
'@
    $retry = $retry.Replace('__CUT__', "$($began.ToBinary())").Replace('__PATHS__', $b64)
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($retry))) | Out-Null
    $lines += "== still in use, removed once nothing uses it: $($later -join ', ') (close any window open in it)"
    if ($hint) { $lines += $hint }
    return $lines
  }
  if ($SharedKept) {
    $lines += "== kept Talos's own files in $TalosHome`: another Talos install on this PC still uses them"
    return $lines
  }
  if ($KeepUninstaller -and (Test-Path -LiteralPath (Join-Path $TalosHome 'bin'))) {
    $lines += "== kept $(Join-Path $TalosHome 'bin') ($($script:TalosUninstallerFiles -join ', ')): what that Start menu entry runs"
  }
  $rest = @(Get-ChildItem -LiteralPath $TalosHome -Force)
  $mine = @('wsl') + @(if ($KeepUninstaller) { 'bin' })
  if ($rest.Count -eq 0) {
    Remove-Item -LiteralPath $TalosHome -Force
    $lines += "== removed $TalosHome"
  } elseif (@($rest | Where-Object { $mine -notcontains $_.Name }).Count) {
    $lines += "== kept $TalosHome`: it holds $((@($rest | Where-Object { $mine -notcontains $_.Name }) | ForEach-Object Name) -join ', '), which Talos did not put there"
  }
  if ($hint) { $lines += $hint }
  $lines
}

function Get-TalosRecoveryText([string]$Verb, [string]$Text) {
  $w = @("$Text" -split "`r?`n" | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
  if ($w -contains 'not-isolated') { return "Talos did not do that: its WSL distro is not cut off from Windows right now. Restart the PC, then try again." }
  # root's own launch state was not "approved" (Fable R7-1 on 9612c7d7): nothing was started
  if ($w -contains 'not-approved' -and $w -notcontains 'restored') { return 'Talos did not do that: how it starts Claude is waiting for your approval. Choose Approve this change first.' }
  if ($Verb -eq 'kit-update') {
    # root's fixed words (kit.py); the details are in the log, never shown here
    if ($w -contains 'kit-updated') { return 'Done: the kit is updated. New conversations use it; ones already open keep theirs until they restart.' }
    if ($w -contains 'kit-policy-updated') { return "The kit is up to date. Talos's plugin policy was updated." }
    if ($w -contains 'kit-current') { return 'The kit is already up to date.' }
    if ($w -contains 'kit-no-release') { return 'There is no kit to install yet: Talos inside the distro has not built one. Run Talos Setup again.' }
    if ($w -contains 'kit-bad-release') { return "Talos did not install the kit: the copy Talos built has something in it a kit must not have. Run Talos Setup again; the log folder has the details." }
    if ($w -contains 'kit-version-taken') { return 'Talos did not install the kit: a different kit with the same version is already installed. Update Talos, then try again.' }
    if ($w -contains 'kit-policy-foreign') { return "Talos did not install the kit: this PC's Claude Code policy (/etc/claude-code in the Talos distro) was not written by Talos, and Talos does not change it." }
    if ($w -contains 'kit-unsafe-path') { return "Talos did not install the kit: a folder it goes in is not root's own. The log folder has the details." }
    if ($w -contains 'kit-busy') { return 'The kit is already being updated. Try again in a minute.' }
    return 'Talos could not update the kit. The log folder has the details.'
  }
  if ($Verb -eq 'restore') {
    # what restore-last-good saves and puts back: the agent folder's .mcp.json and its Claude Code settings files, never how
    # Talos starts Claude (supervisor.json): say exactly that (Fable R7-1)
    if ($w -contains 'restored' -and $w -contains 'restarted') { return "Done: the agent's tool list (.mcp.json) and Claude Code settings from the last clean start are back, and Talos is starting again." }
    if ($w -contains 'restored' -and $w -contains 'not-approved') { return "The agent's tool list and Claude Code settings from the last clean start are back, but Talos did not start again: approve the change first (Approve this change)." }
    if ($w -contains 'restored') { return "The agent's tool list and Claude Code settings from the last clean start are back, but Talos did not start again. Choose Start Talos." }
    if ($w -contains 'nothing-to-do') { return 'Nothing to restore: the setup already matches the last one that started cleanly.' }
    if ($w -contains 'nothing-saved') { return 'Nothing to restore yet: a good setup is saved only after Talos has started cleanly once.' }
    return 'Talos could not restore the last good setup. The log folder has the details.'
  }
  if ($w -contains 'restarted') { return 'Talos is starting. The dot turns green in a minute or so.' }
  return 'Talos could not start. The log folder has the details.'
}

function Stop-TalosStrayHolds([string]$Distro) {
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue)) {
    if (Test-TalosHoldCommandLine $p.CommandLine $Distro) {
      & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /T /F /PID $p.ProcessId 2>&1 | Out-Null
    }
  }
}

<#
  WSL's one VM-wide binfmt entry for Windows programs, checked and given back if it is gone, from Windows: through WSL's own
  system distro (`wsl --system`, Microsoft's, which runs in the same VM and shares its kernel), so none of the owner's
  distros is touched or started, and no interop-off distro is started (a start of one takes the entry away). It writes
  only WSL's own line, to `register`, and only when the entry is missing (R4-2's rule). $true when the entry is there at
  the end. Found live on Titan: a non-administrator can run this.
#>
function Restore-TalosWslInterop {
  $ErrorActionPreference = 'Continue'
  & $script:WslExe --system -u root --exec /bin/sh -c '[ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || echo :WSLInterop:M::MZ::/init:P > /proc/sys/fs/binfmt_misc/register; test -e /proc/sys/fs/binfmt_misc/WSLInterop' 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# One line into a small log (the last 200 lines), and it never throws. The tray calls it from timer ticks, where an
# exception ends the whole tray with the .NET crash dialog (found on Titan, 2026-11-18: another process held the log open and
# Set-Content threw "being used by another process"). A line that cannot be written now is kept (at most 50 per log, the
# oldest dropped) and written with the next one that can; if the process ends first, it is lost, which is fine for a log.
function Write-TalosLogLine([string]$Path, [string]$Line) {
  try {
    if (-not $script:TalosLogPending) { $script:TalosLogPending = @{} }
    if (-not $script:TalosLogPending.ContainsKey($Path)) { $script:TalosLogPending[$Path] = New-Object Collections.Generic.List[string] }
    $pending = $script:TalosLogPending[$Path]
    $pending.Add($Line)
    while ($pending.Count -gt 50) { $pending.RemoveAt(0) }
    $old = @()
    if (Test-Path -LiteralPath $Path) { $old = @(Get-Content -LiteralPath $Path -Tail 199 -ErrorAction Stop) }
    $all = @($old + $pending.ToArray())
    if ($all.Count -gt 200) { $all = @($all[($all.Count - 200)..($all.Count - 1)]) }
    Set-Content -LiteralPath $Path -Value $all -Encoding UTF8 -ErrorAction Stop
    $pending.Clear()
  } catch { }
}

# whether this distro is one Talos made (R1-7)
function Test-TalosDistro([string]$Distro) {
  $ErrorActionPreference = 'Continue'
  & $script:WslExe -d $Distro -u root --exec /usr/bin/test -f $script:TalosMarker 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}
