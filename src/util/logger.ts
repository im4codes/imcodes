import pino from 'pino';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'fs';

const LOG_DIR = join(homedir(), '.imcodes', 'logs');
const LOG_FILE = join(LOG_DIR, 'daemon.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_OLD_LOGS = 2;

function ensureLogDir(): void {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

/** Rotate daemon.log → daemon.1.log → daemon.2.log, delete oldest */
function rotateLogs(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const { size } = statSync(LOG_FILE);
    if (size < MAX_LOG_SIZE) return;
    for (let i = MAX_OLD_LOGS; i >= 1; i--) {
      const src = i === 1 ? LOG_FILE : join(LOG_DIR, `daemon.${i - 1}.log`);
      const dst = join(LOG_DIR, `daemon.${i}.log`);
      try { if (existsSync(src)) renameSync(src, dst); } catch { /* ignore */ }
    }
    const excess = join(LOG_DIR, `daemon.${MAX_OLD_LOGS + 1}.log`);
    try { unlinkSync(excess); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

const isForeground = process.argv.includes('--foreground') || process.argv.includes('start');

ensureLogDir();
rotateLogs();

const streams: pino.StreamEntry[] = [
  { level: 'info', stream: pino.destination({ dest: LOG_FILE, append: true, sync: false }) },
];

if (isForeground) {
  streams.push({ level: 'info', stream: process.stdout });
}

const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  pino.multistream(streams),
);

export default logger;
