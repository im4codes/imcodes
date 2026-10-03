import type Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
let anthropicCountTokens: ((text: string) => number) | null | undefined;
const TOKEN_CACHE_MAX_ENTRIES = 2_048;
const TOKEN_CACHE_MAX_TEXT_LENGTH = 64 * 1024;
const tokenCache = new Map<string, number>();
type PendingTokenRequest = { id: number; text: string; resolve: (count: number) => void; reject: (error: unknown) => void };
type PendingTokenBatch = { id: number; texts: string[]; resolve: (counts: number[]) => void; reject: (error: unknown) => void };
let tokenizerWorker: Worker | null = null;
let nextTokenRequestId = 1;
const pendingTokenRequests = new Map<number, PendingTokenRequest>();
const pendingTokenBatches = new Map<number, PendingTokenBatch>();

function resolveAnthropicTokenizer(): ((text: string) => number) | null {
  if (anthropicCountTokens !== undefined) return anthropicCountTokens;
  try {
    const mod = require('@anthropic-ai/tokenizer') as { countTokens?: (text: string) => number; default?: { countTokens?: (text: string) => number } };
    anthropicCountTokens = mod.countTokens ?? mod.default?.countTokens ?? null;
  } catch {
    anthropicCountTokens = null;
  }
  return anthropicCountTokens;
}

function fallbackCountTokens(text: string): number {
  if (!text) return 0;
  // Most queue/replay metadata is short ASCII. Avoid allocating regex match,
  // replace, and split arrays for those hot entries; the bounded estimate is
  // sufficient for budget guards and keeps a large backlog linear and cheap.
  if (text.length <= 256 && /^[\x20-\x7E]*$/u.test(text)) {
    return Math.max(1, Math.ceil(text.length / 4));
  }
  const cjk = text.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu)?.length ?? 0;
  const withoutCjk = text.replace(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu, ' ');
  const words = withoutCjk.split(/[\s\p{P}]+/u).filter(Boolean).length;
  const codePunct = text.match(/[{}()[\];=<>.+*/|&!-]/g)?.length ?? 0;
  return Math.max(1, Math.ceil(cjk + words * 1.25 + codePunct * 0.35));
}

/**
 * Cheap deterministic estimate for store metadata and non-budget diagnostics.
 * Compression/materialization callers must use countTokensAsync so provider
 * semantics stay exact; this export exists for synchronous SQLite metadata
 * writes that cannot await a worker while holding a transaction.
 */
export function countTokensFallback(text: string): number {
  return fallbackCountTokens(text);
}

export function countTokens(text: string): number {
  // The optional Anthropic tokenizer is synchronous and can spend seconds on
  // a single multi-megabyte backlog. Keep large projections on the bounded,
  // deterministic fallback path; normal-sized prompts retain exact provider
  // tokenization and are cached below.
  if (text.length > TOKEN_CACHE_MAX_TEXT_LENGTH) return fallbackCountTokens(text);
  if (text.length <= TOKEN_CACHE_MAX_TEXT_LENGTH) {
    const cached = tokenCache.get(text);
    if (cached !== undefined) {
      // Refresh recency so repeated context projections keep their hot entries.
      tokenCache.delete(text);
      tokenCache.set(text, cached);
      return cached;
    }
  }
  const tokenizer = resolveAnthropicTokenizer();
  let count: number;
  if (tokenizer) {
    try {
      count = tokenizer(text);
    } catch {
      count = fallbackCountTokens(text);
    }
  } else {
    count = fallbackCountTokens(text);
  }
  if (text.length <= TOKEN_CACHE_MAX_TEXT_LENGTH) {
    tokenCache.set(text, count);
    while (tokenCache.size > TOKEN_CACHE_MAX_ENTRIES) {
      const oldest = tokenCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      tokenCache.delete(oldest);
    }
  }
  return count;
}

function getTokenizerWorker(): Worker {
  if (tokenizerWorker) return tokenizerWorker;
  // Keep the provider's exact semantics off the daemon event loop. The worker
  // is intentionally created from an eval script so source execution via tsx
  // and bundled execution use the same path.
  tokenizerWorker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    let provider = null;
    try {
      const mod = require('@anthropic-ai/tokenizer');
      provider = mod.countTokens || mod.default?.countTokens || null;
    } catch {}
    function fallback(text) {
      if (!text) return 0;
      if (text.length <= 256 && /^[\\x20-\\x7E]*$/.test(text)) return Math.max(1, Math.ceil(text.length / 4));
      const cjk = text.match(/[\\u3400-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF]/g)?.length || 0;
      const withoutCjk = text.replace(/[\\u3400-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF]/g, ' ');
      const words = withoutCjk.split(/[\\s\\p{P}]+/u).filter(Boolean).length;
      const codePunct = text.match(/[{}()[\\];=<>.+*/|&!-]/g)?.length || 0;
      return Math.max(1, Math.ceil(cjk + words * 1.25 + codePunct * 0.35));
    }
    parentPort.on('message', ({ id, text, texts }) => {
      const countOne = (value) => {
        try { return provider ? provider(value) : fallback(value); } catch { return fallback(value); }
      };
      if (Array.isArray(texts)) {
        parentPort.postMessage({ id, counts: texts.map(countOne) });
      } else {
        parentPort.postMessage({ id, count: countOne(text) });
      }
    });
  `, { eval: true });
  tokenizerWorker.unref();
  tokenizerWorker.on('message', ({ id, count, counts }: { id: number; count?: number; counts?: number[] }) => {
    if (Array.isArray(counts)) {
      const batch = pendingTokenBatches.get(id);
      if (!batch) return;
      pendingTokenBatches.delete(id);
      batch.resolve(counts);
      return;
    }
    const pending = pendingTokenRequests.get(id);
    if (!pending) return;
    pendingTokenRequests.delete(id);
    pending.resolve(typeof count === 'number' ? count : fallbackCountTokens(pending.text));
  });
  tokenizerWorker.on('error', (error) => {
    const pending = [...pendingTokenRequests.values()];
    pendingTokenRequests.clear();
    const batches = [...pendingTokenBatches.values()];
    pendingTokenBatches.clear();
    tokenizerWorker = null;
    for (const request of pending) request.reject(error);
    for (const batch of batches) batch.reject(error);
  });
  return tokenizerWorker;
}

/** Exact provider semantics without blocking the daemon's event loop. */
export function countTokensAsync(text: string): Promise<number> {
  const cached = tokenCache.get(text);
  if (cached !== undefined) return Promise.resolve(cached);
  const id = nextTokenRequestId++;
  return new Promise((resolve, reject) => {
    pendingTokenRequests.set(id, {
      id,
      text,
      resolve: (count) => {
        if (text.length <= TOKEN_CACHE_MAX_TEXT_LENGTH) {
          tokenCache.set(text, count);
          while (tokenCache.size > TOKEN_CACHE_MAX_ENTRIES) {
            const oldest = tokenCache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            tokenCache.delete(oldest);
          }
        }
        resolve(count);
      },
      reject,
    });
    getTokenizerWorker().postMessage({ id, text });
  });
}

/** Count a bounded batch in one worker message, preserving exact per-item counts. */
export function countTokensBatchAsync(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return Promise.resolve([]);
  const counts = new Array<number>(texts.length);
  const missingTexts: string[] = [];
  const missingIndexes: number[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const cached = tokenCache.get(texts[index]);
    if (cached === undefined) {
      missingTexts.push(texts[index]);
      missingIndexes.push(index);
    } else {
      counts[index] = cached;
    }
  }
  if (missingTexts.length === 0) return Promise.resolve(counts);
  const id = nextTokenRequestId++;
  return new Promise((resolve, reject) => {
    pendingTokenBatches.set(id, { id, texts: missingTexts, resolve: (missingCounts) => {
      for (let index = 0; index < missingTexts.length; index += 1) {
        const text = missingTexts[index];
        const count = missingCounts[index] ?? fallbackCountTokens(text);
        counts[missingIndexes[index]] = count;
        if (text.length <= TOKEN_CACHE_MAX_TEXT_LENGTH) {
          tokenCache.set(text, count);
          while (tokenCache.size > TOKEN_CACHE_MAX_ENTRIES) {
            const oldest = tokenCache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            tokenCache.delete(oldest);
          }
        }
      }
      resolve(counts);
    }, reject });
    getTokenizerWorker().postMessage({ id, texts });
  });
}

export async function countMessagesTokensAsync(msgs: Anthropic.MessageParam[]): Promise<number> {
  let total = 0;
  for (const msg of msgs) {
    total += await countTokensAsync(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    total += 4;
  }
  return total;
}

/** Test-only reset for deterministic cache pressure tests. */
export function resetTokenizerCacheForTests(): void {
  tokenCache.clear();
}

export function countMessagesTokens(msgs: Anthropic.MessageParam[]): number {
  let total = 0;
  for (const msg of msgs) {
    total += countTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    total += 4;
  }
  return total;
}
