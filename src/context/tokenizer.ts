import type Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let anthropicCountTokens: ((text: string) => number) | null | undefined;

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
  const cjk = text.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu)?.length ?? 0;
  const withoutCjk = text.replace(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu, ' ');
  const words = withoutCjk.split(/[\s\p{P}]+/u).filter(Boolean).length;
  const codePunct = text.match(/[{}()[\];=<>.+*/|&!-]/g)?.length ?? 0;
  return Math.max(1, Math.ceil(cjk + words * 1.25 + codePunct * 0.35));
}

export function countTokens(text: string): number {
  const tokenizer = resolveAnthropicTokenizer();
  if (tokenizer) {
    try {
      return tokenizer(text);
    } catch {
      return fallbackCountTokens(text);
    }
  }
  return fallbackCountTokens(text);
}

export function countMessagesTokens(msgs: Anthropic.MessageParam[]): number {
  let total = 0;
  for (const msg of msgs) {
    total += countTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    total += 4;
  }
  return total;
}
