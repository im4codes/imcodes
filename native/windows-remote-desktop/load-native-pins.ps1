param(
  [Parameter(Mandatory = $true)][string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
$PinsPath = Join-Path $RepositoryRoot 'shared\remote-desktop-native-pins.json'
$PinsFile = Get-Item -LiteralPath $PinsPath
if ($PinsFile.PSIsContainer -or
    ($PinsFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw 'Remote desktop native pins are not a regular file.'
}
$Pins = Get-Content -Raw -LiteralPath $PinsFile.FullName | ConvertFrom-Json
$GitRevisionPattern = '^[a-f0-9]{40}$'
if ($null -eq $Pins -or
    @($Pins.PSObject.Properties.Name).Count -ne 2 -or
    @($Pins.PSObject.Properties.Name | Where-Object { $_ -notin @('libwebrtcRevision', 'depotToolsRevision') }).Count -ne 0 -or
    $Pins.libwebrtcRevision -cnotmatch $GitRevisionPattern -or
    $Pins.depotToolsRevision -cnotmatch $GitRevisionPattern) {
  throw 'Remote desktop native pins are invalid.'
}

[PSCustomObject]@{
  LibwebrtcRevision = [string]$Pins.libwebrtcRevision
  DepotToolsRevision = [string]$Pins.depotToolsRevision
}
