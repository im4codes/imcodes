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
  const render = (maxTextChars: number) => redactSensitiveText([
    CROSS_VENDOR_HANDOFF_HEADINGS.title,
    CROSS_VENDOR_HANDOFF_HEADINGS.notice,
    ...messages.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.slice(0, maxTextChars)}${message.text.length > maxTextChars ? '…' : ''}`),
  ].join('\n\n'));
  const hardCap = CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens;
  const maxTokens = Math.min(config.maxTokens, hardCap);
  // Shorten each message fairly rather than dropping the newest messages
  // from the end of the pack. Keep tokenizer worker round-trips bounded.
  let maxTextChars = Math.min(CROSS_VENDOR_HANDOFF_DEFAULTS.maxTextChars, Math.max(0, ...messages.map((message) => message.text.length)));
  let bounded = render(maxTextChars);
  let tokenCount = await countTokensAsync(bounded);
  for (let attempt = 0; tokenCount > maxTokens && bounded.length > 1 && attempt < 4; attempt += 1) {
    const ratio = (maxTokens / tokenCount) * 0.85;
    const nextTextChars = Math.floor(maxTextChars * ratio);
    if (attempt < 3 && nextTextChars > 0 && nextTextChars < maxTextChars) {
      maxTextChars = nextTextChars;
      bounded = render(maxTextChars);
    } else {
      // An explicitly tiny custom budget may not even fit the headings/roles.
      maxTextChars = 0;
      bounded = bounded.slice(0, Math.max(1, Math.floor(bounded.length * ratio)));
    }
    tokenCount = await countTokensAsync(bounded);
  }
  return { text: bounded, sourceAgentType: record.agentType, sourceRuntimeType: record.runtimeType ?? 'process', sourceConversationKey: sourceConversationKey(record), cutoff, createdAt: Date.now(), tokenCount };
}
