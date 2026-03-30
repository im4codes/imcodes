import pino from 'pino';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'fs';

const LOG_DIR = join(homedir(), '.imcodes', 'logs');
const LOG_FILE = join(LOG_DIR, 'daemon.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_OLD_LOGS = 2;

/** Rotate daemon.log when it exceeds MAX_LOG_SIZE. */
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
    try { unlinkSync(join(LOG_DIR, `daemon.${MAX_OLD_LOGS + 1}.log`)); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function hasPinoPretty(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

// Detect if this is a daemon process (start command with --foreground, or launchd/systemd)
const isDaemon = process.argv.includes('--foreground');
// Detect if running interactively (start without --foreground, or dev mode)
const isInteractive = !isDaemon && process.stdout.isTTY;

function buildLogger(): pino.Logger {
  // Interactive CLI commands (status, bind, etc.): console only, with pino-pretty if available
  if (isInteractive) {
    const usePretty = hasPinoPretty();
    return pino({
      level: process.env.LOG_LEVEL ?? 'info',
      transport: usePretty ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    });
  }

  // Daemon mode: always write to file + console
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
  rotateLogs();

  const streams: pino.StreamEntry[] = [
    { level: 'info', stream: pino.destination({ dest: LOG_FILE, append: true, sync: false }) },
    { level: 'info', stream: process.stdout },
  ];

  return pino(
    { level: process.env.LOG_LEVEL ?? 'info' },
    pino.multistream(streams),
  );
}

const logger = buildLogger();

export default logger;
