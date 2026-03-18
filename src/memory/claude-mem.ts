import type { MemoryBackend, Observation, MemorySearchResult } from './interface.js';

const BASE_URL = 'http://localhost:37777';

export class ClaudeMemBackend implements MemoryBackend {
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async addObservation(obs: Observation): Promise<void> {
    await fetch(`${BASE_URL}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: obs.content,
        project: obs.projectName,
        session: obs.sessionName,
        tags: obs.tags ?? [],
        timestamp: obs.timestamp,
      }),
    });
  }

  async search(query: string, projectName: string, limit = 5): Promise<MemorySearchResult[]> {
    const res = await fetch(`${BASE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, project: projectName, limit }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results: Array<{ content: string; score: number; timestamp: number }> };
    return data.results ?? [];
  }

  async getProjectContext(projectName: string): Promise<MemorySearchResult[]> {
    const res = await fetch(`${BASE_URL}/context/${encodeURIComponent(projectName)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { context: string };
    const context = data.context ?? '';
    if (!context) return [];
    return [{ content: context, score: 1, timestamp: Date.now() }];
  }

  async summarizeSession(sessionName: string, projectName: string, screenContent: string): Promise<void> {
    await fetch(`${BASE_URL}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionName, project: projectName, content: screenContent }),
    });
  }
}
