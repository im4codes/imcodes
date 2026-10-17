import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(async (_command: string, _args: string[]) => ({ stdout: '', stderr: '' })),
  spawn: vi.fn(),
  writeFile: vi.fn(async () => {}),
  register: vi.fn(),
  buffers: [] as string[],
}));
vi.mock('../../src/util/exec-helper.js', () => ({
  execFileOffMain: mocks.exec,
  execFileOffMainIdempotent: mocks.exec,
}));
vi.mock('child_process', async (original) => ({
  ...await original<typeof import('child_process')>(),
  spawn: mocks.spawn,
}));
vi.mock('fs/promises', async (original) => ({
  ...await original<typeof import('fs/promises')>(),
  writeFile: mocks.writeFile,
}));
vi.mock('../../src/store/temp-file-store.js', () => ({
  registerTempFile: mocks.register,
  removeTrackedTempFile: vi.fn(),
}));
vi.stubEnv('IMCODES_MUX', 'tmux');
const { sendKeys } = await import('../../src/agent/tmux.js');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.buffers = [];
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    Object.assign(child, {
      stderr: new EventEmitter(),
      stdin: {
        write: (text: string) => { mocks.buffers.push(text); },
        end: () => { queueMicrotask(() => child.emit('close', 0)); },
      },
    });
    return child;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function deliver(text: string, verbatim = true) {
  const result = sendKeys('shell-target', text, { verbatim });
  await vi.advanceTimersByTimeAsync(250);
  await result;
  await vi.advanceTimersByTimeAsync(1500);
}

describe('shell verbatim send behavior', () => {
  it.each([
    ['short special characters', '! echo "中文 $HOME @file ; \\ literal"'],
    ['long single line', 'echo "' + 'x'.repeat(201) + '"'],
    ['buffer threshold 2000', 'x'.repeat(2000)],
    ['buffer threshold 2001', 'x'.repeat(2001)],
    ['multiline', 'printf "line 1\\n"\nprintf "中文 line 2\\n"'],
    ['very long unicode', 'echo "' + '中文'.repeat(70_000) + '"'],
  ])('actually delivers %s unchanged without a prompt file or extra Enter', async (_name, text) => {
    await deliver(text);
    const writes = mocks.exec.mock.calls.map(([, args]) => args).filter(args => args[0] === 'send-keys');
    const usesBuffer = text.length > 2000 || text.includes('\n');
    if (usesBuffer) {
      expect(mocks.buffers).toEqual([text]);
      expect(mocks.spawn).toHaveBeenCalledWith('tmux', ['load-buffer', '-b', expect.any(String), '-'], expect.any(Object));
      expect(mocks.exec).toHaveBeenCalledWith('tmux', ['paste-buffer', '-b', expect.any(String), '-p', '-d', '-t', 'shell-target']);
      expect(writes).toEqual([['send-keys', '-t', 'shell-target', 'Enter']]);
    } else {
      expect(writes).toEqual([
        ['send-keys', '-t', 'shell-target', '-l', '--', text],
        ['send-keys', '-t', 'shell-target', 'Enter'],
      ]);
      expect(mocks.spawn).not.toHaveBeenCalled();
    }
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('keeps the existing AI-agent file-reference fallback when verbatim is not requested', async () => {
    const text = 'AI instructions\n'.repeat(30);
    await deliver(text, false);
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.stringContaining('.imcodes-prompt-'), text, { encoding: 'utf-8', mode: 0o600 });
    expect(mocks.register).toHaveBeenCalled();
    expect(mocks.exec.mock.calls.some(([, args]) => args.some(arg => arg.includes('Read and execute all instructions in @')))).toBe(true);
  });
});
