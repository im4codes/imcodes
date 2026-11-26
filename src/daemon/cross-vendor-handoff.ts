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

function countTokensConservativeFallback(text: string): number {
  if (!text) return 0;
  // Byte-level BPE tokenizers encode NFKC UTF-8 bytes, so byte length is a safe
  // upper bound even on long unspaced ASCII strings that countTokensFallback
  // would treat as a single word.
  return Math.max(countTokensFallback(text), Buffer.byteLength(text.normalize('NFKC'), 'utf8'));
}

export function resolveCrossVendorHandoffPack(
  build: Promise<CrossVendorHandoffPack | undefined>,
  timeoutMs: number,
): Promise<CrossVendorHandoffPack | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const guardedBuild = build.then((pack) => {
    settled = true;
    return pack;
  });
  // Ensure late rejections from a timed-out build cannot surface unhandled.
  void guardedBuild.catch(() => {});
  return Promise.race([
    guardedBuild,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        if (!settled) incrementCounter('handoff.build_timeout', {});
        resolve(undefined);
      }, Math.max(1, timeoutMs));
    }),
  ]).catch(() => {
    settled = true;
    incrementCounter('handoff.build_failed', {});
    return undefined;
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function buildCrossVendorHandoffPack(record: SessionRecord, cutoff: CrossVendorHandoffCutoff, targetAgentType: string, targetRuntimeType: 'process' | 'transport', inputConfig?: Partial<CrossVendorHandoffConfig>, _afterCutoff?: CrossVendorHandoffCutoff): Promise<CrossVendorHandoffPack | undefined> {
  const config = normalizeCrossVendorHandoffConfig(inputConfig);
  if (!config.enabled) return undefined;
  const buildStartedAt = Date.now();
  const tokenizerReserveMs = Math.min(250, Math.max(20, Math.floor(config.timeoutMs * 0.15)));
  const tokenizerDeadlineAt = buildStartedAt + Math.max(1, config.timeoutMs - tokenizerReserveMs);
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

  const trimSyncToTarget = (
    initialText: string,
    initialTokens: number,
    targetBudget: number,
    countFn: (value: string) => number,
  ): { text: string; tokens: number } => {
    let text = initialText;
    let est = initialTokens;
    while (est > targetBudget && selectedMessages.length > 1) {
      const dropCount = Math.min(
        selectedMessages.length - 1,
        Math.max(1, Math.ceil(selectedMessages.length * (1 - (targetBudget * 0.9) / est))),
      );
      selectedMessages = selectedMessages.slice(dropCount);
      text = render(selectedMessages, maxTextChars, includeTasks);
      est = countFn(text);
    }
    if (est > targetBudget && includeTasks) {
      includeTasks = false;
      text = render(selectedMessages, maxTextChars, includeTasks);
      est = countFn(text);
    }
    if (est > targetBudget && maxTextChars > 0) {
      const ratio = (targetBudget / est) * 0.85;
      maxTextChars = Math.max(0, Math.floor(maxTextChars * ratio));
      text = render(selectedMessages, maxTextChars, includeTasks);
      est = countFn(text);
    }
    if (est > targetBudget && text.length > 1) {
      const ratio = (targetBudget / est) * 0.85;
      text = text.slice(0, Math.max(1, Math.floor(text.length * ratio)));
      est = countFn(text);
      if (est > targetBudget && text.length > 1) {
        let lo = 1;
        let hi = text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          const candidate = text.slice(0, mid);
          if (countFn(candidate) <= targetBudget) lo = mid;
          else hi = mid - 1;
        }
        // Avoid slicing cleanly between a UTF-16 surrogate pair when shrinking.
        if (lo > 1 && lo < text.length) {
          const code = text.charCodeAt(lo - 1);
          if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
        }
        text = text.slice(0, Math.max(1, lo));
        est = countFn(text);
      }
    }
    return { text, tokens: est };
  };

  const measureTokensWithinBudget = async (text: string): Promise<{ count: number; exact: boolean }> => {
    const remainingMs = tokenizerDeadlineAt - Date.now();
    if (remainingMs <= 0) {
      incrementCounter('handoff.tokenizer_fallback', {});
      return { count: countTokensConservativeFallback(text), exact: false };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const tokenPromise = Promise.resolve().then(() => countTokensAsync(text));
    // Prevent a stalled worker that rejects late from raising an unhandled rejection.
    void tokenPromise.catch(() => {});
    try {
      const exactCount = await Promise.race<number | null>([
        tokenPromise.then((count) => {
          settled = true;
          return count;
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            if (!settled) resolve(null);
          }, remainingMs);
        }),
      ]);
      if (exactCount !== null) {
        return { count: exactCount, exact: true };
      }
    } catch {
      // Fall through to conservative fallback when tokenizer worker fails.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    incrementCounter('handoff.tokenizer_fallback', {});
    return { count: countTokensConservativeFallback(text), exact: false };
  };

  let bounded = render(selectedMessages, maxTextChars, includeTasks);
  let estTokens = countTokensFallback(bounded);
  if (estTokens > maxTokens) {
    ({ text: bounded, tokens: estTokens } = trimSyncToTarget(bounded, estTokens, maxTokens, countTokensFallback));
  }

  // Keep tokenizer worker IPC bounded to 1 call in normal cases (<= 3 on rare
  // dense-token divergence) and share total timeoutMs budget so slow worker
  // startup never drops an already-bounded pack.
  let measured = await measureTokensWithinBudget(bounded);
  let tokenCount = measured.count;
  if (!measured.exact) {
    if (tokenCount > maxTokens) {
      ({ text: bounded, tokens: tokenCount } = trimSyncToTarget(bounded, tokenCount, maxTokens, countTokensConservativeFallback));
    }
  } else {
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
      measured = await measureTokensWithinBudget(bounded);
      tokenCount = measured.count;
      if (!measured.exact) {
        if (tokenCount > maxTokens) {
          ({ text: bounded, tokens: tokenCount } = trimSyncToTarget(bounded, tokenCount, maxTokens, countTokensConservativeFallback));
        }
        break;
      }
    }
  }
  return { text: bounded, sourceAgentType: record.agentType, sourceRuntimeType: record.runtimeType ?? 'process', sourceConversationKey: sourceConversationKey(record), cutoff, createdAt: Date.now(), tokenCount };
}
