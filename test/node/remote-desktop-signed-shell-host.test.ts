import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME,
  REMOTE_DESKTOP_ACCOUNT_SHELL_MANIFEST_FILENAME,
  createRemoteDesktopSignedShellLauncher,
  resolveRemoteDesktopAccountShellArtifact,
  verifyRemoteDesktopAccountShellArtifact,
} from '../../src/node/remote-desktop-signed-shell-host.js';

const SIGNER = 'a'.repeat(64);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});
async function artifact() {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-rd-signed-shell-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME);
  const bytes = Buffer.from('signed-shell-test-artifact');
  await writeFile(executablePath, bytes);
  await writeFile(join(root, REMOTE_DESKTOP_ACCOUNT_SHELL_MANIFEST_FILENAME), JSON.stringify({
    schemaVersion: 1,
    artifact: REMOTE_DESKTOP_ACCOUNT_SHELL_FILENAME,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signerSha256: SIGNER,
    nativeClient: 'imcodes-controlled-shell-v1',
  }));
  return { root, executablePath };
}

describe('remote desktop signed-shell artifact host', () => {
  it('resolves only an exact hash/signer-bound Windows x64 manifest', async () => {
    const built = await artifact();
    expect(verifyRemoteDesktopAccountShellArtifact(built.executablePath, SIGNER))
      .toMatchObject({ executablePath: built.executablePath });
    expect(resolveRemoteDesktopAccountShellArtifact(
      'win32', 'x64', join(built.root, 'node.exe'), SIGNER,
    )).toMatchObject({ executablePath: built.executablePath });
    expect(resolveRemoteDesktopAccountShellArtifact(
      'darwin', 'x64', join(built.root, 'node.exe'), SIGNER,
    )).toBeNull();
    await writeFile(built.executablePath, 'tampered');
    expect(verifyRemoteDesktopAccountShellArtifact(built.executablePath, SIGNER)).toBeNull();
  });

  it('revalidates Authenticode immediately before active-user launch', async () => {
    const built = await artifact();
    const verified = verifyRemoteDesktopAccountShellArtifact(built.executablePath, SIGNER)!;
    const verifySigners = vi.fn(async () => true);
    const launch = vi.fn();
    const launcher = createRemoteDesktopSignedShellLauncher(
      verified, SIGNER, verifySigners as never, launch as never,
    );
    await launcher.launch({
      executable: built.executablePath,
      args: [
        '--remote-desktop-signed-shell',
        '--server-origin',
        'https://im.example',
        '--launch-context-b64',
        'eyJob3N0SWQiOiJob3N0LTAwMDAwMDAwMDAwMDAwMDAwMDAxIn0',
      ],
      serverOrigin: 'https://im.example',
      context: {
        hostId: 'host-00000000000000000001',
        launchId: 'launch-000000000000000001',
        issuedAt: 1,
        expiresAt: 2,
        endpointGeneration: 3,
      },
    });
    expect(verifySigners).toHaveBeenCalledWith([built.executablePath], SIGNER);
    expect(launch).toHaveBeenCalledWith(
      built.executablePath,
      expect.stringContaining('https://im.example'),
    );
  });

  it('fails closed when the launch-time signature is no longer valid', async () => {
    const built = await artifact();
    const verified = verifyRemoteDesktopAccountShellArtifact(built.executablePath, SIGNER)!;
    const launch = vi.fn();
    const launcher = createRemoteDesktopSignedShellLauncher(
      verified, SIGNER, (async () => false) as never, launch as never,
    );
    await expect(launcher.launch({
      executable: built.executablePath,
      args: [],
      serverOrigin: 'https://im.example',
      context: {
        hostId: 'host-00000000000000000001',
        launchId: 'launch-000000000000000001',
        issuedAt: 1,
        expiresAt: 2,
        endpointGeneration: 3,
      },
    })).rejects.toThrow('authenticity_failed');
    expect(launch).not.toHaveBeenCalled();
  });
});
