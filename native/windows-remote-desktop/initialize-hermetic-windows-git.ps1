param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot) -or
    [System.IO.Path]::GetPathRoot($WorkspaceRoot) -eq $WorkspaceRoot) {
  throw 'Hermetic Git workspace must be a dedicated non-root directory.'
}
New-Item -ItemType Directory -Force -Path $WorkspaceRoot | Out-Null
$GlobalConfigPath = Join-Path $WorkspaceRoot 'imcodes-empty-global.gitconfig'
if (-not (Test-Path -LiteralPath $GlobalConfigPath)) {
  [System.IO.File]::WriteAllText($GlobalConfigPath, '')
}
$GlobalConfig = Get-Item -LiteralPath $GlobalConfigPath
if ($GlobalConfig.PSIsContainer -or
    ($GlobalConfig.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    $GlobalConfig.Length -ne 0) {
  throw 'Hermetic Git global config is not an empty regular file.'
}
$env:GIT_CONFIG_GLOBAL = $GlobalConfig.FullName
# Ignore Git for Windows' mutable installation-wide etc/gitconfig as well as
# the user profile. The pinned build provides every required rewrite and
# safe.directory entry through process-scoped GIT_CONFIG_KEY_* values.
$env:GIT_CONFIG_NOSYSTEM = '1'
$GitVersionOutput = (& git --version).Trim()
if ($LASTEXITCODE -ne 0 -or $GitVersionOutput -notmatch '^git version (\d+\.\d+(?:\.\d+)?)') {
  throw "Hermetic Git version could not be determined: $GitVersionOutput"
}
if ([version]$Matches[1] -lt [version]'2.32.0') {
  throw "Hermetic Git requires version 2.32 or newer: $GitVersionOutput"
}
