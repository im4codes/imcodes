import type { MemoryBackend, Observation, MemorySearchResult } from './interface.js';

/**
 * mem0 backend using the mem0 Platform REST API (https://api.mem0.ai/v1).
 * Requires MEM0_API_KEY env var. No Python dependency.
 */
const API_BASE = 'https://api.mem0.ai/v1';

export class Mem0Backend implements MemoryBackend {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.MEM0_API_KEY ?? '';
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Token ${this.apiKey}`,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await fetch(`${API_BASE}/memories/`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], user_id: '__healthcheck', dry_run: true }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok || res.status === 400; // 400 = reachable but bad request is fine
    } catch {
      return false;
    }
  }

  async addObservation(obs: Observation): Promise<void> {
    await fetch(`${API_BASE}/memories/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        messages: [{ role: 'user', content: obs.content }],
        user_id: obs.projectName,
        metadata: {
          session: obs.sessionName,
          tags: obs.tags ?? [],
          timestamp: obs.timestamp,
        },
      }),
    });
  }

  async search(query: string, projectName: string, limit = 5): Promise<MemorySearchResult[]> {
    const res = await fetch(`${API_BASE}/memories/search/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        query,
        user_id: projectName,
        limit,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ memory: string; score?: number; metadata?: Record<string, unknown> }>;
    return (data ?? []).map((r) => ({
      content: r.memory,
      score: r.score ?? 0,
      timestamp: (r.metadata?.timestamp as number) ?? 0,
    }));
  }

  async getProjectContext(projectName: string): Promise<MemorySearchResult[]> {
    const res = await fetch(`${API_BASE}/memories/?user_id=${encodeURIComponent(projectName)}`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ memory: string }>;
    return (data ?? [])
      .slice(0, 10)
      .map((r) => ({ content: r.memory, score: 1, timestamp: Date.now() }));
  }

  async summarizeSession(sessionName: string, projectName: string, screenContent: string): Promise<void> {
    const summary = `Session ${sessionName} completed. Summary: ${screenContent.slice(0, 500)}`;
    await this.addObservation({
      sessionName,
      projectName,
      content: summary,
      timestamp: Date.now(),
      tags: ['session_summary'],
    });
  }
}
