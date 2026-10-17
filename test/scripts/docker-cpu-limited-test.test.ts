import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/docker-cpu-limited-test.sh');
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('docker-cpu-limited-test helper', () => {
  it.skipIf(process.platform === 'win32')('has valid shell syntax and documents both bounded modes', () => {
    expect(spawnSync('bash', ['-n', script], { encoding: 'utf8' }).status).toBe(0);
    const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('prefer Docker');
    expect(help.stdout).toContain('--cpus=2');
    expect(help.stdout).toContain('--host-capped');
    expect(help.stdout).toContain('<=min(2 cores,25%)');
    expect(help.stdout).toContain('只要有docker 就可以用 如果还有不用docker 也可以限制cpu制造负载也可以');
    expect(readFileSync(resolve('shared/load-validation-safety.ts'), 'utf8')).toContain(
      '只要有docker 就可以用 如果还有不用docker 也可以限制cpu制造负载也可以',
    );
  });

  it.skipIf(process.platform === 'win32')('never silently falls through when forced Docker is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-docker-load-test-'));
    scratch.push(dir);
    const fakeDocker = join(dir, 'docker');
    writeFileSync(fakeDocker, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeDocker, 0o755);
    const result = spawnSync('bash', [script, '--docker', '--', 'true'], {
      encoding: 'utf8',
      env: { ...process.env, DOCKER_BIN: fakeDocker },
    });
    expect(result.status).toBe(69);
    expect(result.stderr).toContain('docker daemon not running');
    expect(result.stderr).toContain('--host-capped');
  });

  it('pins CPU, process, timeout, trap, and cleanup bounds without an all-core burner', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).toContain('--cpus=2 --memory=4g --pids-limit=512');
    expect(source).toContain('cap_milli=$((cores * 250))');
    expect(source).toContain('((burners > 2)) && burners=2');
    expect(source).toContain('nice -n 19 node');
    expect(source).toContain('trap cleanup EXIT');
    expect(source).toContain("trap 'exit 130' INT");
    expect(source).toContain("trap 'exit 143' TERM HUP");
    expect(source).toContain("echo 'load-validation cleanup=verified'");
    expect(source).not.toMatch(/yes\s*>/);
    expect(source).not.toMatch(/burners=.*cores/);
  });

  it.skipIf(process.platform === 'win32')('removes the named Docker container after a hard timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-docker-timeout-test-'));
    scratch.push(dir);
    const fakeDocker = join(dir, 'docker');
    const calls = join(dir, 'calls.log');
    writeFileSync(fakeDocker, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_CALLS"
case "$1" in
  info) exit 0 ;;
  run) exec sleep 30 ;;
  rm) exit 0 ;;
esac
`);
    chmodSync(fakeDocker, 0o755);

    const result = spawnSync('bash', [script, '--docker', '--timeout', '1', '--', 'true'], {
      encoding: 'utf8',
      timeout: 12_000,
      env: { ...process.env, DOCKER_BIN: fakeDocker, FAKE_DOCKER_CALLS: calls },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('load validation hard timeout after 1s');

    const invocations = readFileSync(calls, 'utf8').trim().split('\n');
    const run = invocations.find((line) => line.startsWith('run '));
    expect(run).toMatch(/^run --name imcodes-load-test-\d+-\d+ --rm /);
    const name = run?.match(/^run --name (imcodes-load-test-\d+-\d+) --rm /)?.[1];
    expect(name).toBeTruthy();
    expect(invocations).toContain(`rm -f ${name}`);
  }, 15_000);
});
