import { describe, expect, it } from 'vitest';
import {
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_USER_ID_ENV,
  IMCODES_DAEMON_PROVIDER_ID_ENV,
  IMCODES_DAEMON_CAPABILITY_TOKEN_ENV,
  buildMemoryMcpServerEnv,
  isMemoryMcpAllowedEnvKey,
} from '../../shared/memory-mcp-env.js';

describe('memory MCP env allow-list', () => {
  it('builds only identity and safe passthrough env keys', () => {
    const env = buildMemoryMcpServerEnv({
      [IMCODES_DAEMON_USER_ID_ENV]: 'user-1',
      [IMCODES_DAEMON_NAMESPACE_ENV]: '{"scope":"personal","userId":"user-1","projectId":"repo"}',
      [IMCODES_DAEMON_PROVIDER_ID_ENV]: 'codex-sdk',
      [IMCODES_DAEMON_CAPABILITY_TOKEN_ENV]: 'runtime-token',
    }, {
      PATH: '/bin',
      HOME: '/tmp/home',
      NODE_OPTIONS: '--conditions=test',
      SECRET_TOKEN: 'do-not-copy',
      IMCODES_SERVER_TOKEN: 'do-not-copy',
    });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/tmp/home',
      NODE_OPTIONS: '--conditions=test',
      [IMCODES_DAEMON_USER_ID_ENV]: 'user-1',
      [IMCODES_DAEMON_NAMESPACE_ENV]: '{"scope":"personal","userId":"user-1","projectId":"repo"}',
      [IMCODES_DAEMON_PROVIDER_ID_ENV]: 'codex-sdk',
      [IMCODES_DAEMON_CAPABILITY_TOKEN_ENV]: 'runtime-token',
    });
    expect(isMemoryMcpAllowedEnvKey('SECRET_TOKEN')).toBe(false);
    expect(isMemoryMcpAllowedEnvKey(IMCODES_DAEMON_USER_ID_ENV)).toBe(true);
    expect(isMemoryMcpAllowedEnvKey(IMCODES_DAEMON_PROVIDER_ID_ENV)).toBe(true);
    expect(isMemoryMcpAllowedEnvKey(IMCODES_DAEMON_CAPABILITY_TOKEN_ENV)).toBe(true);
  });
});
