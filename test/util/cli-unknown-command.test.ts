import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runCli(args: string[], home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    // Piped, not a terminal: the path where the logger writes daemon.log.
    const child = execFile(process.execPath, ['--import', 'tsx', resolve('src/index.ts'), ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}` });
    });
    child.stdin?.end();
  });
}

describe('imcodes with a mistyped command', () => {
  it('says the command is unknown, exits 1, and prints no crash', async () => {
    const home = await mkdtemp(join(tmpdir(), 'imcodes-cli-unknown-'));
    cleanup.push(home);
    const { code, output } = await runCli(['staus'], home);
    expect(code).toBe(1);
    expect(output).toContain("unknown command 'staus'");
    expect(output).toContain('Did you mean status?');
    // The logger's exit flush used to race its own file open.
    expect(output).not.toMatch(/sonic boom|UNHANDLED REJECTION|at .*\.js:\d+/iu);
  }, 90_000);
});
