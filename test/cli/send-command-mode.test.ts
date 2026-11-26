/**
 * `imcodes send --command`: the CLI posts exactly the trimmed text to the
 * dedicated `/send-command` hook path (never `/send`), rejects invalid
 * combinations before any request, fails closed against a daemon that has no
 * command path, and documents the flag in `--help`. Command mode has NO
 * direct-tmux fallback: an unreachable hook, a timeout, any non-2xx status or an
 * unreadable answer exits non-zero naming the cause and never types anything.
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
// Short enough for a real "hook never answers" test; every ordinary response is immediate.
vi.mock('../../shared/send-command-mode.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  SEND_COMMAND_HOOK_TIMEOUT_MS: 300,
}));
vi.mock('../../src/agent/tmux.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendKeys: mocks.sendKeys,
}));

import { createProgram } from '../../src/cli.js';
import { SEND_COMMAND_CLI_FLAG, SEND_COMMAND_ERRORS, SEND_COMMAND_HOOK_PATH, SEND_COMMAND_NO_FALLBACK_NOTE } from '../../shared/send-command-mode.js';

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

  describe('no direct-tmux fallback in command mode, whatever the hook does', () => {
    const failing = async (args: string[]) => {
      const exit = exitSpy();
      await expect(run(SEND_COMMAND_CLI_FLAG, ...args)).rejects.toThrow('exit:1');
      exit.mockRestore();
      return errors.join('\n');
    };
    const neverTyped = () => expect(mocks.sendKeys).not.toHaveBeenCalled();

    it('no live daemon hook at all: exits non-zero, names the cause, types nothing', async () => {
      mocks.hookPort.current = null;
      const text = await failing(['deck_proj_w1', '/stop']);
      expect(text).toContain('no running daemon hook server was found');
      expect(text).toContain(SEND_COMMAND_NO_FALLBACK_NOTE);
      expect(seen).toEqual([]);
      neverTyped();
    });

    it('hook unreachable (connection refused): exits non-zero, names the cause, types nothing', async () => {
      const dead = createServer();
      await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
      mocks.hookPort.current = (dead.address() as AddressInfo).port;
      await new Promise<void>((resolve) => dead.close(() => resolve()));
      const text = await failing(['deck_proj_w1', '/stop']);
      expect(text).toMatch(/daemon hook server is unreachable \(ECONNREFUSED/);
      neverTyped();
    });

    it('hook that never answers: times out, exits non-zero, names the cause, types nothing', async () => {
      const hang = createServer(() => undefined); // accepts the request and never responds
      await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
      mocks.hookPort.current = (hang.address() as AddressInfo).port;
      try {
        const text = await failing(['deck_proj_w1', '/stop']);
        expect(text).toMatch(/daemon hook server timed out \(no answer within 300 ms\)/);
        neverTyped();
      } finally {
        hang.closeAllConnections();
        await new Promise<void>((resolve) => hang.close(() => resolve()));
      }
    });

    it.each([
      ['500 with a JSON error', { status: 500, body: { ok: false, error: 'dispatch exploded' } }, /rejected the command \(HTTP 500: dispatch exploded\)/],
      ['500 with no body', { status: 500 }, /rejected the command \(HTTP 500\)/],
      ['503', { status: 503 }, /HTTP 503/],
      ['403', { status: 403, body: { ok: false, error: 'forbidden' } }, /HTTP 403: forbidden/],
    ])('a %s exits non-zero with the status, types nothing', async (_name, reply, pattern) => {
      respond = () => reply;
      const text = await failing(['deck_proj_w1', '/stop']);
      expect(text).toMatch(pattern);
      expect(text).toContain(SEND_COMMAND_NO_FALLBACK_NOTE);
      expect(seen.map((entry) => entry.path)).toEqual([SEND_COMMAND_HOOK_PATH]);
      neverTyped();
    });

    it('a 200 whose body is not JSON is a failure too, not a delivery', async () => {
      server.removeAllListeners('request');
      server.on('request', (_req, res) => { res.writeHead(200); res.end('<html>not the daemon</html>'); });
      const text = await failing(['deck_proj_w1', '/stop']);
      expect(text).toMatch(/unreadable response \(HTTP 200, body is not JSON\)/);
      neverTyped();
    });

    it('a 404 (older daemon) still names the upgrade, and types nothing', async () => {
      respond = () => ({ status: 404 });
      expect(await failing(['deck_proj_w1', '/stop'])).toContain(SEND_COMMAND_ERRORS.UNSUPPORTED_DAEMON);
      neverTyped();
    });

    it('a daemon answer of ok:false is reported as before and types nothing', async () => {
      respond = () => ({ status: 200, body: { ok: false, error: 'unknown target' } });
      expect(await failing(['deck_proj_w1', '/stop'])).toContain('unknown target');
      neverTyped();
    });

    it.each([
      ['a process-agent session name', ['deck_proj_w1', '/stop']],
      ['a project:role shorthand', ['proj:w1', '/stop']],
      ['--all', ['--all', '/stop']],
      ['--type', ['--type', 'codex', '/stop']],
    ])('the same for %s, on a dead hook (also covers the ConPTY-backed sendKeys, which sits behind the same call)', async (_name, args) => {
      mocks.hookPort.current = null;
      await failing(args);
      neverTyped();
    });

    it('the text is never altered on the way to a failure: exactly the trimmed command reaches the hook', async () => {
      respond = () => ({ status: 500 });
      await failing(['deck_proj_w1', '\n  /stop  \n']);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body.message).toBe('/stop');
    });
  });

  describe('an ordinary (non-command) send keeps its direct fallback', () => {
    it('hook unavailable: types the message into the pane, with the warning', async () => {
      mocks.hookPort.current = null;
      const warnings: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((...args) => { warnings.push(args.join(' ')); });
      await run('deck_proj_w1', 'hello there');
      expect(mocks.sendKeys).toHaveBeenCalledTimes(1);
      expect(mocks.sendKeys).toHaveBeenCalledWith('deck_proj_w1', 'hello there');
      expect(warnings.join('\n')).toContain('hook server unavailable');
      expect(seen).toEqual([]);
    });

    it('hook answering with a non-JSON 500: still falls back, as before', async () => {
      server.removeAllListeners('request');
      server.on('request', (_req, res) => { res.writeHead(500); res.end('boom'); });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await run('deck_proj_w1', 'hello there');
      expect(mocks.sendKeys).toHaveBeenCalledWith('deck_proj_w1', 'hello there');
    });
  });

  it('documents the flag in --help', () => {
    const send = createProgram().commands.find((command) => command.name() === 'send')!;
    const help = send.helpInformation().replace(/\s+/g, ' ');
    expect(help).toContain(SEND_COMMAND_CLI_FLAG);
    expect(help).toMatch(/exactly the given text/);
    expect(help).toMatch(/never falls back to direct tmux input/);
    expect(help).toMatch(/ordinary send falls back to direct tmux/);
  });
});
