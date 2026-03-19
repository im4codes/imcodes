import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, '../../package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const DAEMON_VERSION = readVersion();
