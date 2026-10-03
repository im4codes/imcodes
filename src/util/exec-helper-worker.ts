import { execFile, type ChildProcess } from 'node:child_process';
import {
  EXEC_HELPER_MSG,
  type ExecHelperErrorInfo,
  type ExecHelperRequest,
  type ExecHelperResponse,
} from '../../shared/exec-helper-protocol.js';
import { resolveWorkerRuntime } from './worker-runtime-port.js';

const ERROR_FIELDS = ['code', 'errno', 'syscall', 'path', 'spawnargs', 'killed', 'signal', 'cmd', 'stdout', 'stderr'] as const;

export function serializeExecError(error: unknown, stdout?: string | Uint8Array, stderr?: string | Uint8Array): ExecHelperErrorInfo {
  const source = (error && typeof error === 'object' ? error : { message: String(error) }) as Record<string, unknown>;
  const info: Record<string, unknown> = {
    name: typeof source.name === 'string' ? source.name : 'Error',
    message: typeof source.message === 'string' ? source.message : String(error),
  };
  for (const field of ERROR_FIELDS) {
    if (source[field] !== undefined) info[field] = source[field];
  }
  // The callback's buffers are authoritative (node also attaches them to the error).
  if (stdout !== undefined) info.stdout = stdout;
  if (stderr !== undefined) info.stderr = stderr;
  return info as unknown as ExecHelperErrorInfo;
}

/**
 * Body of the exec helper process: run each request with the ordinary `execFile`
 * (no shell) and post back its output or its error. The helper stays tiny on
 * purpose (node builtins only) so forking from it is cheap whatever the daemon's
 * RSS is.
 */
export function runExecHelperWorker(): void {
  const { port } = resolveWorkerRuntime();
  const children = new Map<number, ChildProcess>();
  const reply = (message: ExecHelperResponse): void => {
    try {
      port.postMessage(message);
    } catch {
      /* the daemon is gone; the exit handler below reaps the children */
    }
  };

  // The helper outlives Ctrl-C / terminal hangup aimed at the daemon's process
  // group: the daemon owns its lifetime (IPC disconnect or SIGTERM).
  process.on('SIGINT', () => undefined);
  process.on('SIGHUP', () => undefined);
  const killChildren = (): void => {
    for (const child of children.values()) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    children.clear();
  };
  process.on('exit', killChildren);
  process.on('SIGTERM', () => process.exit(0));

  port.on('message', (message: ExecHelperRequest) => {
    if (message?.type !== EXEC_HELPER_MSG.EXEC) return;
    const { id, file, args, options } = message;
    try {
      const child = execFile(file, args, options as never, (error, stdout, stderr) => {
        children.delete(id);
        if (error) reply({ type: EXEC_HELPER_MSG.RESULT, id, ok: false, error: serializeExecError(error, stdout, stderr) });
        else reply({ type: EXEC_HELPER_MSG.RESULT, id, ok: true, stdout, stderr });
      });
      children.set(id, child);
    } catch (error) {
      reply({ type: EXEC_HELPER_MSG.RESULT, id, ok: false, error: serializeExecError(error) });
    }
  });

  reply({ type: EXEC_HELPER_MSG.READY, pid: process.pid });
}
