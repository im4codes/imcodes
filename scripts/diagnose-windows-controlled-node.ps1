# Read-only aiDesk / IM.codes controlled-node diagnostics.
# Run from an elevated PowerShell window. This script writes nothing and sends
# nothing over the network; copy only the output you choose to share.
$ErrorActionPreference = 'Continue'

function Write-Section([string]$Name) {
  Write-Output ""
  Write-Output ("==== {0} ====" -f $Name)
}

function Write-RedactedTail([string]$Path, [int]$Lines = 120) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Output ("not found: {0}" -f $Path)
    return
  }
  Write-Output ("path: {0}" -f $Path)
  Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Continue | ForEach-Object {
    $_ -replace '(?i)(authorization|bearer|token|secret|credential)(["'' :=]+)[^,;\s"'']+', '$1$2<redacted>'
  }
}

Write-Section 'Scheduled tasks'
$taskNames = @('imcodes-node', 'imcodes-node-watchdog')
$taskNames += @(Get-ScheduledTask -TaskName 'imcodes-node-upgrade-*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName)
foreach ($taskName in ($taskNames | Sort-Object -Unique)) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Output ("missing: {0}" -f $taskName)
    continue
  }
  [pscustomobject]@{
    TaskName = $taskName
    State = [string]$task.State
    LastRunTime = $info.LastRunTime
    LastTaskResult = $(if ($info) { '0x{0:X8}' -f ([uint32]$info.LastTaskResult) } else { $null })
    NextRunTime = $info.NextRunTime
    Execute = ($task.Actions | ForEach-Object { $_.Execute }) -join '; '
    ExecutionTimeLimit = [string]$task.Settings.ExecutionTimeLimit
    StartWhenAvailable = $task.Settings.StartWhenAvailable
    DisallowStartIfOnBatteries = $task.Settings.DisallowStartIfOnBatteries
    StopIfGoingOnBatteries = $task.Settings.StopIfGoingOnBatteries
    MultipleInstances = [string]$task.Settings.MultipleInstances
  } | Format-List
}

Write-Section 'Node process and version'
$nodeProcess = Get-CimInstance Win32_Process -Filter "Name='imcodes-node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -notmatch '--computer-use-helper' } |
  Select-Object -First 1
if ($nodeProcess) {
  [pscustomobject]@{
    ProcessId = $nodeProcess.ProcessId
    CreationDate = $nodeProcess.CreationDate
    ExecutablePath = $nodeProcess.ExecutablePath
  } | Format-List
  try { & $nodeProcess.ExecutablePath --version } catch { Write-Output ("version failed: {0}" -f $_.Exception.Message) }
  $installDir = Split-Path -Parent $nodeProcess.ExecutablePath
} else {
  Write-Output 'imcodes-node.exe is not running'
  $mainTask = Get-ScheduledTask -TaskName 'imcodes-node' -ErrorAction SilentlyContinue
  $installDir = if ($mainTask) { Split-Path -Parent (($mainTask.Actions | Select-Object -First 1).Execute) } else { $null }
}

Write-Section 'Health lease and watchdog log'
if ($installDir) {
  Write-Output 'Executable and install receipt integrity:'
  $installedExe = Join-Path $installDir 'imcodes-node.exe'
  $journalPath = Join-Path $installDir 'install-journal.json'
  $transactionPath = Join-Path $installDir 'upgrade-in-progress.json'
  $actualExeSha256 = if (Test-Path -LiteralPath $installedExe -PathType Leaf) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $installedExe -ErrorAction Continue).Hash.ToLowerInvariant()
  } else { $null }
  $journal = if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
    try { Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json } catch { $null }
  } else { $null }
  $receiptSha256 = if ($journal -and $journal.stagedReceipt) { [string]$journal.stagedReceipt.sha256 } else { $null }
  [pscustomobject]@{
    ExecutablePath = $installedExe
    ExecutableSha256 = $actualExeSha256
    ReceiptSha256 = $receiptSha256
    ExecutableMatchesReceipt = [bool]($actualExeSha256 -and $receiptSha256 -and $actualExeSha256 -ceq $receiptSha256)
    UpgradeTransactionPresent = Test-Path -LiteralPath $transactionPath -PathType Leaf
    BackupExecutablePresent = Test-Path -LiteralPath ($installedExe + '.upgrade-old') -PathType Leaf
    BackupJournalPresent = Test-Path -LiteralPath ($journalPath + '.upgrade-old') -PathType Leaf
  } | Format-List
  foreach ($name in @('health-lease.json', 'health-watchdog-state.json')) {
    $path = Join-Path $installDir $name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Write-Output ("{0}:" -f $name)
      Get-Content -LiteralPath $path -Raw -ErrorAction Continue
    } else {
      Write-Output ("not found: {0}" -f $path)
    }
  }
  Write-RedactedTail (Join-Path $installDir 'health-watchdog.log')
  $pausePath = Join-Path $installDir 'remote-desktop-access.json'
  if (Test-Path -LiteralPath $pausePath -PathType Leaf) {
    Write-Output 'remote-desktop-access.json:'
    Get-Content -LiteralPath $pausePath -Raw -ErrorAction Continue
  }
}

Write-Section 'Node log tail (secrets redacted)'
$serviceLog = Join-Path $env:SystemRoot 'System32\config\systemprofile\.imcodes\logs\daemon.log'
Write-RedactedTail $serviceLog

Write-Section 'Sleep capabilities and last wake'
powercfg /a
powercfg /lastwake

Write-Section 'Recent sleep, wake, and unexpected shutdown events'
Get-WinEvent -FilterHashtable @{
  LogName = 'System'
  StartTime = (Get-Date).AddDays(-7)
} -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ProviderName -in @('Microsoft-Windows-Kernel-Power', 'Microsoft-Windows-Power-Troubleshooter') -or
    $_.Id -in @(1, 41, 42, 107, 506, 507)
  } |
  Select-Object -First 80 TimeCreated, ProviderName, Id, LevelDisplayName, Message |
  Format-List

Write-Section 'Network adapters and power management'
Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
  Select-Object Name, Status, MediaType, LinkSpeed, InterfaceDescription |
  Format-Table -AutoSize
Get-CimInstance -Namespace root/wmi -ClassName MSPower_DeviceEnable -ErrorAction SilentlyContinue |
  Select-Object InstanceName, Enable |
  Format-Table -AutoSize

Write-Section 'Proxy and DNS status (no credentials)'
netsh winhttp show proxy
Get-DnsClientServerAddress -ErrorAction SilentlyContinue |
  Select-Object InterfaceAlias, AddressFamily, ServerAddresses |
  Format-Table -AutoSize

Write-Output ''
Write-Output 'Diagnostics complete. No settings were changed and no data was uploaded.'
