/**
 * Generic project-memory injection for agent session startup.
 *
 * Reads project context files (CLAUDE.md → AGENTS.md → agent.md → README.md)
 * and returns the content suitable for injecting into a new agent session file.
 * In the future this can be extended to pull from external memory systems.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { AGENT_SEND_DOCS } from './imcodes-workflow-docs.js';
import type { MemorySearchResultItem } from '../context/memory-search.js';
import { selectStartupMemoryForBootstrap } from '../context/memory-recall-client.js';
import { buildStartupProjectMemoryText } from '../../shared/memory-recall-format.js';
import { attachMemoryShortRefs } from '../context/memory-recall-refs.js';
import logger from '../util/logger.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';

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

/**
 * Read processed memory summaries relevant to this project from local context store.
 * Returns a formatted string with recent problem→solution pairs, or null if none.
 */
export async function readProcessedMemory(projectName: string): Promise<string | null> {
  const items = await readProcessedMemoryItems(projectName);
  if (items.length === 0) return null;
  return buildStartupProjectMemoryText(attachMemoryShortRefs(items));
}

export async function readProcessedMemoryItems(projectName: string): Promise<MemorySearchResultItem[]> {
  const normalizedProjectName = projectName.trim();
  if (!normalizedProjectName) return [];
  try {
    return await selectStartupMemoryForBootstrap({ scope: 'personal', projectId: normalizedProjectName });
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
  return (await buildSessionBootstrapContextWithItems(cwd, projectName)).text;
}

/** Build bootstrap text and return the exact processed-memory snapshot used in
 * that text. Startup callers must persist fingerprints from this same snapshot
 * rather than reading the store a second time and creating ghost tombstones. */
export async function buildSessionBootstrapContextWithItems(
  cwd: string,
  projectName: string,
): Promise<{ text: string; items: MemorySearchResultItem[] }> {
  const projectContext = await readProjectMemory(cwd);
  const items = await readProcessedMemoryItems(projectName);
  const processedMemory = items.length > 0 ? buildStartupProjectMemoryText(attachMemoryShortRefs(items)) : null;
  const parts: string[] = [];
  if (projectContext) parts.push(projectContext);
  if (processedMemory) parts.push(processedMemory);
  parts.push(AGENT_SEND_DOCS);
  return { text: parts.join('\n\n'), items };
}

// Pure string helper; it lives beside the docs so callers and tests do not
// have to load this module's memory/timeline/recall graph to use it.
export { appendAgentSendDocs } from './imcodes-workflow-docs.js';

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
