import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

export interface CursorHarnessOptions {
  versionOutput?: string;
  statusOutput?: string;
  createChatOutput?: string;
  versionError?: Error | null;
  statusError?: Error | null;
  createChatError?: Error | null;
}

export interface CursorSpawnRecord {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
}

export function createCursorHeadlessHarness(options: CursorHarnessOptions = {}) {
  const state = {
    versionOutput: options.versionOutput ?? 'Cursor Agent 1.0.0\n',
    statusOutput: options.statusOutput ?? 'Logged in\n',
    createChatOutput: options.createChatOutput ?? 'cursor-chat-1\n',
    versionError: options.versionError ?? null,
    statusError: options.statusError ?? null,
    createChatError: options.createChatError ?? null,
  };

  const spawned: CursorSpawnRecord[] = [];

  const execFile = vi.fn((file: string, args: string[], optsOrCb?: unknown, maybeCb?: unknown) => {
    const cb = typeof optsOrCb === 'function'
      ? optsOrCb as (err: Error | null, stdout: string, stderr: string) => void
      : maybeCb as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    if (args.includes('--version')) {
      if (state.versionError) cb?.(state.versionError, '', '');
      else cb?.(null, state.versionOutput, '');
      return {} as never;
    }
    if (args[0] === 'status') {
      if (state.statusError) {
        cb?.(state.statusError, '', '');
      } else {
        cb?.(null, state.statusOutput, '');
      }
      return {} as never;
    }
    if (args[0] === 'create-chat') {
      if (state.createChatError) {
        cb?.(state.createChatError, '', '');
      } else {
        cb?.(null, state.createChatOutput, '');
      }
      return {} as never;
    }
    cb?.(null, '', '');
    return {} as never;
  });

  const spawn = vi.fn((file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as CursorSpawnRecord['child'];
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.killed = false;
    child.kill = vi.fn((signal?: string) => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', 0, signal ?? 'SIGTERM'));
      return true;
    });
    spawned.push({ file, args, cwd: opts.cwd, env: opts.env, child });
    queueMicrotask(() => child.emit('spawn'));
    return child as never;
  });

  return {
    state,
    spawned,
    execFile,
    spawn,
    lastSpawn(): CursorSpawnRecord {
      const entry = spawned.at(-1);
      if (!entry) throw new Error('No Cursor spawn recorded');
      return entry;
    },
    async flush(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}
