import { randomUUID } from 'node:crypto';
import type { TransportProvider, ProviderError } from '../agent/transport-provider.js';
import { ensureProviderConnected } from '../agent/provider-registry.js';
import type { SharedContextRuntimeBackend } from '../../shared/context-types.js';
import {
  parseTaskRunTerminalStateFromText,
  SUPERVISION_DEFAULT_TIMEOUT_MS,
  SUPERVISION_MODE,
  SUPERVISION_UNAVAILABLE_REASONS,
  type SessionSupervisionSnapshot,
  type SupervisionUnavailableReason,
} from '../../shared/supervision-config.js';
import {
  buildSupervisionDecisionPrompt,
  buildSupervisionDecisionRepairPrompt,
} from './supervision-prompts.js';
import { resolveProcessingProviderSessionConfig } from '../context/processing-provider-config.js';
import { markEphemeralProviderSid, unmarkEphemeralProviderSid } from '../agent/session-manager.js';

export type SupervisionDecisionKind = 'complete' | 'continue' | 'ask_human';

export interface SupervisionDecision {
  decision: SupervisionDecisionKind;
  reason: string;
  confidence: number;
  unavailableReason?: SupervisionUnavailableReason;
}

export interface SupervisionBrokerRequest {
  snapshot: SessionSupervisionSnapshot | null | undefined;
  taskRequest: string;
  assistantResponse?: string;
  cwd?: string;
  description?: string;
}

export interface SupervisionBrokerDeps {
  resolveProvider?: (backend: SharedContextRuntimeBackend) => Promise<TransportProvider>;
  now?: () => number;
}

const DECISIONS = new Set<SupervisionDecisionKind>(['complete', 'continue', 'ask_human']);
const MIN_SUPERVISION_EXECUTION_BUDGET_MS = 5;
const CONTINUE_SIGNAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:todo|not done|unfinished|incomplete|remaining work|still needs? work|missing tests?|needs? tests?|should add tests?|add(?:ing)? more tests?|more tests needed|still need(?:s)? to|follow-?up work|next step(?:s)?|keep working|continue working|not committed|uncommitted|not pushed)\b/i,
    reason: 'assistant response explicitly indicates remaining work',
  },
  {
    pattern: /\b(?:if you want|next step|i can(?: next| also| still)?|we can next|can follow up)\b[\s\S]{0,80}\b(?:add|write|run|fix|improve|update|verify|audit|commit|push|submit|test|tests)\b/i,
    reason: 'assistant response proposes a concrete follow-up engineering step',
  },
  {
    pattern: /(还没完成|未完成|还需要|待处理|待补|缺少测试|需要补测试|补测试|加测试|继续完善|继续修|下一步|接下来|如果你愿意|如果你要|还没提交|未提交|没有提交|还没推送|未推送|没有推送|还没commit|未commit|没commit|还没push|未push|没push)[\s\S]{0,60}(测试|修复|完善|验证|提交|推送|commit|push)/i,
    reason: 'assistant response proposes concrete follow-up work in Chinese',
  },
  {
    pattern: /(这还没提交|还没提交|未提交|没有提交|还没推送|未推送|没有推送|如果你要|我可以顺手|再提一个(?:小)?\s*commit|再帮你(?:提个)?\s*commit|再帮你提交|再帮你推送)/i,
    reason: 'assistant response proposes concrete follow-up work in Chinese',
  },
];

function extractRawOrFencedJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return null;
}

export function parseSupervisionDecision(text: string): SupervisionDecision | null {
  const json = extractRawOrFencedJson(text);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!DECISIONS.has(record.decision as SupervisionDecisionKind)) return null;
  if (typeof record.reason !== 'string' || !record.reason.trim()) return null;
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) return null;
  return {
    decision: record.decision as SupervisionDecisionKind,
    reason: record.reason.trim(),
    confidence: record.confidence,
  };
}

export function askHuman(reason: string, unavailableReason?: SupervisionUnavailableReason): SupervisionDecision {
  return unavailableReason
    ? { decision: 'ask_human', reason, confidence: 0, unavailableReason }
    : { decision: 'ask_human', reason, confidence: 0 };
}

function getAssistantIncompleteSignal(text: string | undefined): { reason: string } | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const taskRunState = parseTaskRunTerminalStateFromText(trimmed);
  if (taskRunState === 'needs_input') {
    return { reason: 'assistant terminal marker requested human continuation' };
  }
  if (taskRunState === 'blocked') {
    return { reason: 'assistant terminal marker reported a blocked state' };
  }

  for (const entry of CONTINUE_SIGNAL_PATTERNS) {
    if (entry.pattern.test(trimmed)) return { reason: entry.reason };
  }
  return null;
}

function applyDecisionGuardrails(
  decision: SupervisionDecision,
  request: SupervisionBrokerRequest,
): SupervisionDecision {
  const incompleteSignal = getAssistantIncompleteSignal(request.assistantResponse);
  if (!incompleteSignal) return decision;

  if (decision.decision === 'complete') {
    return {
      decision: 'continue',
      reason: `${incompleteSignal.reason}; original supervisor reason: ${decision.reason}`,
      confidence: Math.min(decision.confidence, 0.35),
    };
  }
  if (decision.decision === 'continue') return decision;

  return {
    ...decision,
    reason: `${incompleteSignal.reason}; original supervisor reason: ${decision.reason}`,
  };
}

export class SupervisionBroker {
  private readonly resolveProvider: (backend: SharedContextRuntimeBackend) => Promise<TransportProvider>;
  private readonly now: () => number;
  private readonly queueChains = new Map<string, Promise<void>>();

  constructor(deps: SupervisionBrokerDeps = {}) {
    this.resolveProvider = deps.resolveProvider ?? ((backend) => ensureProviderConnected(backend, {}));
    this.now = deps.now ?? (() => Date.now());
  }

  async decide(request: SupervisionBrokerRequest): Promise<SupervisionDecision> {
    const snapshot = request.snapshot;
    if (!snapshot || snapshot.mode === SUPERVISION_MODE.OFF) {
      return askHuman('supervision disabled');
    }
    if (!snapshot.backend || !snapshot.model) {
      return askHuman('invalid supervision snapshot', SUPERVISION_UNAVAILABLE_REASONS.INVALID_SNAPSHOT);
    }

    const startedAt = this.now();
    const timeoutMs = snapshot.timeoutMs > 0 ? snapshot.timeoutMs : SUPERVISION_DEFAULT_TIMEOUT_MS;
    const key = `${snapshot.backend}:${snapshot.model}`;
    const previous = this.queueChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queueChains.set(key, previous.catch(() => {}).then(() => current));

    await previous.catch(() => {});
    const elapsed = this.now() - startedAt;
    const remainingBudget = timeoutMs - elapsed;
    if (elapsed >= timeoutMs || remainingBudget <= MIN_SUPERVISION_EXECUTION_BUDGET_MS) {
      release();
      if (this.queueChains.get(key) === current) this.queueChains.delete(key);
      return askHuman('supervision queue timeout', SUPERVISION_UNAVAILABLE_REASONS.QUEUE_TIMEOUT);
    }

    try {
      const provider = await this.resolveProvider(snapshot.backend);
      return await this.evaluateWithProvider(provider, request, remainingBudget, snapshot, request.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unavailableReason = (error && typeof error === 'object' && 'supervisionUnavailableReason' in error
        ? (error as { supervisionUnavailableReason?: SupervisionUnavailableReason }).supervisionUnavailableReason
        : undefined) ?? SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_NOT_CONNECTED;
      return askHuman(message, unavailableReason);
    } finally {
      release();
      if (this.queueChains.get(key) === current) this.queueChains.delete(key);
    }
  }

  private async evaluateWithProvider(
    provider: TransportProvider,
    request: SupervisionBrokerRequest,
    timeoutMs: number,
    snapshot: SessionSupervisionSnapshot,
    cwd?: string,
  ): Promise<SupervisionDecision> {
    const sessionKey = `deck_supervision_${randomUUID()}`;

    // Delegate backend/model/preset → env/agentId/settings resolution to the
    // shared processing-provider config. For qwen with a preset this applies
    // ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / pinned ANTHROPIC_MODEL; for
    // everything else it short-circuits to `{ agentId: model }`. See
    // openspec change `supervision-qwen-preset-support` design §1.
    const resolved = await resolveProcessingProviderSessionConfig({
      backend: snapshot.backend,
      model: snapshot.model,
      preset: snapshot.preset,
    });
    const effectiveAgentId = resolved.agentId ?? snapshot.model;

    const providerSessionId = await provider.createSession({
      sessionKey,
      fresh: true,
      cwd,
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      ...(resolved.env ? { env: resolved.env } : {}),
      ...(resolved.settings ? { settings: resolved.settings } : {}),
    });
    // Supervision runs its own per-call onComplete/onError filtered by sid;
    // mark the sid so transport-relay's global onDelta drops its events
    // silently instead of per-delta "unresolved route" warnings.
    markEphemeralProviderSid(providerSessionId);

    try {
      if (provider.setSessionAgentId && effectiveAgentId) provider.setSessionAgentId(providerSessionId, effectiveAgentId);
      let output = await this.runDecisionAttempt(
        provider,
        providerSessionId,
        buildSupervisionDecisionPrompt(request, request.snapshot?.promptVersion),
        timeoutMs,
      );
      let parsed = parseSupervisionDecision(output);
      if (parsed) return applyDecisionGuardrails(parsed, request);

      const maxRetries = Math.max(0, request.snapshot?.maxParseRetries ?? 1);
      for (let retry = 0; retry < maxRetries; retry += 1) {
        output = await this.runDecisionAttempt(
          provider,
          providerSessionId,
          buildSupervisionDecisionRepairPrompt(request, output),
          timeoutMs,
        );
        parsed = parseSupervisionDecision(output);
        if (parsed) return applyDecisionGuardrails(parsed, request);
      }
      return askHuman('invalid supervisor decision', SUPERVISION_UNAVAILABLE_REASONS.INVALID_OUTPUT);
    } finally {
      unmarkEphemeralProviderSid(providerSessionId);
      await provider.endSession(providerSessionId).catch(() => {});
    }
  }

  private async runDecisionAttempt(
    provider: TransportProvider,
    providerSessionId: string,
    prompt: string,
    timeoutMs: number,
  ): Promise<string> {
    const waitForCompletion = new Promise<string>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      const finish = (fn: () => void) => {
        while (cleanups.length > 0) cleanups.pop()?.();
        fn();
      };
      cleanups.push(provider.onComplete((sid, message) => {
        if (sid !== providerSessionId) return;
        finish(() => resolve(message.content));
      }));
      cleanups.push(provider.onError((sid, error: ProviderError) => {
        if (sid !== providerSessionId) return;
        finish(() => reject(Object.assign(new Error(error.message), { supervisionUnavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR })));
      }));
      const timeout = setTimeout(() => {
        void provider.cancel?.(providerSessionId).catch(() => {});
        finish(() => reject(Object.assign(new Error('supervision timeout'), { supervisionUnavailableReason: SUPERVISION_UNAVAILABLE_REASONS.DECISION_TIMEOUT })));
      }, timeoutMs);
      cleanups.push(() => clearTimeout(timeout));
    });

    void waitForCompletion.catch(() => {});
    await provider.send(providerSessionId, prompt);
    return await waitForCompletion;
  }
}

export const supervisionBroker = new SupervisionBroker();
