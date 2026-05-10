/**
 * R3 v1b follow-up — Script runner sandbox hardening unit tests.
 *
 * Locks the env deny-list (`P2P_SCRIPT_ENV_DENYLIST`) so dynamic-loader
 * hooks can never reach the spawned script even when the workflow author
 * allowlists them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  P2P_SCRIPT_ENV_DENYLIST,
  buildScriptSpawnEnv,
} from '../../src/daemon/p2p-workflow-script-runner.js';

const SAVED_ENV: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(SAVED_ENV)) delete SAVED_ENV[key];
});

function setEnv(name: string, value: string): void {
  SAVED_ENV[name] = process.env[name];
  process.env[name] = value;
}

describe('buildScriptSpawnEnv (sandbox hardening)', () => {
  it('PATH defaults to empty string when not allowlisted', () => {
    expect(buildScriptSpawnEnv([])).toEqual({ PATH: '' });
  });

  it('copies allowlisted names from process.env when present', () => {
    setEnv('IM_TEST_ALLOWED', 'value-1');
    expect(buildScriptSpawnEnv(['IM_TEST_ALLOWED'])).toEqual({ PATH: '', IM_TEST_ALLOWED: 'value-1' });
  });

  it('omits allowlisted names that are absent from process.env', () => {
    expect(buildScriptSpawnEnv(['IM_TEST_DEFINITELY_UNSET'])).toEqual({ PATH: '' });
  });

  it.each(P2P_SCRIPT_ENV_DENYLIST)(
    'NEVER passes %s through, even when allowlisted by the workflow author',
    (denied) => {
      setEnv(denied, 'malicious-value');
      const env = buildScriptSpawnEnv([denied]);
      expect(env).not.toHaveProperty(denied);
    },
  );

  it('deny-list wins over allowlist for mixed payloads', () => {
    setEnv('LD_PRELOAD', 'evil.so');
    setEnv('IM_BENIGN', 'ok');
    const env = buildScriptSpawnEnv(['LD_PRELOAD', 'IM_BENIGN']);
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.IM_BENIGN).toBe('ok');
  });

  it('exposed deny-list is non-empty and contains the canonical loader hooks', () => {
    expect(P2P_SCRIPT_ENV_DENYLIST.length).toBeGreaterThan(0);
    expect(P2P_SCRIPT_ENV_DENYLIST).toContain('LD_PRELOAD');
    expect(P2P_SCRIPT_ENV_DENYLIST).toContain('DYLD_INSERT_LIBRARIES');
    expect(P2P_SCRIPT_ENV_DENYLIST).toContain('NODE_OPTIONS');
  });
});
