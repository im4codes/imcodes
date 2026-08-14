function Invoke-NativeLogged {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Command,
    [Parameter(Mandatory = $true)][string]$LogRoot,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $Stdout = Join-Path $LogRoot "$Name.stdout.log"
  $Stderr = Join-Path $LogRoot "$Name.stderr.log"
  $PreviousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 turns any native stderr line into an ErrorRecord;
    # tools such as depot_tools legitimately write diagnostics there on exit 0.
    # Capture both streams and use the native exit code as the sole boundary.
    $ErrorActionPreference = 'Continue'
    # A command-resolution failure does not reliably update this automatic
    # variable. Clear it first so a prior successful native process can never
    # make a missing gn/autoninja/test executable look successful.
    $global:LASTEXITCODE = $null
    & $Command 1> $Stdout 2> $Stderr
    $NativeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
  if ($null -eq $NativeExitCode -or $NativeExitCode -ne 0) {
    $ErrorText = Get-Content -Raw -LiteralPath $Stderr -ErrorAction SilentlyContinue
    $ExitDescription = if ($null -eq $NativeExitCode) { 'no native exit code' } else { $NativeExitCode }
    throw "$Name failed ($ExitDescription): $ErrorText"
  }
}
