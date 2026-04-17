import { readFile } from 'node:fs/promises';

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

async function resolveEmbeddingConfig() {
  const modelFromEnv = readEnv('EMBEDDING_MODEL');
  const dtypeFromEnv = readEnv('EMBEDDING_DTYPE');
  if (modelFromEnv && dtypeFromEnv) {
    return { model: modelFromEnv, dtype: dtypeFromEnv };
  }

  const source = await readFile(new URL('../../shared/embedding-config.ts', import.meta.url), 'utf8');
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

main().catch((err) => {
  console.error('[embedding] preload failed', err);
  process.exit(1);
});
