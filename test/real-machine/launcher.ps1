[CmdletBinding()] param(
  [Parameter(Mandatory=$true)][ValidateSet('install','teardown','status','guard-check','fixture')][string]$Action,
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_.:-]{3,96}$')][string]$Owner,
  [Parameter(Mandatory=$true)][ValidateSet('201','win-tv','win-cai')][string]$Machine,
  [string]$BindLink, [string]$Name, [string]$Exec, [string]$Package, [string]$Version, [string]$Registry, [string]$StackManifest,
  [string]$Root = $(if ($env:IMCODES_TEST_KIT_ROOT) {$env:IMCODES_TEST_KIT_ROOT} else {'C:\imc-test-kit'})
)
$ErrorActionPreference='Stop'
$state=Join-Path $Root $Owner; $scopedHome=Join-Path $state 'imcodes-home'; $prefix=Join-Path $state 'prefix'; $manifest=Join-Path $state 'daemon.json'
function NodeExe() {
  $preferred='C:\Program Files\nodejs\node.exe'
  if (Test-Path $preferred) { return $preferred }
  $cmd=Get-Command node -ErrorAction Stop
  if ($cmd.Source) { return $cmd.Source }
  throw 'node executable not found'
}
$nodeExe=NodeExe
$nodeDir=Split-Path -Parent $nodeExe
$env:Path="$nodeDir;$env:Path"
. (Join-Path $PSScriptRoot 'agent-guard.ps1')
if($StackManifest){if(-not(Test-Path $StackManifest)){throw "stack manifest missing: $StackManifest"}; $stack=Get-Content $StackManifest|ConvertFrom-Json; if(-not $BindLink){$BindLink=$stack.bindLink}; if(-not $Registry){$Registry=$stack.registryUrl}}
function Hash([string]$p) { if (Test-Path $p) {(Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant()} else {'missing'} }
function RealProfile() { $h=(& $nodeExe -e "console.log(require('node:os').userInfo().homedir)" 2>$null).Trim(); if(-not $h){throw 'cannot resolve real profile'}; $h }
function Snapshot([string]$p,[string]$defaultImcodes) { @("$defaultImcodes\daemon-watchdog.cmd $(Hash \"$defaultImcodes\daemon-watchdog.cmd\")", "$defaultImcodes\daemon-launcher.vbs $(Hash \"$defaultImcodes\daemon-launcher.vbs\")", "$defaultImcodes\server.json $(Hash \"$defaultImcodes\server.json\")", (schtasks /Query /TN '\imcodes-daemon' /XML 2>$null | Out-String)) | Set-Content -LiteralPath $p }
function Get-OwnedProcessIds([int]$RootPid,[string]$StateHome,[string]$Prefix) {
  $all=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $excluded=[Collections.Generic.HashSet[int]]::new(); $cursor=$PID
  while($cursor -and $excluded.Add([int]$cursor)){ $parent=($all|? ProcessId -eq $cursor).ParentProcessId; $cursor=$parent }
  $ids=[Collections.Generic.HashSet[int]]::new()
  function Add-Tree([int]$id) { if($id -le 0 -or -not $ids.Add($id)){return}; foreach($child in $all|? ParentProcessId -eq $id){ Add-Tree ([int]$child.ProcessId) } }
  Add-Tree $RootPid
  foreach($p in $all){ if($excluded.Contains([int]$p.ProcessId)){continue}; $cmd=[string]$p.CommandLine; if($cmd -and (($cmd -like "*$StateHome*") -or ($cmd -like "*$Prefix*"))){[void]$ids.Add([int]$p.ProcessId)} }
  @($ids | Sort-Object -Descending)
}
function Stop-OwnedProcesses([int]$RootPid,[string]$StateHome,[string]$Prefix) {
  $ids=@(Get-OwnedProcessIds $RootPid $StateHome $Prefix)
  foreach($id in $ids){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}
  for($i=0;$i -lt 30;$i++){ $left=@(Get-OwnedProcessIds $RootPid $StateHome $Prefix | ? {Get-Process -Id $_ -ErrorAction SilentlyContinue}); if($left.Count -eq 0){return $true}; Start-Sleep -Milliseconds 200 }
  $left=@(Get-OwnedProcessIds $RootPid $StateHome $Prefix | ? {Get-Process -Id $_ -ErrorAction SilentlyContinue}); if($left.Count){throw "owned processes remain: $($left -join ',')"}; $true
}
$real=RealProfile; $defaultImcodes=Join-Path $real '.imcodes'
if ($env:USERPROFILE) { $userProfile=[IO.Path]::GetFullPath($env:USERPROFILE); if ($userProfile -ne [IO.Path]::GetFullPath($real)) { throw 'USERPROFILE differs from canonical profile; refusing machine writes' } }
$scopedHome=Join-Path $state 'imcodes-home'; $scopedHomeNorm=(& node -e "const p=require('node:path').win32; console.log(p.resolve(process.argv[1]).replace(/[\\]+$/,'').toLowerCase())" $scopedHome).Trim(); $hash=(& node -e "const c=require('node:crypto'),p=require('node:path').win32; const h=p.resolve(process.argv[1]).replace(/[\\]+$/,'').toLowerCase(); console.log(c.createHash('sha256').update(h).digest('hex').slice(0,12))" $scopedHome).Trim(); $expectedTask="\imcodes-daemon-$hash"
New-Item -ItemType Directory -Force -Path $state,$scopedHome,$prefix | Out-Null
switch ($Action) {
  'install' {
    if (-not $BindLink) { throw '--BindLink required' }
    $before=Join-Path $state 'default.before'; $after=Join-Path $state 'default.after'; Snapshot $before $defaultImcodes
    $guard=New-AgentGuard -State $state -Node $nodeExe; Assert-AgentGuard $guard $nodeExe $real
    $invBefore=Join-Path $state 'agent-homes.before'; Save-AgentGuardInventory $guard $nodeExe $real $invBefore
    if ($Package) { npm install --ignore-scripts --no-audit --no-fund --prefix $prefix $Package | Out-Null } elseif ($Version) { if ($Registry) {$env:IMCODES_UPGRADE_REGISTRY=$Registry; npm install --ignore-scripts --no-audit --no-fund --prefix $prefix "imcodes@$Version" --registry $Registry | Out-Null } else { npm install --ignore-scripts --no-audit --no-fund --prefix $prefix "imcodes@$Version" | Out-Null } } else { throw '--Package or --Version required' }
    $cli=Join-Path $prefix 'node_modules\.bin\imcodes.cmd'; $cliArgs=@(); if(-not(Test-Path $cli)){ $direct=Join-Path $prefix 'node_modules\imcodes\dist\src\index.js'; if(Test-Path $direct){$cli=$nodeExe; $cliArgs=@($direct)} else {throw 'imcodes binary missing'} }; $env:IMCODES_HOME=$scopedHome
    # From here every child (bind, the scoped task's watchdog, a fallback start) runs under the guard; restored below.
    $guardSaved=Set-AgentGuardEnv $guard; Assert-AgentGuard $guard $nodeExe $real -Post
    $proc=Start-Process -FilePath $cli -ArgumentList @($cliArgs + @('bind',$BindLink,$Owner)) -PassThru -WindowStyle Hidden
    $watchdog=Join-Path $scopedHome 'daemon-watchdog.cmd'; if(Test-Path $watchdog){$watchdogText=Get-Content $watchdog -Raw; $watchdogText=[regex]::Replace($watchdogText,'call "[^"]*node\.exe"',('call "'+$nodeExe+'"'),[Text.RegularExpressions.RegexOptions]::IgnoreCase); $sets=Get-AgentGuardCmdSets $guard; $nl=$watchdogText.IndexOf("`n"); if($watchdogText.TrimStart().ToLower().StartsWith('@echo off') -and $nl -ge 0){$watchdogText=$watchdogText.Substring(0,$nl+1)+$sets+$watchdogText.Substring($nl+1)} else {$watchdogText=$sets+$watchdogText}; $watchdogText | Set-Content -NoNewline $watchdog}
    $xml=''; for($i=0;$i -lt 60 -and -not $xml;$i++){ try { $candidate=(schtasks /Query /TN $expectedTask /XML 2>$null | Out-String) } catch { $candidate='' }; if($candidate -match '<Task '){$xml=$candidate} else {Start-Sleep -Seconds 1} }; if(-not $xml){throw "expected owner task $expectedTask missing"}; try { schtasks /Run /TN $expectedTask 2>$null | Out-Null } catch { throw "failed to run owner task $expectedTask" }; $lock=Join-Path $scopedHome 'daemon.lock.json'; for($i=0;$i -lt 60 -and -not(Test-Path $lock);$i++){Start-Sleep -Seconds 1}; if(-not(Test-Path $lock)){ $entry=Join-Path $prefix 'node_modules\imcodes\dist\src\index.js'; $fallback=Start-Process -FilePath $nodeExe -ArgumentList @($entry,'start','--foreground') -RedirectStandardOutput (Join-Path $state 'fallback.out') -RedirectStandardError (Join-Path $state 'fallback.err') -PassThru -WindowStyle Hidden; for($i=0;$i -lt 60 -and -not(Test-Path $lock);$i++){Start-Sleep -Seconds 1} }; Snapshot $after $defaultImcodes; Restore-AgentGuardEnv $guardSaved
    if ((Get-FileHash $before).Hash -ne (Get-FileHash $after).Hash) { throw 'default daemon changed' }
    if($xml -notmatch [regex]::Escape($scopedHomeNorm)){throw 'owner task action does not reference scoped home'}; if(-not(Test-Path $lock)){throw 'scoped daemon lock metadata missing'}; $daemonPid=(Get-Content $lock|ConvertFrom-Json).pid
    $ownedPids=@(Get-OwnedProcessIds $daemonPid $scopedHome $prefix)
    $guardPid=Start-AgentGuardWatcher $guard $nodeExe $manifest
    @{defaultProfile=$real;guardPid=$guardPid;agentHome=$guard.Home;guardBin=$guard.Bin;markers=$guard.Markers;agentHomesBefore=$invBefore;owner=$Owner;machine=$Machine;home=$scopedHome;prefix=$prefix;pid=$daemonPid;ownedPids=$ownedPids;defaultBefore=$before;defaultAfter=$after;defaultImcodes=$defaultImcodes;taskName=$expectedTask;taskXml=$xml;lock=$lock} | ConvertTo-Json | Set-Content $manifest
    Start-Sleep -Seconds ([int]$(if($env:IMCODES_KIT_GUARD_SETTLE_SEC){$env:IMCODES_KIT_GUARD_SETTLE_SEC}else{5}))
    if ((Get-AgentGuardReport $nodeExe $state) -ne 0) { throw 'tripwire fired: the scoped daemon tried to launch a real agent CLI; the run is aborted (see report above)' }
    $invAfter=Join-Path $state 'agent-homes.after'; Save-AgentGuardInventory $guard $nodeExe $real $invAfter
    if ((Compare-AgentGuardInventory $nodeExe $invBefore $invAfter $real $state) -ne 0) { throw 'real agent home was written by the scoped run' }
    Get-Content $manifest
  }
  'teardown' { if (-not (Test-Path $manifest)) {throw 'no manifest'}; $m=Get-Content $manifest|ConvertFrom-Json; Stop-AgentGuardWatcher ([int]$m.guardPid); Stop-OwnedProcesses ([int]$m.pid) $m.home $m.prefix | Out-Null; try { schtasks /Delete /TN $m.taskName /F 2>$null | Out-Null } catch { }; $remaining=@(Get-OwnedProcessIds ([int]$m.pid) $m.home $m.prefix | ? { Get-Process -Id $_ -ErrorAction SilentlyContinue }); if($remaining.Count){throw "owned processes remain before directory cleanup: $($remaining -join ',')"}; Remove-Item -Recurse -Force $m.prefix,$m.home -ErrorAction SilentlyContinue; if((Test-Path $m.prefix) -or (Test-Path $m.home)){throw 'owned directories remain after teardown'}; @{owner=$Owner;taskRemoved=$m.taskName;defaultBefore=$m.defaultBefore;defaultAfter=$m.defaultAfter;processesGone=$true;homeRemoved=$true;prefixRemoved=$true;tripwireFired=(Test-Path (Join-Path $state 'tripwire.fired.json'));cleanedAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $state 'teardown.json'); Write-Output "removed $Owner (manifest retained)" }
  'guard-check' { $g=Get-AgentGuardLayout $state; if ((Get-AgentGuardReport $nodeExe $state) -ne 0) { exit 1 }; Write-Output "no tripwire fired for $Owner" }
  'fixture' { if (-not $Name -or -not $Exec) { throw '-Name and -Exec are required' }; $g=Get-AgentGuardLayout $state; Register-AgentGuardFixture $g $Name $Exec }
  'status' { if (-not (Test-Path $manifest)) {throw 'no manifest'}; Get-Content $manifest }
}
