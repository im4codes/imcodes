/**
 * hook-port — resolve the daemon hook server's local TCP port for clients.
 *
 * The daemon persists its bound port to ~/.imcodes/hook-port. Across restarts,
 * crashes, and (mis)launch races, the file can drift to point at a DEAD port
 * while the live daemon serves a different one within the bind-retry range
 * (e.g. file says 51950 but the live server is on 51947). Clients that blindly
 * trust the file then fail with ECONNREFUSED.
 *
 * resolveLiveHookPort() verifies the saved port and, if it does not answer,
 * probes the search range and heals the file — so a stale file self-corrects on
 * first use, no daemon restart required.
 *
 * Kept dependency-light (only fs/net/os/path) so the stdio MCP process and the
 * `imcodes send` CLI can import it without pulling in the daemon module graph.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import net from 'net';

/** First port the hook server tries to bind; it increments on conflict. */
export const DEFAULT_HOOK_PORT = 51913;
/** Ports scanned upward from DEFAULT_HOOK_PORT — matches the server bind-retry span. */
export const HOOK_PORT_SCAN_SPAN = 20;
export const HOOK_PORT_FILE = join(homedir(), '.imcodes', 'hook-port');

export function readSavedHookPort(): number | null {
  try {
    const raw = readFileSync(HOOK_PORT_FILE, 'utf8').trim();
    const port = parseInt(raw, 10);
    return Number.isFinite(port) && port > 1024 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

export function writeHookPort(port: number): void {
  try {
    mkdirSync(dirname(HOOK_PORT_FILE), { recursive: true });
    writeFileSync(HOOK_PORT_FILE, String(port));
  } catch {
    /* best effort — a missing/stale file just triggers a rescan next time */
  }
}

/** True when something is accepting TCP connections on 127.0.0.1:port. */
export function probeHookPort(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export interface ResolveHookPortDeps {
  readSaved?: () => number | null;
  probe?: (port: number) => Promise<boolean>;
  write?: (port: number) => void;
}

/**
 * Ports to scan for a live hook server, ascending and de-duplicated. Covers two
 * realistic cases: a fresh daemon binding near DEFAULT_HOOK_PORT, and a daemon
 * whose port drifted (the server increments upward from the saved port, and a
 * dead later instance can leave the file pointing slightly above the live one),
 * so we also sweep a neighborhood around the saved port.
 */
export function hookPortScanCandidates(saved: number | null): number[] {
  const set = new Set<number>();
  const addRange = (from: number): void => {
    for (let p = from; p < from + HOOK_PORT_SCAN_SPAN; p++) {
      if (p > 1024 && p < 65536) set.add(p);
    }
  };
  addRange(DEFAULT_HOOK_PORT);
  if (saved != null) addRange(Math.max(1025, saved - HOOK_PORT_SCAN_SPAN + 1));
  return [...set].sort((a, b) => a - b);
}

/**
 * Resolve a live hook-server port. Prefers the saved port; if it does not
 * answer, scans the candidate range and heals the file when it finds a live
 * port different from the saved one. Returns null when nothing answers (caller
 * surfaces "daemon hook server is unavailable").
 */
export async function resolveLiveHookPort(deps: ResolveHookPortDeps = {}): Promise<number | null> {
  const readSaved = deps.readSaved ?? readSavedHookPort;
  const probe = deps.probe ?? probeHookPort;
  const write = deps.write ?? writeHookPort;

  const saved = readSaved();
  if (saved != null && await probe(saved)) return saved;

  for (const port of hookPortScanCandidates(saved)) {
    if (port === saved) continue; // already probed above
    if (await probe(port)) {
      write(port);
      return port;
    }
  }
  return null;
}
