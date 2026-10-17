import { execFile } from 'node:child_process';
import { WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT } from '../../shared/windows-powershell-modules.js';
import { buildWindowsReleasePublisherTrustScript } from '../../shared/windows-release-publisher-trust.js';

// Replaced by scripts/build-node-exe.mjs when producing the Windows SEA. An
// ordinary source/dev runtime deliberately has no release trust anchor and
// therefore cannot advertise or execute production native sidecars.
declare const __IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__: string | undefined;

export const WINDOWS_COMPILED_RELEASE_SIGNER_SHA256 =
  typeof __IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__ === 'string'
    ? __IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__
    : '';

const SHA256_RE = /^[a-f0-9]{64}$/;
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function powershellBase64(value: string): string {
  return Buffer.from(value, 'utf16le').toString('base64');
}

function runWindowsTrustScript(
  script: string,
  run: typeof execFile = execFile,
  timeout = 30_000,
): Promise<boolean> {
  return runWindowsTrustScriptWithDetail(script, run, timeout).then((outcome) => outcome.ok);
}

/** Why a trust script failed, in the script's own words. */
export interface WindowsTrustOutcome {
  ok: boolean;
  /** PowerShell's failure text, already trimmed and bounded. Empty when ok. */
  detail: string;
}

const TRUST_DETAIL_MAX_CHARS = 400;

/**
 * Unwrap PowerShell's CLIXML error envelope.
 *
 * When stderr is redirected — which it always is here, because the caller
 * captures it — powershell.exe serializes error records instead of writing
 * plain text, so the stream starts with `#< CLIXML` and the real message is
 * buried in `<S S="Error">` elements with `_xNNNN_` character escapes. Reading
 * the first "line" of that stream yields the literal string `#< CLIXML`, which
 * is what a real failed install reported to its operator.
 *
 * Anything that is not CLIXML is returned untouched.
 */
export function decodePowerShellClixml(raw: string): string {
  if (!raw.includes('#< CLIXML')) return raw;
  const segments = [...raw.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/g)].map((match) => match[1] ?? '');
  if (segments.length === 0) return raw;
  return segments
    .map((segment) => segment
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // Ampersand last, so a literal `&amp;lt;` does not become `<`.
      .replace(/&amp;/g, '&'))
    .join('');
}

/**
 * Reduce a PowerShell failure to the one line that says what went wrong.
 *
 * The trust script throws six distinct, deliberately specific messages. Only
 * the first line of PowerShell's error output carries one; the rest is `At
 * line:N char:M` position noise and a source echo, which pushes the useful text
 * off a console the operator can barely read as it is.
 */
function summarizeTrustFailure(
  error: (Error & { killed?: boolean; code?: number | string }) | null,
  stdout: string,
  stderr: string,
  timeout: number,
): string {
  if (error?.killed) return `PowerShell did not finish within ${Math.round(timeout / 1000)}s`;
  const lines = `${decodePowerShellClixml(stderr)}\n${decodePowerShellClixml(stdout)}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Filter by shape, not by prose: PowerShell localizes its position header
    // ("At line:1 char:1" becomes 所在位置 行:1 字符: 1 on a Chinese host), so an
    // English-only pattern silently keeps the noise on exactly the machines
    // that are hardest to debug.
    .filter((line) => line.length > 0 && !/^\+|^~+$|^#< CLIXML$|^<Objs\b/.test(line));
  const first = lines[0] ?? error?.message ?? '';
  // Strip PowerShell's `<script> : ` prefix so the thrown text leads.
  return first.replace(/^.*?\.ps1\s*:\s*/, '').slice(0, TRUST_DETAIL_MAX_CHARS);
}

function runWindowsTrustScriptWithDetail(
  script: string,
  run: typeof execFile = execFile,
  timeout = 30_000,
): Promise<WindowsTrustOutcome> {
  return new Promise((resolveOutcome) => {
    run(
      WINDOWS_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', powershellBase64(script)],
      { windowsHide: true, timeout, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolveOutcome({ ok: true, detail: '' });
        resolveOutcome({
          ok: false,
          detail: summarizeTrustFailure(
            error as Error & { killed?: boolean },
            typeof stdout === 'string' ? stdout : '',
            typeof stderr === 'string' ? stderr : '',
            timeout,
          ),
        });
      },
    );
  });
}

/** Re-establish Windows trust-chain and exact release-signer identity. */
export function verifyWindowsAuthenticodeSigners(
  paths: readonly string[],
  expectedSignerSha256: string,
  run: typeof execFile = execFile,
): Promise<boolean> {
  if (!SHA256_RE.test(expectedSignerSha256) || paths.length === 0) {
    return Promise.resolve(false);
  }
  const pathsBase64 = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT
    + String.raw`
$paths = @((ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATHS64__')))))
$expected = '__SIGNER_SHA256__'
foreach ($path in $paths) {
  $signature = Get-AuthenticodeSignature -LiteralPath ([string]$path)
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'invalid Authenticode signature' }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }
  if ($actual -cne $expected) { throw 'unexpected Authenticode signer' }
}
`.replace('__PATHS64__', pathsBase64).replace('__SIGNER_SHA256__', expectedSignerSha256);
  return runWindowsTrustScript(script, run);
}

/**
 * Trust the public leaf embedded in the signed installer after elevation.
 * The private key is never exported or installed. The exact compiled DER hash
 * and Code Signing EKU are checked before the leaf reaches either trust store.
 */
export function installWindowsReleasePublisherTrust(
  executablePath: string,
  expectedSignerSha256 = WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
  run: typeof execFile = execFile,
): Promise<WindowsTrustOutcome> {
  if (!SHA256_RE.test(expectedSignerSha256)) {
    return Promise.resolve({ ok: false, detail: 'no compiled release trust anchor' });
  }
  const script = buildWindowsReleasePublisherTrustScript(executablePath, expectedSignerSha256);
  return runWindowsTrustScriptWithDetail(script, run, 60_000);
}
