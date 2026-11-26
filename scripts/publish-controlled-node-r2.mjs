#!/usr/bin/env node
import { execFile as execFileCb } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export const R2_MUTABLE_CACHE_CONTROL = 'no-cache, max-age=0, must-revalidate';
export const CONTROLLED_NODE_R2_MANIFEST_FILENAME = 'release-artifacts-manifest.json';
const MAX_UPLOAD_ATTEMPTS = 3;

function defaultSleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function defaultRunAws(args, env) {
  const { stdout, stderr } = await execFile('aws', args, {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}

function normalizeTrimmed(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizePrefix(raw) {
  return normalizeTrimmed(raw).replace(/^\/+|\/+$/gu, '');
}

/**
 * Deterministically publish top-level controlled-node artifacts to R2 without
 * `aws s3 sync --delete` (which can delete prefix-sibling filenames after upload):
 * 1. Upload every non-manifest artifact first (`s3 cp`, no-cache headers, retries)
 * 2. Upload `release-artifacts-manifest.json` last so readers never observe a manifest ahead of its binaries
 * 3. Delete only top-level keys absent from `distDir` (`list-objects-v2 --delimiter /`)
 * 4. Verify every manifest entry (and manifest itself) via `s3api head-object` ContentLength parity
 */
export async function publishControlledNodeR2(options = {}) {
  const env = options.env ?? process.env;
  const distDir = resolve(options.distDir ?? env.DIST_DIR ?? 'dist-controlled-node-release');
  const accountId = normalizeTrimmed(options.accountId ?? env.R2_ACCOUNT_ID);
  const bucket = normalizeTrimmed(options.bucket ?? env.R2_BUCKET);
  const accessKeyId = normalizeTrimmed(options.accessKeyId ?? env.R2_ACCESS_KEY_ID);
  const secretAccessKey = normalizeTrimmed(options.secretAccessKey ?? env.R2_SECRET_ACCESS_KEY);
  const prefix = normalizePrefix(options.prefix ?? env.R2_PREFIX);
  const channel = normalizeTrimmed(options.channel ?? env.R2_CHANNEL);
  const retryDelayRaw = options.retryDelaySeconds ?? env.R2_SYNC_RETRY_DELAY_SECONDS ?? '5';
  const retryDelaySeconds = Number.isFinite(Number(retryDelayRaw)) && Number(retryDelayRaw) >= 0
    ? Number(retryDelayRaw)
    : 5;

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('missing_r2_credentials');
  }
  if (channel !== 'dev' && channel !== 'master') {
    throw new Error(`invalid_r2_channel:${channel || '(empty)'}`);
  }

  const endpointUrl = `https://${accountId}.r2.cloudflarestorage.com`;
  const keyPrefix = `${prefix ? `${prefix}/` : ''}${channel}/`;
  const awsEnv = {
    ...env,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_DEFAULT_REGION: 'auto',
    AWS_REQUEST_CHECKSUM_CALCULATION: env.AWS_REQUEST_CHECKSUM_CALCULATION || 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: env.AWS_RESPONSE_CHECKSUM_VALIDATION || 'when_required',
  };

  const runAws = options.runAws ?? defaultRunAws;
  const sleep = options.sleep ?? defaultSleep;

  const entries = readdirSync(distDir)
    .filter((name) => {
      if (!name || name === '.' || name === '..' || name.includes('/')) return false;
      const st = lstatSync(join(distDir, name));
      return st.isFile() && !st.isSymbolicLink();
    })
    .sort();

  if (!entries.includes(CONTROLLED_NODE_R2_MANIFEST_FILENAME)) {
    throw new Error(`missing_manifest:${join(distDir, CONTROLLED_NODE_R2_MANIFEST_FILENAME)}`);
  }

  const nonManifestFiles = entries.filter((name) => name !== CONTROLLED_NODE_R2_MANIFEST_FILENAME);
  const localFileSet = new Set(entries);

  const runWithRetries = async (args, label) => {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        return await runAws(args, awsEnv);
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_UPLOAD_ATTEMPTS && retryDelaySeconds > 0) {
          await sleep(attempt * retryDelaySeconds * 1000);
        }
      }
    }
    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`${label}_failed_after_${MAX_UPLOAD_ATTEMPTS}_attempts:${detail}`);
  };

  const uploadSingleFile = async (fileName) => {
    const localPath = join(distDir, fileName);
    const s3Uri = `s3://${bucket}/${keyPrefix}${fileName}`;
    await runWithRetries(
      [
        's3',
        'cp',
        localPath,
        s3Uri,
        '--cache-control',
        R2_MUTABLE_CACHE_CONTROL,
        '--endpoint-url',
        endpointUrl,
        '--no-progress',
      ],
      `upload:${fileName}`,
    );
  };

  // 1. Upload every artifact binary/archive first.
  for (const fileName of nonManifestFiles) {
    await uploadSingleFile(fileName);
  }

  // 2. Upload release-artifacts-manifest.json last.
  await uploadSingleFile(CONTROLLED_NODE_R2_MANIFEST_FILENAME);

  // 3. Delete only stale top-level objects in `${keyPrefix}` absent from `distDir`, never touching `android/*` or `npm/*`.
  const staleKeys = [];
  let continuationToken;
  do {
    const listArgs = [
      's3api',
      'list-objects-v2',
      '--bucket',
      bucket,
      '--prefix',
      keyPrefix,
      '--delimiter',
      '/',
      '--endpoint-url',
      endpointUrl,
      '--output',
      'json',
    ];
    if (continuationToken) {
      listArgs.push('--continuation-token', continuationToken);
    }
    const { stdout } = await runWithRetries(listArgs, 'list_objects');
    const parsed = stdout.trim() ? JSON.parse(stdout) : {};
    const contents = Array.isArray(parsed.Contents) ? parsed.Contents : [];
    for (const item of contents) {
      const fullKey = typeof item?.Key === 'string' ? item.Key : '';
      if (!fullKey.startsWith(keyPrefix)) continue;
      const rel = fullKey.slice(keyPrefix.length);
      if (!rel || rel.includes('/')) continue;
      if (!localFileSet.has(rel)) {
        staleKeys.push(fullKey);
      }
    }
    continuationToken = parsed.IsTruncated && typeof parsed.NextContinuationToken === 'string'
      ? parsed.NextContinuationToken
      : undefined;
  } while (continuationToken);

  for (const staleKey of staleKeys) {
    await runWithRetries(
      [
        's3api',
        'delete-object',
        '--bucket',
        bucket,
        '--key',
        staleKey,
        '--endpoint-url',
        endpointUrl,
      ],
      `delete:${staleKey}`,
    );
  }

  // 4. Post-publish verification gate: head-object check for manifest and every manifest artifact.
  const manifestPath = join(distDir, CONTROLLED_NODE_R2_MANIFEST_FILENAME);
  const manifestSize = statSync(manifestPath).size;
  const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expectedObjects = new Map([[CONTROLLED_NODE_R2_MANIFEST_FILENAME, manifestSize]]);

  const artifacts = manifestJson && typeof manifestJson === 'object' && !Array.isArray(manifestJson.artifacts)
    ? manifestJson.artifacts
    : {};
  for (const entry of Object.values(artifacts)) {
    if (!entry || typeof entry !== 'object') continue;
    const assetFilename = typeof entry.assetFilename === 'string' ? entry.assetFilename : '';
    const sizeBytes = typeof entry.sizeBytes === 'number' ? entry.sizeBytes : -1;
    if (!assetFilename || assetFilename.includes('/') || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw new Error(`invalid_manifest_entry:${JSON.stringify(entry)}`);
    }
    const prev = expectedObjects.get(assetFilename);
    if (prev !== undefined && prev !== sizeBytes) {
      throw new Error(`conflicting_manifest_size:${assetFilename}`);
    }
    expectedObjects.set(assetFilename, sizeBytes);
  }

  for (const [fileName, expectedSize] of expectedObjects.entries()) {
    const { stdout } = await runWithRetries(
      [
        's3api',
        'head-object',
        '--bucket',
        bucket,
        '--key',
        `${keyPrefix}${fileName}`,
        '--endpoint-url',
        endpointUrl,
        '--output',
        'json',
      ],
      `head:${fileName}`,
    );
    const head = stdout.trim() ? JSON.parse(stdout) : {};
    const actualSize = Number(head.ContentLength);
    if (!Number.isSafeInteger(actualSize) || actualSize !== expectedSize) {
      throw new Error(`r2_verify_size_mismatch:${fileName}:expected=${expectedSize}:actual=${String(head.ContentLength)}`);
    }
  }

  return {
    channel,
    keyPrefix,
    uploaded: [...nonManifestFiles, CONTROLLED_NODE_R2_MANIFEST_FILENAME],
    deleted: staleKeys,
    verifiedCount: expectedObjects.size,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  publishControlledNodeR2().then((res) => {
    process.stdout.write(
      `Published ${res.uploaded.length} R2 controlled-node files to ${res.keyPrefix} (deleted ${res.deleted.length} stale keys, verified ${res.verifiedCount} objects)\n`,
    );
  }).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
