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
      model: '', backend: '', usedBackup: false, fromSdk: false,
    };
  }

  const prompt = buildCompressionPrompt(events, previousSummary, targetTokens);
  const now = Date.now();

  // Try primary (or health-check if it was failing)
  const shouldTryPrimary = primaryConsecutiveFailures < MAX_CONSECUTIVE_FAILURES
    || (now - lastPrimaryAttemptAt > PRIMARY_HEALTH_CHECK_INTERVAL_MS);

  if (shouldTryPrimary) {
    lastPrimaryAttemptAt = now;
    try {
      const result = await sendToProvider(modelConfig.primaryContextBackend, prompt);
      primaryConsecutiveFailures = 0;
      return {
        summary: result, model: modelConfig.primaryContextModel,
        backend: modelConfig.primaryContextBackend, usedBackup: false, fromSdk: true,
      };
    } catch (err) {
      primaryConsecutiveFailures++;
      // Tear down failed provider so next attempt starts fresh
      await shutdownCompressionProvider();
      logger.warn({ err, backend: modelConfig.primaryContextBackend, failures: primaryConsecutiveFailures },
        'Primary SDK compression failed');
    }
  }

  // Try backup
  if (modelConfig.backupContextBackend && modelConfig.backupContextModel) {
    try {
      const result = await sendToProvider(modelConfig.backupContextBackend, prompt);
      backupConsecutiveFailures = 0;
      return {
        summary: result, model: modelConfig.backupContextModel,
        backend: modelConfig.backupContextBackend, usedBackup: true, fromSdk: true,
      };
    } catch (err) {
      backupConsecutiveFailures++;
      await shutdownCompressionProvider();
      logger.warn({ err, backend: modelConfig.backupContextBackend, failures: backupConsecutiveFailures },
        'Backup SDK compression failed');
    }
  }

  // All SDK attempts failed — local fallback
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
