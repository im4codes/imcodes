/**
 * Generic project-memory injection for agent session startup.
 *
 * Reads project context files (CLAUDE.md → AGENTS.md → agent.md → README.md)
 * and returns the content suitable for injecting into a new agent session file.
 * In the future this can be extended to pull from external memory systems.
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'node:crypto';
import { timelineEmitter } from './timeline-emitter.js';
import { buildMemoryContextTimelinePayload } from './memory-context-timeline.js';
import { AGENT_SEND_DOCS } from './imcodes-workflow-docs.js';
import type { MemorySearchResultItem } from '../context/memory-search.js';
import { selectStartupMemoryItems } from '../context/startup-memory.js';
import { buildStartupProjectMemoryText } from '../../shared/memory-recall-format.js';
import logger from '../util/logger.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';

const GEMINI_TMP_DIR = join(homedir(), '.gemini', 'tmp');

const CONTEXT_CANDIDATES = ['CLAUDE.md', 'AGENTS.md', 'agent.md', 'README.md'];

/**
 * Read the first available project context file from the given directory.
 * Returns the content prefixed with a header, or null if none found.
 */
export async function readProjectMemory(cwd: string): Promise<string | null> {
  for (const name of CONTEXT_CANDIDATES) {
    try {
      const content = await readFile(join(cwd, name), 'utf8');
      if (content.trim()) {
        logger.debug({ cwd, file: name }, 'memory-inject: loaded project context');
        return `# Project context (${name})\n\n${content.trim()}`;
      }
    } catch (error) {
      incrementCounter('mem.startup.silent_failure', { source: 'project-doc-read' });
      warnOncePerHour('mem.startup.silent_failure.project-doc-read', { cwd, file: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return null;
}

// ── Gemini session injection ───────────────────────────────────────────────────

async function findGeminiSessionFile(sessionId: string): Promise<string | null> {
  const prefix = sessionId.slice(0, 8);
  let slugs: string[];
  try { slugs = await readdir(GEMINI_TMP_DIR); } catch { return null; }
  for (const slug of slugs) {
    const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
    let entries: string[];
    try { entries = await readdir(chatsDir); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('session-') && entry.endsWith(`-${prefix}.json`)) return join(chatsDir, entry);
    }
  }
  return null;
}

/**
 * Inject project memory directly into the Gemini session JSON file.
 * Replaces the initial 'hi' probe message with the project context so it
 * never appears as a sent message in the UI but is part of the history.
 * Retries for up to 3s to handle Gemini's async file write timing.
 */
export async function injectGeminiMemory(sessionId: string, cwd: string, projectName?: string): Promise<void> {
  const memory = await buildSessionBootstrapContext(cwd, projectName ?? '');
  // memory is always non-null now since appendAgentSendDocs guarantees content

  // Retry: Gemini writes the session file slightly after emitting 'init'
  let filePath: string | null = null;
  for (let i = 0; i < 15 && !filePath; i++) {
    filePath = await findGeminiSessionFile(sessionId).catch(() => null);
    if (!filePath) await new Promise((r) => setTimeout(r, 200));
  }
  if (!filePath) {
    logger.warn({ sessionId }, 'memory-inject: Gemini session file not found, skipping injection');
    return;
  }

  let session: any;
  try {
    session = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    logger.warn({ filePath }, 'memory-inject: failed to parse Gemini session file');
    return;
  }

  if (!Array.isArray(session.messages)) return;

  const first = session.messages[0];
  if (first?.type === 'user' && first?.content?.[0]?.text === 'hi') {
    // Replace the 'hi' probe message with project context
    first.content[0].text = memory;
  } else {
    // Prepend project context as a new historical user message
    session.messages.unshift({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'user',
      content: [{ text: memory }],
    });
  }
  session.lastUpdated = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(session, null, 2), 'utf8');
  logger.info({ sessionId, filePath }, 'memory-inject: injected project memory into Gemini session');
}

export async function injectGeminiMemoryWithTimeline(
  sessionName: string,
  sessionId: string,
  cwd: string,
  projectName?: string,
): Promise<void> {
  await injectGeminiMemory(sessionId, cwd, projectName);
  const items = await readProcessedMemoryItems(projectName ?? '');
  const payload = buildMemoryContextTimelinePayload(undefined, items, 'startup');
  if (!payload) return;
  timelineEmitter.emit(sessionName, 'memory.context', payload, { source: 'daemon', confidence: 'high' });
}

/**
 * Read processed memory summaries relevant to this project from local context store.
 * Returns a formatted string with recent problem→solution pairs, or null if none.
 */
export async function readProcessedMemory(projectName: string): Promise<string | null> {
  const items = await readProcessedMemoryItems(projectName);
  if (items.length === 0) return null;
  return buildStartupProjectMemoryText(items);
}

export async function readProcessedMemoryItems(projectName: string): Promise<MemorySearchResultItem[]> {
  const normalizedProjectName = projectName.trim();
  if (!normalizedProjectName) return [];
  try {
    return selectStartupMemoryItems({ scope: 'personal', projectId: normalizedProjectName });
  } catch (error) {
    incrementCounter('mem.startup.silent_failure', { source: 'startup-memory-select' });
    warnOncePerHour('mem.startup.silent_failure.startup-memory-select', { projectName: normalizedProjectName, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * Build full session bootstrap context: project files + processed memory + send docs.
 */
export async function buildSessionBootstrapContext(cwd: string, projectName: string): Promise<string> {
  const projectContext = await readProjectMemory(cwd);
  const processedMemory = await readProcessedMemory(projectName);
  const parts: string[] = [];
  if (projectContext) parts.push(projectContext);
  if (processedMemory) parts.push(processedMemory);
  parts.push(AGENT_SEND_DOCS);
  return parts.join('\n\n');
}

/**
 * Append inter-agent communication docs to a memory string.
 * Returns the combined memory with send docs appended.
 */
export function appendAgentSendDocs(memory: string | null): string {
  if (memory?.trim()) {
    return `${memory.trim()}\n\n${AGENT_SEND_DOCS}`;
  }
  return AGENT_SEND_DOCS;
}

// ── Codex rollout helpers ──────────────────────────────────────────────────────

/**
 * Build a Codex rollout JSONL entry injecting memory as a user message.
 * This uses the `response_item` format from real Codex rollout files.
 */
export function buildCodexMemoryEntry(memory: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: memory }],
    },
  });
}
