import { linuxControlledNodeAbiDetectionScript } from './controlled-node-abi-detection.js';
import { CONTROLLED_NODE_ABI_GLIBC217, CONTROLLED_NODE_ABI_PROFILE_FIELD, type ControlledNodeAbiProfile } from '../../../shared/controlled-node-abi.js';
/**
 * One-line install commands for controlled nodes.
 *
 * The operator pastes a single line into a terminal on the machine being
 * enrolled. That machine is, by definition, one they cannot yet reach with
 * IM.codes, so the command has to carry everything: which artifact to fetch,
 * proof it may be fetched, elevation, and a readable outcome.
 *
 * Two properties drive the shape of both scripts:
 *
 * 1. They are consumed by a pipe (`| sh`, `| iex`). A pipe hands the
 *    interpreter whatever arrived, so a connection dropped mid-transfer would
 *    otherwise execute half a script. Every script therefore defines a function
 *    and invokes it on the final line: a truncated body defines an incomplete
 *    function that is never called.
 * 2. They are the only feedback channel. There is no UI and no log to read
 *    afterwards, so each failure says what went wrong and what to do next.
 */

import { isCanonicalServerOrigin } from '../security/server-url.js';
import {
  CONTROLLED_NODE_ARCH_ARM64,
  CONTROLLED_NODE_INSTALL_COMMAND_PATH,
  isControlledNodeInstallCode,
  type ControlledNodeArtifactArch,
  type ControlledNodeOs,
} from '../../../shared/controlled-node-artifacts.js';
import { buildWindowsReleasePublisherTrustScriptForVariable } from '../../../shared/windows-release-publisher-trust.js';
import {
  CONTROLLED_NODE_ENROLL_STDIN_FLAG,
  CONTROLLED_NODE_INSTALL_PAYLOAD_PATH,
  CONTROLLED_NODE_INSTALL_SUBCOMMAND,
  CONTROLLED_NODE_INSTALL_TICKET_FIELD,
} from '../../../shared/controlled-node-install.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

export { CONTROLLED_NODE_INSTALL_COMMAND_PATH };

export interface InstallCommandScript {
  body: string;
  contentType: string;
}

/**
 * Reject anything that has not already been validated.
 *
 * Both values are interpolated into a script that runs as root, so this is the
 * boundary that makes that safe. The code is checked against its exact
 * alphabet, and the server URL against an https origin with no path, so neither
 * can carry a quote, a space or a shell metacharacter.
 */
function assertRenderable(serverUrl: string, installCode: string): void {
  if (!isControlledNodeInstallCode(installCode)) {
    throw new Error('invalid_controlled_node_install_code');
  }
  if (!isCanonicalServerOrigin(serverUrl)) {
    throw new Error('invalid_controlled_node_install_server_url');
  }
}

/**
 * curl transport flags for an already-validated origin.
 *
 * Derived in ONE place because there are two curl invocations — the command the
 * operator pastes, which fetches this script, and the download inside it — and
 * they must not drift. They did: the inner one was pinned and the outer one was
 * not, so `curl -fsSL https://… | sudo sh` would follow an HTTPS→HTTP redirect
 * and pipe cleartext straight into a root shell.
 *
 * `--proto` alone already refuses a downgraded redirect, but `--proto-redir` is
 * stated explicitly so the guarantee does not depend on which curl build reads
 * `--proto` as covering redirects.
 *
 * Loopback HTTP is narrowed the same way rather than left unrestricted: the
 * canonical-URL policy admits it only for development, and a development origin
 * has no business being redirected off-host either.
 */
export function curlTransportFlags(serverUrl: string): string {
  return serverUrl.startsWith('https://')
    ? "--proto '=https' --proto-redir '=https' --tlsv1.2"
    : "--proto '=http' --proto-redir '=http'";
}

/**
 * POSIX sh, for macOS and Linux.
 *
 * Deliberately sh and not bash: the smallest Linux images ship dash or busybox
 * ash and no bash at all, and an installer that cannot run on a minimal host is
 * useless precisely where remote install matters most.
 */
function renderShellScript(
  serverUrl: string,
  installCode: string,
  os: ControlledNodeOs,
  abiProfile?: ControlledNodeAbiProfile,
): string {
  const expectOs = os === 'mac' ? 'mac' : 'linux';
  const curlProtocolFlags = `${curlTransportFlags(serverUrl)} `;
  // wget is the fallback when curl is absent, and follows redirects just as
  // readily.
  //
  // NOT `--https-only`: GNU documents that as "when in recursive mode, only
  // HTTPS links are followed". This fetch has no `-r`, so it constrains nothing
  // — it reads like a redirect guarantee and is not one.
  //
  // `--max-redirect=0` is the real guarantee, and it is applied to loopback
  // HTTP too: neither `/i/:code` nor the artifact route ever redirects, so any
  // 3xx in a root-executed download chain is illegitimate regardless of scheme.
  // This mirrors the PowerShell `-MaximumRedirection 0` policy.
  const wgetProtocolFlags = '--max-redirect=0 ';
  return String.raw`#!/bin/sh
# IM.codes controlled-node installer.
imcodes_install() {
  set -eu

  imcodes_server='__SERVER_URL__'
  imcodes_code='__INSTALL_CODE__'
  imcodes_expect_os='__EXPECT_OS__'

  if [ "$(id -u)" -ne 0 ]; then
    echo "IM.codes: this installer needs root." >&2
    echo "  curl -fsSL __CURL_PROTOCOL_FLAGS__$imcodes_server/i/$imcodes_code | sudo sh" >&2
    exit 1
  fi

  case "$(uname -s)" in
    Darwin) imcodes_host_os=mac ;;
    Linux) imcodes_host_os=linux ;;
    *) echo "IM.codes: unsupported system $(uname -s)." >&2; exit 1 ;;
  esac
  if [ "$imcodes_host_os" != "$imcodes_expect_os" ]; then
    echo "IM.codes: this command installs the $imcodes_expect_os build, but this machine is $imcodes_host_os." >&2
    echo "IM.codes: generate the $imcodes_host_os command from the IM.codes web page." >&2
    exit 1
  fi

  __ABI_DETECTION__

  imcodes_dir=$(mktemp -d 2>/dev/null || mktemp -d -t imcodes)
  trap 'rm -rf "$imcodes_dir"' EXIT INT TERM
  umask 077
  imcodes_binary="$imcodes_dir/imcodes-node"
  imcodes_payload="$imcodes_dir/payload.json"
  imcodes_meta="$imcodes_dir/meta"
  imcodes_enroll="$imcodes_dir/enroll.json"

  echo "IM.codes: downloading..."
  if command -v curl >/dev/null 2>&1; then
    set -- --data-urlencode "__TICKET_FIELD__=$imcodes_code"
    if [ "$imcodes_abi" = '__COMPAT_ABI__' ]; then
      set -- "$@" --data-urlencode "__ABI_FIELD__=$imcodes_abi"
    fi
    curl -fsSL --max-redirs 0 __CURL_PROTOCOL_FLAGS__\
      "$@" \
      "$imcodes_server__PAYLOAD_PATH__" -o "$imcodes_payload" || {
      echo "IM.codes: download failed. The install command may have been revoked or used up." >&2
      exit 1
    }
  elif command -v wget >/dev/null 2>&1; then
    # Any wget that does not advertise --max-redirect cannot pin redirects;
    # BusyBox's applet is the common case but the branch is not specific to it,
    # so the message must not name one implementation. Refuse explicitly rather
    # than emit "unrecognized option", and never fall through to an unpinned
    # download whose bytes are executed as root.
    if ! wget --help 2>&1 | grep -q -- '--max-redirect'; then
      echo "IM.codes: this wget implementation cannot restrict redirects." >&2
      echo "IM.codes: install curl, or GNU wget, and run the command again." >&2
      exit 1
    fi
    imcodes_post_data="__TICKET_FIELD__=$imcodes_code"
    if [ "$imcodes_abi" = '__COMPAT_ABI__' ]; then
      imcodes_post_data="$imcodes_post_data&__ABI_FIELD__=$imcodes_abi"
    fi
    wget -q __WGET_PROTOCOL_FLAGS__--post-data="$imcodes_post_data" \
      "$imcodes_server__PAYLOAD_PATH__" -O "$imcodes_payload" || {
      echo "IM.codes: download failed. The install command may have been revoked or used up." >&2
      exit 1
    }
  else
    echo "IM.codes: neither curl nor wget is available." >&2
    exit 1
  fi

  if [ ! -s "$imcodes_payload" ]; then
    echo "IM.codes: the enrollment payload is empty." >&2
    exit 1
  fi

  awk -v meta_out="$imcodes_meta" -v enr_out="$imcodes_enroll" '
    { s = s (NR > 1 ? "\n" : "") $0 }
    END {
      n = length(s)
      i = 1; depth = 0; in_str = 0; esc = 0
      str_buf = ""; cur_key = ""; expect_val = 0
      url = ""; sha = ""; abi = ""; enr = ""; enr_start = 0
      while (i <= n) {
        c = substr(s, i, 1)
        if (in_str) {
          if (esc) { str_buf = str_buf c; esc = 0 }
          else if (c == "\\") { str_buf = str_buf c; esc = 1 }
          else if (c == "\"") {
            in_str = 0
            if (depth == 1 && expect_val) {
              if (cur_key == "artifactUrl") url = str_buf
              else if (cur_key == "sha256") sha = str_buf
              else if (cur_key == "abiProfile") abi = str_buf
              cur_key = ""; expect_val = 0
            } else if (depth == 1) {
              cur_key = str_buf
            }
          } else {
            str_buf = str_buf c
          }
        } else {
          if (c == "\"") { in_str = 1; str_buf = "" }
          else if (c == "{") {
            if (depth == 1 && expect_val && cur_key == "enrollment") enr_start = i
            depth++
          } else if (c == "}") {
            depth--
            if (enr_start > 0 && depth == 1) {
              enr = substr(s, enr_start, i - enr_start + 1)
              enr_start = 0; cur_key = ""; expect_val = 0
            }
          } else if (c == ":" && depth == 1 && cur_key != "") { expect_val = 1 }
          else if (c == "," && depth == 1) { cur_key = ""; expect_val = 0 }
        }
        i++
      }
      if (url == "" || sha == "" || abi == "" || enr == "") exit 1
      print url "\n" sha "\n" abi "\n" > meta_out
      print enr > enr_out
    }
  ' "$imcodes_payload" || {
    echo "IM.codes: invalid enrollment payload from server." >&2
    exit 1
  }

  imcodes_artifact_url=$(sed -n '1p' "$imcodes_meta")
  imcodes_sha256=$(sed -n '2p' "$imcodes_meta" | awk '{print tolower($0)}')
  imcodes_response_abi=$(sed -n '3p' "$imcodes_meta")
  if [ -z "$imcodes_artifact_url" ] || [ -z "$imcodes_sha256" ] || [ ! -s "$imcodes_enroll" ]; then
    echo "IM.codes: incomplete enrollment payload from server." >&2
    exit 1
  fi

  case "$imcodes_server" in
    https://*)
      case "$imcodes_artifact_url" in
        https://*) ;;
        *) echo "IM.codes: refused non-HTTPS artifact URL." >&2; exit 1 ;;
      esac
      ;;
    http://*)
      case "$imcodes_artifact_url" in
        "$imcodes_server/"*|https://*) ;;
        *) echo "IM.codes: refused mismatched artifact URL." >&2; exit 1 ;;
      esac
      ;;
    *) exit 1 ;;
  esac

  if [ "$imcodes_abi" = '__COMPAT_ABI__' ] && [ "$imcodes_response_abi" != "$imcodes_abi" ]; then
    echo "IM.codes: server did not acknowledge the requested ABI; refusing to execute." >&2
    exit 1
  fi

  if command -v curl >/dev/null 2>&1; then
    case "$imcodes_artifact_url" in
      https://*)
        curl -fsSL --max-redirs 5 __HTTPS_ARTIFACT_CURL_FLAGS__"$imcodes_artifact_url" -o "$imcodes_binary" || {
          echo "IM.codes: binary download failed." >&2
          exit 1
        }
        ;;
      http://*)
        curl -fsSL --max-redirs 0 __CURL_PROTOCOL_FLAGS__"$imcodes_artifact_url" -o "$imcodes_binary" || {
          echo "IM.codes: binary download failed." >&2
          exit 1
        }
        ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    case "$imcodes_artifact_url" in
      https://*)
        wget -q --max-redirect=5 "$imcodes_artifact_url" -O "$imcodes_binary" || {
          echo "IM.codes: binary download failed." >&2
          exit 1
        }
        ;;
      http://*)
        wget -q __WGET_PROTOCOL_FLAGS__"$imcodes_artifact_url" -O "$imcodes_binary" || {
          echo "IM.codes: binary download failed." >&2
          exit 1
        }
        ;;
    esac
  fi

  if [ ! -s "$imcodes_binary" ]; then
    echo "IM.codes: the downloaded file is empty." >&2
    exit 1
  fi

  imcodes_actual_sha=""
  if command -v sha256sum >/dev/null 2>&1; then
    imcodes_actual_sha=$(sha256sum "$imcodes_binary" | awk '{print tolower($1)}')
  elif command -v shasum >/dev/null 2>&1; then
    imcodes_actual_sha=$(shasum -a 256 "$imcodes_binary" | awk '{print tolower($1)}')
  elif command -v openssl >/dev/null 2>&1; then
    imcodes_actual_sha=$(openssl dgst -sha256 -r "$imcodes_binary" | awk '{print tolower($1)}')
  else
    echo "IM.codes: no SHA-256 verification tool (sha256sum, shasum, openssl) is available." >&2
    exit 1
  fi
  if [ "$imcodes_actual_sha" != "$imcodes_sha256" ]; then
    echo "IM.codes: downloaded binary checksum mismatch; refusing to execute." >&2
    exit 1
  fi

  chmod 700 "$imcodes_binary"
  echo "IM.codes: installing..."
  "$imcodes_binary" __INSTALL_SUBCMD__ __ENROLL_STDIN_FLAG__ < "$imcodes_enroll"
}

imcodes_install
`
    .replace('__ABI_DETECTION__', linuxControlledNodeAbiDetectionScript(abiProfile))
    .replace(/__ABI_FIELD__/g, CONTROLLED_NODE_ABI_PROFILE_FIELD)
    .replace(/__COMPAT_ABI__/g, CONTROLLED_NODE_ABI_GLIBC217)
    .replace(/__SERVER_URL__/g, serverUrl)
    .replace(/__INSTALL_CODE__/g, installCode)
    .replace(/__EXPECT_OS__/g, expectOs)
    .replace(/__CURL_PROTOCOL_FLAGS__/g, curlProtocolFlags)
    .replace(/__HTTPS_ARTIFACT_CURL_FLAGS__/g, serverUrl.startsWith('https://') ? curlProtocolFlags : '')
    .replace(/__WGET_PROTOCOL_FLAGS__/g, wgetProtocolFlags)
    .replace(/__PAYLOAD_PATH__/g, CONTROLLED_NODE_INSTALL_PAYLOAD_PATH)
    .replace(/__TICKET_FIELD__/g, CONTROLLED_NODE_INSTALL_TICKET_FIELD)
    .replace(/__INSTALL_SUBCMD__/g, CONTROLLED_NODE_INSTALL_SUBCOMMAND)
    .replace(/__ENROLL_STDIN_FLAG__/g, CONTROLLED_NODE_ENROLL_STDIN_FLAG);
}

/**
 * Windows PowerShell, for `irm ... | iex`.
 *
 * Elevation is handled by re-running the same one-liner through `RunAs` rather
 * than by telling the operator to open an admin prompt and start over: the
 * whole point of a pasted command is that it works from wherever it was pasted.
 * The elevated window keeps `-NoExit` because it is a new console that would
 * otherwise close over the result before it could be read.
 */
function renderPowerShellScript(
  serverUrl: string,
  installCode: string,
  arch: ControlledNodeArtifactArch,
  expectedSignerSha256: string,
): string {
  if (!SHA256_RE.test(expectedSignerSha256)) {
    throw new Error('invalid_windows_release_signer_sha256');
  }
  const expectArch = arch === CONTROLLED_NODE_ARCH_ARM64 ? 'ARM64' : 'AMD64';
  const publisherTrustScript = buildWindowsReleasePublisherTrustScriptForVariable(
    'binary',
    expectedSignerSha256,
  ) + String.raw`
foreach ($requiredStoreName in @('TrustedPeople', 'TrustedPublisher')) {
  if (-not (Test-AnchoredCertificateInStore $requiredStoreName)) {
    throw ('release publisher trust installation did not anchor ' + $requiredStoreName)
  }
}
`;
  return String.raw`# IM.codes controlled-node installer.
function Invoke-ImcodesInstall {
  $ErrorActionPreference = 'Stop'
  $server = '__SERVER_URL__'
  $code = '__INSTALL_CODE__'
  $expectArch = '__EXPECT_ARCH__'

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'IM.codes: administrator rights are required; a prompt will appear.'
    $relaunch = "irm -MaximumRedirection 0 '$server/i/$code' | iex"
    try {
      Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', $relaunch
      ) | Out-Null
    } catch {
      Write-Host 'IM.codes: the elevation prompt was refused. Right-click PowerShell,' -ForegroundColor Red
      Write-Host '          choose "Run as administrator", and paste the command again.' -ForegroundColor Red
    }
    return
  }

  $hostArch = $env:PROCESSOR_ARCHITECTURE
  if ($hostArch -ne $expectArch) {
    Write-Host "IM.codes: this command installs the $expectArch build, but this machine is $hostArch." -ForegroundColor Red
    Write-Host 'IM.codes: generate the matching command from the IM.codes web page.' -ForegroundColor Red
    return
  }

  $dir = Join-Path $env:TEMP ('imcodes-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $binary = Join-Path $dir 'imcodes-node.exe'
  $prevOutputEncoding = $OutputEncoding
  $prevConsoleOutputEncoding = [Console]::OutputEncoding
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host 'IM.codes: downloading...'
    try {
      $payloadResponse = Invoke-WebRequest -Uri ($server + '__PAYLOAD_PATH__') -Method Post -Body @{ __TICKET_FIELD__ = $code } -UseBasicParsing -MaximumRedirection 0
      $payload = $payloadResponse.Content | ConvertFrom-Json
    } catch {
      Write-Host 'IM.codes: download failed. The install command may have been revoked or used up.' -ForegroundColor Red
      Write-Host ("IM.codes: " + $_.Exception.Message) -ForegroundColor Red
      return
    }
    if (-not $payload -or -not $payload.artifactUrl -or -not $payload.sha256 -or -not $payload.enrollment) {
      Write-Host 'IM.codes: invalid enrollment payload from server.' -ForegroundColor Red
      return
    }
    $artifactUri = [Uri][string]$payload.artifactUrl
    $expectedSha = ([string]$payload.sha256).ToLowerInvariant()
    if ($expectedSha -notmatch '^[0-9a-f]{64}$') {
      Write-Host 'IM.codes: invalid binary checksum from server.' -ForegroundColor Red
      return
    }
    if ($server.StartsWith('https://')) {
      if ($artifactUri.Scheme -cne 'https') {
        Write-Host 'IM.codes: refused non-HTTPS artifact URL.' -ForegroundColor Red
        return
      }
    } elseif ($artifactUri.Scheme -cne 'https' -and $artifactUri.GetLeftPart([System.UriPartial]::Authority) -cne $server) {
      Write-Host 'IM.codes: refused mismatched artifact URL.' -ForegroundColor Red
      return
    }
    try {
      if ($artifactUri.Scheme -cne 'https') {
        Invoke-WebRequest -Uri $artifactUri.AbsoluteUri -Method Get -OutFile $binary -UseBasicParsing -MaximumRedirection 0
      } else {
        $currentUri = $artifactUri
        for ($hop = 0; $hop -le 5; $hop++) {
          try {
            Invoke-WebRequest -Uri $currentUri.AbsoluteUri -Method Get -OutFile $binary -UseBasicParsing -MaximumRedirection 0
            break
          } catch {
            $resp = $_.Exception.Response
            if (-not $resp) { throw }
            $statusCode = [int]$resp.StatusCode
            if ($statusCode -notin @(301, 302, 303, 307, 308)) { throw }
            if ($hop -ge 5) { throw [System.Exception]::new('too many artifact redirects') }
            $loc = $null
            if ($resp.Headers -and $resp.Headers.Location) { $loc = [string]$resp.Headers.Location }
            elseif ($resp.Headers -and $resp.Headers['Location']) { $loc = [string]$resp.Headers['Location'] }
            if ([string]::IsNullOrWhiteSpace($loc)) { throw [System.Exception]::new('redirect missing Location header') }
            $nextUri = [Uri]::new($currentUri, $loc)
            if ($nextUri.Scheme -cne 'https') { throw [System.Exception]::new('refused non-HTTPS artifact redirect') }
            if ($nextUri.UserInfo) { throw [System.Exception]::new('refused credential-bearing artifact redirect') }
            $currentUri = $nextUri
          }
        }
      }
    } catch {
      Write-Host 'IM.codes: binary download failed.' -ForegroundColor Red
      Write-Host ("IM.codes: " + $_.Exception.Message) -ForegroundColor Red
      return
    }
    if (-not (Test-Path -LiteralPath $binary) -or (Get-Item -LiteralPath $binary).Length -eq 0) {
      Write-Host 'IM.codes: the downloaded file is empty.' -ForegroundColor Red
      return
    }
    $actualSha = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -cne $expectedSha) {
      Write-Host 'IM.codes: downloaded binary checksum mismatch; refusing to execute.' -ForegroundColor Red
      return
    }
    # Strip the Mark of the Web, or Windows treats the freshly downloaded
    # binary as untrusted and blocks it before it can report anything.
    Unblock-File -LiteralPath $binary -ErrorAction SilentlyContinue
__PUBLISHER_TRUST_SCRIPT__
    Write-Host 'IM.codes: installing...'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $enrollJson = $payload.enrollment | ConvertTo-Json -Compress -Depth 4
    $enrollJson | & $binary __INSTALL_SUBCMD__ __ENROLL_STDIN_FLAG__
  } finally {
    $OutputEncoding = $prevOutputEncoding
    [Console]::OutputEncoding = $prevConsoleOutputEncoding
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Invoke-ImcodesInstall
`
    .replace(/__SERVER_URL__/g, serverUrl)
    .replace(/__INSTALL_CODE__/g, installCode)
    .replace(/__EXPECT_ARCH__/g, expectArch)
    .replace('__PUBLISHER_TRUST_SCRIPT__', publisherTrustScript)
    .replace(/__PAYLOAD_PATH__/g, CONTROLLED_NODE_INSTALL_PAYLOAD_PATH)
    .replace(/__TICKET_FIELD__/g, CONTROLLED_NODE_INSTALL_TICKET_FIELD)
    .replace(/__INSTALL_SUBCMD__/g, CONTROLLED_NODE_INSTALL_SUBCOMMAND)
    .replace(/__ENROLL_STDIN_FLAG__/g, CONTROLLED_NODE_ENROLL_STDIN_FLAG);
}

/**
 * Render the installer for the platform the ticket was minted for.
 *
 * The ticket is bound to one os/arch at mint time, so the script is too. The
 * mismatch guards inside each script exist for the case the operator pastes a
 * command onto the wrong machine, which is easy to do when several are open.
 */
export function renderControlledNodeInstallScript(input: {
  serverUrl: string;
  installCode: string;
  os: ControlledNodeOs;
  arch: ControlledNodeArtifactArch;
  abiProfile?: ControlledNodeAbiProfile;
  /** Required only for Windows; obtained from the ticket-pinned release manifest. */
  windowsAuthenticodeSignerSha256?: string;
}): InstallCommandScript {
  assertRenderable(input.serverUrl, input.installCode);
  return input.os === 'win'
    ? {
      body: renderPowerShellScript(
        input.serverUrl,
        input.installCode,
        input.arch,
        input.windowsAuthenticodeSignerSha256 ?? '',
      ),
      contentType: 'text/plain; charset=utf-8',
    }
    : {
      body: renderShellScript(input.serverUrl, input.installCode, input.os, input.abiProfile),
      contentType: 'text/plain; charset=utf-8',
    };
}

/** The line the operator copies. Shown in the UI, never parsed by the server. */
export function controlledNodeInstallCommand(
  serverUrl: string,
  installCode: string,
  os: ControlledNodeOs,
): string {
  assertRenderable(serverUrl, installCode);
  const url = `${serverUrl}${CONTROLLED_NODE_INSTALL_COMMAND_PATH}/${installCode}`;
  // This line is executed by a root shell, so its transport is part of the
  // security boundary, not presentation. `-L` without a protocol restriction
  // would follow an HTTPS→HTTP redirect and pipe cleartext into `sudo sh`.
  //
  // `/i/:code` answers 200 or 404 and never redirects, so PowerShell — which
  // has no scheme-restricting switch — refuses redirection entirely. Any 3xx
  // reaching the operator is illegitimate by construction.
  return os === 'win'
    ? `irm -MaximumRedirection 0 ${url} | iex`
    : `curl -fsSL ${curlTransportFlags(serverUrl)} ${url} | sudo sh`;
}
