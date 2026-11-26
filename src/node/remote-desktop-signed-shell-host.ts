import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  RemoteDesktopSignedShellLaunchCommand,
  RemoteDesktopSignedShellLauncher,
} from './remote-desktop-shell-launch.js';
import {
  launchWindowsActiveUserCommand,
  quoteWindowsArgument,
} from './windows-user-session.js';
import {
  WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
  verifyWindowsAuthenticodeSigners,
} from './windows-artifact-trust.js';

export const REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME =
  'imcodes-remote-desktop-account-shell.exe';
export const REMOTE_DESKTOP_ACCOUNT_SHELL_MANIFEST_FILENAME =
  'account-shell-manifest.json';

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface RemoteDesktopAccountShellManifest {
  schemaVersion: 1;
  artifact: typeof REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME;
  size: number;
  sha256: string;
  signerSha256: string;
  nativeClient: 'imcodes-controlled-shell-v1';
}

export interface VerifiedRemoteDesktopAccountShellArtifact {
  executablePath: string;
  manifestPath: string;
  manifest: RemoteDesktopAccountShellManifest;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function validateRemoteDesktopAccountShellManifest(
  value: unknown,
): RemoteDesktopAccountShellManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, [
    'schemaVersion', 'artifact', 'size', 'sha256', 'signerSha256', 'nativeClient',
  ])
    || candidate.schemaVersion !== 1
    || candidate.artifact !== REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME
    || typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size)
    || candidate.size <= 0
    || typeof candidate.sha256 !== 'string' || !SHA256_RE.test(candidate.sha256)
    || typeof candidate.signerSha256 !== 'string' || !SHA256_RE.test(candidate.signerSha256)
    || candidate.nativeClient !== 'imcodes-controlled-shell-v1') return null;
  return candidate as unknown as RemoteDesktopAccountShellManifest;
}

export function verifyRemoteDesktopAccountShellArtifact(
  executablePath: string,
  trustedSignerSha256 = WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
): VerifiedRemoteDesktopAccountShellArtifact | null {
  try {
    if (!SHA256_RE.test(trustedSignerSha256)) return null;
    const manifestPath = join(dirname(executablePath), REMOTE_DESKTOP_ACCOUNT_SHELL_MANIFEST_FILENAME);
    const executable = lstatSync(executablePath);
    const manifestFile = lstatSync(manifestPath);
    if (!executable.isFile() || executable.isSymbolicLink()
      || !manifestFile.isFile() || manifestFile.isSymbolicLink()) return null;
    const manifest = validateRemoteDesktopAccountShellManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    );
    if (!manifest || manifest.signerSha256 !== trustedSignerSha256
      || executable.size !== manifest.size
      || createHash('sha256').update(readFileSync(executablePath)).digest('hex')
        !== manifest.sha256) return null;
    return { executablePath, manifestPath, manifest };
  } catch {
    return null;
  }
}

function candidateExecutables(execPath = process.execPath): string[] {
  const explicit = process.env.IMCODES_REMOTE_DESKTOP_ACCOUNT_SHELL_EXE?.trim();
  const executableDir = dirname(resolve(execPath));
  return [...new Set([
    explicit,
    join(executableDir, 'remote-desktop-account-shell', 'win32-x64',
      REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME),
    join(executableDir, REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME),
    resolve(process.cwd(), 'dist', 'remote-desktop-account-shell', 'win32-x64',
      REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME),
  ].filter((entry): entry is string => Boolean(entry)))];
}

export function resolveRemoteDesktopAccountShellArtifact(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
  execPath = process.execPath,
  trustedSignerSha256 = WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
): VerifiedRemoteDesktopAccountShellArtifact | null {
  if (platform !== 'win32' || arch !== 'x64') return null;
  for (const candidate of candidateExecutables(execPath)) {
    if (!existsSync(candidate)) continue;
    const verified = verifyRemoteDesktopAccountShellArtifact(candidate, trustedSignerSha256);
    if (verified) return verified;
  }
  return null;
}

export function createRemoteDesktopSignedShellLauncher(
  artifact: VerifiedRemoteDesktopAccountShellArtifact,
  trustedSignerSha256 = WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
  verifySigners: typeof verifyWindowsAuthenticodeSigners = verifyWindowsAuthenticodeSigners,
  launch: typeof launchWindowsActiveUserCommand = launchWindowsActiveUserCommand,
): RemoteDesktopSignedShellLauncher {
  return {
    async launch(command: RemoteDesktopSignedShellLaunchCommand): Promise<void> {
      if (command.executable !== artifact.executablePath) {
        throw new Error('remote_desktop_account_shell_path_changed');
      }
      const current = verifyRemoteDesktopAccountShellArtifact(
        artifact.executablePath,
        trustedSignerSha256,
      );
      if (!current || !await verifySigners([current.executablePath], trustedSignerSha256)) {
        throw new Error('remote_desktop_account_shell_authenticity_failed');
      }
      launch(
        current.executablePath,
        command.args.map(quoteWindowsArgument).join(' '),
      );
    },
  };
}
