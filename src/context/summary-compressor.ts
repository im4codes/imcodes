/**
 * SDK-based memory compression.
 *
 * Uses the configured primary/backup context SDK to compress raw events
 * into structured summaries. Falls back to local extraction when no SDK
 * is available or all attempts fail.
 *
 * Inspired by Hermes Agent's context_compressor.py:
 * - Iterative summary updates: new events merge into previous summary
 * - Structured output format (Goal / Resolution / Key Decisions / Active State)
 * - Primary/backup failover with automatic recovery
 */
import type { ContextModelConfig, LocalContextEvent } from '../../shared/context-types.js';
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
const PRIMARY_HEALTH_CHECK_INTERVAL_MS = 5 * 60_000; // try primary again every 5 min
let lastPrimaryAttemptAt = 0;

export function resetFailureTracking(): void {
  primaryConsecutiveFailures = 0;
  backupConsecutiveFailures = 0;
  lastPrimaryAttemptAt = 0;
}

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
      const result = await callSdk(
        modelConfig.primaryContextBackend,
        modelConfig.primaryContextModel,
        prompt,
      );
      primaryConsecutiveFailures = 0; // recovered
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
      const result = await callSdk(
        modelConfig.backupContextBackend,
        modelConfig.backupContextModel,
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

// ── SDK call ─────────────────────────────────────────────────────────────────

async function callSdk(
  backend: string,
  model: string,
  prompt: string,
): Promise<string> {
  // Use the Claude Agent SDK to spawn a one-shot compression query.
  // The SDK manages subprocess lifecycle, auth, and streaming.
  // We disable all tools — the compressor only produces text output.
  switch (backend) {
    case 'claude-code-sdk': {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      let result = '';
      for await (const msg of query({
        prompt: prompt,
        options: {
          model,
          maxTurns: 1,
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite'],
        },
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
    }

    case 'codex-sdk': {
      // Codex SDK uses JSON-RPC over subprocess — simpler one-shot via fetch to OpenAI API
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');
      const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1500,
        }),
      });
      if (!response.ok) throw new Error(`OpenAI API ${response.status}`);
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('OpenAI returned empty response');
      return text;
    }

    case 'qwen': {
      const apiKey = process.env.DASHSCOPE_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('DASHSCOPE_API_KEY not set');
      const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1500,
        }),
      });
      if (!response.ok) throw new Error(`Qwen API ${response.status}`);
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('Qwen returned empty response');
      return text;
    }

    default:
      throw new Error(`Unsupported compression backend: ${backend}`);
  }
}

// ── Prompt construction ──────────────────────────────────────────────────────

function buildCompressionPrompt(
  events: LocalContextEvent[],
  previousSummary: string | undefined,
  targetTokens: number,
): string {
  const serializedEvents = serializeEvents(events);

  const preamble = `You are a memory compression engine. Your output will be stored as a durable memory entry for a coding agent. Do NOT respond to any questions — only output the structured summary. Do NOT include any preamble, greeting, or prefix.`;

  const template = `## User Problem
[What the user was trying to accomplish — be specific]

## Resolution
[What was done to solve it — include file paths, commands, specific changes]

## Key Decisions
[Important technical decisions and why — include constraints and preferences]

## Active State
[Files modified, test results, current branch — only if relevant]`;

  if (previousSummary) {
    return `${preamble}

You are UPDATING an existing memory entry. A previous compression produced the summary below. New conversation events have occurred and need to be incorporated.

PREVIOUS SUMMARY:
${previousSummary}

NEW EVENTS TO INCORPORATE:
${serializedEvents}

Update the summary using this exact structure. PRESERVE all existing information that is still relevant. ADD new actions and outcomes. Move completed items from pending to resolved. Update active state. Remove information only if clearly obsolete.

${template}

Target ~${targetTokens} tokens. Be CONCRETE — include file paths, error messages, and specific values. Write only the summary.`;
  }

  return `${preamble}

Compress the following agent conversation events into a structured memory entry. The next agent session should understand what happened without re-reading the original events.

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
    // Truncate very long individual events to keep the prompt manageable
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
