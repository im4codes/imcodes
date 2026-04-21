import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
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

async function main() {
  const { model, dtype } = await resolveEmbeddingConfig();
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = readEnv('IMCODES_EMBEDDING_CACHE_DIR') || '/app/embedding-cache';
  console.log(`[embedding] preloading ${model} (${dtype}) into ${env.cacheDir}`);
  await pipeline('feature-extraction', model, { dtype });
  console.log('[embedding] preload complete');
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error('[embedding] preload failed', err);
    process.exit(1);
  });
}
