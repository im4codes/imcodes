#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIBWEBRTC_SDK_LOCK_FILENAME,
  verifyLibwebrtcSdkLock,
} from './libwebrtc-sdk-artifacts.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function main() {
  const lockPath = resolve(
    repositoryRoot,
    process.argv[2] ?? `native/windows-remote-desktop/${LIBWEBRTC_SDK_LOCK_FILENAME}`,
  );
  const lock = await verifyLibwebrtcSdkLock(lockPath);
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  const lines = [
    `repository=${lock.repository}`,
    `release_tag=${lock.releaseTag}`,
    `asset_name=${lock.assetName}`,
    `sha256=${lock.sha256}`,
    `source_sha256=${lock.sourceSha256}`,
  ];
  if (outputPath) {
    await appendFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  } else {
    process.stdout.write(`${JSON.stringify(lock)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
