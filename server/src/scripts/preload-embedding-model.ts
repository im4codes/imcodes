import { EMBEDDING_DTYPE, EMBEDDING_MODEL } from '../../../shared/embedding-config.js';

async function main(): Promise<void> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = process.env.IMCODES_EMBEDDING_CACHE_DIR?.trim() || '/app/embedding-cache';
  console.log(`[embedding] preloading ${EMBEDDING_MODEL} (${EMBEDDING_DTYPE}) into ${env.cacheDir}`);
  await pipeline('feature-extraction', EMBEDDING_MODEL, {
    dtype: EMBEDDING_DTYPE,
  });
  console.log('[embedding] preload complete');
}

main().catch((err) => {
  console.error('[embedding] preload failed', err);
  process.exit(1);
});
