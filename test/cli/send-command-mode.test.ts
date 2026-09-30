/**
 * `imcodes send --command`: the CLI posts exactly the trimmed text to the
 * dedicated `/send-command` hook path (never `/send`), rejects invalid
 * combinations before any request, fails closed against a daemon that has no
 * command path, and documents the flag in `--help`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hookPort: { current: 0 as number | null },
  sendKeys: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/hook-port.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLiveHookPort: async () => mocks.hookPort.current,
}));
vi.mock('../../src/agent/tmux.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendKeys: mocks.sendKeys,
}));

import { createProgram } from '../../src/cli.js';
import { SEND_COMMAND_CLI_FLAG, SEND_COMMAND_ERRORS, SEND_COMMAND_HOOK_PATH } from '../../shared/send-command-mode.js';

interface Seen { path: string; body: Record<string, unknown> }

describe('imcodes send --command', () => {
  let server: Server;
  let seen: Seen[];
  let respond: (path: string) => { status: number; body?: Record<string, unknown> };
  let logs: string[];
  let errors: string[];
  const previousSession = process.env.IMCODES_SESSION;

  beforeEach(async () => {
    seen = [];
    respond = () => ({ status: 200, body: { ok: true, delivered: true, target: 'deck_proj_w1', messageId: 'send_message_cli1' } });
    server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> });
        const reply = respond(req.url ?? '');
        res.writeHead(reply.status, reply.body ? { 'Content-Type': 'application/json' } : {});
        res.end(reply.body ? JSON.stringify(reply.body) : undefined);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mocks.hookPort.current = (server.address() as AddressInfo).port;
    mocks.sendKeys.mockClear();
    process.env.IMCODES_SESSION = 'deck_proj_brain';
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousSession === undefined) delete process.env.IMCODES_SESSION;
    else process.env.IMCODES_SESSION = previousSession;
  });

  const run = (...args: string[]) => createProgram().parseAsync(['node', 'imcodes', 'send', ...args]);
  const exitSpy = () => vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);

  it('posts exactly the trimmed text to the dedicated command path', async () => {
    const raw = '\n  /compact  \n';
    await run(SEND_COMMAND_CLI_FLAG, 'deck_proj_w1', raw);
    expect(seen).toEqual([{
      path: SEND_COMMAND_HOOK_PATH,
      body: { from: 'deck_proj_brain', to: 'deck_proj_w1', message: '/compact', depth: 0 },
    }]);
    expect(logs.join('\n')).toContain('deck_proj_w1');
  });

  it('keeps multi-line and non-ASCII text byte-equal, joining separate words like an ordinary send', async () => {
    await run(SEND_COMMAND_CLI_FLAG, 'deck_proj_w1', '第一行\n  second — ✓', 'tail');
    expect(Buffer.from(String(seen[0]!.body.message)).equals(Buffer.from('第一行\n  second — ✓ tail'))).toBe(true);
  });

  it('counterexample: without --command the CLI uses /send and never the command path', async () => {
    await run('deck_proj_w1', 'hello');
    expect(seen.map((entry) => entry.path)).toEqual(['/send']);
  });

  it('works with --all and --type (targets resolved by the daemon)', async () => {
    await run(SEND_COMMAND_CLI_FLAG, '--all', '/compact');
    await run(SEND_COMMAND_CLI_FLAG, '--type', 'codex', '/compact');
    expect(seen.map((entry) => [entry.path, entry.body.to, entry.body.message])).toEqual([
      [SEND_COMMAND_HOOK_PATH, '*', '/compact'],
      [SEND_COMMAND_HOOK_PATH, 'codex', '/compact'],
    ]);
  });

  it.each([
    ['--reply', ['--reply'], SEND_COMMAND_ERRORS.WITH_REPLY],
    ['--files', ['--files', 'a.ts'], SEND_COMMAND_ERRORS.WITH_FILES],
  ])('rejects --command with %s before any request', async (_name, extra, error) => {
    const exit = exitSpy();
    await expect(run(SEND_COMMAND_CLI_FLAG, ...extra, 'deck_proj_w1', '/compact')).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain(error);
    expect(seen).toEqual([]);
    exit.mockRestore();
  });

  it('rejects an empty command', async () => {
    const exit = exitSpy();
    await expect(run(SEND_COMMAND_CLI_FLAG, 'deck_proj_w1', '   ')).rejects.toThrow();
    expect(seen).toEqual([]);
    exit.mockRestore();
  });

  it('an older daemon without the command path (404) is refused, never delivered wrapped or through tmux', async () => {
    respond = () => ({ status: 404 });
    const exit = exitSpy();
    await expect(run(SEND_COMMAND_CLI_FLAG, 'deck_proj_w1', '/compact')).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain(SEND_COMMAND_ERRORS.UNSUPPORTED_DAEMON);
    expect(seen.map((entry) => entry.path)).toEqual([SEND_COMMAND_HOOK_PATH]);
    expect(mocks.sendKeys).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('documents the flag in --help', () => {
    const send = createProgram().commands.find((command) => command.name() === 'send')!;
    const help = send.helpInformation();
    expect(help).toContain(SEND_COMMAND_CLI_FLAG);
    expect(help).toMatch(/exactly the given text/);
  });
});
