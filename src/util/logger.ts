import pino from 'pino';

function hasPinoPretty(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const usePretty = process.env.NODE_ENV !== 'production' && hasPinoPretty();

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: usePretty ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

export default logger;
