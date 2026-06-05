import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readPositiveIntEnv(name, fallback) {
  const value = readEnv(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(name, fallback = false) {
  const value = readEnv(name);
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolvePreloadRetryConfig() {
  return {
    attempts: readPositiveIntEnv('IMCODES_EMBEDDING_PRELOAD_ATTEMPTS', 3),
    retryDelayMs: readPositiveIntEnv('IMCODES_EMBEDDING_PRELOAD_RETRY_DELAY_MS', 2_000),
    softFail: readBooleanEnv('IMCODES_EMBEDDING_PRELOAD_SOFT_FAIL', false),
  };
}

export async function resolveEmbeddingConfig() {
  const modelFromEnv = readEnv('EMBEDDING_MODEL');
  const dtypeFromEnv = readEnv('EMBEDDING_DTYPE');
  if (modelFromEnv && dtypeFromEnv) {
    return { model: modelFromEnv, dtype: dtypeFromEnv };
  }

  const candidateUrls = [
    new URL('../../shared/embedding-config.ts', import.meta.url), // repo layout
    new URL('../shared/embedding-config.ts', import.meta.url),    // docker preload stage
  ];
  let source = null;
  for (const url of candidateUrls) {
    try {
      source = await readFile(url, 'utf8');
      break;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
  if (!source) {
    throw new Error('Failed to locate shared/embedding-config.ts for embedding preload');
  }
  const modelMatch = source.match(/export const EMBEDDING_MODEL = '([^']+)'/);
  const dtypeMatch = source.match(/export const EMBEDDING_DTYPE = '([^']+)'/);
  if (!modelMatch?.[1] || !dtypeMatch?.[1]) {
    throw new Error('Failed to parse EMBEDDING_MODEL / EMBEDDING_DTYPE from shared/embedding-config.ts');
  }
  return {
    model: modelMatch[1],
    dtype: dtypeMatch[1],
  };
}

export async function preloadEmbeddingModel(opts = {}) {
  const { model, dtype } = await resolveEmbeddingConfig();
  const {
    attempts,
    retryDelayMs,
    softFail,
  } = opts.retryConfig ?? resolvePreloadRetryConfig();
  const logger = opts.logger ?? console;
  const pause = opts.sleep ?? sleep;
  const importTransformers = opts.importTransformers ?? (() => import('@huggingface/transformers'));
  const { pipeline, env } = await importTransformers();
  env.cacheDir = readEnv('IMCODES_EMBEDDING_CACHE_DIR') || '/app/embedding-cache';

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const suffix = attempts > 1 ? ` (attempt ${attempt}/${attempts})` : '';
      logger.log(`[embedding] preloading ${model} (${dtype}) into ${env.cacheDir}${suffix}`);
      await pipeline('feature-extraction', model, { dtype });
      logger.log('[embedding] preload complete');
      return true;
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) break;
      logger.warn(`[embedding] preload attempt ${attempt}/${attempts} failed; retrying in ${retryDelayMs}ms`, err);
      if (retryDelayMs > 0) await pause(retryDelayMs);
    }
  }

  if (softFail) {
    logger.warn(`[embedding] preload failed after ${attempts} attempt(s); continuing without a warm embedding cache`, lastError);
    return false;
  }
  throw lastError ?? new Error('embedding preload failed');
}

async function main() {
  await preloadEmbeddingModel();
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error('[embedding] preload failed', err);
    process.exit(1);
  });
}
