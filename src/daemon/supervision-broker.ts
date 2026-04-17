import { randomUUID } from 'node:crypto';
import type { TransportProvider, ProviderError } from '../agent/transport-provider.js';
import { ensureProviderConnected } from '../agent/provider-registry.js';
import type { SharedContextRuntimeBackend } from '../../shared/context-types.js';
import {
  SUPERVISION_DEFAULT_TIMEOUT_MS,
  SUPERVISION_MODE,
  type SessionSupervisionSnapshot,
} from '../../shared/supervision-config.js';
import {
  buildSupervisionDecisionPrompt,
  buildSupervisionDecisionRepairPrompt,
} from './supervision-prompts.js';

export type SupervisionDecisionKind = 'complete' | 'continue' | 'ask_human';

export interface SupervisionDecision {
  decision: SupervisionDecisionKind;
  reason: string;
  confidence: number;
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

function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function extractCandidateJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  return null;
}

export function parseSupervisionDecision(text: string): SupervisionDecision | null {
  const json = extractCandidateJson(text);
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
  return {
    decision: record.decision as SupervisionDecisionKind,
    reason: record.reason.trim(),
    confidence: clampConfidence(record.confidence),
  };
}

export function askHuman(reason: string): SupervisionDecision {
  return { decision: 'ask_human', reason, confidence: 0 };
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
      return askHuman('invalid supervision snapshot');
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
    if (elapsed >= timeoutMs) {
      release();
      if (this.queueChains.get(key) === current) this.queueChains.delete(key);
      return askHuman('supervision queue timeout');
    }

    try {
      const provider = await this.resolveProvider(snapshot.backend);
      return await this.evaluateWithProvider(provider, request, timeoutMs - elapsed, snapshot.model, request.cwd);
    } catch (error) {
      return askHuman(error instanceof Error ? error.message : String(error));
    } finally {
      release();
      if (this.queueChains.get(key) === current) this.queueChains.delete(key);
    }
  }

  private async evaluateWithProvider(
    provider: TransportProvider,
    request: SupervisionBrokerRequest,
    timeoutMs: number,
    model: string,
    cwd?: string,
  ): Promise<SupervisionDecision> {
    const sessionKey = `deck_supervision_${randomUUID()}`;
    const providerSessionId = await provider.createSession({
      sessionKey,
      fresh: true,
      cwd,
      agentId: model,
    });

    try {
      if (provider.setSessionAgentId) provider.setSessionAgentId(providerSessionId, model);
      let output = await this.runDecisionAttempt(
        provider,
        providerSessionId,
        buildSupervisionDecisionPrompt(request, request.snapshot?.promptVersion),
        timeoutMs,
      );
      let parsed = parseSupervisionDecision(output);
      if (parsed) return parsed;

      const maxRetries = Math.max(0, request.snapshot?.maxParseRetries ?? 1);
      for (let retry = 0; retry < maxRetries; retry += 1) {
        output = await this.runDecisionAttempt(
          provider,
          providerSessionId,
          buildSupervisionDecisionRepairPrompt(request, output),
          timeoutMs,
        );
        parsed = parseSupervisionDecision(output);
        if (parsed) return parsed;
      }
      return askHuman('invalid supervisor decision');
    } finally {
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
        finish(() => reject(new Error(error.message)));
      }));
      const timeout = setTimeout(() => {
        void provider.cancel?.(providerSessionId).catch(() => {});
        finish(() => reject(new Error('supervision timeout')));
      }, timeoutMs);
      cleanups.push(() => clearTimeout(timeout));
    });

    void waitForCompletion.catch(() => {});
    await provider.send(providerSessionId, prompt);
    return await waitForCompletion;
  }
}

export const supervisionBroker = new SupervisionBroker();
