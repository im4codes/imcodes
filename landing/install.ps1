# IM.codes daemon — Windows one-click installer
#
#   Quick install (latest):
#     irm https://im.codes/install.ps1 | iex
#
#   Dev channel:
#     $env:IMCODES_CHANNEL='dev'; irm https://im.codes/install.ps1 | iex
#
#   Force mirror / direct source, or pass params explicitly:
#     & ([scriptblock]::Create((irm https://im.codes/install.ps1))) -Channel dev -Source mirror
#
# Behavior (no admin required):
#   1. Source auto-detect: probes a host that only resolves on unrestricted
#      networks. If unreachable, assumes a restricted-network region and uses
#      the mirror for both Node downloads and the npm registry.
#   2. If npm is already on PATH, it is used as-is (no Node install, no version
#      gate). Only when npm is missing do we install Node (portable zip).
#   3. Installs the daemon with a plain dist-tag: npm install -g imcodes@<channel>.
#      No version pinning and no custom upgrade logic — the daemon's own
#      auto-upgrade handles updates from here on. In a restricted-network region
#      the npm registry is set persistently (user ~/.npmrc) so that the daemon's
#      auto-upgrade (a plain `npm i -g`) keeps working through the mirror too.
#
# Compatible with Windows PowerShell 5.1 (built into Windows 10/11) and PowerShell 7+.

[CmdletBinding()]
param(
  [string]$Channel    = $env:IMCODES_CHANNEL,   # latest | dev          (default: latest)
  [string]$Source     = $env:IMCODES_SOURCE,    # auto | mirror | direct (default: auto)
  [string]$NodeMajor  = '24',
  [string]$InstallRoot = "$env:LOCALAPPDATA\imcodes"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'  # huge speedup for Invoke-WebRequest on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = `
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ── Normalize options (env fallback + defaults + validation) ──────────────────
if (-not $Channel) { $Channel = 'latest' }
if (-not $Source)  { $Source  = 'auto' }
$Channel = $Channel.ToLower()
$Source  = $Source.ToLower()
if ($Channel -notin @('latest','dev'))           { throw "Invalid -Channel '$Channel' (use: latest | dev)" }
if ($Source  -notin @('auto','mirror','direct'))  { throw "Invalid -Source '$Source' (use: auto | mirror | direct)" }
if ($PSVersionTable.PSVersion.Major -lt 5)       { throw "Windows PowerShell 5.1+ is required." }

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m"  -ForegroundColor Green }
function Write-Note($m) { Write-Host "    $m"  -ForegroundColor Yellow }

Write-Host ""
Write-Host "  IM.codes daemon installer" -ForegroundColor White
Write-Host "  channel=$Channel  source=$Source" -ForegroundColor DarkGray
Write-Host ""

# ── Source selection ──────────────────────────────────────────────────────────
function Test-OpenInternet {
  # Single 3s probe of a 204 connectivity endpoint. Open internet returns exactly
  # 204; anything else (block / timeout / captive-portal 200) => restricted => mirror.
  try {
    $req = [Net.HttpWebRequest]::Create('https://www.google.com/generate_204')
    $req.Method = 'GET'; $req.Timeout = 3000; $req.ReadWriteTimeout = 3000
    $resp = $req.GetResponse(); $code = [int]$resp.StatusCode; $resp.Close()
    return ($code -eq 204)
  } catch { return $false }
}

$useMirror = $false
switch ($Source) {
  'mirror' { $useMirror = $true }
  'direct' { $useMirror = $false }
  default {
    Write-Step "Probing network..."
    $open = Test-OpenInternet
    $useMirror = -not $open
    Write-Ok ("open internet: {0}  ->  using {1}" -f $open, $(if ($useMirror) { 'mirror' } else { 'direct source' }))
  }
}

if ($useMirror) {
  # Single mirror vendor (Tencent): a pass-through proxy that always carries the
  # current imcodes. NOTE: npmmirror is deliberately NOT used — it re-hosts
  # tarballs and refuses packages over 80MB, so it permanently lags imcodes
  # (~220MB) and would break the daemon's auto-upgrade in a restricted-network region.
  $nodeBase    = 'https://mirrors.cloud.tencent.com/nodejs-release'
  $npmRegistry = 'https://mirrors.cloud.tencent.com/npm/'
} else {
  $nodeBase    = 'https://nodejs.org/dist'
  $npmRegistry = $null   # keep npm default (registry.npmjs.org)
}

# ── Node: use existing npm if present, otherwise install Node (portable) ──────
$npmExe = 'npm'
if (Get-Command npm -ErrorAction SilentlyContinue) {
  Write-Step "Node/npm check"
  $nv = try { (& node -v) 2>$null } catch { '?' }
  $pv = try { (& npm  -v) 2>$null } catch { '?' }
  Write-Ok "found node $nv, npm $pv — using it as-is"
  if ($nv -match 'v(\d+)\.' -and [int]$Matches[1] -lt 22) {
    Write-Note "WARNING: Node $nv is below imcodes's required >= 22 — the daemon may fail at runtime; please upgrade Node."
  }
} else {
  Write-Step "npm not found — installing Node $NodeMajor (portable zip, no admin)..."

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

  # Resolve the exact latest patch for the requested major from index.json
  $index = Invoke-RestMethod "$nodeBase/index.json" -TimeoutSec 30
  $entry = $index | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1
  if (-not $entry) { throw "Could not find Node v$NodeMajor.x on $nodeBase" }
  $ver = $entry.version                       # e.g. v24.4.0
  $pkg = "node-$ver-win-$arch"
  $url = "$nodeBase/$ver/$pkg.zip"

  $tmp = Join-Path $env:TEMP "$pkg.zip"
  Write-Ok "downloading $url"
  Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing -TimeoutSec 300
  # Cross-source integrity (N1): SHASUMS is a tiny text file fetched from the
  # OFFICIAL nodejs.org even when the binary uses a mirror — a poisoned mirror
  # cannot forge a matching hash here. Fail-closed if unreachable.
  $shasumsUrl = "https://nodejs.org/dist/$ver/SHASUMS256.txt"
  Write-Ok "verifying SHA256 from official SHASUMS ..."
  try {
    $shasums = Invoke-RestMethod $shasumsUrl -TimeoutSec 15
  } catch { throw "Failed to fetch SHASUMS256.txt from $shasumsUrl: $_" }
  $match = $shasums | Where-Object { $_ -match " $($pkg.zip)`$" } | Select-Object -First 1
  if (-not $match) { throw "SHA256 entry not found for $pkg.zip in SHASUMS256.txt" }
  $expectedHash = ($match -split ' ')[0]
  $actualHash = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
  if ($actualHash -ne $expectedHash) {
    throw "SHA256 mismatch for $pkg.zip`n  expected: $expectedHash`n  got:      $actualHash"
  }
  Write-Ok "SHA256 verified"

  $nodeDir = Join-Path $InstallRoot 'node'
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  Write-Ok "extracting to $nodeDir"
  Expand-Archive -Path $tmp -DestinationPath $nodeDir -Force
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  $nodeHome = Join-Path $nodeDir $pkg          # zip contains a single top-level folder

  # Persist to user PATH (no admin) so a freshly-launched daemon can find node/npm
  # for its own auto-upgrade; also make it available in the current session.
  $userPath = [Environment]::GetEnvironmentVariable('Path','User')
  if (($userPath -split ';') -notcontains $nodeHome) {
    [Environment]::SetEnvironmentVariable('Path', "$nodeHome;$userPath", 'User')
    Write-Ok "added to user PATH: $nodeHome"
  }
  $env:Path = "$nodeHome;$env:Path"
  $npmExe   = Join-Path $nodeHome 'npm.cmd'
  Write-Ok "node $(& "$nodeHome\node.exe" -v) installed"
}

# ── Existing npm whose global dir isn't writable → user prefix (no admin) ─────
#    Mirrors install.sh. Without this, `npm i -g` fails under a Program Files
#    Node install on a non-admin shell (EPERM). On Windows the global bin shims
#    live in the prefix ROOT (not prefix\bin), so PATH gets the prefix itself.
if ($npmExe -eq 'npm') {
  $groot = try { (& npm root -g 2>$null) } catch { $null }
  $writable = $false
  if ($groot) {
    $probe = Join-Path $groot ('.imcodes-wtest-' + [guid]::NewGuid().ToString('N'))
    try { New-Item $probe -ItemType File -Force -ErrorAction Stop | Out-Null; Remove-Item $probe -Force; $writable = $true } catch { $writable = $false }
  }
  if (-not $writable) {
    $prefix = Join-Path $InstallRoot 'npm-global'
    New-Item -ItemType Directory -Force -Path $prefix | Out-Null
    Write-Step "Global npm dir not writable — using a user prefix (no admin): $prefix"
    & npm config set prefix $prefix
    $userPath = [Environment]::GetEnvironmentVariable('Path','User')
    if (($userPath -split ';') -notcontains $prefix) {
      [Environment]::SetEnvironmentVariable('Path', "$prefix;$userPath", 'User')
    }
    $env:Path = "$prefix;$env:Path"
    Write-Ok "npm prefix -> $prefix"
  }
}

# ── Restricted-network region: persist the mirror registry so the daemon's own
#    auto-upgrade (a plain `npm i -g imcodes@…`) keeps working through the mirror.
if ($useMirror) {
  Write-Step "Setting npm registry to the mirror (keeps the daemon's auto-upgrade working here)..."
  & $npmExe config set registry $npmRegistry
  Write-Ok "npm registry -> $npmRegistry   (revert any time: npm config delete registry)"
}

# ── Install the daemon (plain dist-tag; no pin, no custom upgrade path) ────────
Write-Step "Installing imcodes@$Channel ..."
& $npmExe install -g "imcodes@$Channel" --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }

# ── Done ──────────────────────────────────────────────────────────────────────
$installed = ''
try { $installed = (& imcodes --version) 2>$null } catch {}
Write-Host ""
Write-Host "  imcodes installed  $installed" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "    1) Open a NEW terminal (so the updated PATH takes effect)" -ForegroundColor Gray
Write-Host "    2) imcodes bind     # connect this machine to your IM.codes server" -ForegroundColor Gray
Write-Host "    3) imcodes          # start the daemon (it keeps itself up to date)" -ForegroundColor Gray
Write-Host ""
