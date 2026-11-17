import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  REMOTE_DESKTOP_TRAFFIC, RemoteDesktopTrafficCounter, addTrafficBytes,
  isTrafficCounter, isRemoteDesktopTraffic,
  type RemoteDesktopTraffic, type RemoteDesktopTrafficHistory, type RemoteDesktopTrafficRecord,
} from '../../shared/remote-desktop-traffic.js';

/** Bounded local history. Totals outlive the most recent 200 rows. No route,
 * capability, address, email or credentials are persisted. */
export class RemoteDesktopTrafficLedger {
  private total: RemoteDesktopTraffic = { bytesSent: 0, bytesReceived: 0 };
  private rows: RemoteDesktopTrafficRecord[] = [];
  private active = new Map<string, { row: RemoteDesktopTrafficRecord; counter: RemoteDesktopTrafficCounter }>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private persistenceError = false;
  private writable = true;
  constructor(private readonly path?: string, private readonly now = Date.now) {
    if (!path) return;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('invalid traffic history');
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (value.version !== 1 || !isRemoteDesktopTraffic(value.total) || !Array.isArray(value.connections)
        || value.connections.length > REMOTE_DESKTOP_TRAFFIC.HISTORY_LIMIT
        || !value.connections.every((r: RemoteDesktopTrafficRecord) => isRemoteDesktopTraffic(r)
          && typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id)
          && typeof r.label === 'string' && /^#\d{1,12}$/.test(r.label)
          && isTrafficCounter(r.connectedAt) && (r.endedAt === undefined || isTrafficCounter(r.endedAt))
          && typeof r.measured === 'boolean')) throw new Error('invalid traffic history');
      this.total = { ...value.total };
      this.rows = value.connections.map((row) => ({ ...row, endedAt: row.endedAt ?? this.now() }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve unreadable/corrupt history instead of overwriting it with zero.
        this.persistenceError = true;
        this.writable = false;
      }
    }
  }
  start(id: string, label: string, connectedAt: number): void {
    if (this.active.has(id)) return;
    const row: RemoteDesktopTrafficRecord = { id, label, connectedAt, bytesSent: 0, bytesReceived: 0, measured: false };
    this.rows.unshift(row);
    while (this.rows.length > REMOTE_DESKTOP_TRAFFIC.HISTORY_LIMIT) {
      let index = this.rows.length - 1;
      while (index >= 0 && this.rows[index]!.endedAt === undefined) index -= 1;
      if (index < 0) break; // Live routes are never evicted by other connections.
      this.rows.splice(index, 1);
    }
    this.active.set(id, { row, counter: new RemoteDesktopTrafficCounter() });
    this.schedule();
  }
  observe(id: string, traffic: RemoteDesktopTraffic, transportId = id): void {
    const entry = this.active.get(id);
    if (!entry || !isRemoteDesktopTraffic(traffic)) return;
    entry.counter.observe(transportId, traffic);
    for (const key of ['bytesSent', 'bytesReceived'] as const) {
      this.total[key] = addTrafficBytes(this.total[key], entry.counter.total[key] - entry.row[key]);
      entry.row[key] = entry.counter.total[key];
    }
    entry.row.measured = true;
    this.schedule();
  }
  end(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    entry.row.endedAt = this.now();
    this.active.delete(id);
    void this.flush();
  }
  snapshot(): RemoteDesktopTrafficHistory {
    return { total: { ...this.total }, connections: this.rows.map((r) => ({ ...r })),
      ...(this.persistenceError ? { persistenceError: true } : {}) };
  }
  private schedule(): void {
    if (!this.path || !this.writable || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1_000);
    this.timer.unref?.();
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.path || !this.writable) return;
    const path = this.path;
    const body = JSON.stringify({ version: 1, ...this.snapshot() });
    this.writing = this.writing.then(async () => {
      const temp = `${path}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, path);
        this.persistenceError = false;
      } catch { this.persistenceError = true; }
      finally { await rm(temp, { force: true }).catch(() => {}); }
    });
    await this.writing;
  }
}
