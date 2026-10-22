import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';
import {
  CLAUDE_CODE_MESSAGING_SOCKET,
  CLAUDE_CODE_MESSAGING_TOKEN,
  checkClaudeAuthUds,
  claudeAuthUdsEnv,
} from '../../src/agent/claude-auth-uds.js';

const root = '/tmp/cc-socks';
const socketPath = `${root}/imcodes-uds-${process.pid}.sock`;
let server: Server | undefined;

afterEach(async () => {
  server?.close();
  server = undefined;
  await rm(socketPath, { force: true });
});

async function listen(): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  server = createServer((socket) => { socket.on('data', () => {}); });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
}

describe('Claude auth UDS context', () => {
  it('accepts the real uds address form and preserves only the UDS env', async () => {
    await listen();
    const result = await checkClaudeAuthUds({
      [CLAUDE_CODE_MESSAGING_SOCKET]: `uds:${socketPath}`,
      [CLAUDE_CODE_MESSAGING_TOKEN]: 'token-is-inherited-not-reused-as-a-source',
      ANTHROPIC_API_KEY: 'must-not-be-projected',
    });
    expect(result.reason).toBeUndefined();
    expect(result.context?.address).toBe(`uds:${socketPath}`);
    expect(claudeAuthUdsEnv({
      [CLAUDE_CODE_MESSAGING_SOCKET]: `uds:${socketPath}`,
      [CLAUDE_CODE_MESSAGING_TOKEN]: 'token',
      ANTHROPIC_API_KEY: 'secret',
    })).toEqual({
      [CLAUDE_CODE_MESSAGING_SOCKET]: socketPath,
      [CLAUDE_CODE_MESSAGING_TOKEN]: 'token',
    });
  });

  it('rejects missing, unrelated, nested and non-socket paths', async () => {
    await expect(checkClaudeAuthUds({})).resolves.toMatchObject({
      reason: `${CLAUDE_CODE_MESSAGING_SOCKET} is not set`,
    });
    await expect(checkClaudeAuthUds({ [CLAUDE_CODE_MESSAGING_SOCKET]: '/tmp/other.sock' })).resolves.toMatchObject({
      reason: 'Claude auth UDS must match uds:/tmp/cc-socks/<name>.sock',
    });
    await expect(checkClaudeAuthUds({ [CLAUDE_CODE_MESSAGING_SOCKET]: 'uds:/tmp/cc-socks/nested/x.sock' })).resolves.toMatchObject({
      reason: 'Claude auth UDS must match uds:/tmp/cc-socks/<name>.sock',
    });
    await expect(checkClaudeAuthUds({ [CLAUDE_CODE_MESSAGING_SOCKET]: `uds:${root}/missing-${process.pid}.sock` })).resolves.toMatchObject({
      reason: expect.stringContaining('unavailable'),
    });
  });

  it('reports a stale socket handshake failure instead of authenticated', async () => {
    await listen();
    server!.close();
    server = undefined;
    const result = await checkClaudeAuthUds({
      [CLAUDE_CODE_MESSAGING_SOCKET]: socketPath,
      [CLAUDE_CODE_MESSAGING_TOKEN]: 'token',
    });
    expect(result.context).toBeUndefined();
    expect(result.reason).toMatch(/unavailable|handshake failed/);
  });
});
