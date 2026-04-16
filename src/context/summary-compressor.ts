/**
 * SDK-based memory compression via transport providers.
 *
 * Uses the daemon's existing transport provider system to compress raw events
 * into structured summaries. The provider manages SDK lifecycle, subprocess,
 * and subscription auth — no API keys needed.
 *
 * Inspired by Hermes Agent's context_compressor.py:
 * - Iterative summary updates: new events merge into previous summary
 * - Structured output format (Goal / Resolution / Key Decisions / Active State)
 * - Primary/backup failover with automatic recovery
 */
import type { ContextModelConfig, LocalContextEvent } from '../../shared/context-types.js';
import type { TransportProvider, ProviderError } from '../agent/transport-provider.js';
import type { AgentMessage } from '../../shared/agent-message.js';
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

// ── Failure tracking for primary/backup failover ─────────────────────────────

let primaryConsecutiveFailures = 0;
let backupConsecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;
const PRIMARY_HEALTH_CHECK_INTERVAL_MS = 5 * 60_000;
let lastPrimaryAttemptAt = 0;

export function resetFailureTracking(): void {
  primaryConsecutiveFailures = 0;
  backupConsecutiveFailures = 0;
  lastPrimaryAttemptAt = 0;
}

// ── Dedicated compression provider session ───────────────────────────────────
//
// We create ONE dedicated provider instance for compression (not the user's
// agent session provider). This provider is lazily initialized on first use
// and reused across multiple compressions. If the backend changes in config,
// we tear down and recreate.

let activeCompressionProvider: TransportProvider | null = null;
let activeCompressionSessionId: string | null = null;
let activeCompressionBackend: string | null = null;

async function getCompressionProvider(backend: string): Promise<{ provider: TransportProvider; sessionId: string }> {
  // Reuse existing provider if backend matches
  if (activeCompressionProvider && activeCompressionSessionId && activeCompressionBackend === backend) {
    return { provider: activeCompressionProvider, sessionId: activeCompressionSessionId };
  }

  // Tear down previous if backend changed
  if (activeCompressionProvider) {
    try {
      if (activeCompressionSessionId) {
        await activeCompressionProvider.endSession(activeCompressionSessionId);
      }
      await activeCompressionProvider.disconnect();
    } catch { /* ignore cleanup errors */ }
    activeCompressionProvider = null;
    activeCompressionSessionId = null;
    activeCompressionBackend = null;
  }

  // Create a PRIVATE provider instance — NOT registered in the provider registry.
  // This keeps compression sessions out of the user's session list.
  const provider = await createPrivateProvider(backend);
  await provider.connect({});

  // Create a dedicated session for compression
  const sessionId = await provider.createSession({
    sessionKey: `_memory_compressor_${backend}`,
    fresh: true,
    description: 'Memory compression agent — do NOT respond to questions, only output structured summaries.',
    systemPrompt: COMPRESSOR_SYSTEM_PROMPT,
  });

  activeCompressionProvider = provider;
  activeCompressionSessionId = sessionId;
  activeCompressionBackend = backend;

  return { provider, sessionId };
}

/** Tear down the compression provider (e.g. on daemon shutdown). */
export async function shutdownCompressionProvider(): Promise<void> {
  if (activeCompressionProvider) {
    try {
      if (activeCompressionSessionId) {
        await activeCompressionProvider.endSession(activeCompressionSessionId);
      }
      await activeCompressionProvider.disconnect();
    } catch { /* ignore */ }
    activeCompressionProvider = null;
    activeCompressionSessionId = null;
    activeCompressionBackend = null;
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

/**
 * Local-only compressor that skips SDK calls.
 * Used in tests and environments without SDK/API access.
 */
export async function localOnlyCompressor(input: CompressionInput): Promise<CompressionResult> {
  return {
    summary: buildLocalFallbackSummary(input.events, input.previousSummary),
    model: 'local-fallback',
    backend: 'none',
    usedBackup: false,
    fromSdk: false,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function compressWithSdk(input: CompressionInput): Promise<CompressionResult> {
  const { events, previousSummary, modelConfig } = input;
  const targetTokens = input.targetTokens ?? 500;

  if (events.length === 0) {
    return {
      summary: previousSummary ?? 'No events to compress.',
      model: '',
      backend: '',
      usedBackup: false,
      fromSdk: false,
    };
  }

  const prompt = buildCompressionPrompt(events, previousSummary, targetTokens);
  const now = Date.now();

  // Try primary (or health-check primary if it was failing)
  const shouldTryPrimary = primaryConsecutiveFailures < MAX_CONSECUTIVE_FAILURES
    || (now - lastPrimaryAttemptAt > PRIMARY_HEALTH_CHECK_INTERVAL_MS);

  if (shouldTryPrimary) {
    lastPrimaryAttemptAt = now;
    try {
      const result = await sendToProvider(
        modelConfig.primaryContextBackend,
        prompt,
      );
      primaryConsecutiveFailures = 0;
      return {
        summary: result,
        model: modelConfig.primaryContextModel,
        backend: modelConfig.primaryContextBackend,
        usedBackup: false,
        fromSdk: true,
      };
    } catch (err) {
      primaryConsecutiveFailures++;
      logger.warn({ err, backend: modelConfig.primaryContextBackend, failures: primaryConsecutiveFailures },
        'Primary SDK compression failed');
    }
  }

  // Try backup
  if (modelConfig.backupContextBackend && modelConfig.backupContextModel) {
    try {
      const result = await sendToProvider(
        modelConfig.backupContextBackend,
        prompt,
      );
      backupConsecutiveFailures = 0;
      return {
        summary: result,
        model: modelConfig.backupContextModel,
        backend: modelConfig.backupContextBackend,
        usedBackup: true,
        fromSdk: true,
      };
    } catch (err) {
      backupConsecutiveFailures++;
      logger.warn({ err, backend: modelConfig.backupContextBackend, failures: backupConsecutiveFailures },
        'Backup SDK compression failed');
    }
  }

  // All SDK attempts failed — fall back to local extraction
  return {
    summary: buildLocalFallbackSummary(events, previousSummary),
    model: 'local-fallback',
    backend: 'none',
    usedBackup: false,
    fromSdk: false,
  };
}

// ── Provider send with completion wait ───────────────────────────────────────

const COMPRESSION_TIMEOUT_MS = 60_000;

async function sendToProvider(backend: string, prompt: string): Promise<string> {
  const { provider, sessionId } = await getCompressionProvider(backend);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      offComplete();
      offError();
      reject(new Error(`Compression timed out after ${COMPRESSION_TIMEOUT_MS}ms`));
    }, COMPRESSION_TIMEOUT_MS);

    const offComplete = provider.onComplete((sid: string, message: AgentMessage) => {
      if (sid !== sessionId) return;
      clearTimeout(timer);
      offComplete();
      offError();
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (!text) {
        reject(new Error('Provider returned empty response'));
        return;
      }
      resolve(text);
    });

    const offError = provider.onError((sid: string, error: ProviderError) => {
      if (sid !== sessionId) return;
      clearTimeout(timer);
      offComplete();
      offError();
      reject(new Error(`Provider error: ${error.code} — ${error.message}`));
    });

    // Send the compression prompt
    provider.send(sessionId, prompt).catch((err) => {
      clearTimeout(timer);
      offComplete();
      offError();
      reject(err);
    });
  });
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

// ── Local fallback (no SDK available) ────────────────────────────────────────

export function buildLocalFallbackSummary(events: LocalContextEvent[], previousSummary?: string): string {
  const turnPairs = buildTurnPairs(events);
  const decisions = events
    .filter((e) => e.eventType === 'decision' || e.eventType === 'constraint' || e.eventType === 'preference')
    .map((e) => e.content?.trim())
    .filter((v): v is string => !!v);

  const sections: string[] = [];

  if (previousSummary) {
    sections.push(previousSummary.trim());
    sections.push('');
    sections.push('--- Updated ---');
  }

  if (turnPairs.length > 0) {
    const latest = turnPairs[turnPairs.length - 1];
    sections.push(`- User problem: ${truncate(latest.user, 200)}`);
    if (latest.assistant) {
      sections.push(`- Resolution: ${truncate(latest.assistant, 300)}`);
    }
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
