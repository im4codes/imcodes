# Self-test of the Windows agent-CLI guard. Needs no daemon, no server and no npm install, so it can prove the guard
# on a real Windows machine (201) in a minute without touching the default daemon, its scheduled task or its lock.
#
#   powershell -File agent-guard-test.ps1 -Root C:\imc-guard-selftest-<unique> [-RepoRoot <checkout with node_modules>]
#
# It creates the guard in a scoped state dir under -Root, and proves:
#   1. the assertion accepts the scoped layout and rejects a home that IS the real profile / contains it / sits in a real agent dir;
#   2. the scoped USERPROFILE/HOME/APPDATA reach a child process while this process's own environment is left exactly as it was
#      (the default daemon's environment is never involved: only the scoped child gets the scoped values);
#   3. every agent CLI name resolves, via PATH and via the daemon's own resolver (resolveExecutableForSpawn, when -RepoRoot has
#      tsx), to a tripwire that records the caller, masks secrets, never runs a real CLI and exits 97;
#   4. the watcher stops a stand-in scoped daemon when a tripwire fires, and the report names the caller;
#   5. the real-agent-home verdict table (quiet machine + change = FAIL, live real agents = inconclusive, owner reference = FAIL);
#   6. the default daemon's files, lock and scheduled task are byte-identical before and after.
[CmdletBinding()] param(
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$RepoRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-guard.ps1')
$node = if (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { (Get-Command node -ErrorAction Stop).Source }
$failures = New-Object System.Collections.Generic.List[string]
function Check([string]$what, [bool]$ok, [string]$detail = '') { if ($ok) { Write-Host "  ok: $what" } else { Write-Host "  FAIL: $what $detail"; $failures.Add($what) } }
function Hash([string]$p) { if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant() } else { 'missing' } }

$real = (& $node -e "console.log(require('node:os').userInfo().homedir)").Trim()
$defaultImcodes = Join-Path $real '.imcodes'
function DefaultSnapshot() {
  @("daemon-watchdog.cmd $(Hash (Join-Path $defaultImcodes 'daemon-watchdog.cmd'))", "daemon-launcher.vbs $(Hash (Join-Path $defaultImcodes 'daemon-launcher.vbs'))", "server.json $(Hash (Join-Path $defaultImcodes 'server.json'))",
    "daemon.lock.json $(Hash (Join-Path $defaultImcodes 'daemon.lock.json'))", "task $((schtasks /Query /TN '\imcodes-daemon' /XML 2>$null | Out-String).GetHashCode())") -join "`n"
}
$snapshotBefore = DefaultSnapshot
$profileBefore = $env:USERPROFILE; $homeBefore = $env:HOME; $pathBefore = $env:Path
if ($env:USERPROFILE -and ([IO.Path]::GetFullPath($env:USERPROFILE) -ne [IO.Path]::GetFullPath($real))) { throw 'USERPROFILE differs from the canonical profile; refusing to run' }

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$state = Join-Path $Root 'guard-selftest'
$g = New-AgentGuard -State $state -Node $node
Write-Host "agent guard self-test: state=$state real profile=$real"

# 1. assertion
Write-Host '1. assertion'
Check 'a properly scoped layout is accepted' ((Invoke-AgentGuardTool -Node $node -ToolArgs @('assert','--profile',$real,'--state',$g.State,'--bin',$g.Bin,'--home',$g.Home,'--sep',';')) -eq 0)
function Rejects([string]$why, [string]$homeArg) { $c = Invoke-AgentGuardTool -Node $node -ToolArgs @('assert','--profile',$real,'--state',$g.State,'--bin',$g.Bin,'--home',$homeArg,'--sep',';'); Check "rejected: $why" ($c -ne 0) }
Rejects 'agent home == real profile' $real
Rejects 'agent home == real .codex' (Join-Path $real '.codex')
Rejects 'agent home inside real .claude' (Join-Path $real '.claude\sub')
Rejects 'agent home contains the real profile' (Split-Path -Parent $real)
Check 'post-export assertion fails before the export' ((Invoke-AgentGuardTool -Node $node -ToolArgs @('assert','--profile',$real,'--state',$g.State,'--bin',$g.Bin,'--home',$g.Home,'--sep',';','--post')) -ne 0)

# 2. scoped environment reaches a child, and only the child
Write-Host '2. scoped environment'
$saved = Set-AgentGuardEnv $g
try {
  Check 'post-export assertion passes' ((Invoke-AgentGuardTool -Node $node -ToolArgs @('assert','--profile',$real,'--state',$g.State,'--bin',$g.Bin,'--home',$g.Home,'--sep',';','--post')) -eq 0)
  $childHome = (& $node -e "console.log(require('node:os').homedir())").Trim()
  Check 'a child sees the scoped homedir (USERPROFILE)' ($childHome -ieq $g.Home) "got $childHome"
  Check 'a child sees the scoped CODEX_HOME' ((& cmd /c 'echo %CODEX_HOME%').Trim() -ieq (Join-Path $g.Home '.codex'))
  Check 'the tripwire dir is first on PATH' ((($env:Path -split ';')[0]) -ieq $g.Bin)

  # 3. tripwires
  Write-Host '3. tripwires'
  $out = & cmd /c "codex --api-key=SUPERSECRET1 --token SUPERSECRET2 --model x 2>&1"
  Check 'codex resolves to the tripwire and exits 97' ($LASTEXITCODE -eq 97) "exit=$LASTEXITCODE"
  Check 'the tripwire says what to do' ((@($out) -join ' ') -match 'refusing to run the real agent CLI')
  foreach ($n in @('claude','gemini','opencode','qwen','cursor-agent','copilot','kimi')) { & cmd /c "$n --version >nul 2>&1"; Check "$n tripwire fires (exit 97)" ($LASTEXITCODE -eq 97) "exit=$LASTEXITCODE" }
  $marker = Get-ChildItem $g.Markers -Filter 'codex.*' | Where-Object { $_.Name -notlike '*.tmp' } | Select-Object -First 1
  $text = if ($marker) { Get-Content -LiteralPath $marker.FullName -Raw } else { '' }
  Check 'marker records tripwire, argv and a caller' (($text -match 'tripwire=codex') -and ($text -match 'argv\.1=--api-key=\[REDACTED\]') -and ($text -match 'argv\.3=\[REDACTED\]') -and ($text -match 'caller\.1='))
  Check 'marker leaks no secret' ($text -notmatch 'SUPERSECRET')
  Check 'marker records the scoped USERPROFILE' ($text -match [regex]::Escape("env.USERPROFILE=$($g.Home)"))
  Check 'the report names the fired tripwire' ((Get-AgentGuardReport $node $state) -ne 0)

  if ($RepoRoot -and (Test-Path (Join-Path $RepoRoot 'node_modules\tsx'))) {
    $probeFile = Join-Path $state 'resolve-probe.mts'
    Set-Content -LiteralPath $probeFile -Encoding ASCII -Value "import { resolveExecutableForSpawn } from '$(([Uri](Join-Path $RepoRoot 'src\agent\transport-paths.ts')).AbsoluteUri)'; console.log(JSON.stringify(resolveExecutableForSpawn('codex')));"
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $resolvedText = (& $node --import tsx $probeFile 2>$null | Select-Object -Last 1) } finally { $ErrorActionPreference = $prevEap }
    $resolved = $resolvedText | ConvertFrom-Json
    Check 'the daemon resolver resolves codex to node + the tripwire script' (([string]$resolved.executable -ieq $node) -and ([string]$resolved.prependArgs[0] -like '*tripwire-codex.js')) ($resolved | ConvertTo-Json -Compress)
    $before = @(Get-ChildItem $g.Markers | Where-Object { $_.Name -notlike '*.tmp' }).Count
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $resolved.executable @($resolved.prependArgs) '--version' 2>$null | Out-Null } finally { $ErrorActionPreference = $prevEap }
    Check 'spawning what the resolver returned fires the tripwire' (($LASTEXITCODE -eq 97) -and (@(Get-ChildItem $g.Markers | Where-Object { $_.Name -notlike '*.tmp' }).Count -gt $before))
  } else { Write-Host '  skip: daemon resolver check (no -RepoRoot with node_modules\tsx)' }
} finally { Restore-AgentGuardEnv $saved }
Check 'this process environment is restored (USERPROFILE, HOME, Path)' (($env:USERPROFILE -eq $profileBefore) -and ($env:HOME -eq $homeBefore) -and ($env:Path -eq $pathBefore))

# 4. watcher stops a stand-in scoped daemon
Write-Host '4. watcher'
Get-ChildItem $g.Markers | Remove-Item -Force
$dummy = Start-Process -FilePath $node -ArgumentList @('-e', '"setInterval(() => {}, 1000)"') -PassThru -WindowStyle Hidden
$manifestPath = Join-Path $state 'daemon.json'
@{ pid = $dummy.Id } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath
$wpid = Start-AgentGuardWatcher $g $node $manifestPath
Start-Sleep -Seconds 1
Check 'the stand-in daemon is alive before the tripwire' (-not $dummy.HasExited)
$saved = Set-AgentGuardEnv $g; try { & cmd /c 'gemini --version >nul 2>&1' } finally { Restore-AgentGuardEnv $saved }
for ($i = 0; $i -lt 40 -and -not (Test-Path $g.Fired); $i++) { Start-Sleep -Milliseconds 500 }
Check 'the watcher recorded the fired tripwire' (Test-Path $g.Fired)
for ($i = 0; $i -lt 40 -and -not $dummy.HasExited; $i++) { Start-Sleep -Milliseconds 500; $dummy.Refresh() }
Check 'the watcher stopped the stand-in daemon' $dummy.HasExited
if (-not $dummy.HasExited) { Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue }
Stop-AgentGuardWatcher $wpid
$fired = if (Test-Path $g.Fired) { Get-Content -LiteralPath $g.Fired -Raw | ConvertFrom-Json } else { $null }
Check 'the fired record names the tripwire and the stopped pid' ($fired -and $fired.first.tripwire -eq 'gemini' -and $fired.daemonPid -eq $dummy.Id)

# 5. verdict table for the real-agent-home inventory
Write-Host '5. inventory verdicts'
$cmp = Join-Path $Root 'cmp'; New-Item -ItemType Directory -Force -Path $cmp | Out-Null
$fakeProfile = Join-Path $cmp 'profile'; New-Item -ItemType Directory -Force -Path (Join-Path $fakeProfile '.codex\sessions') | Out-Null
Set-Content -LiteralPath (Join-Path $fakeProfile '.codex\sessions\a.jsonl') -Value 'real rollout'
$b = Join-Path $cmp 'before'; $a = Join-Path $cmp 'after'
Save-AgentGuardInventory $g $node $fakeProfile $b
Set-Content -LiteralPath (Join-Path $fakeProfile '.codex\sessions\a.jsonl') -Value 'changed by somebody'
Save-AgentGuardInventory $g $node $fakeProfile $a
'' | Set-Content "$b.procs"; '' | Set-Content "$a.procs"
Check 'quiet machine + changed file is a FAIL' ((Compare-AgentGuardInventory $node $b $a $fakeProfile $state) -ne 0)
"4242`tcodex app-server" | Set-Content "$a.procs"
Check 'a live real agent + changed file is inconclusive, not a failure' ((Compare-AgentGuardInventory $node $b $a $fakeProfile $state) -eq 0)
Set-Content -LiteralPath (Join-Path $fakeProfile '.codex\sessions\rollout-owner.jsonl') -Value "{`"cwd`":`"$state\projects\p`"}"
Save-AgentGuardInventory $g $node $fakeProfile $a
"4242`tcodex app-server" | Set-Content "$a.procs"
Check 'a rollout referencing the scoped run is a FAIL even with live agents' ((Compare-AgentGuardInventory $node $b $a $fakeProfile $state) -ne 0)
Save-AgentGuardInventory $g $node $real (Join-Path $cmp 'real-before')
Save-AgentGuardInventory $g $node $real (Join-Path $cmp 'real-after')
Check 'the inventory tool runs on the real profile' ((Test-Path (Join-Path $cmp 'real-before')) -and (Test-Path (Join-Path $cmp 'real-after')))

# 6. the default daemon was never involved
Write-Host '6. default daemon untouched'
Check 'default watchdog/launcher/server.json/lock/scheduled task are unchanged' ((DefaultSnapshot) -eq $snapshotBefore)

Remove-Item -LiteralPath $state, $cmp -Recurse -Force -ErrorAction SilentlyContinue
if ($failures.Count) { Write-Host "agent guard self-test: FAIL ($($failures.Count)): $($failures -join '; ')"; exit 1 }
Write-Host 'agent guard self-test (windows): PASS'
