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
#      the mirror registry is recorded in ~/.imcodes/install.json (NOT the global
#      ~/.npmrc) so the daemon passes it explicitly on its own `npm i -g` without
#      affecting other npm projects.
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
if ($NodeMajor -notmatch '^\d+$')                { throw "Invalid -NodeMajor '$NodeMajor' (must be an integer)" }
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
  # NOTE: -TimeoutSec bounds the request/response like `curl -m`, but (as with the
  # earlier HttpWebRequest.Timeout) may not bound a stalled DNS lookup; treating a
  # slow/failed probe as "restricted" keeps us fail-safe toward the mirror.
  try {
    $resp = Invoke-WebRequest -Uri 'https://www.google.com/generate_204' `
      -Method Get -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return ([int]$resp.StatusCode -eq 204)
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
  $npmRegistry = 'https://registry.npmjs.org/'   # official npm registry (passed explicitly)
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

  if ([int]$NodeMajor -lt 22) {
    throw "IM.codes requires Node.js 22 or later (requested major: $NodeMajor). Re-run with -NodeMajor 22 or newer, or install Node 22+ first."
  }

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

  # Resolve the exact latest patch for the requested major from index.json.
  # Sort by [version] descending so we don't rely on the array order of index.json
  # (keeps parity with install.sh's explicit semver sort).
  $index = Invoke-RestMethod "$nodeBase/index.json" -TimeoutSec 30
  $entry = $index |
    Where-Object { $_.version -match "^v$NodeMajor\." } |
    Sort-Object { [version]($_.version.TrimStart('v')) } -Descending |
    Select-Object -First 1
  if (-not $entry) { throw "Could not find Node v$NodeMajor.x on $nodeBase" }
  $ver = $entry.version                       # e.g. v24.4.0
  $pkg = "node-$ver-win-$arch"
  $url = "$nodeBase/$ver/$pkg.zip"

  # Unique temp dir so concurrent installs don't collide on a fixed %TEMP% name,
  # and so a failed download/verify never leaves a stale zip behind (the finally
  # block always cleans it up).
  $tmpDir = Join-Path $env:TEMP ('imcodes-node-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $tmp = Join-Path $tmpDir "$pkg.zip"
  $nodeDir = Join-Path $InstallRoot 'node'
  try {
    Write-Ok "downloading $url"
    Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing -TimeoutSec 300
    # Cross-source integrity: the binary may come from the mirror, but its SHA256 is
    # anchored to SHASUMS256.txt fetched over TLS directly from nodejs.org — an origin
    # independent of the mirror. A mirror serving a tampered binary will not match this
    # anchor (fail-closed). Residual trust reduces to the TLS connection to nodejs.org
    # itself (the same model nvm/Volta/fnm rely on); the GPG .sig is intentionally not
    # additionally verified. Fail-closed if unreachable.
    $shasumsUrl = "https://nodejs.org/dist/$ver/SHASUMS256.txt"
    Write-Ok "verifying SHA256 from official SHASUMS ..."
    try {
      $shasumsText = (Invoke-WebRequest $shasumsUrl -UseBasicParsing -TimeoutSec 15).Content
    } catch { throw "Failed to fetch SHASUMS256.txt from $shasumsUrl: $_" }
    # Parse line-by-line and match the artifact name as a WHOLE field (column 2),
    # not a regex suffix. The previous " $($pkg.zip)`$" evaluated $pkg.zip as a
    # (non-existent) .zip PROPERTY -> $null, collapsing the pattern to " $" which
    # never matched, so this branch always failed closed. Whole-field equality also
    # removes the literal-'.'-as-wildcard hazard.
    $target = "$pkg.zip"
    $expectedHash = $null
    foreach ($line in ($shasumsText -split "`r?`n")) {
      $fields = @($line -split '\s+' | Where-Object { $_ -ne '' })
      if ($fields.Count -ge 2 -and $fields[1] -eq $target) { $expectedHash = $fields[0].ToLower(); break }
    }
    if (-not $expectedHash) { throw "SHA256 entry not found for $target in SHASUMS256.txt" }
    $actualHash = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
    if ($actualHash -ne $expectedHash) {
      throw "SHA256 mismatch for $target`n  expected: $expectedHash`n  got:      $actualHash"
    }
    Write-Ok "SHA256 verified"

    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    Write-Ok "extracting to $nodeDir"
    Expand-Archive -Path $tmp -DestinationPath $nodeDir -Force
  } finally {
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
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

# ── Record the registry for the daemon's own auto-upgrade WITHOUT mutating the
#    user's global ~/.npmrc. The daemon reads ~/.imcodes/install.json and passes
#    the recorded registry explicitly on its own `npm i -g`. ─────────────────────
$imcodesHome   = Join-Path $env:USERPROFILE '.imcodes'
$installConfig = Join-Path $imcodesHome 'install.json'
New-Item -ItemType Directory -Force -Path $imcodesHome | Out-Null
if ($useMirror) {
  Write-Step "Recording mirror registry for the daemon's auto-upgrade (no global npm config changes)..."
  "{`n  `"npmRegistry`": `"$npmRegistry`"`n}" | Set-Content -Path $installConfig -Encoding utf8
  Write-Ok "imcodes registry -> $npmRegistry   (config: $installConfig)"
} else {
  # direct: clear any imcodes-managed mirror memory so -Source direct really
  # means direct for future daemon upgrades. We do NOT touch the user's global
  # npm config — that may be a deliberately-configured private/corporate source.
  if (Test-Path $installConfig) {
    Remove-Item $installConfig -Force -ErrorAction SilentlyContinue
    Write-Ok "cleared imcodes mirror registry memory ($installConfig)"
  }
  $curReg = try { (& $npmExe config get registry 2>$null) } catch { '' }
  if ($curReg -and ($curReg -notmatch 'registry\.npmjs\.org')) {
    Write-Note "note: your global npm registry is '$curReg' — -Source direct forces THIS install to the official registry, but the daemon's future upgrades will follow your global npm config."
  }
}

# ── Install the daemon (plain dist-tag; explicit --registry, no global config) ─
Write-Step "Installing imcodes@$Channel ..."
& $npmExe install -g "imcodes@$Channel" --no-fund --no-audit --registry $npmRegistry
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
