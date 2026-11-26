import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'ci-npm-ci.sh');

function resolveBashExecutable(): string | null {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const BASH_BIN = resolveBashExecutable();

describe('scripts/ci-npm-ci.sh install environment contract', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-npm-ci-test-'));
    dirs.push(dir);
    return dir;
  };

  it('keeps QODER_SKIP_DOWNLOAD and CUDA skip defaults scoped inside scripts/ci-npm-ci.sh', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(source).toContain('export npm_config_onnxruntime_node_install_cuda="${npm_config_onnxruntime_node_install_cuda:-skip}"');
    expect(source).toContain('export QODER_SKIP_DOWNLOAD="${QODER_SKIP_DOWNLOAD:-1}"');
  });

  it.skipIf(!BASH_BIN)(
    'defaults QODER_SKIP_DOWNLOAD=1 and CUDA skip for npm ci, while honoring explicit caller overrides',
    async () => {
      const root = scratch();
      const binDir = join(root, 'bin');
      const workDir = join(root, 'work');
      const capturePath = join(root, 'captured.env');
      const argsPath = join(root, 'captured.args');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });

      const fakeNpm = join(binDir, 'npm');
      writeFileSync(
        fakeNpm,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'printf "%s\\n" "$@" > "$TEST_ARGS_FILE"',
          'printf "QODER_SKIP_DOWNLOAD=%s\\nCUDA=%s\\n" "${QODER_SKIP_DOWNLOAD:-}" "${npm_config_onnxruntime_node_install_cuda:-}" > "$TEST_ENV_FILE"',
        ].join('\n') + '\n',
        'utf8',
      );
      chmodSync(fakeNpm, 0o755);

      const baseEnv: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        CI_NPM_CI_MAX_ATTEMPTS: '1',
        TEST_ENV_FILE: capturePath,
        TEST_ARGS_FILE: argsPath,
      };
      delete baseEnv.QODER_SKIP_DOWNLOAD;
      delete baseEnv.npm_config_onnxruntime_node_install_cuda;

      // 1. Default CI invocation sets QODER_SKIP_DOWNLOAD=1 and CUDA skip.
      await execFileAsync(BASH_BIN!, [SCRIPT_PATH, workDir], { env: baseEnv });
      expect(readFileSync(capturePath, 'utf8')).toBe('QODER_SKIP_DOWNLOAD=1\nCUDA=skip\n');
      expect(readFileSync(argsPath, 'utf8')).toContain('ci\n');

      // 2. Explicit caller overrides are preserved verbatim.
      await execFileAsync(BASH_BIN!, [SCRIPT_PATH, workDir], {
        env: {
          ...baseEnv,
          QODER_SKIP_DOWNLOAD: '0',
          npm_config_onnxruntime_node_install_cuda: 'force',
        },
      });
      expect(readFileSync(capturePath, 'utf8')).toBe('QODER_SKIP_DOWNLOAD=0\nCUDA=force\n');
    },
  );
});
