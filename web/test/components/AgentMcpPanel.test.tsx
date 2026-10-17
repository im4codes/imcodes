/**
 * The MCP tab: lists one machine's MCP servers (from its agents' own configs),
 * searches the official MCP Registry, and adds a server on the ticked machines.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/preact';

const NOW = Date.now();
const SERVERS = [
  { id: 'mac', name: 'mini-2', status: 'online', lastHeartbeatAt: NOW },
  { id: 'linux', name: 'vm-211', status: 'online', lastHeartbeatAt: NOW },
];
const LIST = {
  servers: [
    { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', envNames: [], headerNames: ['Authorization'], agents: ['claude-code', 'codex'] },
    { name: 'imcodes-memory', transport: 'stdio', command: 'imcodes', envNames: [], headerNames: [], agents: ['cursor'] },
  ],
  agents: [{ agent: 'claude-code', displayName: 'Claude Code' }, { agent: 'codex', displayName: 'Codex' }],
};

const listAgentMcp = vi.fn(async (_serverId: string) => LIST);
const runAgentMcp = vi.fn(async (_serverId: string, _request: unknown) => ({
  ok: true, results: [{ agent: 'claude-code', ok: true }, { agent: 'codex', ok: true }], list: LIST,
}));
const searchRegistry = vi.fn(async (_query: string) => [
  {
    id: 'com.pulsemcp/remote-filesystem', description: 'Files in a bucket', version: '0.1.2',
    npm: { identifier: 'remote-filesystem-mcp-server', version: '0.1.2', env: [
      { name: 'GCS_BUCKET', required: true, secret: false },
      { name: 'GCS_PRIVATE_KEY', required: true, secret: true },
    ] },
  },
  {
    id: 'io.github.acme/remote', description: 'Remote tools',
    remote: { transport: 'http', url: 'https://mcp.acme.dev/mcp', headers: [{ name: 'Authorization', required: true, secret: true, template: 'Bearer {api_key}' }] },
  },
]);

vi.mock('../../src/api.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  apiFetch: vi.fn(async () => ({ servers: SERVERS })),
}));
vi.mock('../../src/api/agent-mcp.js', () => ({
  listAgentMcp: (serverId: string) => listAgentMcp(serverId),
  runAgentMcp: (serverId: string, request: unknown) => runAgentMcp(serverId, request),
  searchAgentMcpRegistry: (query: string) => searchRegistry(query),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

const { AgentMcpPanel } = await import('../../src/components/AgentMcpPanel.js');
const KEY = 'sharedContext.management.agentMcp';

beforeEach(() => {
  listAgentMcp.mockClear();
  runAgentMcp.mockClear();
  searchRegistry.mockClear();
});
afterEach(() => cleanup());

async function searchAndPick(button: string) {
  fireEvent.input(screen.getByLabelText(`${KEY}.searchLabel`), { target: { value: 'files' } });
  fireEvent.click(screen.getByText(`${KEY}.search`));
  const found = await screen.findByTestId('agent-mcp-search-results');
  fireEvent.click([...found.querySelectorAll('button')].find((node) => node.textContent === `${KEY}.${button}`)!);
}

describe('AgentMcpPanel', () => {
  it('lists the machine\'s servers by name, transport, URL and the agents that have them', async () => {
    render(h(AgentMcpPanel, { serverId: 'mac' }));
    expect(await screen.findByText('github')).toBeDefined();
    const inventory = screen.getByTestId('agent-mcp-inventory');
    expect(inventory.textContent).toContain('https://api.githubcopilot.com/mcp/');
    expect(inventory.textContent).toContain('Claude Code, Codex');
    expect(inventory.textContent).toContain('Authorization');
    expect(screen.getByTestId('agent-mcp-agents').textContent).toContain('Claude Code, Codex');
  });

  it('fills the form from a registry package, requires its secrets, and adds it on the ticked machines', async () => {
    render(h(AgentMcpPanel, { serverId: 'mac' }));
    await screen.findByText('github');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'vm-211' }));
    await searchAndPick('useNpm');

    expect((screen.getByLabelText(`${KEY}.name`) as HTMLInputElement).value).toBe('remote-filesystem');
    expect((screen.getByLabelText(`${KEY}.args`) as HTMLTextAreaElement).value).toBe('-y\nremote-filesystem-mcp-server@0.1.2');
    const secret = screen.getByLabelText('GCS_PRIVATE_KEY') as HTMLInputElement;
    expect(secret.type).toBe('password');

    const install = () => screen.getByText(new RegExp(`^${KEY}\\.install:`)).closest('button')!;
    expect(install().disabled).toBe(true);
    expect(screen.getByText(new RegExp(`${KEY}.missingRequired`)).textContent).toContain('GCS_BUCKET, GCS_PRIVATE_KEY');

    fireEvent.input(screen.getByLabelText('GCS_BUCKET'), { target: { value: 'bucket-1' } });
    fireEvent.input(secret, { target: { value: 'private-key' } });
    expect(install().disabled).toBe(false);
    fireEvent.click(install());

    await waitFor(() => expect(runAgentMcp).toHaveBeenCalledTimes(2));
    for (const machine of ['mac', 'linux']) {
      expect(runAgentMcp).toHaveBeenCalledWith(machine, {
        action: 'add',
        server: {
          name: 'remote-filesystem', transport: 'stdio', command: 'npx',
          args: ['-y', 'remote-filesystem-mcp-server@0.1.2'],
          env: { GCS_BUCKET: 'bucket-1', GCS_PRIVATE_KEY: 'private-key' },
        },
      });
    }
    const results = await screen.findByTestId('agent-mcp-results');
    expect(results.textContent).toContain(`${KEY}.done`);
    expect(results.textContent).toContain('Claude Code: ✓');
  });

  it('fills a remote server with its header template so only the token is left to type', async () => {
    render(h(AgentMcpPanel, { serverId: 'mac' }));
    await screen.findByText('github');
    await searchAndPick('useRemote');
    expect((screen.getByLabelText(`${KEY}.url`) as HTMLInputElement).value).toBe('https://mcp.acme.dev/mcp');
    expect((screen.getByLabelText('Authorization') as HTMLInputElement).value).toBe('Bearer ');
  });

  it('removes a server from the machine on screen after confirmation', async () => {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    render(h(AgentMcpPanel, { serverId: 'mac' }));
    await screen.findByText('github');
    fireEvent.click(screen.getByText(`${KEY}.remove`));
    await waitFor(() => expect(runAgentMcp).toHaveBeenCalledWith('mac', { action: 'remove', name: 'github' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('says the registry is unavailable and still lets the form be filled by hand', async () => {
    searchRegistry.mockRejectedValueOnce(new Error('502'));
    render(h(AgentMcpPanel, { serverId: 'mac' }));
    await screen.findByText('github');
    fireEvent.input(screen.getByLabelText(`${KEY}.searchLabel`), { target: { value: 'x' } });
    fireEvent.click(screen.getByText(`${KEY}.search`));
    expect(await screen.findByText(`${KEY}.registryUnavailable`)).toBeDefined();
    fireEvent.input(screen.getByLabelText(`${KEY}.name`), { target: { value: 'local-tool' } });
    fireEvent.input(screen.getByLabelText(`${KEY}.args`), { target: { value: '-y\nsome-mcp' } });
    fireEvent.click(screen.getByText(new RegExp(`^${KEY}\\.install:`)).closest('button')!);
    await waitFor(() => expect(runAgentMcp).toHaveBeenCalledWith('mac', {
      action: 'add', server: { name: 'local-tool', transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp'] },
    }));
  });

  it('shows IM.codes\' own server as built in, with nothing to remove', async () => {
    render(h(AgentMcpPanel, { serverId: 'mac' }));
    const card = [...(await screen.findByTestId('agent-mcp-inventory')).querySelectorAll('article')]
      .find((article) => article.textContent?.includes('imcodes-memory'))!;
    expect(card.textContent).toContain(`${KEY}.builtIn`);
    expect(card.querySelector('button')).toBeNull();
  });
});
