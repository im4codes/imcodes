import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface SavedServer {
  origin: string;
  label?: string;
  addedAt: number;
}

export interface PersistedServersState {
  version: 1;
  lastOrigin: string | null;
  servers: SavedServer[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Normalize and validate a server URL strictly to its exact URL origin.
 * Allows `https:` for any host and `http:` only for loopback development hosts.
 * Rejects embedded credentials and all other schemes.
 */
export function normalizeServerOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Server URL cannot be empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid server URL: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Server URL must not include embedded credentials');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new Error('Server URL must include a hostname');
  }
  if (parsed.protocol === 'https:') {
    return parsed.origin;
  }
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname)) {
    return parsed.origin;
  }
  throw new Error(
    `Unsupported server URL scheme "${parsed.protocol}"; use https:// (or http://localhost / http://127.0.0.1 for local dev)`,
  );
}

function emptyState(): PersistedServersState {
  return { version: 1, lastOrigin: null, servers: [] };
}

function sanitizeLabel(label: string | undefined): string | undefined {
  if (typeof label !== 'string') return undefined;
  const trimmed = label.trim();
  return trimmed ? trimmed.slice(0, 80) : undefined;
}

function parsePersistedState(raw: string): PersistedServersState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!parsed || typeof parsed !== 'object') {
    return emptyState();
  }
  const obj = parsed as { lastOrigin?: unknown; servers?: unknown };
  const byOrigin = new Map<string, SavedServer>();

  if (Array.isArray(obj.servers)) {
    for (const item of obj.servers) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as { origin?: unknown; label?: unknown; addedAt?: unknown };
      if (typeof entry.origin !== 'string') continue;
      let normalized: string;
      try {
        normalized = normalizeServerOrigin(entry.origin);
      } catch {
        continue;
      }
      if (byOrigin.has(normalized)) continue;
      const label = sanitizeLabel(typeof entry.label === 'string' ? entry.label : undefined);
      const addedAt = typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt)
        ? entry.addedAt
        : Date.now();
      byOrigin.set(normalized, { origin: normalized, ...(label ? { label } : {}), addedAt });
    }
  }

  const servers = [...byOrigin.values()];
  let lastOrigin: string | null = null;
  if (typeof obj.lastOrigin === 'string') {
    try {
      const normalizedLast = normalizeServerOrigin(obj.lastOrigin);
      if (byOrigin.has(normalizedLast)) {
        lastOrigin = normalizedLast;
      }
    } catch {
      lastOrigin = null;
    }
  }
  if (lastOrigin === null && servers.length > 0) {
    lastOrigin = servers[0]!.origin;
  }

  return { version: 1, lastOrigin, servers };
}

/**
 * Atomic file-backed store for saved remote servers and exact trusted origins
 * inside Electron's `userData` directory.
 */
export class ServerStore {
  private readonly filePath: string;
  private state: PersistedServersState;

  constructor(userDataDir: string, fileName = 'servers.json') {
    this.filePath = path.join(userDataDir, fileName);
    this.state = this.loadFromDisk();
  }

  private loadFromDisk(): PersistedServersState {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      return parsePersistedState(raw);
    } catch {
      return emptyState();
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      rmSync(tmpPath, { force: true });
      throw err;
    }
  }

  list(): SavedServer[] {
    return this.state.servers.map((s) => ({ ...s }));
  }

  trustedOrigins(): Set<string> {
    return new Set(this.state.servers.map((s) => s.origin));
  }

  getLastOrigin(): string | null {
    return this.state.lastOrigin;
  }

  addServer(rawUrl: string, label?: string): SavedServer {
    const origin = normalizeServerOrigin(rawUrl);
    const cleanLabel = sanitizeLabel(label);
    const idx = this.state.servers.findIndex((s) => s.origin === origin);
    let saved: SavedServer;
    if (idx >= 0) {
      const existing = this.state.servers[idx]!;
      saved = {
        ...existing,
        ...(cleanLabel ? { label: cleanLabel } : {}),
      };
      this.state.servers[idx] = saved;
    } else {
      saved = {
        origin,
        ...(cleanLabel ? { label: cleanLabel } : {}),
        addedAt: Date.now(),
      };
      this.state.servers.push(saved);
    }
    if (!this.state.lastOrigin) {
      this.state.lastOrigin = origin;
    }
    this.persist();
    return { ...saved };
  }

  removeServer(rawOrigin: string): boolean {
    let origin: string;
    try {
      origin = normalizeServerOrigin(rawOrigin);
    } catch {
      return false;
    }
    const idx = this.state.servers.findIndex((s) => s.origin === origin);
    if (idx < 0) return false;
    this.state.servers.splice(idx, 1);
    if (this.state.lastOrigin === origin) {
      this.state.lastOrigin = this.state.servers[0]?.origin ?? null;
    }
    this.persist();
    return true;
  }

  setLastOrigin(origin: string | null): void {
    if (origin !== null) {
      const normalized = normalizeServerOrigin(origin);
      if (!this.trustedOrigins().has(normalized)) {
        throw new Error(`Untrusted origin: ${normalized}`);
      }
      this.state.lastOrigin = normalized;
    } else {
      this.state.lastOrigin = null;
    }
    this.persist();
  }
}
