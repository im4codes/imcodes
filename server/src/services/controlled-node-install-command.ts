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
  isControlledNodeInstallCode,
  type ControlledNodeArtifactArch,
  type ControlledNodeOs,
} from '../../../shared/controlled-node-artifacts.js';

/** Path the pasted command hits. Short because it is typed and dictated. */
export const CONTROLLED_NODE_INSTALL_COMMAND_PATH = '/i';

/** Where the script posts the install code to obtain the personalized binary. */
const DOWNLOAD_PATH = '/api/enroll/v2/download';

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

  imcodes_dir=$(mktemp -d 2>/dev/null || mktemp -d -t imcodes)
  trap 'rm -rf "$imcodes_dir"' EXIT INT TERM
  imcodes_binary="$imcodes_dir/imcodes-node"

  echo "IM.codes: downloading..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL __CURL_PROTOCOL_FLAGS__\
      --data-urlencode "ticket=$imcodes_code" \
      "$imcodes_server__DOWNLOAD_PATH__" -o "$imcodes_binary" || {
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
    wget -q __WGET_PROTOCOL_FLAGS__--post-data="ticket=$imcodes_code" \
      "$imcodes_server__DOWNLOAD_PATH__" -O "$imcodes_binary" || {
      echo "IM.codes: download failed. The install command may have been revoked or used up." >&2
      exit 1
    }
  else
    echo "IM.codes: neither curl nor wget is available." >&2
    exit 1
  fi

  if [ ! -s "$imcodes_binary" ]; then
    echo "IM.codes: the downloaded file is empty." >&2
    exit 1
  fi

  chmod 700 "$imcodes_binary"
  echo "IM.codes: installing..."
  "$imcodes_binary"
}

imcodes_install
`
    .replace(/__SERVER_URL__/g, serverUrl)
    .replace(/__INSTALL_CODE__/g, installCode)
    .replace(/__EXPECT_OS__/g, expectOs)
    .replace(/__CURL_PROTOCOL_FLAGS__/g, curlProtocolFlags)
    .replace(/__WGET_PROTOCOL_FLAGS__/g, wgetProtocolFlags)
    .replace(/__DOWNLOAD_PATH__/g, DOWNLOAD_PATH);
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
): string {
  const expectArch = arch === CONTROLLED_NODE_ARCH_ARM64 ? 'ARM64' : 'AMD64';
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
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host 'IM.codes: downloading...'
    try {
      Invoke-WebRequest -Uri ($server + '__DOWNLOAD_PATH__') -Method Post -Body @{ ticket = $code } -OutFile $binary -UseBasicParsing -MaximumRedirection 0
    } catch {
      Write-Host 'IM.codes: download failed. The install command may have been revoked or used up.' -ForegroundColor Red
      Write-Host ("IM.codes: " + $_.Exception.Message) -ForegroundColor Red
      return
    }
    if (-not (Test-Path -LiteralPath $binary) -or (Get-Item -LiteralPath $binary).Length -eq 0) {
      Write-Host 'IM.codes: the downloaded file is empty.' -ForegroundColor Red
      return
    }
    # Strip the Mark of the Web, or Windows treats the freshly downloaded
    # binary as untrusted and blocks it before it can report anything.
    Unblock-File -LiteralPath $binary -ErrorAction SilentlyContinue
    Write-Host 'IM.codes: installing...'
    & $binary
  } finally {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Invoke-ImcodesInstall
`
    .replace(/__SERVER_URL__/g, serverUrl)
    .replace(/__INSTALL_CODE__/g, installCode)
    .replace(/__EXPECT_ARCH__/g, expectArch)
    .replace(/__DOWNLOAD_PATH__/g, DOWNLOAD_PATH);
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
}): InstallCommandScript {
  assertRenderable(input.serverUrl, input.installCode);
  return input.os === 'win'
    ? {
      body: renderPowerShellScript(input.serverUrl, input.installCode, input.arch),
      contentType: 'text/plain; charset=utf-8',
    }
    : {
      body: renderShellScript(input.serverUrl, input.installCode, input.os),
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
