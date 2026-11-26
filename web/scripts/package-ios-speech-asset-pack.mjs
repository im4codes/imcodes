#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IOS_SPEECH_ASSET_PACK_ID = 'com.im.codes.speech.qwen3-asr-0.6b-mlx-4bit';
export const IOS_SPEECH_ASSET_PACK_DIR = 'ios-models';
export const IOS_SPEECH_ASSET_PACK_REQUIRED_FILES = [
  'config.json',
  'merges.txt',
  'model.safetensors',
  'model.safetensors.index.json',
  'tokenizer_config.json',
  'vocab.json',
  'hotwords.txt',
];

const DEFAULT_SOURCE_DIR = fileURLToPath(new URL('../plugins/streaming-speech/ios-models', import.meta.url));
const DEFAULT_OUTPUT_PATH = fileURLToPath(
  new URL(`../plugins/streaming-speech/dist/${IOS_SPEECH_ASSET_PACK_ID}.aar`, import.meta.url),
);

/**
 * Builds an Apple-Hosted Background Assets manifest for on-demand delivery.
 * Deliberately omits `userInfo` per Apple's App Store Connect hosted pack schema.
 */
export function buildIosSpeechAssetPackManifest({
  assetPackID = IOS_SPEECH_ASSET_PACK_ID,
  directory = IOS_SPEECH_ASSET_PACK_DIR,
} = {}) {
  return {
    assetPackID,
    downloadPolicy: {
      onDemand: {},
    },
    fileSelectors: [
      {
        directory,
      },
    ],
    platforms: ['iOS'],
  };
}

/**
 * Returns `true` only on macOS hosts whose active Xcode toolchain includes `ba-package` (Xcode 26+).
 * Returns `false` immediately on non-darwin hosts without spawning `xcrun`.
 */
export function isBaPackageAvailable({
  platform = process.platform,
  execRunner = execFileSync,
} = {}) {
  if (platform !== 'darwin') {
    return false;
  }
  try {
    execRunner('xcrun', ['--find', 'ba-package'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function packageIosSpeechAssetPack({
  sourceDir = DEFAULT_SOURCE_DIR,
  outputPath = DEFAULT_OUTPUT_PATH,
  manifestPath,
  assetPackID = IOS_SPEECH_ASSET_PACK_ID,
  quiet = false,
  execRunner = execFileSync,
} = {}) {
  const resolvedSource = resolve(sourceDir);
  const resolvedOutput = resolve(outputPath);
  if (!resolvedOutput.endsWith('.aar')) {
    throw new Error(`Asset pack output path must end with .aar: ${resolvedOutput}`);
  }
  if (!existsSync(resolvedSource)) {
    throw new Error(`iOS speech model directory not found: ${resolvedSource}`);
  }
  for (const filename of IOS_SPEECH_ASSET_PACK_REQUIRED_FILES) {
    const filePath = join(resolvedSource, filename);
    if (!existsSync(filePath)) {
      throw new Error(`Missing required iOS speech asset file for packaging: ${filePath}`);
    }
  }

  mkdirSync(dirname(resolvedOutput), { recursive: true });
  const manifest = buildIosSpeechAssetPackManifest({
    assetPackID,
    directory: basename(resolvedSource),
  });

  let tempDir;
  let resolvedManifest;
  if (manifestPath) {
    resolvedManifest = resolve(manifestPath);
    mkdirSync(dirname(resolvedManifest), { recursive: true });
  } else {
    tempDir = mkdtempSync(join(tmpdir(), 'imcodes-ba-manifest-'));
    resolvedManifest = join(tempDir, 'manifest.json');
  }

  try {
    writeFileSync(resolvedManifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const args = ['ba-package', 'package', resolvedManifest, '--output-path', resolvedOutput];
    if (quiet) args.push('--quiet');
    execRunner('xcrun', args, {
      cwd: dirname(resolvedSource),
      stdio: quiet ? 'pipe' : 'inherit',
    });
    return {
      assetPackID,
      manifest,
      manifestPath: manifestPath ? resolvedManifest : null,
      outputPath: resolvedOutput,
      sourceDir: resolvedSource,
    };
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source' && argv[i + 1]) {
      opts.sourceDir = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      opts.outputPath = argv[++i];
    } else if (arg === '--manifest' && argv[i + 1]) {
      opts.manifestPath = argv[++i];
    } else if (arg === '--asset-pack-id' && argv[i + 1]) {
      opts.assetPackID = argv[++i];
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: node web/scripts/package-ios-speech-asset-pack.mjs [--source <dir>] [--output <path.aar>] [--manifest <manifest.json>] [--asset-pack-id <id>] [--quiet]`,
      );
      process.exit(0);
    }
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = packageIosSpeechAssetPack(parseCliArgs(process.argv.slice(2)));
  console.log(`Packaged Apple-Hosted asset pack ${result.assetPackID} -> ${result.outputPath}`);
}
