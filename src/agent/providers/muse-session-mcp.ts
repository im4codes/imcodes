import { AsyncLocalStorage } from 'node:async_hooks';
import type { Connection } from '@muse-code/sdk';
import type { SessionConfig as MuseWireConfig } from '@muse-code/sdk/dist/src/msp.js';
import type { SessionConfig } from '../transport-provider.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { IMCODES_DAEMON_SESSION_NAME_ENV } from '../../../shared/memory-mcp-env.js';
import { IMCODES_MCP_HOST_LIFETIME_ENV, SESSION_RESOURCE_LIFETIME } from '../../../shared/session-resource-lifecycle.js';
import { MUSE_SESSION_MCP_CAPABILITY, MUSE_SESSION_OPEN_METHODS } from '../../../shared/muse-mcp.js';

/**
 * Muse's current facade omits `config`, although its public MSP command
 * contract supports session-scoped MCP with the sessionMcp grant. Compose
 * that field at the public Connection seam, leaving the SDK's single event
 * pump, replay buffering and host-death handling untouched.
 */
export function createMuseSessionMcpScope(connection: Connection, grantedCapabilities: readonly string[]) {
  const context = new AsyncLocalStorage<MuseWireConfig>();
  const command: Connection['command'] = (method, params, options) => {
    const config = context.getStore();
    return connection.command(method, config && (MUSE_SESSION_OPEN_METHODS as readonly string[]).includes(method)
      ? { ...params, config } : params, options);
  };
  const scopedConnection = new Proxy(connection, {
    get(target, key) {
      if (key === 'command') return command;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    connection: scopedConnection,
    run<T>(config: SessionConfig, serverName: string, operation: () => Promise<T>): Promise<T> {
      const server = getDefaultMcpServers(config)[IMCODES_MEMORY_MCP_SERVER_NAME];
      if (!server.env[IMCODES_DAEMON_SESSION_NAME_ENV]) return operation();
      if (!grantedCapabilities.includes(MUSE_SESSION_MCP_CAPABILITY)) {
        return Promise.reject(new Error('Muse did not grant sessionMcp; managed session identity cannot be bound'));
      }
      const wireConfig: MuseWireConfig = { mcpServers: { [serverName]: {
        transport: 'stdio', command: server.command, args: server.args,
        env: { ...server.env, [IMCODES_MCP_HOST_LIFETIME_ENV]: SESSION_RESOURCE_LIFETIME.PROVIDER_HOST },
        mode: 'required',
      } } };
      return context.run(wireConfig, operation);
    },
  };
}
