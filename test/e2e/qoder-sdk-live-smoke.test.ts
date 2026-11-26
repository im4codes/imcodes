import { describe, expect, it } from 'vitest';
import {
  accessTokenFromEnv,
  query,
  type SDKMessage,
} from '@qoder-ai/qoder-agent-sdk';

import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { getDefaultMcpServers } from '../../src/agent/providers/getDefaultMcpServers.js';

const liveEnabled = process.env.IMCODES_QODER_LIVE_SMOKE === '1'
  && !!process.env.QODER_PERSONAL_ACCESS_TOKEN;

describe.skipIf(!liveEnabled)('Qoder SDK live smoke', () => {
  it('imports, authenticates, streams one response, reports MCP status, and cancels locally', async () => {
    const mcpServers = getDefaultMcpServers({
      sessionKey: 'qoder-live-smoke',
      sessionName: 'qoder_live_smoke',
      projectName: 'qoder-live',
      serverId: process.env.IMCODES_QODER_LIVE_SMOKE_SERVER_ID ?? 'qoder-live-smoke-server',
      cwd: process.cwd(),
      env: {},
    });
    const q = query({
      prompt: 'Reply with exactly: ok',
      options: {
        auth: accessTokenFromEnv(),
        cwd: process.cwd(),
        includePartialMessages: true,
        maxTurns: 1,
        strictMcpConfig: true,
        allowedMcpServerNames: [IMCODES_MEMORY_MCP_SERVER_NAME],
        mcpServers,
      },
    });

    const messages: SDKMessage[] = [];
    for await (const message of q) {
      messages.push(message);
      if (message.type === 'result') break;
    }

    expect(messages.some((message) => message.type === 'result')).toBe(true);

    const q2 = query({
      prompt: 'Wait briefly, then reply cancelled.',
      options: {
        auth: accessTokenFromEnv(),
        cwd: process.cwd(),
        includePartialMessages: true,
        maxTurns: 1,
      },
    });
    const first = q2.next();
    await q2.interrupt();
    await q2.close();
    await first.catch(() => undefined);
  }, 120_000);
});
