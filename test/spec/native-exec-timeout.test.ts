import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCurrentTest } from 'vitest/suite';

import { NATIVE_COMPILE_TEST_TIMEOUT_MS } from './support/native-exec.js';
import { readSource } from '../helpers/read-source.js';

const SPEC_DIRS = ['test/spec', 'test/node', 'test/util'].map((dir) => resolve(__dirname, '..', '..', dir));

describe('native compile specs are not held to the default 20 s per-test timeout', () => {
  it('importing the native-exec helper raises the importing file\'s per-test timeout', () => {
    const current = getCurrentTest() as { timeout?: number } | undefined;
    expect(NATIVE_COMPILE_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(current?.timeout).toBe(NATIVE_COMPILE_TEST_TIMEOUT_MS);
  });

  it('every spec that compiles natively either imports the helper or sets an explicit timeout on its tests', () => {
    const offenders: string[] = [];
    for (const dir of SPEC_DIRS) {
      for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.test.ts') && entry !== 'native-exec-timeout.test.ts')) {
        const source = readSource(join(dir, name));
        const compilesNatively = /-fsanitize|(?:spawnSync|execFileSync|execFile|runNative|runNativeOrThrow)\(\s*['"`](?:xcrun|clang\+\+|clang|g\+\+|\/usr\/bin\/clang\+\+)['"`]/.test(source);
        if (!compilesNatively) continue;
        const importsHelper = /support\/native-exec/.test(source);
        const explicitTimeout = /^\s*\}, *\d[\d_]{4,}\);/m.test(source);
        if (!importsHelper && !explicitTimeout) offenders.push(`${dir.split('/').slice(-2).join('/')}/${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
