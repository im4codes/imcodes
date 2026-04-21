/**
 * SDK-based memory compression via dedicated transport provider instances.
 *
 * Creates PRIVATE provider instances (not registered in global provider registry)
 * so compression sessions never appear in the user's session list.
 * Each backend (claude-code-sdk, codex-sdk, qwen) uses its own subscription auth.
 *
 * Inspired by Hermes Agent's context_compressor.py:
 * - Iterative summary updates: new events merge into previous summary
 * - Structured output format (Goal / Resolution / Key Decisions / Active State)
 * - Primary/backup failover with automatic recovery
 */
import type { ContextModelConfig, LocalContextEvent } from '../../shared/context-types.js';
import type { TransportProvider, ProviderError } from '../agent/transport-provider.js';
import type { AgentMessage } from '../../shared/agent-message.js';
import { randomUUID } from 'node:crypto';
import logger from '../util/logger.js';
import {
  resolveProcessingProviderSessionConfig,
  type ProcessingBackendSelection as CompressionBackendSelection,
  type ProcessingProviderSessionConfig as CompressionProviderSessionConfig,
} from './processing-provider-config.js';
import { markEphemeralProviderSid, unmarkEphemeralProviderSid } from '../agent/session-manager.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CompressionInput {
  events: LocalContextEvent[];
  previousSummary?: string;
  modelConfig: ContextModelConfig;
  targetTokens?: number;
}

export interface CompressionResult {
  summary: string;
  model: string;
  backend: string;
  usedBackup: boolean;
  fromSdk: boolean;
}

// ── Circuit breaker — per-backend state machine ──────────────────────────────
//
// States:
// - CLOSED: normal operation, requests flow through
// - OPEN: too many failures, requests short-circuit to next tier (backup/fallback)
// - HALF_OPEN: cooldown elapsed, let one probe through to test recovery
//
// On repeated HALF_OPEN failures, cooldown extends exponentially to avoid
// hammering a down service.

type BreakerState = 'closed' | 'open' | 'half_open';

interface BreakerStats {
  state: BreakerState;
  consecutiveFailures: number;
  consecutiveHalfOpenFailures: number;
  openedAt: number;
  cooldownMs: number;
}

const MAX_CONSECUTIVE_FAILURES = 3;
const BASE_COOLDOWN_MS = 60_000;        // 1 minute initial cooldown
const MAX_COOLDOWN_MS = 30 * 60_000;    // 30 minute cap
const COOLDOWN_MULTIPLIER = 2;          // double each failed half-open probe

const breakers = new Map<string, BreakerStats>();

function getBreaker(backend: string): BreakerStats {
  let b = breakers.get(backend);
  if (!b) {
    b = {
      state: 'closed',
      consecutiveFailures: 0,
      consecutiveHalfOpenFailures: 0,
      openedAt: 0,
      cooldownMs: BASE_COOLDOWN_MS,
    };
    breakers.set(backend, b);
  }
  return b;
}

function canCall(backend: string, now: number): boolean {
  const b = getBreaker(backend);
  if (b.state === 'closed') return true;
  if (b.state === 'half_open') return true; // allow probe (only one concurrent; per-call retry serializes)
  // OPEN: check if cooldown elapsed → transition to half_open
  if (now - b.openedAt >= b.cooldownMs) {
    b.state = 'half_open';
    logger.info({ backend }, 'Circuit breaker half-open — allowing probe');
    return true;
  }
  return false;
}

function recordSuccess(backend: string): void {
  const b = getBreaker(backend);
  b.state = 'closed';
  b.consecutiveFailures = 0;
  b.consecutiveHalfOpenFailures = 0;
  b.cooldownMs = BASE_COOLDOWN_MS; // reset cooldown on full recovery
}

function recordFailure(backend: string, now: number): void {
  const b = getBreaker(backend);
  b.consecutiveFailures++;
  if (b.state === 'half_open') {
    // Probe failed — extend cooldown exponentially
    b.consecutiveHalfOpenFailures++;
    b.cooldownMs = Math.min(b.cooldownMs * COOLDOWN_MULTIPLIER, MAX_COOLDOWN_MS);
    b.state = 'open';
    b.openedAt = now;
    logger.warn({ backend, cooldownMs: b.cooldownMs, halfOpenFailures: b.consecutiveHalfOpenFailures },
      'Circuit breaker reopened with extended cooldown');
    return;
  }
  if (b.state === 'closed' && b.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    b.state = 'open';
    b.openedAt = now;
    logger.warn({ backend, failures: b.consecutiveFailures, cooldownMs: b.cooldownMs },
      'Circuit breaker opened');
  }
}

// Per-call retry config (transient errors)
const MAX_RETRIES_PER_BACKEND = 2; // total attempts = 1 initial + 2 retries = 3
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 8000;

/** Classify error as retryable (transient) or permanent. */
function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  // Permanent errors — don't retry
  if (msg.includes('invalid api key') || msg.includes('401') || msg.includes('unauthorized')) return false;
  if (msg.includes('model not found') || msg.includes('not supported')) return false;
  if (msg.includes('invalid session')) return false;
  // Everything else (network, timeout, 5xx, empty response) is retryable
  return true;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Try a backend with transient-error retries.
 * Retries with exponential backoff + jitter on transient errors.
 * Permanent errors (auth, model not found) fail fast.
 */
async function sendWithRetry(prompt: string, selection: CompressionBackendSelection): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES_PER_BACKEND; attempt++) {
    try {
      return await sendToProvider(selection, prompt);
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === MAX_RETRIES_PER_BACKEND) {
        throw err;
      }
      // Tear down and retry with fresh provider
      await shutdownCompressionProvider();
      const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS)
        + Math.random() * 500;
      logger.warn({ err, backend: selection.backend, attempt: attempt + 1, delay }, 'SDK compression retry after transient error');
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function resetFailureTracking(): void {
  breakers.clear();
}

/** Get current circuit breaker state for observability/diagnostics. */
export function getCircuitBreakerStats(): Record<string, BreakerStats> {
  const result: Record<string, BreakerStats> = {};
  for (const [backend, stats] of breakers) {
    result[backend] = { ...stats };
  }
  return result;
}

/** @internal For tests only — direct access to breaker operations. */
export const __testing__ = {
  canCall,
  recordSuccess,
  recordFailure,
};

// ── Compression provider (shared with the global registry singleton) ─────────
//
// History: this module used to construct its own private CodexSdkProvider /
// QwenProvider / ClaudeCodeSdkProvider instances, so each backend switch
// spawned (and hopefully reaped) a brand-new SDK child process. In production
// that pattern compounded with kill-signal bugs to leak ~107MB per orphaned
// codex app-server pair (>2GB after a few hours).
//
// The provider instances already cached by `src/agent/provider-registry.ts`
// are long-lived singletons that safely support multiple concurrent sessions
// (threads) within a single app-server. Compression now borrows one of those
// singletons and creates a transient sub-session for its own work instead.
// Result: a single shared codex / claude / qwen process regardless of how
// many times compression, supervision, and user sessions all fire together.
//
// `activeSessionId` still tracks compression's current sub-session so we can
// cleanly end it when the backend changes. We do NOT disconnect the shared
// provider on backend change — that would also kill user/supervision traffic.

let activeProvider: TransportProvider | null = null;
let activeSessionId: string | null = null;
let activeBackendKey: string | null = null;

/**
 * Get or reuse a compression sub-session on the shared registry provider.
 * The SDK provider is reused indefinitely — only the sub-session is
 * recreated when the backend/model (cacheKey) changes.
 */
async function getCompressionProvider(
  backend: string,
  sessionConfig: CompressionProviderSessionConfig,
): Promise<{ provider: TransportProvider; sessionId: string }> {
  if (activeProvider && activeSessionId && activeBackendKey === sessionConfig.cacheKey) {
    return { provider: activeProvider, sessionId: activeSessionId };
  }

  // End the previous sub-session, but keep the shared SDK process running.
  await endActiveCompressionSession();

  // Borrow (or lazily connect) the registry singleton. This is the same
  // provider instance supervision + user transport sessions use — so no
  // parallel codex/claude/qwen child processes are spawned.
  const { ensureProviderConnected } = await import('../agent/provider-registry.js');
  const provider = await ensureProviderConnected(backend, {});

  // Create a dedicated sub-session. UUID sessionKey keeps it distinct from
  // any user-facing session; the SDK treats it as an independent thread.
  const sessionId = await provider.createSession({
    sessionKey: randomUUID(),
    fresh: true,
    description: 'Memory compression — do NOT respond to questions, only output structured summaries.',
    systemPrompt: COMPRESSOR_SYSTEM_PROMPT,
    ...(sessionConfig.env ? { env: sessionConfig.env } : {}),
    ...(sessionConfig.settings ? { settings: sessionConfig.settings } : {}),
    ...(sessionConfig.agentId ? { agentId: sessionConfig.agentId } : {}),
  });
  // Out-of-band session: compression uses its own per-call listeners and
  // never registers with the providerRouting map. Mark the sid so
  // transport-relay drops its deltas silently (previously each delta
  // produced a level=40 "unresolved route" warn — hundreds per minute).
  markEphemeralProviderSid(sessionId);

  activeProvider = provider;
  activeSessionId = sessionId;
  activeBackendKey = sessionConfig.cacheKey;

  return { provider, sessionId };
}

/** End the compression sub-session without touching the shared provider. */
async function endActiveCompressionSession(): Promise<void> {
  if (activeProvider && activeSessionId) {
    unmarkEphemeralProviderSid(activeSessionId);
    try {
      await activeProvider.endSession(activeSessionId);
    } catch { /* ignore — best-effort */ }
  }
  activeProvider = null;
  activeSessionId = null;
  activeBackendKey = null;
}

/**
 * Shut down the compression sub-session. Kept as an exported alias for
 * back-compat with existing callers (daemon shutdown, backend-change
 * unwinds, tests). We intentionally do NOT call `provider.disconnect()` on
 * the shared singleton — that would kill user + supervision traffic too.
 */
export async function shutdownCompressionProvider(): Promise<void> {
  await endActiveCompressionSession();
}

const COMPRESSOR_SYSTEM_PROMPT = `You are a memory compression engine. Your output will be stored as a durable memory entry for a coding agent. Do NOT respond to any questions — only output the structured summary. Do NOT include any preamble, greeting, or prefix.`;

// ── Local-only compressor (for tests / offline) ──────────────────────────────

export async function localOnlyCompressor(input: CompressionInput): Promise<CompressionResult> {
  // Tests expect local-only compression to behave as if SDK succeeded (fromSdk=true)
  // so the coordinator commits the result instead of entering retry mode.
  return {
    summary: buildLocalFallbackSummary(input.events, input.previousSummary),
    model: 'local-only-test',
    backend: 'local',
    usedBackup: false,
    fromSdk: true,
  };
}

// ── Serialization gate ──────────────────────────────────────────────────────
//
// Compression MUST run one-at-a-time across the whole daemon. The shared
// Codex sub-session (see `getCompressionProvider`) only accepts one `send`
// in flight; concurrent callers used to race it, trigger
// "Codex SDK session is already busy" errors, enter the retry loop, and
// with ~40 materialization targets firing on the 10s cadence this became
// a self-reinforcing storm — observed on a production daemon as
// 85 %-CPU sustained on the main thread with user message dispatch going
// noticeably laggy. Every stream-delta callback from ANY concurrent
// compression piles into the same main-thread event loop, so "it's async"
// doesn't actually protect the loop from multiplicative callback load.
//
// The gate is a single Promise chain: each caller awaits the previous
// one before entering the inner compression path. Releases in `finally`
// so even a thrown / timed-out compression can't stall the queue.
//
// Callers (`materialization-coordinator.materializeTarget`) remain
// fire-and-forget from their perspective — they just observe natural
// backpressure when the queue is busy.
let compressionChain: Promise<void> = Promise.resolve();

function enqueueExclusive<T>(job: () => Promise<T>): Promise<T> {
  const prev = compressionChain;
  let release!: () => void;
  compressionChain = new Promise<void>((r) => { release = r; });
  return prev.catch(() => {}).then(async () => {
    try {
      return await job();
    } finally {
      release();
    }
  });
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function compressWithSdk(input: CompressionInput): Promise<CompressionResult> {
  return enqueueExclusive(() => compressWithSdkInner(input));
}

async function compressWithSdkInner(input: CompressionInput): Promise<CompressionResult> {
  const { events, previousSummary, modelConfig } = input;
  const targetTokens = input.targetTokens ?? 500;

  if (events.length === 0) {
    return {
      summary: previousSummary ?? 'No events to compress.',
      model: '', backend: '', usedBackup: false, fromSdk: false,
    };
  }

  const prompt = buildCompressionPrompt(events, previousSummary, targetTokens);
  const now = Date.now();

  // Try primary (gated by circuit breaker)
  if (canCall(modelConfig.primaryContextBackend, now)) {
    try {
      const result = await sendWithRetry(prompt, {
        backend: modelConfig.primaryContextBackend,
        model: modelConfig.primaryContextModel,
        preset: modelConfig.primaryContextPreset,
      });
      recordSuccess(modelConfig.primaryContextBackend);
      return {
        summary: result, model: modelConfig.primaryContextModel,
        backend: modelConfig.primaryContextBackend, usedBackup: false, fromSdk: true,
      };
    } catch (err) {
      recordFailure(modelConfig.primaryContextBackend, now);
      await shutdownCompressionProvider();
      logger.warn({ err, backend: modelConfig.primaryContextBackend },
        'Primary SDK compression failed; circuit breaker updated');
    }
  } else {
    logger.debug({ backend: modelConfig.primaryContextBackend },
      'Primary skipped — circuit breaker open');
  }

  // Try backup (gated by its own circuit breaker)
  if (modelConfig.backupContextBackend && modelConfig.backupContextModel) {
    if (canCall(modelConfig.backupContextBackend, now)) {
      try {
        const result = await sendWithRetry(prompt, {
          backend: modelConfig.backupContextBackend,
          model: modelConfig.backupContextModel,
          preset: modelConfig.backupContextPreset,
        });
        recordSuccess(modelConfig.backupContextBackend);
        return {
          summary: result, model: modelConfig.backupContextModel,
          backend: modelConfig.backupContextBackend, usedBackup: true, fromSdk: true,
        };
      } catch (err) {
        recordFailure(modelConfig.backupContextBackend, now);
        await shutdownCompressionProvider();
        logger.warn({ err, backend: modelConfig.backupContextBackend },
          'Backup SDK compression failed; circuit breaker updated');
      }
    } else {
      logger.debug({ backend: modelConfig.backupContextBackend },
        'Backup skipped — circuit breaker open');
    }
  }

  // All SDK attempts failed / circuits open — local fallback
  return {
    summary: buildLocalFallbackSummary(events, previousSummary),
    model: 'local-fallback', backend: 'none', usedBackup: false, fromSdk: false,
  };
}

// ── Provider send with completion wait ───────────────────────────────────────

// Tighter than the 60 s we had during single-request debugging. With the
// serialization gate above the queue is now the budget, not the timeout —
// a single slow call blocked everything behind it for up to a full minute.
// 20 s still lets a model with warm context finish a structured summary;
// genuinely slow/broken calls release the lane 3× faster and the
// circuit breaker trips sooner, falling back to the local summarizer.
const COMPRESSION_TIMEOUT_MS = 20_000;

export async function resolveCompressionProviderSessionConfig(
  selection: CompressionBackendSelection,
): Promise<CompressionProviderSessionConfig> {
  return resolveProcessingProviderSessionConfig(selection);
}

async function sendToProvider(selection: CompressionBackendSelection, prompt: string): Promise<string> {
  // claude-code-sdk: use SDK query() directly — the transport provider's spawn
  // hook adds CLI flags that cause exit code 1 in one-shot compression mode.
  // SDK query() handles subprocess lifecycle and subscription auth correctly.
  if (selection.backend === 'claude-code-sdk') {
    return sendViaSdkQuery(prompt);
  }

  // Other backends: use the transport provider's send/onComplete flow.
  const sessionConfig = await resolveCompressionProviderSessionConfig(selection);
  const { provider, sessionId } = await getCompressionProvider(selection.backend, sessionConfig);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      offComplete(); offError();
      // Tear down the underlying provider session so a stuck CLI subprocess
      // (e.g., a qwen child waiting on a misconfigured model endpoint) is
      // killed via SIGTERM. Without this, hung subprocesses keep buffering
      // stream-json output into the daemon's stdout pipes until the V8 heap
      // exhausts and the daemon OOM-crashes, taking every active session
      // with it. Best-effort: don't await — the rejection must fire promptly.
      void shutdownCompressionProvider().catch(() => { /* best-effort */ });
      reject(new Error(`Compression timed out after ${COMPRESSION_TIMEOUT_MS}ms`));
    }, COMPRESSION_TIMEOUT_MS);

    const offComplete = provider.onComplete((sid: string, message: AgentMessage) => {
      if (sid !== sessionId) return;
      clearTimeout(timer); offComplete(); offError();
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (!text) { reject(new Error('Provider returned empty response')); return; }
      resolve(text);
    });

    const offError = provider.onError((sid: string, error: ProviderError) => {
      if (sid !== sessionId) return;
      clearTimeout(timer); offComplete(); offError();
      reject(new Error(`Provider error: ${error.code} — ${error.message}`));
    });

    provider.send(sessionId, prompt).catch((err) => {
      clearTimeout(timer); offComplete(); offError();
      reject(err);
    });
  });
}

/**
 * Use Claude Agent SDK query() directly for one-shot compression.
 * Strips CLAUDECODE env to avoid nested-session detection.
 * SDK manages subprocess lifecycle and subscription auth.
 */
async function sendViaSdkQuery(prompt: string): Promise<string> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const savedClaudeCode = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;
  try {
    let result = '';
    for await (const msg of query({
      prompt: COMPRESSOR_SYSTEM_PROMPT + '\n\n' + prompt,
      options: { maxTurns: 1 },
    })) {
      if (msg.type === 'assistant') {
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block && 'type' in block && block.type === 'text' && 'text' in block) {
              result += String(block.text);
            }
          }
        } else if (typeof content === 'string') {
          result += content;
        }
      }
    }
    if (!result.trim()) throw new Error('SDK returned empty response');
    return result.trim();
  } finally {
    if (savedClaudeCode !== undefined) process.env.CLAUDECODE = savedClaudeCode;
  }
}

// ── Prompt construction ──────────────────────────────────────────────────────

function buildCompressionPrompt(
  events: LocalContextEvent[],
  previousSummary: string | undefined,
  targetTokens: number,
): string {
  const serializedEvents = serializeEvents(events);

  const template = `## User Problem
[What the user was trying to accomplish — be specific]

## Resolution
[What was done to solve it — include file paths, commands, specific changes]

## Key Decisions
[Important technical decisions and why — include constraints and preferences]

## User-Pinned Notes
[If the user explicitly asked you to remember, memorize, take note of, or never forget any specific piece of information (in any language — e.g. English "remember/keep in mind/note this", Chinese "记住/记得/记下/牢记", Japanese "覚えて/覚えておいて", Korean "기억해줘", Spanish "recuerda", Russian "запомни", etc. — recognise the INTENT, not any fixed keyword list), copy the exact content here VERBATIM. Never paraphrase, summarise, translate, truncate, or reword pinned content. Preserve the user's original words exactly, including code, paths, numbers, names, and formatting. If there are no such requests in this batch, omit this section entirely.]

## Active State
[Files modified, test results, current branch — only if relevant]`;

  if (previousSummary) {
    return `You are UPDATING an existing memory entry. A previous compression produced the summary below. New conversation events have occurred and need to be incorporated.

PREVIOUS SUMMARY:
${previousSummary}

NEW EVENTS TO INCORPORATE:
${serializedEvents}

Update the summary using this exact structure. PRESERVE all existing information that is still relevant. ADD new actions and outcomes. Move completed items from pending to resolved. Update active state. Remove information only if clearly obsolete.

CRITICAL — VERBATIM PRESERVATION RULE: If the previous summary contains a "User-Pinned Notes" section, every line in it MUST be carried forward UNCHANGED (word-for-word, character-for-character) into the updated summary. Also scan NEW EVENTS for any user message expressing an intent to be remembered (in any language — see the "User-Pinned Notes" description below). Append such content verbatim to that section. Never drop, paraphrase, translate, or compress pinned content, even if it looks redundant.

${template}

Target ~${targetTokens} tokens. Be CONCRETE — include file paths, error messages, and specific values. Write only the summary.`;
  }

  return `Compress the following agent conversation events into a structured memory entry. The next agent session should understand what happened without re-reading the original events.

EVENTS TO COMPRESS:
${serializedEvents}

Use this exact structure:

${template}

CRITICAL — VERBATIM PRESERVATION RULE: If any user message in the events above expresses an intent to be remembered (in any language — see the "User-Pinned Notes" description above), copy that exact content word-for-word into the "User-Pinned Notes" section. Never paraphrase, translate, summarise, or reorder pinned content.

Target ~${targetTokens} tokens. Be CONCRETE — include file paths, error messages, and specific values. Write only the summary.`;
}

function serializeEvents(events: LocalContextEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    const content = event.content?.trim();
    if (!content) continue;
    const truncated = content.length > 2000
      ? content.slice(0, 1800) + '\n...[truncated]...\n' + content.slice(-200)
      : content;
    parts.push(`[${event.eventType}] ${truncated}`);
  }
  return parts.join('\n\n');
}

// ── Local fallback ───────────────────────────────────────────────────────────

export function buildLocalFallbackSummary(events: LocalContextEvent[], previousSummary?: string): string {
  const turnPairs = buildTurnPairs(events);
  const decisions = events
    .filter((e) => e.eventType === 'decision' || e.eventType === 'constraint' || e.eventType === 'preference')
    .map((e) => e.content?.trim())
    .filter((v): v is string => !!v);

  const sections: string[] = [];
  if (previousSummary) {
    sections.push(previousSummary.trim(), '', '--- Updated ---', '');
  }

  sections.push('> ⚠️ **Structured summary unavailable** — AI compression backend is currently offline. Showing raw event transcripts below. Will retry automatically when backend recovers.');
  sections.push('');

  // Show each turn pair in full (truncated to reasonable length)
  if (turnPairs.length > 0) {
    sections.push('## Conversation');
    for (let i = 0; i < turnPairs.length; i++) {
      const pair = turnPairs[i];
      sections.push('');
      sections.push(`**User:** ${truncate(pair.user, 500)}`);
      if (pair.assistant) {
        sections.push('');
        sections.push(`**Assistant:** ${truncate(pair.assistant, 800)}`);
      } else {
        sections.push('');
        sections.push('**Assistant:** _(no response yet — turn in progress)_');
      }
    }
  } else {
    // No user/assistant pairs — show raw event list
    sections.push('## Staged events');
    for (const event of events.slice(0, 10)) {
      const content = event.content?.trim();
      if (content) {
        sections.push(`- \`${event.eventType}\`: ${truncate(content, 300)}`);
      }
    }
  }

  if (decisions.length > 0) {
    sections.push('');
    sections.push('## Key Decisions');
    for (const d of decisions) {
      sections.push(`- ${truncate(d, 300)}`);
    }
  }

  return sections.join('\n');
}

function buildTurnPairs(events: LocalContextEvent[]): Array<{ user: string; assistant?: string }> {
  const pairs: Array<{ user: string; assistant?: string }> = [];
  for (const event of events) {
    const content = event.content?.trim();
    if (!content) continue;
    if (event.eventType === 'user.turn' || event.eventType === 'user.message') {
      pairs.push({ user: content });
    } else if (event.eventType === 'assistant.text' || event.eventType === 'assistant.turn') {
      const openPair = [...pairs].reverse().find((p) => !p.assistant);
      if (openPair) openPair.assistant = content;
    }
  }
  return pairs;
}

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen - 1) + '…';
}
