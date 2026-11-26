import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error ESM config module
import { createPcAppElectronBuilderConfig } from '../electron-builder.config.mjs';

const require = createRequire(import.meta.url);
const { Packager, CancellationToken } = require('app-builder-lib') as {
  Packager: new (
    options: { projectDir: string; config: Record<string, unknown> },
    cancellationToken: unknown,
  ) => { validateConfig(): Promise<void> };
  CancellationToken: new () => unknown;
};

describe('PC App electron-builder schema validation', () => {
  const pcAppDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

  it('validates generated darwin and win32 configs against real app-builder-lib schema and rejects top-level zip', async () => {
    const releaseSha1 = 'A'.repeat(40);
    const winThumbprint = 'a'.repeat(40);
    const winSha256 = 'b'.repeat(64);

    const darwinCfg = createPcAppElectronBuilderConfig({
      platform: 'darwin',
      macArch: 'universal',
      version: '0.1.0',
      env: {
        IMCODES_MACOS_SIGNING_IDENTITY: releaseSha1,
        IMCODES_PC_APP_UPDATE_URL: 'https://dl.im.codes/dev/pc-app',
      },
    });
    expect('zip' in darwinCfg).toBe(false);
    await new Packager({ projectDir: pcAppDir, config: darwinCfg }, new CancellationToken()).validateConfig();

    const winCfg = createPcAppElectronBuilderConfig({
      platform: 'win32',
      winArch: 'x64',
      version: '0.1.0',
      env: {
        IMCODES_PC_APP_REQUIRE_SIGNING: '1',
        IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT: winThumbprint,
        IMCODES_WINDOWS_SIGNING_CERT_SHA256: winSha256,
        IMCODES_PC_APP_UPDATE_URL: 'https://dl.im.codes/pc-app',
      },
    });
    expect('zip' in winCfg).toBe(false);
    await new Packager({ projectDir: pcAppDir, config: winCfg }, new CancellationToken()).validateConfig();

    const invalidWithZip = createPcAppElectronBuilderConfig({
      platform: 'darwin',
      version: '0.1.0',
      env: {},
    });
    (invalidWithZip as Record<string, unknown>).zip = {
      artifactName: 'IM.codes-${version}-${arch}.${ext}',
    };
    await expect(
      new Packager({ projectDir: pcAppDir, config: invalidWithZip }, new CancellationToken()).validateConfig(),
    ).rejects.toThrow(/unknown property 'zip'/);
  });
});
