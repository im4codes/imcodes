import { writeFile } from 'fs/promises';
import { join } from 'path';
import type { MemoryBackend } from './interface.js';

export async function buildMemoryMd(
  backend: MemoryBackend,
  projectName: string,
  query = 'recent work',
): Promise<string> {
  let context: import('./interface.js').MemorySearchResult[] = [];
  let results: import('./interface.js').MemorySearchResult[] = [];

  try {
    [context, results] = await Promise.all([
      backend.getProjectContext(projectName),
      backend.search(query, projectName, 10),
    ]);
  } catch {
    // Backend unavailable or errored — return empty
    return '';
  }

  const allResults = [...context, ...results];
  if (allResults.length === 0) return '';

  const lines: string[] = ['## Relevant Memory\n'];
  for (const r of allResults) {
    const ts = r.timestamp ? new Date(r.timestamp).toISOString() : '';
    lines.push(`- ${ts ? `[${ts}] ` : ''}${r.content}`);
  }
  lines.push('');

  return lines.join('\n');
}

export async function writeMemoryMd(
  backend: MemoryBackend,
  projectName: string,
  dir: string,
): Promise<void> {
  const content = await buildMemoryMd(backend, projectName);
  await writeFile(join(dir, 'MEMORY.md'), content, 'utf8');
}
