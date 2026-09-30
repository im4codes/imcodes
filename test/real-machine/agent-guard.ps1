# Agent-CLI guard for scoped Windows real-machine daemons. Dot-sourced by launcher.ps1, checker.ps1 and
# agent-guard-test.ps1. Same design as agent-guard.sh (read that header): tripwire shims first on PATH, a scoped
# USERPROFILE/APPDATA/agent-home for the SCOPED daemon only, a pre-start assertion against the canonical profile,
# a watcher that stops the scoped daemon when a tripwire fires, and a before/after inventory of the real agent dirs.
# The checks themselves live in agent-guard-tools.mjs (one implementation for POSIX and Windows).
#
# The default daemon is never touched: USERPROFILE and friends are set only inside the scoped daemon's own
# environment (the scoped watchdog .cmd, and the launcher process while it starts the scoped daemon), never machine-wide.
# Nothing here reads USERPROFILE to find the real profile: the canonical profile is passed in.

$script:AgentGuardKit = $PSScriptRoot

function Invoke-AgentGuardTool {
  # Returns the tool's exit code; its stderr is streamed to the host (native stderr must not become a terminating error).
  param([Parameter(Mandatory=$true)][string]$Node, [Parameter(Mandatory=$true)][string[]]$ToolArgs)
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $output = & $Node (Join-Path $script:AgentGuardKit 'agent-guard-tools.mjs') @ToolArgs 2>&1
    $code = $LASTEXITCODE
    foreach ($line in @($output)) { Write-Host ([string]$line) }
    return $code
  } finally { $ErrorActionPreference = $previous }
}

function Get-AgentGuardNames([string]$Node) {
  $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { @(& $Node (Join-Path $script:AgentGuardKit 'agent-guard-tools.mjs') names) | Where-Object { $_ } } finally { $ErrorActionPreference = $previous }
}

function Get-AgentGuardLayout([string]$State) {
  $root = Join-Path $State 'agent-guard'
  [pscustomobject]@{
    State = $State; Root = $root; Bin = Join-Path $root 'bin'; Markers = Join-Path $root 'markers'; Fixtures = Join-Path $root 'fixtures'
    Home = Join-Path $State 'agent-home'; Fired = Join-Path $State 'tripwire.fired.json'
  }
}

function New-AgentGuard([string]$State, [string]$Node) {
  $g = Get-AgentGuardLayout $State
  foreach ($d in @($g.Bin, $g.Markers, $g.Fixtures, (Join-Path $g.Home '.codex'), (Join-Path $g.Home '.claude'), (Join-Path $g.Home '.gemini'), (Join-Path $g.Home '.config'),
      (Join-Path $g.Home '.local\share'), (Join-Path $g.Home '.local\state'), (Join-Path $g.Home '.cache'), (Join-Path $g.Home 'AppData\Roaming'), (Join-Path $g.Home 'AppData\Local'))) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
  Copy-Item -LiteralPath (Join-Path $script:AgentGuardKit 'agent-guard-tripwire.cjs') -Destination $g.Bin -Force
  $names = Get-AgentGuardNames $Node
  if (-not $names) { throw 'agent guard: the tool returned no CLI names' }
  foreach ($name in $names) {
    Set-Content -LiteralPath (Join-Path $g.Bin "tripwire-$name.js") -Value "require('./agent-guard-tripwire.cjs')('$name');" -Encoding ASCII
    # npm-shaped shim: the line with "%dp0%\...js" is exactly what parseNpmCmdShim extracts, so the daemon's own
    # resolver spawns `node tripwire-<name>.js` and a plain cmd lookup runs the same file.
    $shim = "@echo off`r`nsetlocal`r`nset `"dp0=%~dp0`"`r`nset `"_prog=$Node`"`r`n`"%_prog%`"  `"%dp0%\tripwire-$name.js`" %*`r`nexit /b 97`r`n"
    Set-Content -LiteralPath (Join-Path $g.Bin "$name.cmd") -Value $shim -Encoding ASCII -NoNewline
  }
  Set-Content -LiteralPath (Join-Path $g.Home '.gitconfig') -Value "[user]`n`tname = imcodes kit`n`temail = kit@example.invalid`n[safe]`n`tdirectory = *`n" -Encoding ASCII
  $g
}

function Get-AgentGuardEnv($g) {
  $agentHome = $g.Home   # not $home: that is a read-only automatic variable in PowerShell
  $drive = if ($agentHome -match '^([A-Za-z]:)') { $Matches[1] } else { '' }
  $vars = [ordered]@{
    HOME = $agentHome; USERPROFILE = $agentHome; HOMEDRIVE = $drive; HOMEPATH = $agentHome.Substring($drive.Length)
    APPDATA = (Join-Path $agentHome 'AppData\Roaming'); LOCALAPPDATA = (Join-Path $agentHome 'AppData\Local')
    CODEX_HOME = (Join-Path $agentHome '.codex'); CLAUDE_CONFIG_DIR = (Join-Path $agentHome '.claude'); GEMINI_CLI_HOME = $agentHome
    XDG_CONFIG_HOME = (Join-Path $agentHome '.config'); XDG_DATA_HOME = (Join-Path $agentHome '.local\share'); XDG_STATE_HOME = (Join-Path $agentHome '.local\state'); XDG_CACHE_HOME = (Join-Path $agentHome '.cache')
    IMCODES_KIT_GUARD = '1'; IMCODES_KIT_TRIPWIRE_DIR = $g.Markers
  }
  $vars
}

# Sets the guard in THIS process (for `bind` and a fallback foreground start) and returns what to restore.
function Set-AgentGuardEnv($g) {
  $saved = @{}
  $vars = Get-AgentGuardEnv $g
  foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, [string]$vars[$k], 'Process') }
  $saved['Path'] = [Environment]::GetEnvironmentVariable('Path', 'Process')
  [Environment]::SetEnvironmentVariable('Path', "$($g.Bin);$($saved['Path'])", 'Process')
  $saved
}

function Restore-AgentGuardEnv($saved) {
  foreach ($k in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
}

# `set` lines for the scoped watchdog .cmd, which is what the scoped scheduled task actually runs.
function Get-AgentGuardCmdSets($g) {
  $vars = Get-AgentGuardEnv $g
  $lines = foreach ($k in $vars.Keys) { "set `"$k=$($vars[$k])`"" }
  $lines += "set `"PATH=$($g.Bin);%PATH%`""
  ($lines -join "`r`n") + "`r`n"
}

function Assert-AgentGuard($g, [string]$Node, [string]$Profile, [switch]$Post) {
  $a = @('assert', '--profile', $Profile, '--state', $g.State, '--bin', $g.Bin, '--home', $g.Home, '--sep', ';')
  if ($Post) { $a += '--post' }
  if ((Invoke-AgentGuardTool -Node $Node -ToolArgs $a) -ne 0) { throw 'agent guard assertion failed (see above)' }
}

function Save-AgentGuardInventory($g, [string]$Node, [string]$Profile, [string]$Out) {
  if ((Invoke-AgentGuardTool -Node $Node -ToolArgs @('inventory', '--profile', $Profile, '--out', $Out)) -ne 0) { throw 'agent guard inventory failed' }
  if ((Invoke-AgentGuardTool -Node $Node -ToolArgs @('live', '--out', "$Out.procs")) -ne 0) { throw 'agent guard live-process scan failed' }
}

# 0 = clean, 1 = attributable write to the real agent dirs.
function Compare-AgentGuardInventory([string]$Node, [string]$Before, [string]$After, [string]$Profile, [string]$State) {
  Invoke-AgentGuardTool -Node $Node -ToolArgs @('compare', '--before', $Before, '--after', $After, '--profile', $Profile, '--state', $State)
}

# 0 = nothing fired, 1 = a tripwire fired (report printed, caller named).
function Get-AgentGuardReport([string]$Node, [string]$State) {
  Invoke-AgentGuardTool -Node $Node -ToolArgs @('report', '--state', $State)
}

function Start-AgentGuardWatcher($g, [string]$Node, [string]$ManifestPath) {
  Remove-Item -LiteralPath $g.Fired -Force -ErrorAction SilentlyContinue
  $log = Join-Path $g.State 'guard-watch.log'
  $watchArgs = @((Join-Path $script:AgentGuardKit 'guard-watch.mjs'), $g.Markers, $g.Fired, $ManifestPath, '')
  $p = Start-Process -FilePath $Node -ArgumentList $watchArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $p.Id
}

function Stop-AgentGuardWatcher([int]$WatcherPid) {
  if ($WatcherPid -le 0) { return }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$WatcherPid" -ErrorAction SilentlyContinue
  if ($proc -and [string]$proc.CommandLine -like '*guard-watch.mjs*') { Stop-Process -Id $WatcherPid -Force -ErrorAction SilentlyContinue }
}

function Register-AgentGuardFixture($g, [string]$Name, [string]$Target) {
  if ($Name -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw 'fixture name must match [A-Za-z0-9._-]{1,40}' }
  if (-not [IO.Path]::IsPathRooted($Target) -or -not (Test-Path -LiteralPath $Target)) { throw "fixture target must be an absolute existing path: $Target" }
  New-Item -ItemType Directory -Force -Path $g.Fixtures | Out-Null
  $wrapper = Join-Path $g.Fixtures "$Name.cmd"
  Set-Content -LiteralPath $wrapper -Value "@echo off`r`n`"$Target`" %*`r`n" -Encoding ASCII -NoNewline
  $wrapper
}
