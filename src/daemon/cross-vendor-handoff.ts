import { countTokensAsync, countTokensFallback } from '../context/tokenizer.js';
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
import { isClaudeCodeSdkAgentType } from '../../shared/agent-types.js';
import { classifySessionControlCommand } from '../../shared/session-control-commands.js';
import { getTaskPairStore } from './task-pairs/store.js';
import { TASK_PAIR_TERMINAL_STATUSES } from '../../shared/task-pair.js';

const MAX_HANDOFF_TASK_PAIRS = 12;
const MAX_TASK_TITLE_CHARS = 80;

function readRecentTaskPairLines(record: SessionRecord): string[] {
  try {
    const store = getTaskPairStore();
    const byId = new Map<string, ReturnType<typeof store.pairsForSession>[number]>();
    for (const pair of store.pairsForSession(record.name)) {
      byId.set(pair.state.taskId, pair);
    }
    if (record.projectName) {
      for (const pair of store.listActivePairs(record.projectName)) {
        byId.set(pair.state.taskId, pair);
      }
      if (byId.size < MAX_HANDOFF_TASK_PAIRS) {
        for (const pair of store.listPairs(record.projectName)) {
          if (!byId.has(pair.state.taskId)) {
            byId.set(pair.state.taskId, pair);
          }
          if (byId.size >= MAX_HANDOFF_TASK_PAIRS * 2) break;
        }
      }
    }
    if (byId.size === 0) return [];
    const ordered = [...byId.values()]
      .sort((a, b) => {
        const aTerminal = TASK_PAIR_TERMINAL_STATUSES.includes(a.state.status) ? 1 : 0;
        const bTerminal = TASK_PAIR_TERMINAL_STATUSES.includes(b.state.status) ? 1 : 0;
        if (aTerminal !== bTerminal) return aTerminal - bTerminal;
        return (b.state.updatedAt ?? 0) - (a.state.updatedAt ?? 0);
      })
      .slice(0, MAX_HANDOFF_TASK_PAIRS);
    return ordered.map((pair) => {
      const { taskId, status, round, executor, auditor, title } = pair.state;
      const cleanTitle = redactSensitiveText(String(title ?? '').replace(/\s+/g, ' ').trim()).slice(0, MAX_TASK_TITLE_CHARS);
      return `- ${taskId} [${status}] ${cleanTitle || '(untitled)'} (exec=${executor ?? '-'}, aud=${auditor ?? '-'}, round=${round})`;
    });
  } catch {
    return [];
  }
}

export function shouldCreateCrossVendorHandoff(
  record: Pick<SessionRecord, 'agentType' | 'runtimeType'>,
  targetAgentType: string,
  targetRuntimeType: 'process' | 'transport',
  fresh: boolean,
  force = false,
): boolean {
  if (force) return true;
  return !fresh && (record.agentType !== targetAgentType || (record.runtimeType ?? 'process') !== targetRuntimeType);
}

export function sourceConversationKey(record: Pick<SessionRecord, 'agentType' | 'ccSessionId' | 'codexSessionId' | 'providerResumeId' | 'providerSessionId'>): string | undefined {
  if (isClaudeCodeSdkAgentType(record.agentType)) return record.ccSessionId;
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
    messages = await readSessionTextMessages(record.name, config.recentTurns, cutoff, true, { excludeDaemonNotices: true });
  } catch {
    incrementCounter('handoff.timeline_read_failed', {});
    return undefined;
  }
  // Never echo bare session control commands (/clear, /handoff, /compact, /stop)
  // back into the new conversation as user turns.
  messages = messages.filter((message) => classifySessionControlCommand(message.text) === null);
  if (messages.length === 0) return undefined;
  const taskLines = readRecentTaskPairLines(record);
  // Identity/system instructions are reapplied by the normal launch bootstrap.
  // The handoff carries concise work state pointers + recent conversation text,
  // never tools or processed memory.
  const render = (rows: typeof messages, maxTextChars: number, includeTasks: boolean) => {
    const parts: string[] = [
      CROSS_VENDOR_HANDOFF_HEADINGS.title,
      CROSS_VENDOR_HANDOFF_HEADINGS.notice,
    ];
    if (includeTasks && taskLines.length > 0) {
      parts.push(`${CROSS_VENDOR_HANDOFF_HEADINGS.work}:\n${taskLines.join('\n')}`);
    }
    parts.push(...rows.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.slice(0, maxTextChars)}${message.text.length > maxTextChars ? '…' : ''}`));
    return redactSensitiveText(parts.join('\n\n'));
  };
  const hardCap = CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens;
  const maxTokens = Math.min(config.maxTokens, hardCap);
  let selectedMessages = messages;
  let includeTasks = taskLines.length > 0;
  let maxTextChars = Math.min(CROSS_VENDOR_HANDOFF_DEFAULTS.maxTextChars, Math.max(0, ...selectedMessages.map((message) => message.text.length)));

  const trimSyncToTarget = (renderFn: () => string, currentTokens: number, targetBudget: number): { text: string; tokens: number } => {
    let text = renderFn();
    let est = currentTokens;
    while (est > targetBudget && selectedMessages.length > 1) {
      const dropCount = Math.min(
        selectedMessages.length - 1,
        Math.max(1, Math.ceil(selectedMessages.length * (1 - (targetBudget * 0.9) / est))),
      );
      selectedMessages = selectedMessages.slice(dropCount);
      text = render(selectedMessages, maxTextChars, includeTasks);
      est = countTokensFallback(text);
    }
    if (est > targetBudget && includeTasks) {
      includeTasks = false;
      text = render(selectedMessages, maxTextChars, includeTasks);
      est = countTokensFallback(text);
    }
    if (est > targetBudget && maxTextChars > 0) {
      const ratio = (targetBudget / est) * 0.85;
      maxTextChars = Math.max(0, Math.floor(maxTextChars * ratio));
      text = render(selectedMessages, maxTextChars, includeTasks);
      est = countTokensFallback(text);
    }
    return { text, tokens: est };
  };

  let bounded = render(selectedMessages, maxTextChars, includeTasks);
  let estTokens = countTokensFallback(bounded);
  if (estTokens > maxTokens) {
    ({ text: bounded, tokens: estTokens } = trimSyncToTarget(() => bounded, estTokens, maxTokens));
    if (estTokens > maxTokens && bounded.length > 1) {
      const ratio = (maxTokens / estTokens) * 0.85;
      bounded = bounded.slice(0, Math.max(1, Math.floor(bounded.length * ratio)));
    }
  }

  // Keep tokenizer worker IPC bounded to 1 call in normal cases (<= 3 on rare
  // dense-token divergence) so large histories never stall or hit timeoutMs.
  let tokenCount = await countTokensAsync(bounded);
  for (let attempt = 0; tokenCount > maxTokens && bounded.length > 1 && attempt < 3; attempt += 1) {
    if (selectedMessages.length > 1) {
      const dropCount = Math.min(
        selectedMessages.length - 1,
        Math.max(1, Math.ceil(selectedMessages.length * (1 - (maxTokens * 0.9) / tokenCount))),
      );
      selectedMessages = selectedMessages.slice(dropCount);
      bounded = render(selectedMessages, maxTextChars, includeTasks);
    } else if (includeTasks) {
      includeTasks = false;
      bounded = render(selectedMessages, maxTextChars, includeTasks);
    } else {
      const ratio = (maxTokens / tokenCount) * 0.85;
      const nextTextChars = Math.floor(maxTextChars * ratio);
      if (attempt === 0 && nextTextChars > 0 && nextTextChars < maxTextChars) {
        maxTextChars = nextTextChars;
        bounded = render(selectedMessages, maxTextChars, includeTasks);
      } else {
        maxTextChars = 0;
        bounded = bounded.slice(0, Math.max(1, Math.floor(bounded.length * ratio)));
      }
    }
    tokenCount = await countTokensAsync(bounded);
  }
  return { text: bounded, sourceAgentType: record.agentType, sourceRuntimeType: record.runtimeType ?? 'process', sourceConversationKey: sourceConversationKey(record), cutoff, createdAt: Date.now(), tokenCount };
}
