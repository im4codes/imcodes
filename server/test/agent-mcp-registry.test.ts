import { describe, expect, it, vi } from 'vitest';
import { AGENT_MCP_REGISTRY } from '../../shared/agent-mcp.js';
import { createAgentMcpRegistry } from '../src/services/agent-mcp-registry.js';

const ACTIVE = { 'io.modelcontextprotocol.registry/official': { status: 'active' } };

function reply(servers: unknown[]): Response {
  return new Response(JSON.stringify({ servers, metadata: { count: servers.length } }), { status: 200 });
}

describe('MCP Registry search', () => {
  it('keeps what an install form needs and nothing it cannot use', async () => {
    const fetchImpl = vi.fn(async () => reply([
      { server: {
        name: 'io.github.acme/remote', description: 'Remote\u0007 tools', version: '1.2.0',
        repository: { url: 'https://github.com/acme/remote' },
        remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp',
          headers: [{ name: 'Authorization', isRequired: true, isSecret: true, value: 'Bearer {api_key}', description: 'Token' }] }],
      }, _meta: ACTIVE },
      { server: {
        name: 'com.pulsemcp/remote-filesystem', description: 'Files', version: '0.1.2',
        packages: [{ registryType: 'npm', identifier: 'remote-filesystem-mcp-server', version: '0.1.2', transport: { type: 'stdio' },
          environmentVariables: [{ name: 'GCS_BUCKET', isRequired: true }, { name: 'GCS_PRIVATE_KEY', isSecret: true }, { name: 'bad name' }] }],
      }, _meta: ACTIVE },
      { server: { name: 'retired/server', packages: [{ registryType: 'npm', identifier: 'x', transport: { type: 'stdio' } }] },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } },
      { server: { name: 'python/only', packages: [{ registryType: 'pypi', identifier: 'x', transport: { type: 'stdio' } }] }, _meta: ACTIVE },
      { server: { name: 'cleartext/remote', remotes: [{ type: 'sse', url: 'http://example.com/sse' }] }, _meta: ACTIVE },
      { server: { name: 'evil/npm', packages: [{ registryType: 'npm', identifier: '--global', transport: { type: 'stdio' } }] }, _meta: ACTIVE },
    ]));
    const registry = createAgentMcpRegistry({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await registry.search('files')).toEqual([
      {
        id: 'io.github.acme/remote', description: 'Remote  tools', version: '1.2.0', repositoryUrl: 'https://github.com/acme/remote',
        remote: { transport: 'http', url: 'https://mcp.acme.dev/mcp',
          headers: [{ name: 'Authorization', description: 'Token', required: true, secret: true, template: 'Bearer {api_key}' }] },
      },
      {
        id: 'com.pulsemcp/remote-filesystem', description: 'Files', version: '0.1.2',
        npm: { identifier: 'remote-filesystem-mcp-server', version: '0.1.2', env: [
          { name: 'GCS_BUCKET', required: true, secret: false },
          { name: 'GCS_PRIVATE_KEY', required: false, secret: true },
        ] },
      },
    ]);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown as [string])[0]));
    expect(`${url.origin}${url.pathname}`).toBe(AGENT_MCP_REGISTRY.SEARCH_URL);
    expect(url.searchParams.get('search')).toBe('files');
    expect(url.searchParams.get('version')).toBe('latest');
  });

  it('fails rather than returning something it does not understand', async () => {
    const registry = createAgentMcpRegistry({ fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch });
    await expect(registry.search('x')).rejects.toThrow();
  });
});
