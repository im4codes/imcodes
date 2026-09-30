[CmdletBinding()] param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_.:-]{3,96}$')][string]$Owner,[ValidateSet('201','win-tv','win-cai')][string]$Machine,[string]$Root=$(if($env:IMCODES_TEST_KIT_ROOT){$env:IMCODES_TEST_KIT_ROOT}else{'C:\imc-test-kit'}))
$ErrorActionPreference='Stop'; $drive=(Get-Item $Root).PSDrive; $freeGb=[math]::Floor($drive.Free/1GB); $minGb=if($env:IMCODES_MIN_FREE_GB){[int]$env:IMCODES_MIN_FREE_GB}else{15}; if($freeGb -lt $minGb){throw "insufficient free disk: ${freeGb}GB < ${minGb}GB"}; $state=Join-Path $Root $Owner; $mPath=Join-Path $state 'daemon.json'; $tPath=Join-Path $state 'teardown.json'; if(-not(Test-Path $state)){throw "no owner state"}; $failed=$false
function Hash([string]$p){if(Test-Path $p){(Get-FileHash $p -Algorithm SHA256).Hash}else{'missing'}}
function TaskExists([string]$name){try{[bool](schtasks /Query /TN $name 2>$null)}catch{$false}}
function OwnedProcessIds([int]$RootPid,[string]$StateHome,[string]$Prefix) {
  $all=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue); $excluded=[Collections.Generic.HashSet[int]]::new(); $cursor=$PID
  while($cursor -and $excluded.Add([int]$cursor)){ $parent=($all|? ProcessId -eq $cursor).ParentProcessId; $cursor=$parent }
  $ids=[Collections.Generic.HashSet[int]]::new()
  function Add-Tree([int]$id){if($id -le 0 -or -not $ids.Add($id)){return}; foreach($child in $all|? ParentProcessId -eq $id){Add-Tree ([int]$child.ProcessId)}}
  Add-Tree $RootPid
  foreach($p in $all){if($excluded.Contains([int]$p.ProcessId)){continue}; $cmd=[string]$p.CommandLine; if($cmd -and (($cmd -like "*$StateHome*") -or ($cmd -like "*$Prefix*"))){[void]$ids.Add([int]$p.ProcessId)}}
  @($ids | Sort-Object -Descending)
}
$real=(& node -e "console.log(require('node:os').userInfo().homedir)" 2>$null).Trim(); $default=Join-Path $real '.imcodes';
if(Test-Path $mPath){$m=Get-Content $mPath|ConvertFrom-Json; $before=$m.defaultBefore; $after=$m.defaultAfter; if((Hash $before) -ne (Hash $after)){$failed=$true}; $owned=@(OwnedProcessIds ([int]$m.pid) $m.home $m.prefix | ? {Get-Process -Id $_ -ErrorAction SilentlyContinue}); if($owned.Count){$failed=$true; Write-Warning "leftover owned process tree: $($owned -join ',')"}; if(Test-Path $m.home){$failed=$true; Write-Warning "leftover home $($m.home)"}; if(Test-Path $m.prefix){$failed=$true; Write-Warning "leftover prefix $($m.prefix)"}; $taskExists=TaskExists $m.taskName; if($taskExists){Write-Warning "owned task remains: $($m.taskName)";$failed=$true}; [pscustomobject]@{owner=$Owner;machine=$Machine;defaultImcodes=$default;task=$m.taskName;defaultUntouched=((Hash $before) -eq (Hash $after))}}
if(Test-Path $tPath){$t=Get-Content $tPath|ConvertFrom-Json; if($t.defaultBefore -and ((Hash $t.defaultBefore) -ne (Hash $t.defaultAfter))){$failed=$true}; if($t.taskRemoved){$still=TaskExists $t.taskRemoved; if($still){Write-Warning "owned task remains: $($t.taskRemoved)";$failed=$true}}; try{$allTasks=@(schtasks /Query /FO CSV /NH 2>$null)}catch{$allTasks=@()}; $foreign=@($allTasks|Where-Object {$_ -match 'imcodes-daemon-' -and $_ -notmatch [regex]::Escape([string]$t.taskRemoved)}); if($foreign.Count){Write-Output "foreign scoped tasks (left untouched): $($foreign -join ';')"}}
# Agent-CLI guard: a fired tripwire fails the run and names the caller; attributable writes to the real agent dirs fail it too.
. (Join-Path $PSScriptRoot 'agent-guard.ps1'); $nodeForGuard=if(Test-Path 'C:\Program Files\nodejs\node.exe'){'C:\Program Files\nodejs\node.exe'}else{(Get-Command node -ErrorAction Stop).Source}
if(Test-Path (Join-Path $state 'agent-guard\markers')){
  if((Get-AgentGuardReport $nodeForGuard $state) -ne 0){$failed=$true}
  if(Test-Path $mPath){$gm=Get-Content $mPath|ConvertFrom-Json; if($gm.agentHomesBefore -and (Test-Path $gm.agentHomesBefore) -and $gm.defaultProfile){$now=Join-Path $state 'agent-homes.now'; $gl=Get-AgentGuardLayout $state; Save-AgentGuardInventory $gl $nodeForGuard $gm.defaultProfile $now; if((Compare-AgentGuardInventory $nodeForGuard $gm.agentHomesBefore $now $gm.defaultProfile $state) -ne 0){Write-Warning 'real agent home was written during the run'; $failed=$true}}}
}
$aborted=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ? {([string]$_.CommandLine -match '(?i)imcodes.*\sstart') -and ([string]$_.CommandLine -match '(?i)[A-Z]:\\imc-kit-')}); if($aborted.Count){Write-Warning "live imcodes start under an imc-kit state dir: $((($aborted|% ProcessId) -join ','))"}
if($failed){exit 1}; Write-Output "checker PASS: owner=$Owner machine=$Machine defaults unchanged and no owned leftovers"
