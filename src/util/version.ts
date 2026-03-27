import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './project-root.js';

function readVersion(): string {
  try {
    const raw = readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const DAEMON_VERSION = readVersion();
