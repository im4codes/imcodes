import { countTokens } from '../context/tokenizer.js';
import { timelineStore } from './timeline-store.js';
import type { TimelineEvent } from './timeline-event.js';
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import type { ContextNamespace, ProcessedContextProjection } from '../../shared/context-types.js';
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

function payloadText(event: TimelineEvent): string {
  const value = event.payload.text ?? event.payload.content ?? event.payload.message;
  return typeof value === 'string' ? redactSensitiveText(value.trim()) : '';
}

function safeToolLine(event: TimelineEvent, includePreview: boolean): string {
  const name = String(event.payload.tool ?? event.payload.name ?? 'tool');
  const status = String(event.payload.status ?? event.payload.terminalStatus ?? 'observed');
  if (!includePreview) return `- ${name} (${status})`;
  const raw = redactSensitiveText(String(event.payload.output ?? event.payload.error ?? '').replace(/\s+/g, ' ').trim());
  return `- ${name} (${status})${raw ? `: ${raw.slice(0, 240)}` : ''}`;
}

function renderTurns(events: TimelineEvent[], config: CrossVendorHandoffConfig): string {
  const conversation = events.filter((event) => event.type === 'user.message' || (event.type === 'assistant.text' && event.payload.streaming !== true));
  const tail = conversation.slice(-config.recentTurns);
  return tail.map((event) => `${event.type === 'user.message' ? 'User' : 'Assistant'}: ${payloadText(event).slice(0, 1200)}`).join('\n');
}

function renderTools(events: TimelineEvent[], config: CrossVendorHandoffConfig): string {
  return events.filter((event) => event.type === 'tool.call' || event.type === 'tool.result').slice(-20).map((event) => safeToolLine(event, config.includeToolPreviews)).join('\n');
}

async function readMemory(namespace?: ContextNamespace): Promise<string> {
  if (!namespace) return '';
  try {
    const [recent, durable] = await Promise.all([
      getContextStoreClient().run<ProcessedContextProjection[]>('listProcessedProjections', [namespace, 'recent_summary']),
      getContextStoreClient().run<ProcessedContextProjection[]>('listProcessedProjections', [namespace, 'durable_memory_candidate']),
    ]);
    return [...durable, ...recent]
      .filter((item) => item.status !== 'archived' && item.status !== 'archived_dedup')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .map((item) => `- ${redactSensitiveText(item.summary.replace(/\s+/g, ' ').trim())}`)
      .join('\n');
  } catch {
    incrementCounter('handoff.memory_read_failed', {});
    return '';
  }
}

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

export async function buildCrossVendorHandoffPack(record: SessionRecord, cutoff: CrossVendorHandoffCutoff, targetAgentType: string, targetRuntimeType: 'process' | 'transport', inputConfig?: Partial<CrossVendorHandoffConfig>, afterCutoff?: CrossVendorHandoffCutoff): Promise<CrossVendorHandoffPack | undefined> {
  const config = normalizeCrossVendorHandoffConfig(inputConfig);
  if (!config.enabled) return undefined;
  let events: TimelineEvent[];
  try {
    events = await timelineStore.readPreferred(record.name, { afterTs: afterCutoff?.ts, beforeTs: cutoff.ts, limit: Math.max(100, config.recentTurns * 8) });
  } catch {
    // A busy/open-circuit projection must never block session.send; degrade to
    // no handoff and let the target provider proceed with its normal bootstrap.
    incrementCounter('handoff.timeline_read_failed', {});
    return undefined;
  }
  const memory = await readMemory(record.contextNamespace);
  const latestUser = events.filter((event) => event.type === 'user.message').map(payloadText).filter(Boolean).slice(-1)[0] ?? 'Not available';
  const tools = renderTools(events, config);
  const text = redactSensitiveText([
    CROSS_VENDOR_HANDOFF_HEADINGS.title,
    CROSS_VENDOR_HANDOFF_HEADINGS.notice,
    `${CROSS_VENDOR_HANDOFF_HEADINGS.goal}:\n- Current request: ${latestUser.slice(0, 1200)}\n- Open TODOs: verify the current task list in the worktree.`,
    memory ? `${CROSS_VENDOR_HANDOFF_HEADINGS.facts}:\n${memory}` : `${CROSS_VENDOR_HANDOFF_HEADINGS.facts}:\n- No processed summary was available.`,
    `${CROSS_VENDOR_HANDOFF_HEADINGS.turns}:\n${renderTurns(events, config) || '- No completed turns were available.'}`,
    tools ? `${CROSS_VENDOR_HANDOFF_HEADINGS.tools}:\n${tools}` : '',
    `${CROSS_VENDOR_HANDOFF_HEADINGS.work}:\n- cwd: ${record.projectDir}\n- project: ${record.projectName}\n- Verify branch, worktree, last commit and tests before acting.`,
    `${CROSS_VENDOR_HANDOFF_HEADINGS.metadata}:\n- source: ${record.agentType}/${record.runtimeType ?? 'process'}\n- target: ${targetAgentType}/${targetRuntimeType}\n- cutoff: epoch=${cutoff.epoch}, seq=${cutoff.seq}, ts=${cutoff.ts}`,
  ].filter(Boolean).join('\n\n'));
  const hardCap = CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens;
  const maxTokens = Math.min(config.maxTokens, hardCap);
  let bounded = text;
  while (countTokens(bounded) > maxTokens && bounded.length > 32) {
    bounded = bounded.slice(0, Math.max(32, Math.floor(bounded.length * 0.85)));
  }
  if (countTokens(bounded) > maxTokens) {
    let low = 0;
    let high = bounded.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (countTokens(bounded.slice(0, mid)) > maxTokens) high = mid - 1;
      else low = mid;
    }
    bounded = bounded.slice(0, low);
  }
  return { text: bounded, sourceAgentType: record.agentType, sourceRuntimeType: record.runtimeType ?? 'process', sourceConversationKey: sourceConversationKey(record), cutoff, createdAt: Date.now(), tokenCount: countTokens(bounded) };
}
