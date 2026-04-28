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

/**
 * Structured supervisor verdict. The schema is intentionally action-oriented:
 * `continue` without a concrete `nextAction` is NOT acceptable — it used to
 * cause a documented "supervision keeps tugging back and forth" loop where
 * the supervisor kept returning `continue` with a vague reason and the
 * target agent had nothing actionable to do. The guardrail below forces
 * any such vague continue to `ask_human` so the user is brought back into
 * the loop instead of re-running the same empty nudge.
 *
 * Fields:
 *  - `decision`: complete / continue / ask_human — the verdict.
 *  - `reason`: human-readable explanation (shown in UI / logs).
 *  - `confidence`: supervisor's self-reported confidence, 0..1.
 *  - `gap`: what is specifically missing to close out the task. Required
 *    (strongly preferred) when `decision === 'continue'`.
 *  - `nextAction`: imperative, specific instruction for the target agent's
 *    next turn, e.g. "Run npm test and report failing specs" or
 *    "Commit staged changes with message X and push to origin/dev".
 *    **Required when `decision === 'continue'`** — the guardrail downgrades
 *    to `ask_human` if absent or too vague.
 *  - `extra`: reserved for future schema extensions; passed through
 *    verbatim to callers that want richer metadata without another schema
 *    bump.
 */
export interface SupervisionDecision {
  decision: SupervisionDecisionKind;
  reason: string;
  confidence: number;
  gap?: string;
  nextAction?: string;
  extra?: Record<string, unknown>;
  unavailableReason?: SupervisionUnavailableReason;
}

/** Minimum length for `nextAction` to be treated as "concrete enough" to
 *  dispatch to the target agent. Anything shorter is almost certainly a
 *  placeholder or single-word filler — escalate to human instead. */
const MIN_ACTIONABLE_NEXT_ACTION_LENGTH = 12;

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
/**
 * Regex guardrails that downgrade a supervisor LLM's `complete` verdict to
 * `continue` when the assistant response obviously proposes follow-up work.
 *
 * CRITICAL DESIGN RULE: every trigger must be an INTENT phrase (the agent
 * says it will do something next), not a STATE DESCRIPTOR (the agent
 * reports how things currently are). Bare state words like "uncommitted",
 * "未提交", "not pushed", "还没提交" used to live here and caused a
 * supervision loop when the user asked git-status Q&A: the assistant
 * answered factually ("是的，还有未提交代码，当前 3 个文件"), the regex
 * matched the bare state word, the guardrail flipped complete→continue,
 * the continue-prompt nudged the agent, the agent answered factually
 * again, and the loop repeated 5-6 times until the outer continueLoops
 * cap kicked in. The user-facing symptom was "supervision keeps tugging
 * back and forth on the same answer".
 *
 * State words alone must NEVER fire these patterns. Only clear intent
 * phrases ("I'll commit next", "如果你要，我可以顺手", "next step") with
 * an actionable verb are allowed. The supervisor LLM is trusted to judge
 * whether a bare state report means more work is needed for the ORIGINAL
 * task — regex second-guessing that decision is exactly what caused the
 * loop.
 */
const CONTINUE_SIGNAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // English: self-declared incomplete-work markers the agent applies to
    // its OWN task state. Removed bare "uncommitted", "not committed",
    // "not pushed" — those match factual git-state reports and caused
    // the documented supervision loop. "TODO", "unfinished", etc. remain
    // because those words only appear when the agent itself flags remaining
    // work on the current task.
    pattern: /\b(?:todo|not done|unfinished|incomplete|remaining work|still needs? work|missing tests?|needs? tests?|should add tests?|add(?:ing)? more tests?|more tests needed|still need(?:s)? to|follow-?up work|next step(?:s)?|keep working|continue working)\b/i,
    reason: 'assistant response explicitly indicates remaining work',
  },
  {
    // English: two-part intent + action verb. Unchanged — this has always
    // required both an intent phrase AND a concrete action verb, so it
    // doesn't false-positive on state reports.
    pattern: /\b(?:if you want|next step|i can(?: next| also| still)?|we can next|can follow up)\b[\s\S]{0,80}\b(?:add|write|run|fix|improve|update|verify|audit|commit|push|submit|test|tests)\b/i,
    reason: 'assistant response proposes a concrete follow-up engineering step',
  },
  {
    // Chinese: two-part intent + action. Removed state markers
    // (还没提交 / 未提交 / 没有提交 / 还没推送 / 未推送 / 没有推送 /
    // 还没commit / 未commit / 没commit / 还没push / 未push / 没push)
    // from the first group — they let "报告状态" sentences like
    // "未提交代码被我修复了" trip the two-part guard, same class of bug
    // as the pattern-4 fix below. Kept are intent phrases only:
    // 还没完成 / 未完成 / 还需要 / 待处理 / 待补 / 缺少测试 /
    // 需要补测试 / 补测试 / 加测试 / 继续完善 / 继续修 /
    // 下一步 / 接下来 / 如果你愿意 / 如果你要.
    pattern: /(还没完成|未完成|还需要|待处理|待补|缺少测试|需要补测试|补测试|加测试|继续完善|继续修|下一步|接下来|如果你愿意|如果你要)[\s\S]{0,60}(测试|修复|完善|验证|提交|推送|commit|push)/i,
    reason: 'assistant response proposes concrete follow-up work in Chinese',
  },
  {
    // Chinese: explicit offer to do a commit/push next. Removed the bare
    // state markers (这还没提交 / 还没提交 / 未提交 / 没有提交 /
    // 还没推送 / 未推送 / 没有推送) that previously made this pattern
    // fire on any factual mention of git state — that was the direct
    // cause of the supervision loop. What's left is unambiguous intent:
    // the agent offering to act, e.g. "如果你要，我可以顺手给你再提一个
    // 小 commit" still matches via 如果你要 / 我可以顺手 / 再提一个 commit.
    pattern: /(如果你要|我可以顺手|再提一个(?:小)?\s*commit|再帮你(?:提个)?\s*commit|再帮你提交|再帮你推送)/i,
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
  // gap / nextAction / extra are all optional at parse time — the guardrail
  // below is where "continue without nextAction" gets downgraded to
  // ask_human. Keeping the parser permissive means a still-correct
  // supervisor that forgets the new fields doesn't trigger a parse retry
  // storm; the behavior just degrades gracefully.
  const gap = typeof record.gap === 'string' && record.gap.trim() ? record.gap.trim() : undefined;
  const nextAction = typeof record.nextAction === 'string' && record.nextAction.trim() ? record.nextAction.trim() : undefined;
  const extra = record.extra && typeof record.extra === 'object' && !Array.isArray(record.extra)
    ? record.extra as Record<string, unknown>
    : undefined;
  return {
    decision: record.decision as SupervisionDecisionKind,
    reason: record.reason.trim(),
    confidence: record.confidence,
    ...(gap ? { gap } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(extra ? { extra } : {}),
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

function isActionableNextAction(nextAction: string | undefined): boolean {
  if (!nextAction) return false;
  const trimmed = nextAction.trim();
  if (trimmed.length < MIN_ACTIONABLE_NEXT_ACTION_LENGTH) return false;
  // Reject obvious placeholder text that doesn't instruct the agent.
  // These are the shapes supervisors default to when they know they need
  // to return continue but have nothing specific to say — exactly the
  // case we want to force-escalate.
  const lowered = trimmed.toLowerCase();
  const vagueMarkers = [
    /^(keep going|continue|proceed|carry on|do more)\.?$/i,
    /^(not done|task incomplete|finish the task|complete the task|work on it)\.?$/i,
    /^继续完成(任务)?。?$/,
    /^继续。?$/,
    /^请继续。?$/,
  ];
  if (vagueMarkers.some((re) => re.test(trimmed))) return false;
  // At minimum the instruction should contain an imperative verb or a
  // concrete noun hinting at what to do. The easiest robust check is that
  // it isn't pure whitespace + common-stopwords filler.
  const contentChars = lowered.replace(/[\s\p{P}]/gu, '');
  if (contentChars.length < 6) return false;
  return true;
}

function applyDecisionGuardrails(
  decision: SupervisionDecision,
  request: SupervisionBrokerRequest,
): SupervisionDecision {
  let working: SupervisionDecision = decision;

  // ── 1) Vague-continue escape hatch ──
  // The user-facing symptom this prevents: supervisor returns
  // `{decision: 'continue', reason: 'not done yet'}` with no concrete
  // nextAction. The target agent gets a continue prompt that basically
  // says "keep going" and has no new information to act on, so it
  // re-answers the previous turn the same way, the supervisor judges
  // again, and the loop runs until the outer cap kicks in. Force
  // ask_human instead — bringing the user back in is STRICTLY better
  // than spinning a pointless loop.
  if (working.decision === 'continue' && !isActionableNextAction(working.nextAction)) {
    working = {
      decision: 'ask_human',
      reason: `supervisor returned continue without an actionable nextAction; escalating to human. original supervisor reason: ${working.reason}`,
      confidence: 0,
      ...(working.gap ? { gap: working.gap } : {}),
      ...(working.extra ? { extra: working.extra } : {}),
    };
  }

  // ── 2) Incomplete-signal regex override ──
  // Upgrade a 'complete' verdict to 'continue' only when the regex catches
  // a clear intent-to-do-more phrase AND the supervisor's nextAction (if
  // any) is usable. If the supervisor didn't provide a nextAction we
  // surface the regex's own reason as a stand-in so the target at least
  // gets something directional to act on.
  const incompleteSignal = getAssistantIncompleteSignal(request.assistantResponse);
  if (!incompleteSignal) return working;

  if (working.decision === 'complete') {
    return {
      decision: 'continue',
      reason: `${incompleteSignal.reason}; original supervisor reason: ${working.reason}`,
      confidence: Math.min(working.confidence, 0.35),
      gap: working.gap ?? incompleteSignal.reason,
      nextAction: working.nextAction ?? `Finish the follow-up implied by the prior turn (${incompleteSignal.reason}).`,
      ...(working.extra ? { extra: working.extra } : {}),
    };
  }
  if (working.decision === 'continue') return working;

  return {
    ...working,
    reason: `${incompleteSignal.reason}; original supervisor reason: ${working.reason}`,
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
    const key = `${snapshot.backend}:${snapshot.model}:${snapshot.preset ?? ''}`;
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
    let resolved: Awaited<ReturnType<typeof resolveProcessingProviderSessionConfig>>;
    try {
      resolved = await resolveProcessingProviderSessionConfig({
        backend: snapshot.backend,
        model: snapshot.model,
        preset: snapshot.preset,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), {
        supervisionUnavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR,
      });
    }
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
