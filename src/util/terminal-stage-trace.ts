/**
 * Opt-in timing breadcrumbs for the terminal input/output round trip.
 *
 * The browser/server timestamps are emitted by the command handler; the
 * backend and stream stages emit the same session-scoped clock here.  Keeping
 * this behind an environment flag makes the normal terminal path allocation
 * and log free while allowing a real Windows run to attribute latency to a
 * concrete stage instead of guessing from a browser timeout.
 */
import logger from './logger.js';

export function terminalStageTrace(
  stage: string,
  sessionName: string,
  startedAt?: number,
): void {
  if (process.env.IMCODES_TERMINAL_STAGE_TRACE !== '1') return;
  const at = Date.now();
  logger.debug({
    terminalStage: stage,
    sessionName,
    at,
    ...(startedAt === undefined ? {} : { elapsedMs: at - startedAt }),
  }, 'terminal stage');
}
