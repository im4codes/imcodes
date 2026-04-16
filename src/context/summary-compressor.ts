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
async function sendWithRetry(backend: string, prompt: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES_PER_BACKEND; attempt++) {
    try {
      return await sendToProvider(backend, prompt);
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === MAX_RETRIES_PER_BACKEND) {
        throw err;
      }
      // Tear down and retry with fresh provider
      await shutdownCompressionProvider();
      const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS)
        + Math.random() * 500;
      logger.warn({ err, backend, attempt: attempt + 1, delay }, 'SDK compression retry after transient error');
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

// ── Dedicated compression provider (private, NOT in global registry) ─────────

let activeProvider: TransportProvider | null = null;
let activeSessionId: string | null = null;
let activeBackend: string | null = null;

/**
 * Get or create a private provider + session for compression.
 * The provider is lazily initialized and reused across compressions.
 * If backend changes, old one is torn down and a new one created.
 */
async function getCompressionProvider(backend: string): Promise<{ provider: TransportProvider; sessionId: string }> {
  if (activeProvider && activeSessionId && activeBackend === backend) {
    return { provider: activeProvider, sessionId: activeSessionId };
  }

  // Tear down previous
  await shutdownCompressionProvider();

  // Create a PRIVATE provider instance — not in the global registry.
  const provider = await createPrivateProvider(backend);

  await provider.connect({});

  // Create a dedicated session. Use UUID format for sessionKey since some
  // providers (e.g. qwen) require UUID-formatted session IDs.
  const sessionId = await provider.createSession({
    sessionKey: randomUUID(),
    fresh: true,
    description: 'Memory compression — do NOT respond to questions, only output structured summaries.',
    systemPrompt: COMPRESSOR_SYSTEM_PROMPT,
  });

  activeProvider = provider;
  activeSessionId = sessionId;
  activeBackend = backend;

  return { provider, sessionId };
}

/** Tear down the compression provider (e.g. on daemon shutdown or backend change). */
export async function shutdownCompressionProvider(): Promise<void> {
  if (activeProvider) {
    try {
      if (activeSessionId) await activeProvider.endSession(activeSessionId);
      await activeProvider.disconnect();
    } catch { /* ignore cleanup errors */ }
    activeProvider = null;
    activeSessionId = null;
    activeBackend = null;
  }
}

/**
 * Create a standalone provider instance that is NOT registered in the global
 * provider registry. Its sessions won't appear in the user's session list.
 */
async function createPrivateProvider(backend: string): Promise<TransportProvider> {
  switch (backend) {
    case 'claude-code-sdk': {
      const { ClaudeCodeSdkProvider } = await import('../agent/providers/claude-code-sdk.js');
      return new ClaudeCodeSdkProvider();
    }
    case 'codex-sdk': {
      const { CodexSdkProvider } = await import('../agent/providers/codex-sdk.js');
      return new CodexSdkProvider();
    }
    case 'qwen': {
      const { QwenProvider } = await import('../agent/providers/qwen.js');
      return new QwenProvider();
    }
    case 'openclaw': {
      const { OpenClawProvider } = await import('../agent/providers/openclaw.js');
      return new OpenClawProvider();
    }
    default:
      throw new Error(`Unsupported compression backend: ${backend}`);
  }
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

// ── Main entry point ─────────────────────────────────────────────────────────

export async function compressWithSdk(input: CompressionInput): Promise<CompressionResult> {
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
      const result = await sendWithRetry(modelConfig.primaryContextBackend, prompt);
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
        const result = await sendWithRetry(modelConfig.backupContextBackend, prompt);
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

const COMPRESSION_TIMEOUT_MS = 60_000;

async function sendToProvider(backend: string, prompt: string): Promise<string> {
  // claude-code-sdk: use SDK query() directly — the transport provider's spawn
  // hook adds CLI flags that cause exit code 1 in one-shot compression mode.
  // SDK query() handles subprocess lifecycle and subscription auth correctly.
  if (backend === 'claude-code-sdk') {
    return sendViaSdkQuery(prompt);
  }

  // Other backends: use the transport provider's send/onComplete flow.
  const { provider, sessionId } = await getCompressionProvider(backend);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      offComplete(); offError();
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

## Active State
[Files modified, test results, current branch — only if relevant]`;

  if (previousSummary) {
    return `You are UPDATING an existing memory entry. A previous compression produced the summary below. New conversation events have occurred and need to be incorporated.

PREVIOUS SUMMARY:
${previousSummary}

NEW EVENTS TO INCORPORATE:
${serializedEvents}

Update the summary using this exact structure. PRESERVE all existing information that is still relevant. ADD new actions and outcomes. Move completed items from pending to resolved. Update active state. Remove information only if clearly obsolete.

${template}

Target ~${targetTokens} tokens. Be CONCRETE — include file paths, error messages, and specific values. Write only the summary.`;
  }

  return `Compress the following agent conversation events into a structured memory entry. The next agent session should understand what happened without re-reading the original events.

EVENTS TO COMPRESS:
${serializedEvents}

Use this exact structure:

${template}

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
    sections.push(previousSummary.trim(), '', '--- Updated ---');
  }
  if (turnPairs.length > 0) {
    const latest = turnPairs[turnPairs.length - 1];
    sections.push(`- User problem: ${truncate(latest.user, 200)}`);
    if (latest.assistant) sections.push(`- Resolution: ${truncate(latest.assistant, 300)}`);
  }
  if (decisions.length > 0) {
    sections.push(`- Key decisions: ${decisions.map((d) => truncate(d, 120)).join('; ')}`);
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
