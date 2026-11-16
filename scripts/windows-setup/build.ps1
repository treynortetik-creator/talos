<#
.SYNOPSIS
  Builds Talos Setup.exe (unsigned; the owner's decision, 2026-11-12) for a basic user's PC: no git, no clone, no
  terminal. docs/WINDOWS-PLAN.md section 8, "The no-terminal install".

    powershell -ExecutionPolicy Bypass -File scripts\windows-setup\build.ps1 -Version 0.1.0 [-Ref origin/main]
      [-RelayUrl https://her-relay] [-Msi C:\path\wsl.2.7.11.0.x64.msi] [-Out C:\path\folder]

  What it carries, all from ONE commit (-Ref), never the working tree:
  - talos-setup.zip: apps\windows from that commit (git archive), the git bundle of that commit, and payload.json (the
    version, the commit, the bundle's SHA-256, the relay URL, the origin without any login)
  - setup-ui.ps1 and TalosWin.ps1 from that commit: Setup's window (which dot-sources TalosWin.ps1 from its own folder),
    which unpacks the zip into %LOCALAPPDATA%\Talos\setup and runs install.ps1 -Silent (the list is TalosWin.ps1
    $TalosSetupPackFiles)
  - Microsoft's WSL installer, pinned in TalosWin.ps1 by version and SHA-256 (-Msi, or downloaded from its GitHub release
    and checked); a PC that has WSL never runs it
  IExpress (built into Windows) packs them into one .exe, which runs as the user (asInvoker).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Ref = 'origin/main',
  [string]$RelayUrl = '',
  [string]$Msi = '',
  [string]$Out = (Join-Path (Get-Location) 'dist'),
  # the clone -Ref is read from (default: the one this script is in). A WSL worktree's .git names a Linux path Windows git
  # cannot follow: point this at the main clone instead.
  [string]$Repo = ''
)
$ErrorActionPreference = 'Stop'
# worked out here, not as the parameter's default: Windows PowerShell 5.1 has no $PSScriptRoot yet while it evaluates param
# defaults, so the default was "" and Split-Path refused it (rc13's agent-run: "Cannot bind argument to parameter 'Path'")
$repo = if ($Repo) { $Repo } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'apps\windows\TalosWin.ps1')

function Git([string[]]$a) {
  $ErrorActionPreference = 'Continue'
  $o = & git.exe @a 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($a[0]) failed: $o" }
  $o
}

$commit = "$(Git @('-C', $repo, 'rev-parse', '--verify', "$Ref^{commit}"))".Trim()
$origin = Remove-TalosUrlLogin "$(Git @('-C', $repo, 'remote', 'get-url', 'origin'))".Trim()
$origin = $origin -replace '\.git$', ''
Write-Host "== Talos $Version from $Ref ($commit)"

$stage = Join-Path ([IO.Path]::GetTempPath()) "talos-setup-build-$PID"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
# IExpress cannot read a path with a space in its SED (C:\Users\First Last\...): the stage by its 8.3 short name
$stage = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($stage).ShortPath
if ($stage -match ' ') { throw "the build folder $stage has a space in it even as a short name; set TEMP to a folder without one" }
try {
  # a repo with that one commit as main and HEAD: what setup-user.sh clones (`git clone <bundle>` checks out HEAD)
  $tmp = Join-Path $stage 'repo'
  Git @('init', '-q', $tmp) | Out-Null
  Git @('-C', $tmp, 'fetch', '-q', '--no-tags', $repo, "${commit}:refs/heads/main") | Out-Null
  Git @('-C', $tmp, 'symbolic-ref', 'HEAD', 'refs/heads/main') | Out-Null
  $zipDir = Join-Path $stage 'zip'
  New-Item -ItemType Directory -Path $zipDir | Out-Null
  $bundle = Join-Path $zipDir 'talos-src.bundle'
  Git @('-C', $tmp, 'bundle', 'create', '-q', $bundle, 'HEAD', 'main') | Out-Null
  $bundleSha = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLower()

  # apps\windows as that commit has it, at the zip's root (install.ps1 finds payload.json beside itself)
  $tar = Join-Path $stage 'windows.zip'
  Git @('-C', $tmp, 'archive', '--format=zip', '-o', $tar, 'main:apps/windows') | Out-Null
  Expand-Archive -LiteralPath $tar -DestinationPath $zipDir
  $manifest = [ordered]@{ version = $Version; commit = $commit; bundle = 'talos-src.bundle'; bundleSha256 = $bundleSha; relayUrl = $RelayUrl; origin = $origin }
  [IO.File]::WriteAllText((Join-Path $zipDir 'payload.json'), ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  # the checks install.ps1 makes, made here first: a payload it would refuse is never shipped
  $p = Get-TalosPayload $zipDir
  if (-not (Test-TalosPayloadBundle $p)) { throw 'the bundle does not match payload.json' }

  $pack = Join-Path $stage 'pack'
  New-Item -ItemType Directory -Path $pack | Out-Null
  Compress-Archive -Path (Join-Path $zipDir '*') -DestinationPath (Join-Path $pack 'talos-setup.zip')
  # every file setup-ui.ps1 needs before it unpacks anything, from the same commit (Fable R2-1 on ebad65d5)
  foreach ($f in $TalosSetupPackFiles) {
    if ($f -ne 'talos-setup.zip') { Copy-Item -LiteralPath (Join-Path $zipDir $f) -Destination $pack }
  }

  if (-not $Msi) {
    $Msi = Join-Path $stage $TalosWslMsi.Name
    Write-Host "== downloading $($TalosWslMsi.Source)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    (New-Object Net.WebClient).DownloadFile($TalosWslMsi.Source, $Msi)
  }
  $got = (Get-FileHash -LiteralPath $Msi -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $TalosWslMsi.Sha256) { throw "$Msi is not the WSL installer TalosWin.ps1 pins (SHA-256 $got)" }
  Copy-Item -LiteralPath $Msi -Destination (Join-Path $pack $TalosWslMsi.Name)

  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  $exe = Join-Path (Resolve-Path -LiteralPath $Out) "TalosSetup-$Version.exe"
  # IExpress writes into the stage (a path with no spaces), then the .exe is moved to -Out
  $built = Join-Path $stage 'TalosSetup.exe'
  $files = @($TalosSetupPackFiles) + $TalosWslMsi.Name
  # Windows PowerShell by its full path (Fable R1-6 on f3575ba1): IExpress starts what it is given with Windows' search
  # order, which looks in Setup.exe's own folder first, so a bare powershell.exe beside it in Downloads would run instead.
  # Windows is in C:\Windows on every PC Setup is for; the guide also says to run Setup from a folder of its own.
  $psFull = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if ($psFull -match ' ') { throw "$psFull has a space in it, which IExpress cannot read" }
  # one line each, joined here: an array inside a here-string is joined with spaces, which IExpress cannot read
  $fileLines = (0..($files.Count - 1) | ForEach-Object { "FILE$_=`"$($files[$_])`"" }) -join "`r`n"
  $sourceLines = (0..($files.Count - 1) | ForEach-Object { "%FILE$_%=" }) -join "`r`n"
  $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$built
FriendlyName=Talos Setup
AppLaunched=$psFull -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File setup-ui.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
$fileLines
[SourceFiles]
SourceFiles0=$pack\
[SourceFiles0]
$sourceLines
"@
  $sedFile = Join-Path $stage 'talos.sed'
  [IO.File]::WriteAllText($sedFile, ($sed -replace "(?<!`r)`n", "`r`n"), [Text.Encoding]::ASCII)
  Write-Host '== packing with IExpress'
  # the SED's path unquoted: IExpress (11.00.26100) fails at once, exit 1 and no .exe, when it is given in quotes (found on
  # Titan, 2026-11-12). The stage is a short path with no space in it (checked above), so nothing needs quoting.
  $ix = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\iexpress.exe') -ArgumentList @('/N', '/Q', $sedFile) -Wait -PassThru
  if (-not (Test-Path -LiteralPath $built)) { throw "IExpress made no .exe (exit $($ix.ExitCode)); the SED it was given is kept at $sedFile" }
  Move-Item -LiteralPath $built -Destination $exe -Force
  $sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
  Write-Host "== $exe"
  Write-Host "   SHA-256 $sha, $((Get-Item -LiteralPath $exe).Length) bytes, unsigned"
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  # the stage is kept on a failure, to look at (it holds nothing secret: the release and the public WSL installer)
  Write-Host "build: failed; the work folder is kept at $stage" -ForegroundColor Red
  throw
}
