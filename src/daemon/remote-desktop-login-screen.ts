import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CONTROLLED_NODE_ENROLL_STDIN_FLAG,
  CONTROLLED_NODE_INSTALL_PAYLOAD_PATH,
  CONTROLLED_NODE_INSTALL_SUBCOMMAND,
  validateEnrollmentPayload,
  type ControlledNodeInstallPayloadResponse,
} from '../../shared/controlled-node-install.js';
import {
  REMOTE_DESKTOP_LOGIN_SCREEN_ERROR,
  type RemoteDesktopLoginScreenError,
} from '../../shared/remote-desktop-login-screen.js';
import type { DaemonCredential } from './machine-mcp-deps.js';

const execFileAsync = promisify(execFile);

const MAX_ARTIFACT_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

export class ElevatedLoginScreenInstallError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`elevated install exited ${exitCode}`);
    this.name = 'ElevatedLoginScreenInstallError';
    this.exitCode = exitCode;
  }
}

function powershell(): string {
  return join(
    process.env.WINDIR ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function assertValidArtifactUrl(rawUrl: string, serverUrl: string): URL {
  const serverOrigin = new URL(serverUrl);
  const artifact = new URL(rawUrl);
  if (artifact.username || artifact.password) {
    throw new Error('refused credential-bearing artifact URL');
  }
  if (serverOrigin.protocol === 'https:') {
    if (artifact.protocol !== 'https:') {
      throw new Error('refused non-HTTPS artifact URL');
    }
    return artifact;
  }
  if (
    artifact.protocol !== 'https:'
    && !(artifact.protocol === 'http:' && (artifact.origin === serverOrigin.origin || isLoopbackHost(artifact.hostname)))
  ) {
    throw new Error('refused mismatched artifact URL');
  }
  return artifact;
}

async function parseInstallPayload(
  raw: unknown,
  serverUrl: string,
): Promise<{
  artifactUrl: URL;
  sha256: string;
  sizeBytes?: number;
  enrollmentJson: string;
} | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<ControlledNodeInstallPayloadResponse>;
  if (typeof candidate.artifactUrl !== 'string' || typeof candidate.sha256 !== 'string') return null;
  if (!SHA256_HEX_RE.test(candidate.sha256)) return null;
  let artifactUrl: URL;
  try {
    artifactUrl = assertValidArtifactUrl(candidate.artifactUrl, serverUrl);
  } catch {
    return null;
  }
  let sizeBytes: number | undefined;
  if (candidate.sizeBytes !== undefined) {
    if (typeof candidate.sizeBytes !== 'number' || !Number.isFinite(candidate.sizeBytes) || candidate.sizeBytes <= 0) {
      return null;
    }
    sizeBytes = candidate.sizeBytes;
  }
  const enrollment = validateEnrollmentPayload(candidate.enrollment);
  if (!enrollment.ok) return null;
  return {
    artifactUrl,
    sha256: candidate.sha256.toLowerCase(),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    enrollmentJson: JSON.stringify(enrollment.value),
  };
}

async function downloadVerifiedArtifact(
  fetchImpl: typeof fetch,
  initialUrl: URL,
  serverUrl: string,
  expectedSha256: string,
  expectedSizeBytes?: number,
): Promise<Buffer> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_ARTIFACT_REDIRECTS; hop++) {
    const response = await fetchImpl(currentUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
    });
    if (REDIRECT_STATUS_CODES.has(response.status)) {
      await response.body?.cancel?.().catch(() => {});
      if (hop >= MAX_ARTIFACT_REDIRECTS) {
        throw new Error('too many artifact redirects');
      }
      const location = response.headers.get('location')?.trim() ?? '';
      if (!location) {
        throw new Error('redirect missing Location header');
      }
      const nextUrl = new URL(location, currentUrl);
      currentUrl = assertValidArtifactUrl(nextUrl.toString(), serverUrl);
      continue;
    }
    if (!response.ok) {
      throw new Error(`artifact download failed (${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error('downloaded binary is empty');
    }
    if (expectedSizeBytes !== undefined && bytes.length !== expectedSizeBytes) {
      throw new Error(`downloaded binary size mismatch (${bytes.length} !== ${expectedSizeBytes})`);
    }
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error(`downloaded binary sha256 mismatch (${actualSha256} !== ${expectedSha256})`);
    }
    return bytes;
  }
  throw new Error('too many artifact redirects');
}

/**
 * Build the PowerShell script that runs inside the UAC-elevated session to
 * pipe the enrollment JSON via UTF-8 (no BOM) stdin into `install --enroll-stdin`.
 */
export function buildElevatedLoginScreenInnerScript(
  executable: string,
  enrollmentFile: string,
): string {
  const escapedExe = escapePowerShellSingleQuoted(executable);
  const escapedEnroll = escapePowerShellSingleQuoted(enrollmentFile);
  return [
    "$ErrorActionPreference = 'Stop'",
    '$prevOut = $OutputEncoding',
    '$prevCon = [Console]::OutputEncoding',
    '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
    'try {',
    '  $OutputEncoding = $utf8NoBom',
    '  [Console]::OutputEncoding = $utf8NoBom',
    `  $json = [System.IO.File]::ReadAllText('${escapedEnroll}', $utf8NoBom)`,
    `  $json | & '${escapedExe}' ${CONTROLLED_NODE_INSTALL_SUBCOMMAND} ${CONTROLLED_NODE_ENROLL_STDIN_FLAG}`,
    '  exit $LASTEXITCODE',
    '} finally {',
    '  $OutputEncoding = $prevOut',
    '  [Console]::OutputEncoding = $prevCon',
    '}',
  ].join('; ');
}

/**
 * Ask Windows to run the verified installer elevated, piping the temporary
 * enrollment JSON file through `--enroll-stdin`.
 *
 * `-Verb RunAs` raises the UAC prompt, and that prompt shows the unmodified
 * binary's publisher signature. The inner command runs via `-EncodedCommand` so
 * paths with spaces or single quotes and `--enroll-stdin` never suffer nested
 * quoting bugs or expose `enrollToken` on the command line.
 */
export async function elevateLoginScreenInstaller(
  executable: string,
  enrollmentFile: string,
  run: (file: string, args: readonly string[]) => Promise<unknown> = (file, args) =>
    execFileAsync(file, [...args], { windowsHide: true, timeout: 600_000 }),
): Promise<void> {
  const psPath = powershell();
  const innerEncoded = Buffer.from(
    buildElevatedLoginScreenInnerScript(executable, enrollmentFile),
    'utf16le',
  ).toString('base64');
  try {
    await run(psPath, [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; "
      + `$p = Start-Process -FilePath '${escapePowerShellSingleQuoted(psPath)}' `
      + `-ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', '${innerEncoded}') `
      + '-Verb RunAs -Wait -PassThru; '
      + 'if ($p.ExitCode -ne 0) { throw "elevated install exited $($p.ExitCode)" }',
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const match = /\belevated install exited (-?\d+)\b/.exec(message);
    if (match) {
      throw new ElevatedLoginScreenInstallError(Number(match[1]));
    }
    throw error;
  }
}

export interface InstallLoginScreenControlInput {
  /** Minted by the browser with the user's own session. */
  ticket: string;
  /** Where the daemon keeps downloads. */
  root: string;
  loadCredential: () => Promise<DaemonCredential | null>;
  fetchImpl?: typeof fetch;
  elevate?: (executable: string, enrollmentFile: string) => Promise<void>;
  onState?: (state: 'downloading' | 'elevating') => void;
}

/**
 * Exchange the browser ticket for an unmodified signed installer URL +
 * enrollment payload, verify SHA-256 (and size), then elevate once with
 * `install --enroll-stdin`.
 *
 * Returns null on success, or the reason to report. Nothing about the enrolment
 * itself is decided here: the installer enrols the node from inside, which is
 * why the browser learns the outcome by seeing the machine appear rather than
 * from this daemon.
 */
export async function installLoginScreenControl(
  input: InstallLoginScreenControlInput,
): Promise<RemoteDesktopLoginScreenError | null> {
  const credential = await input.loadCredential();
  if (!credential) return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.NOT_BOUND;

  const fetchImpl = input.fetchImpl ?? fetch;
  input.onState?.('downloading');
  const payloadUrl = new URL(CONTROLLED_NODE_INSTALL_PAYLOAD_PATH, credential.serverUrl).toString();
  let parsedPayload: Awaited<ReturnType<typeof parseInstallPayload>>;
  try {
    const response = await fetchImpl(payloadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.ticket}` },
      redirect: 'error',
    });
    if (!response.ok) return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
    parsedPayload = await parseInstallPayload(await response.json(), credential.serverUrl);
  } catch {
    return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
  }
  if (!parsedPayload) return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;

  let bytes: Buffer;
  try {
    bytes = await downloadVerifiedArtifact(
      fetchImpl,
      parsedPayload.artifactUrl,
      credential.serverUrl,
      parsedPayload.sha256,
      parsedPayload.sizeBytes,
    );
  } catch {
    return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED;
  }

  const baseDir = join(input.root, 'login-screen');
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  const attemptDir = await mkdtemp(join(baseDir, 'attempt-'));
  const executable = join(attemptDir, `imcodes-node-${parsedPayload.sha256.slice(0, 16)}.exe`);
  const enrollmentFile = join(attemptDir, 'enrollment.json');
  try {
    await writeFile(executable, bytes, { mode: 0o755 });
    await writeFile(enrollmentFile, parsedPayload.enrollmentJson, { encoding: 'utf8', mode: 0o600 });

    input.onState?.('elevating');
    try {
      await (input.elevate ?? elevateLoginScreenInstaller)(executable, enrollmentFile);
    } catch (error) {
      if (error instanceof ElevatedLoginScreenInstallError) {
        return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.INSTALL_FAILED;
      }
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (/\belevated install exited (-?\d+)\b/.test(message)) {
        return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.INSTALL_FAILED;
      }
      // Windows reports a dismissed prompt as a failed Start-Process, and cannot
      // distinguish "declined" from "cancelled" — both mean nobody approved it.
      return REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ELEVATION_DECLINED;
    }
    return null;
  } finally {
    await rm(attemptDir, { recursive: true, force: true }).catch(() => {});
  }
}
