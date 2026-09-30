import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  childProcessEnvWithStateDir,
  IMCODES_HOME_ENV,
  imcodesStateDir,
  imcodesStateDirEnv,
  imcodesStateDirForHome,
  imcodesStatePath,
} from '../../src/util/imcodes-state-dir.js';
import { resolveImcodesHome } from '../../src/util/windows-daemon-lock.js';
import { resolveTaskPairsDbPath } from '../../src/daemon/task-pairs/store.js';
import { getDefaultMcpServers } from '../../src/agent/providers/getDefaultMcpServers.js';
import { buildMemoryMcpServerEnv } from '../../shared/memory-mcp-env.js';
import { getManagedSkillRoot } from '../../src/capability/managed-skill-paths.js';

const DEFAULT_STATE_DIR = join(homedir(), '.imcodes');

describe('imcodesStateDir', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to <home>/.imcodes exactly as before when IMCODES_HOME is unset', () => {
    vi.stubEnv(IMCODES_HOME_ENV, '');
    expect(imcodesStateDir()).toBe(DEFAULT_STATE_DIR);
    expect(imcodesStatePath('sessions.sqlite')).toBe(join(DEFAULT_STATE_DIR, 'sessions.sqlite'));
    expect(resolveTaskPairsDbPath({})).toBe(join(DEFAULT_STATE_DIR, 'task-pairs.sqlite'));
    expect(getManagedSkillRoot()).toBe(join(DEFAULT_STATE_DIR, 'skills', 'managed'));
    expect(childProcessEnvWithStateDir({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('is the same answer as the daemon-lock resolver for every input', () => {
    for (const value of [undefined, '', '   ', '/tmp/x', '  /tmp/y  ', 'relative/dir']) {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { [IMCODES_HOME_ENV]: value };
      expect(imcodesStateDir(env)).toBe(resolveImcodesHome({ env }));
    }
  });

  it('uses IMCODES_HOME itself as the state directory (trimmed; relative resolved against cwd; blank means default)', () => {
    expect(imcodesStateDir({ IMCODES_HOME: '/tmp/scoped-home' })).toBe(resolve('/tmp/scoped-home'));
    expect(imcodesStateDir({ IMCODES_HOME: '  /tmp/scoped-home  ' })).toBe(resolve('/tmp/scoped-home'));
    expect(imcodesStateDir({ IMCODES_HOME: 'rel/state' })).toBe(resolve('rel/state'));
    expect(imcodesStateDir({ IMCODES_HOME: '   ' })).toBe(DEFAULT_STATE_DIR);
  });

  it('reads the environment when called, never at import time', () => {
    vi.stubEnv(IMCODES_HOME_ENV, '/tmp/late-a');
    expect(imcodesStatePath('a')).toBe(join(resolve('/tmp/late-a'), 'a'));
    vi.stubEnv(IMCODES_HOME_ENV, '/tmp/late-b');
    expect(imcodesStatePath('a')).toBe(join(resolve('/tmp/late-b'), 'a'));
  });

  it('relocates the stores that thread an account-home parameter, but keeps an explicit other home as it was', () => {
    const env = { IMCODES_HOME: '/tmp/scoped-home' };
    expect(imcodesStateDirForHome(homedir(), env)).toBe(resolve('/tmp/scoped-home'));
    expect(imcodesStateDirForHome('/some/test/home', env)).toBe(join('/some/test/home', '.imcodes'));
    expect(imcodesStateDirForHome(homedir(), {})).toBe(DEFAULT_STATE_DIR);
    vi.stubEnv(IMCODES_HOME_ENV, '/tmp/scoped-home');
    expect(getManagedSkillRoot()).toBe(join(resolve('/tmp/scoped-home'), 'skills', 'managed'));
    expect(getManagedSkillRoot('/some/test/home')).toBe(join('/some/test/home', '.imcodes', 'skills', 'managed'));
  });

  it('gives agent session and MCP children the state directory only when IMCODES_HOME is set', () => {
    expect(imcodesStateDirEnv({})).toEqual({});
    expect(imcodesStateDirEnv({ IMCODES_HOME: '  ' })).toEqual({});
    expect(imcodesStateDirEnv({ IMCODES_HOME: 'rel/state' })).toEqual({ IMCODES_HOME: resolve('rel/state') });

    // The MCP server is a separate process that only receives an allowlisted env: IMCODES_HOME must be on it, resolved.
    expect(buildMemoryMcpServerEnv({}, { PATH: '/bin', IMCODES_HOME: '/tmp/scoped-home', SECRET: 'x' })).toEqual({
      PATH: '/bin',
      IMCODES_HOME: '/tmp/scoped-home',
    });
    vi.stubEnv(IMCODES_HOME_ENV, 'rel/state');
    const scoped = getDefaultMcpServers({ sessionName: 'deck_p_w1' } as never)['imcodes-memory'];
    expect(scoped?.env?.IMCODES_HOME).toBe(resolve('rel/state'));
    vi.stubEnv(IMCODES_HOME_ENV, '');
    const plain = getDefaultMcpServers({ sessionName: 'deck_p_w1' } as never)['imcodes-memory'];
    expect(plain?.env && 'IMCODES_HOME' in plain.env).toBe(false);
  });

  it('hands children the RESOLVED directory so a relative IMCODES_HOME cannot drift with the child cwd', () => {
    const child = childProcessEnvWithStateDir({ IMCODES_HOME: 'rel/state', KEEP: '1' });
    expect(child.IMCODES_HOME).toBe(resolve('rel/state'));
    expect(child.KEEP).toBe('1');
  });
});

/**
 * The two launcher scripts that must run with only node builtins carry an inline copy of the IMCODES_HOME rule. Evaluate the
 * copies themselves and require them to agree with the shared resolver.
 */
describe('standalone scripts resolve the same IMCODES_HOME', () => {
  const SCRIPTS = ['src/util/windows-launch-preflight.mjs', 'src/util/windows-upgrade-runner.mjs'];

  function inlineResolver(file: string): () => string {
    const source = readFileSync(join(__dirname, '..', '..', file), 'utf8');
    const match = /function resolveImcodesStateDir\(\) \{[\s\S]*?\n\}/.exec(source);
    if (!match) throw new Error(`${file}: resolveImcodesStateDir not found`);
    // eslint-disable-next-line no-new-func
    return new Function('process', 'homedir', 'resolve', 'join', `${match[0]}\nreturn resolveImcodesStateDir();`)
      .bind(null, process, homedir, resolve, join) as () => string;
  }

  afterEach(() => vi.unstubAllEnvs());

  for (const file of SCRIPTS) {
    it(`${file} agrees with the shared resolver`, () => {
      const run = inlineResolver(file);
      for (const value of ['/tmp/x', '  /tmp/y  ', 'relative/dir']) {
        vi.stubEnv(IMCODES_HOME_ENV, value);
        expect(run()).toBe(imcodesStateDir());
      }
      vi.stubEnv(IMCODES_HOME_ENV, '');
      expect(run()).toBe(imcodesStateDir());
    });
  }
});
