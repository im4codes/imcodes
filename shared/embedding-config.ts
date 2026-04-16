/**
 * Shared embedding model configuration.
 * Single source of truth for model name, dimension, dtype, and cosine similarity.
 * Used by both daemon (src/context/embedding.ts) and server (server/src/util/embedding.ts).
 */

/** Hugging Face model ID for multilingual semantic search. */
export const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

/** Quantization type — q8 balances memory (~726MB) and quality (0.9945 vs fp32). */
export const EMBEDDING_DTYPE = 'q8';

/** Output embedding dimension. */
export const EMBEDDING_DIM = 384;

/**
 * Cosine similarity between two normalized vectors.
 * Since embeddings are L2-normalized, dot product equals cosine similarity.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Serialize a Float32Array embedding to a pgvector-compatible string: '[0.1,0.2,...]' */
export function embeddingToSql(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(',')}]`;
}

/** Deserialize a pgvector string or JSON array back to Float32Array. */
export function sqlToEmbedding(value: string | number[]): Float32Array {
  if (typeof value === 'string') {
    const trimmed = value.replace(/^\[|\]$/g, '');
    return new Float32Array(trimmed.split(',').map(Number));
  }
  return new Float32Array(value);
}
