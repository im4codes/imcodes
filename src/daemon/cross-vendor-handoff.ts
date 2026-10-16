import { countTokensAsync } from '../context/tokenizer.js';
import { readSessionTextMessages } from './session-history.js';
import {
  CROSS_VENDOR_HANDOFF_DEFAULTS,
  CROSS_VENDOR_HANDOFF_HEADINGS,
  normalizeCrossVendorHandoffConfig,
  type CrossVendorHandoffConfig,
  type CrossVendorHandoffCutoff,
  type CrossVendorHandoffPack,
} from '../../shared/cross-vendor-handoff.js';
import type { SessionRecord } from '../store/session-store.js';
import { incrementCounter } from '../util/metrics.js';
import { redactSensitiveText } from '../../shared/redact-secrets.js';

export function shouldCreateCrossVendorHandoff(record: Pick<SessionRecord, 'agentType' | 'runtimeType'>, targetAgentType: string, targetRuntimeType: 'process' | 'transport', fresh: boolean): boolean {
  return !fresh && (record.agentType !== targetAgentType || (record.runtimeType ?? 'process') !== targetRuntimeType);
}

export function sourceConversationKey(record: Pick<SessionRecord, 'agentType' | 'ccSessionId' | 'codexSessionId' | 'providerResumeId' | 'providerSessionId'>): string | undefined {
  if (record.agentType === 'claude-code-sdk') return record.ccSessionId;
  if (record.agentType === 'codex-sdk') return record.codexSessionId;
  return record.providerResumeId ?? record.providerSessionId ?? record.ccSessionId ?? record.codexSessionId;
}

export function resolveCrossVendorHandoffPack(
  build: Promise<CrossVendorHandoffPack | undefined>,
  timeoutMs: number,
): Promise<CrossVendorHandoffPack | undefined> {
  return Promise.race([
    build,
    new Promise<undefined>((resolve) => setTimeout(() => {
      incrementCounter('handoff.build_timeout', {});
      resolve(undefined);
    }, Math.max(1, timeoutMs))),
  ]).catch((err) => {
    incrementCounter('handoff.build_failed', {});
    return undefined;
  });
}

export async function buildCrossVendorHandoffPack(record: SessionRecord, cutoff: CrossVendorHandoffCutoff, targetAgentType: string, targetRuntimeType: 'process' | 'transport', inputConfig?: Partial<CrossVendorHandoffConfig>, _afterCutoff?: CrossVendorHandoffCutoff): Promise<CrossVendorHandoffPack | undefined> {
  const config = normalizeCrossVendorHandoffConfig(inputConfig);
  if (!config.enabled) return undefined;
  let messages;
  try {
    messages = await readSessionTextMessages(record.name, config.recentTurns, cutoff);
  } catch {
    incrementCounter('handoff.timeline_read_failed', {});
    return undefined;
  }
  // Identity/system instructions are reapplied by the normal launch bootstrap.
  // The handoff is conversation text only, never tools or processed memory.
  const text = redactSensitiveText([
    CROSS_VENDOR_HANDOFF_HEADINGS.title,
    CROSS_VENDOR_HANDOFF_HEADINGS.notice,
    ...messages.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.slice(0, 1200)}`),
  ].join('\n\n'));
  const hardCap = CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens;
  const maxTokens = Math.min(config.maxTokens, hardCap);
  // Count the complete pack once, then choose a conservative proportional
  // prefix. The old implementation performed an async worker round-trip for
  // every 15% shrink and again for a binary search; a cold worker therefore
  // routinely exceeded providerWaitMs before the first turn could dispatch.
  const sourceTokens = await countTokensAsync(text);
  let bounded = text;
  if (sourceTokens > maxTokens && text.length > 32) {
    bounded = text.slice(0, Math.max(32, Math.floor(text.length * (maxTokens / sourceTokens) * 0.85)));
  }
  let tokenCount = await countTokensAsync(bounded);
  // Provider token boundaries can make the proportional prefix slightly high.
  // Correct with at most two further proportional probes; this is bounded and
  // avoids the previous unbounded O(log n) worker loop while retaining exact
  // provider semantics for the final pack.
  for (let attempt = 0; tokenCount > maxTokens && bounded.length > 32 && attempt < 2; attempt += 1) {
    const nextLength = Math.max(32, Math.floor(bounded.length * (maxTokens / tokenCount) * 0.85));
    if (nextLength >= bounded.length) break;
    bounded = bounded.slice(0, nextLength);
    tokenCount = await countTokensAsync(bounded);
  }
  return { text: bounded, sourceAgentType: record.agentType, sourceRuntimeType: record.runtimeType ?? 'process', sourceConversationKey: sourceConversationKey(record), cutoff, createdAt: Date.now(), tokenCount };
}
