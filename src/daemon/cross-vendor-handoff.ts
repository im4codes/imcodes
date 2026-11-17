import { countTokensAsync, countTokensFallback } from '../context/tokenizer.js';
import { readSessionSummaries, readSessionTextMessages } from './session-history.js';
import type { SessionTextMessage } from '../../shared/session-history.js';
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
  let messages: SessionTextMessage[] = [];
  if (config.recentTurns > 0) {
    try {
      messages = await readSessionTextMessages(record.name, config.recentTurns, cutoff, true, {
        excludeDaemonNotices: true,
        maxChars: config.maxChars,
      });
    } catch {
      incrementCounter('handoff.timeline_read_failed', {});
      return undefined;
    }
    // Never echo bare session control commands (/clear, /handoff, /compact, /stop)
    // back into the new conversation as user turns.
    messages = messages.filter((message) => classifySessionControlCommand(message.text) === null);
  }
  let summaries: Awaited<ReturnType<typeof readSessionSummaries>> = [];
  if (config.summaryLimit > 0 && record.contextNamespace) {
    try {
      summaries = await readSessionSummaries(
        record.name,
        record.contextNamespace,
        config.summaryLimit,
        true,
        config.maxChars,
      );
    } catch {
      summaries = [];
    }
  }
  if (messages.length === 0 && summaries.length === 0) return undefined;
  const taskLines = readRecentTaskPairLines(record);
  // Identity/system instructions are reapplied by the normal launch bootstrap.
  // The handoff carries concise work state pointers, optional summaries, and
  // recent conversation text — never raw tool payloads.
  const render = (
    rows: typeof messages,
    summaryRows: typeof summaries,
    maxItemChars: number,
    includeTasks: boolean,
  ) => {
    const parts: string[] = [
      CROSS_VENDOR_HANDOFF_HEADINGS.title,
      CROSS_VENDOR_HANDOFF_HEADINGS.notice,
    ];
    if (includeTasks && taskLines.length > 0) {
      parts.push(`${CROSS_VENDOR_HANDOFF_HEADINGS.work}:\n${taskLines.join('\n')}`);
    }
    if (summaryRows.length > 0) {
      parts.push(
        `${CROSS_VENDOR_HANDOFF_HEADINGS.summaries}:\n${summaryRows
          .map((item) => `- ${item.summary.slice(0, maxItemChars)}${item.summary.length > maxItemChars ? '…' : ''}`)
          .join('\n')}`,
      );
    }
    parts.push(...rows.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.slice(0, maxItemChars)}${message.text.length > maxItemChars ? '…' : ''}`));
    return redactSensitiveText(parts.join('\n\n'));
  };

  let selectedMessages = messages;
  // readSessionSummaries returns newest-first; reverse so slice(dropCount) drops oldest first.
  let selectedSummaries = [...summaries].reverse();
  let includeTasks = taskLines.length > 0;
  let maxItemChars = Math.min(
    config.maxChars,
    Math.max(
      0,
      ...selectedMessages.map((message) => message.text.length),
      ...selectedSummaries.map((item) => item.summary.length),
    ),
  );

  const trimToBudget = (initialText: string, targetBudget: number, measure: (text: string) => number): string => {
    let text = initialText;
    let metric = measure(text);
    while (metric > targetBudget && selectedMessages.length > 1) {
      const dropCount = Math.min(
        selectedMessages.length - 1,
        Math.max(1, Math.ceil(selectedMessages.length * (1 - (targetBudget * 0.9) / metric))),
      );
      selectedMessages = selectedMessages.slice(dropCount);
      text = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
      metric = measure(text);
    }
    while (metric > targetBudget && selectedSummaries.length > 1) {
      const dropCount = Math.min(
        selectedSummaries.length - 1,
        Math.max(1, Math.ceil(selectedSummaries.length * (1 - (targetBudget * 0.9) / metric))),
      );
      selectedSummaries = selectedSummaries.slice(dropCount);
      text = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
      metric = measure(text);
    }
    if (metric > targetBudget && includeTasks) {
      includeTasks = false;
      text = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
      metric = measure(text);
    }
    for (let shrinkAttempt = 0; metric > targetBudget && maxItemChars > 0 && shrinkAttempt < 4; shrinkAttempt += 1) {
      const ratio = (targetBudget / metric) * 0.85;
      const next = Math.floor(maxItemChars * ratio);
      maxItemChars = next < maxItemChars ? next : Math.max(0, maxItemChars - 16);
      text = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
      metric = measure(text);
    }
    return text;
  };

  let bounded = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
  if (bounded.length > config.maxChars) {
    bounded = trimToBudget(bounded, config.maxChars, (text) => text.length);
    if (bounded.length > config.maxChars) {
      bounded = bounded.slice(0, config.maxChars);
    }
  }

  const hasExplicitMaxTokens = typeof inputConfig?.maxTokens === 'number' && Number.isFinite(inputConfig.maxTokens);
  const maxTokens = Math.min(config.maxTokens, CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens);
  if (hasExplicitMaxTokens) {
    const estTokens = countTokensFallback(bounded);
    if (estTokens > maxTokens) {
      bounded = trimToBudget(bounded, maxTokens, countTokensFallback);
      const afterEst = countTokensFallback(bounded);
      if (afterEst > maxTokens && bounded.length > 1) {
        const ratio = (maxTokens / afterEst) * 0.85;
        bounded = bounded.slice(0, Math.max(1, Math.floor(bounded.length * ratio)));
      }
    }
  }

  // Keep tokenizer worker IPC bounded to 1 call in normal cases (<= 2-3 when
  // explicit token budget hits dense-token divergence).
  let tokenCount = await countTokensAsync(bounded);
  for (let attempt = 0; hasExplicitMaxTokens && tokenCount > maxTokens && bounded.length > 1 && attempt < 3; attempt += 1) {
    if (selectedMessages.length > 1) {
      const dropCount = Math.min(
        selectedMessages.length - 1,
        Math.max(1, Math.ceil(selectedMessages.length * (1 - (maxTokens * 0.9) / tokenCount))),
      );
      selectedMessages = selectedMessages.slice(dropCount);
      bounded = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
    } else if (selectedSummaries.length > 1) {
      const dropCount = Math.min(
        selectedSummaries.length - 1,
        Math.max(1, Math.ceil(selectedSummaries.length * (1 - (maxTokens * 0.9) / tokenCount))),
      );
      selectedSummaries = selectedSummaries.slice(dropCount);
      bounded = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
    } else if (includeTasks) {
      includeTasks = false;
      bounded = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
    } else {
      const ratio = (maxTokens / tokenCount) * 0.85;
      const nextTextChars = Math.floor(maxItemChars * ratio);
      if (attempt === 0 && nextTextChars > 0 && nextTextChars < maxItemChars) {
        maxItemChars = nextTextChars;
        bounded = render(selectedMessages, selectedSummaries, maxItemChars, includeTasks);
      } else {
        maxItemChars = 0;
        bounded = bounded.slice(0, Math.max(1, Math.floor(bounded.length * ratio)));
      }
    }
    if (bounded.length > config.maxChars) {
      bounded = bounded.slice(0, config.maxChars);
    }
    tokenCount = await countTokensAsync(bounded);
  }
  return { text: bounded, sourceAgentType: record.agentType, sourceRuntimeType: record.runtimeType ?? 'process', sourceConversationKey: sourceConversationKey(record), cutoff, createdAt: Date.now(), tokenCount };
}
