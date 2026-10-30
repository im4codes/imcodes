import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';
import logger from '../util/logger.js';

const STORE_VERSION = 1;
const STORE_ENV = 'IMCODES_MEMORY_DAEMON_SWITCH_PATH';

interface MemoryDaemonSwitchPayload {
  version: typeof STORE_VERSION;
  enabled: boolean;
  updatedAt: number;
}

export class MemoryDisabledError extends Error {
  readonly code = 'memory_disabled';
  constructor() {
    super('Memory recording, embedding, and indexing are disabled; run `imcodes memory enable` to re-enable.');
    this.name = 'MemoryDisabledError';
  }
}

function switchPath(): string {
  return process.env[STORE_ENV]?.trim() || join(imcodesStateDir(), 'memory-daemon-switch.json');
}

function readPayload(): MemoryDaemonSwitchPayload {
  try {
    const raw = JSON.parse(readFileSync(switchPath(), 'utf8')) as Partial<MemoryDaemonSwitchPayload>;
    if (raw.version !== STORE_VERSION || typeof raw.enabled !== 'boolean') return { version: STORE_VERSION, enabled: true, updatedAt: 0 };
    return { version: STORE_VERSION, enabled: raw.enabled, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0 };
  } catch {
    return { version: STORE_VERSION, enabled: true, updatedAt: 0 };
  }
}

function writePayload(enabled: boolean): MemoryDaemonSwitchPayload {
  const next: MemoryDaemonSwitchPayload = { version: STORE_VERSION, enabled, updatedAt: Date.now() };
  const path = switchPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return next;
}

export function isMemoryDaemonEnabled(): boolean {
  return readPayload().enabled;
}

export function getMemoryDaemonSwitchStatus(): { enabled: boolean; path: string; updatedAt: number } {
  const payload = readPayload();
  return { enabled: payload.enabled, path: switchPath(), updatedAt: payload.updatedAt };
}

export function setMemoryDaemonEnabled(enabled: boolean): { enabled: boolean; path: string; updatedAt: number } {
  const payload = writePayload(enabled);
  logger.info({ enabled: payload.enabled, path: switchPath() }, 'daemon memory switch updated');
  return { enabled: payload.enabled, path: switchPath(), updatedAt: payload.updatedAt };
}

export function assertMemoryDaemonEnabled(): void {
  if (!isMemoryDaemonEnabled()) throw new MemoryDisabledError();
}
