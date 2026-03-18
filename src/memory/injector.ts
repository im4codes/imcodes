import type { MemoryBackend } from './interface.js';

/**
 * Search related memories and prepend them to a prompt.
 * Returns the original prompt unchanged if no memories found or no backend.
 */
export async function injectMemoryContext(
  prompt: string,
  projectName: string,
  backend: MemoryBackend | null,
  limit = 5,
): Promise<string> {
  if (!backend) return prompt;

  const results = await backend.search(prompt, projectName, limit).catch(() => []);
  if (results.length === 0) return prompt;

  const header = '[Related past work]';
  const memories = results.map((r) => `- ${r.content}`).join('\n');
  return `${header}\n${memories}\n\n${prompt}`;
}
