<#
.SYNOPSIS
  Shares one Windows folder with the Talos distro, for a thread that needs it (docs/WINDOWS-PLAN.md section 8). None is shared
  by default. It is mounted at /mnt/win/<name>, owned by the talos user; give that path to the thread as its folder.
  Refused: system folders, AppData and other programs' data, key folders (.ssh, .aws, ...), a whole profile, whole drives,
  network folders, Talos's own files, and any path with a link or junction in it.

  Read-write (the default) means the thread can change anything in the folder. In a git repository that includes .git\hooks:
  a hook the thread wrote runs on Windows, as you, the next time you run git there yourself. Share a repository you also
  work in from Windows with -ReadOnly, or check .git\hooks before running git in it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File add-folder.ps1 'C:\Users\you\Projects\atlas'
  powershell -ExecutionPolicy Bypass -File add-folder.ps1 'C:\Users\you\Projects\atlas' -ReadOnly
  powershell -ExecutionPolicy Bypass -File add-folder.ps1 -List
  powershell -ExecutionPolicy Bypass -File add-folder.ps1 -Remove /mnt/win/atlas
#>
[CmdletBinding(DefaultParameterSetName = 'Add')]
param(
  [Parameter(ParameterSetName = 'Add', Mandatory = $true, Position = 0)][string]$Path,
  [Parameter(ParameterSetName = 'Add')][switch]$ReadOnly,
  [Parameter(ParameterSetName = 'List', Mandatory = $true)][switch]$List,
  [Parameter(ParameterSetName = 'Remove', Mandatory = $true)][string]$Remove,
  [string]$Distro = 'talos'
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'TalosWin.ps1')
$tool = '/opt/talos-wsl/talos-wsl.sh'
function Fail([string]$m) { Write-Host "add-folder: $m" -ForegroundColor Red; exit 1 }
if (-not (Test-TalosDistro $Distro)) { Fail "there is no Talos distro named $Distro (install.ps1 makes it)" }
# --exec: the arguments reach the script as they are, never through a Linux shell (backslashes, spaces)
switch ($PSCmdlet.ParameterSetName) {
  'List' { & $WslExe -d $Distro -u root --exec $tool folder-list }
  'Remove' { & $WslExe -d $Distro -u root --exec $tool folder-remove $Remove }
  'Add' {
    # the real folder, as Windows resolves it, with no link or junction anywhere on the way (R1-4)
    try { $real = Resolve-TalosShareFolder $Path } catch { Fail $_.Exception.Message }
    if ($ReadOnly) { & $WslExe -d $Distro -u root --exec $tool folder-add --read-only $real }
    else { & $WslExe -d $Distro -u root --exec $tool folder-add $real }
  }
}
exit $LASTEXITCODE
