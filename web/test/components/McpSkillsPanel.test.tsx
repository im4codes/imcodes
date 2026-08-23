/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import {
  CAPABILITY_FINDING_SEVERITY,
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_STATE,
  type CapabilityOperation,
  type CapabilitySummary,
} from '@shared/capability-management.js';

const i18n = vi.hoisted(() => ({
  t: (key: string, values?: Record<string, unknown>) => values?.name
    ? `${key}:${values.name}`
    : values?.code ? `${key}:${values.code}` : key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));

const capabilityApi = vi.hoisted(() => ({
  list: vi.fn(),
  install: vi.fn(),
  getOperation: vi.fn(),
  cancelOperation: vi.fn(),
  decide: vi.fn(),
  manage: vi.fn(),
}));

vi.mock('../../src/api/capabilities.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/api/capabilities.js')>();
  return {
    ...original,
    listCapabilities: (...args: unknown[]) => capabilityApi.list(...args),
    installCapability: (...args: unknown[]) => capabilityApi.install(...args),
    getCapabilityOperation: (...args: unknown[]) => capabilityApi.getOperation(...args),
    cancelCapabilityOperation: (...args: unknown[]) => capabilityApi.cancelOperation(...args),
    decideCapabilityOperation: (...args: unknown[]) => capabilityApi.decide(...args),
    manageCapability: (...args: unknown[]) => capabilityApi.manage(...args),
  };
});

import { CapabilityOperationCard } from '../../src/components/CapabilityOperationCard.js';
import { CapabilityRequestError } from '../../src/api/capabilities.js';
import { McpSkillsPanel } from '../../src/components/McpSkillsPanel.js';
import { resetCapabilityOperationStoreForTests } from '../../src/capability-operation-store.js';

const summary: CapabilitySummary = {
  id: 'cap-1',
  revision: 1,
  kind: CAPABILITY_KIND.SKILL,
  name: 'Review helper',
  state: CAPABILITY_STATE.ACTIVE,
  scope: CAPABILITY_SCOPE.ACCOUNT,
  version: 3,
  sourceLabel: 'github.com/example/review-helper',
  readiness: CAPABILITY_READINESS.READY,
  findings: [],
  tools: ['repo_read'],
  permissions: ['read repository'],
  bindings: [{
    id: 'binding-account',
    scope: CAPABILITY_SCOPE.ACCOUNT,
    providers: ['codex'],
    machines: ['server-1'],
    active: true,
  }],
  hasScripts: true,
  hasExecutables: false,
  updatedAt: 1,
};

const operation: CapabilityOperation = {
  id: 'op-1',
  capabilityId: 'cap-1',
  kind: CAPABILITY_KIND.MCP,
  state: 'awaiting_confirmation',
  revision: 2,
  displayName: 'Local MCP',
  scope: CAPABILITY_SCOPE.LOCAL,
  artifactDigest: 'artifact',
  auditDigest: 'audit',
  findings: [{
    code: 'shell-risk', severity: CAPABILITY_FINDING_SEVERITY.HIGH, message: 'Runs a local command', source: 'auditor', blocking: false,
  }],
  providers: ['codex'],
  machines: ['machine-1'],
  hasScripts: false,
  hasExecutables: true,
  stdioCommand: ['node', 'server.js'],
  createdAt: 1,
  updatedAt: 2,
};

describe('McpSkillsPanel', () => {
  beforeEach(() => {
    for (const mock of Object.values(capabilityApi)) mock.mockReset();
    resetCapabilityOperationStoreForTests();
    localStorage.clear();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    capabilityApi.list.mockResolvedValue({ items: [summary] });
  });

  afterEach(cleanup);

  it('renders one searchable inventory and derives safe management actions', async () => {
    render(<McpSkillsPanel serverId="server-1" canAskAi />);
    expect(await screen.findByText('Review helper')).toBeDefined();
    expect(screen.getByText('repo_read')).toBeDefined();
    expect(screen.getByText('capabilities.action.disable')).toBeDefined();
    expect(screen.getByText('capabilities.action.uninstall')).toBeDefined();
    fireEvent.input(screen.getByLabelText('capabilities.searchLabel'), { target: { value: 'missing' } });
    expect(await screen.findByText('capabilities.noMatches')).toBeDefined();
  });

  it('makes Ask AI primary and hands the source to the active composer callback', async () => {
    const onAskAi = vi.fn();
    render(<McpSkillsPanel canAskAi onAskAi={onAskAi} />);
    await screen.findByText('Review helper');
    fireEvent.input(screen.getByPlaceholderText('capabilities.askAiPlaceholder'), { target: { value: 'https://example.test/skill' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.askAiAction' }));
    expect(onAskAi).toHaveBeenCalledWith('https://example.test/skill');
    expect(capabilityApi.install).not.toHaveBeenCalled();
  });

  it('uses the same install endpoint for the simple manual fallback', async () => {
    capabilityApi.install.mockResolvedValue(operation);
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), { target: { value: 'https://example.test/skill.zip' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    await waitFor(() => expect(capabilityApi.install).toHaveBeenCalledOnce());
    expect(capabilityApi.install.mock.calls[0]?.[0]).toMatchObject({
      serverId: 'server-1',
      request: { kind: CAPABILITY_KIND.SKILL, scope: CAPABILITY_SCOPE.ACCOUNT, source: { kind: 'url' } },
    });
    expect(await screen.findByText('capabilities.operationTitle')).toBeDefined();
  });

  it('surfaces a bounded content-safe quota response instead of generic success', async () => {
    capabilityApi.install.mockRejectedValue(new CapabilityRequestError({
      status: 429,
      reason: CAPABILITY_ERROR.RATE_LIMITED,
      safeMessage: 'Capability quota reached',
      retryable: true,
    }));
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), { target: { value: 'https://example.test/skill.zip' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Capability quota reached');
    expect(screen.queryByText('capabilities.operationTitle')).toBeNull();
  });

  it('requires a selected online machine before a manual install can start', async () => {
    render(<McpSkillsPanel />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    expect(screen.getByRole('alert').textContent).toContain('capabilities.manualNeedsServer');
    const install = screen.getByRole('button', { name: 'capabilities.scanAndReview' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    expect(capabilityApi.install).not.toHaveBeenCalled();
  });

  it('normalizes JSON MCP input and fails closed on malformed config', async () => {
    capabilityApi.install.mockResolvedValue(operation);
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    const kind = screen.getByLabelText('capabilities.kindLabel') as HTMLSelectElement;
    fireEvent.input(kind, { target: { value: CAPABILITY_KIND.MCP } });
    expect(kind.value).toBe(CAPABILITY_KIND.MCP);
    const source = screen.getByPlaceholderText('capabilities.manualSourcePlaceholder');
    fireEvent.input(source, { target: { value: '{not-json' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    expect(await screen.findByText('capabilities.mcpConfigInvalid')).toBeDefined();
    expect(capabilityApi.install).not.toHaveBeenCalled();

    fireEvent.input(source, { target: { value: '{"url":"https://mcp.example.test"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    await waitFor(() => expect(capabilityApi.install).toHaveBeenCalledOnce());
    expect(capabilityApi.install.mock.calls[0]?.[0]).toMatchObject({
      request: { kind: CAPABILITY_KIND.MCP, source: { kind: 'mcp_config', mcpConfig: expect.objectContaining({ url: 'https://mcp.example.test/' }) } },
    });
  });

  it('imports Codex TOML through the same non-executing install API', async () => {
    capabilityApi.install.mockResolvedValue(operation);
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByLabelText('capabilities.kindLabel'), { target: { value: CAPABILITY_KIND.MCP } });
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), {
      target: { value: '[mcp_servers.review]\ncommand = "npx"\nargs = ["-y", "review-mcp"]' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    await waitFor(() => expect(capabilityApi.install).toHaveBeenCalledOnce());
    expect(capabilityApi.install.mock.calls[0]?.[0]).toMatchObject({
      request: {
        source: {
          kind: 'mcp_config',
          mcpConfig: { name: 'review', transport: 'stdio', command: 'npx', args: ['-y', 'review-mcp'] },
        },
      },
    });
  });

  it('reads a bounded JSONC file and does not persist its raw text', async () => {
    capabilityApi.install.mockResolvedValue(operation);
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByLabelText('capabilities.kindLabel'), { target: { value: CAPABILITY_KIND.MCP } });
    const content = '{"name":"docs", // comment\n"url":"https://mcp.example.test",}';
    const file = new File([content], 'mcp.jsonc', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(content) });
    const fileInput = screen.getByLabelText('capabilities.importFileLabel') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.input(fileInput);
    await waitFor(() => expect((screen.getByPlaceholderText('capabilities.manualSourcePlaceholder') as HTMLTextAreaElement).value).toBe(content));
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    await waitFor(() => expect(capabilityApi.install).toHaveBeenCalledOnce());
    expect(JSON.stringify(capabilityApi.install.mock.calls[0]?.[0])).not.toContain(content);
    expect(capabilityApi.install.mock.calls[0]?.[0]).toMatchObject({
      request: { userIntent: 'capabilities.manualInstallIntent' },
    });
  });

  it('keeps every valid batch import operation visible and reports invalid entries', async () => {
    capabilityApi.install
      .mockResolvedValueOnce({ ...operation, id: 'op-docs', displayName: 'Docs', updatedAt: 3 })
      .mockResolvedValueOnce({ ...operation, id: 'op-review', displayName: 'Review', updatedAt: 4 });
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByLabelText('capabilities.kindLabel'), { target: { value: CAPABILITY_KIND.MCP } });
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), { target: { value: JSON.stringify({
      mcpServers: {
        docs: { url: 'https://docs.example.test' },
        review: { command: 'node', args: ['review.js'] },
        unsafe: { command: 'node', args: ['--api-key=sk-live-abcdefghijklmnop'] },
      },
    }) } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    await waitFor(() => expect(capabilityApi.install).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Docs')).toBeDefined();
    expect(screen.getByText('Review')).toBeDefined();
    expect(screen.getByText('capabilities.importPartial')).toBeDefined();
  });

  it('runs batch imports with bounded concurrency and independent partial results', async () => {
    let active = 0;
    let peak = 0;
    capabilityApi.install.mockImplementation(async ({ request }: { request: { source: { mcpConfig: { name: string } } } }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (request.source.mcpConfig.name === 'server-2') throw new Error('bounded failure');
      return { ...operation, id: `op-${request.source.mcpConfig.name}`, displayName: request.source.mcpConfig.name };
    });
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByLabelText('capabilities.kindLabel'), { target: { value: CAPABILITY_KIND.MCP } });
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), { target: { value: JSON.stringify({
      mcpServers: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [
        `server-${index}`,
        { url: `https://mcp-${index}.example.test` },
      ])),
    }) } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    await waitFor(() => expect(capabilityApi.install).toHaveBeenCalledTimes(7));
    await waitFor(() => expect(screen.getByText('capabilities.importPartial')).toBeDefined());
    expect(peak).toBeLessThanOrEqual(CAPABILITY_LIMITS.INSTALL_BATCH_CONCURRENCY);
    expect(screen.getByText('server-0')).toBeDefined();
    expect(screen.getByText('server-6')).toBeDefined();
  });

  it('rejects an MCP batch above the shared entry limit before any request', async () => {
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByLabelText('capabilities.kindLabel'), { target: { value: CAPABILITY_KIND.MCP } });
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), { target: { value: JSON.stringify({
      mcpServers: Object.fromEntries(Array.from(
        { length: CAPABILITY_LIMITS.MCP_IMPORT_ENTRIES + 1 },
        (_, index) => [`server-${index}`, { url: `https://mcp-${index}.example.test` }],
      )),
    }) } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    expect(await screen.findByText('capabilities.importTooLarge')).toBeDefined();
    expect(capabilityApi.install).not.toHaveBeenCalled();
  });

  it('fails closed on plain Skill text and recognizes a GitHub repository', async () => {
    capabilityApi.install.mockResolvedValue(operation);
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    const source = screen.getByPlaceholderText('capabilities.manualSourcePlaceholder');
    fireEvent.input(source, { target: { value: 'install this skill please' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    expect(await screen.findByText('capabilities.skillSourceInvalid')).toBeDefined();
    expect(capabilityApi.install).not.toHaveBeenCalled();

    fireEvent.input(source, { target: { value: 'https://github.com/example/review-helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    await waitFor(() => expect(capabilityApi.install).toHaveBeenCalledOnce());
    expect(capabilityApi.install.mock.calls[0]?.[0]).toMatchObject({
      request: { source: { kind: 'repository', value: 'https://github.com/example/review-helper' } },
    });
  });

  it.each([
    'git@github.com:example/review-helper.git',
    'ssh://git@github.com/example/review-helper.git',
  ])('rejects a remote Skill repository that is not credential-free HTTPS: %s', async (remote) => {
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), { target: { value: remote } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    expect(await screen.findByText('capabilities.skillSourceInvalid')).toBeDefined();
    expect(capabilityApi.install).not.toHaveBeenCalled();
  });

  it.each([
    [CAPABILITY_KIND.MCP, 'https://mcp.example.test/connect?key=temporary'],
    [CAPABILITY_KIND.MCP, 'https://mcp.example.test/connect?signature=temporary'],
    [CAPABILITY_KIND.SKILL, 'https://example.test/skill.zip?X-Amz-Signature=temporary'],
  ] as const)('keeps credential-shaped %s URLs out of the generic install request', async (kind, sourceValue) => {
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.showManual' }));
    fireEvent.input(screen.getByLabelText('capabilities.kindLabel'), { target: { value: kind } });
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), { target: { value: sourceValue } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanAndReview' }));
    expect(await screen.findByText(kind === CAPABILITY_KIND.MCP
      ? 'capabilities.mcpConfigInvalid'
      : 'capabilities.skillSourceInvalid')).toBeDefined();
    expect(capabilityApi.install).not.toHaveBeenCalled();
  });

  it('uninstalls immediately from the explicit action and explains credential retention', async () => {
    capabilityApi.list.mockResolvedValue({ items: [{ ...summary, kind: CAPABILITY_KIND.MCP, credentialsRetained: true }] });
    capabilityApi.manage.mockResolvedValue({ ...summary, state: CAPABILITY_STATE.TOMBSTONED });
    render(<McpSkillsPanel />);
    await screen.findByText('Review helper');
    expect(screen.getByText('capabilities.credentialsRetained')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.action.uninstall' }));
    await waitFor(() => expect(capabilityApi.manage).toHaveBeenCalledWith(
      'cap-1',
      expect.objectContaining({
        action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
        bindingId: 'binding-account',
        scope: CAPABILITY_SCOPE.ACCOUNT,
        expectedRevision: summary.revision,
      }),
      undefined,
    ));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks once for an exact binding and sends that binding as sole authority', async () => {
    const multiBinding = {
      ...summary,
      bindings: [
        ...summary.bindings!,
        { id: 'binding-local', scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-2', providers: ['pi'], machines: ['server-2'], active: true },
      ],
    };
    capabilityApi.list.mockResolvedValue({ items: [multiBinding] });
    capabilityApi.manage.mockResolvedValue({ ...multiBinding, state: CAPABILITY_STATE.DISABLED });
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.action.disable' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.input(screen.getByLabelText('capabilities.chooseBinding'), { target: { value: 'binding-local' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'capabilities.action.disable' }));
    await waitFor(() => expect(capabilityApi.manage).toHaveBeenCalledWith(
      'cap-1',
      expect.objectContaining({ bindingId: 'binding-local', scope: CAPABILITY_SCOPE.LOCAL }),
      'server-1',
    ));
  });

  it('keeps a local exact-binding action pending until the daemon-backed response arrives', async () => {
    const local = {
      ...summary,
      scope: CAPABILITY_SCOPE.LOCAL,
      bindings: [{
        id: 'binding-local', scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-1', providers: ['codex'], machines: ['server-1'], active: true,
      }],
    };
    let resolveManage!: (value: CapabilitySummary) => void;
    capabilityApi.list.mockResolvedValue({ items: [local] });
    capabilityApi.manage.mockReturnValue(new Promise((resolve) => { resolveManage = resolve; }));
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.action.disable' }));
    expect((await screen.findByRole('status')).textContent).toContain('capabilities.working');
    expect(screen.getByText('capabilities.state.active')).toBeDefined();
    resolveManage({ ...local, state: CAPABILITY_STATE.DISABLED, revision: 2 });
    await waitFor(() => expect(screen.getByText('capabilities.state.disabled')).toBeDefined());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reconciles a typed local runtime-pending response instead of claiming success', async () => {
    const local = {
      ...summary,
      scope: CAPABILITY_SCOPE.LOCAL,
      bindings: [{
        id: 'binding-local', scope: CAPABILITY_SCOPE.LOCAL, scopeId: 'server-1', providers: ['codex'], machines: ['server-1'], active: true,
      }],
    };
    const pending = { ...local, state: CAPABILITY_STATE.RUNTIME_PENDING, readiness: CAPABILITY_READINESS.RUNTIME_PENDING };
    capabilityApi.list.mockResolvedValueOnce({ items: [local] }).mockResolvedValueOnce({ items: [pending] });
    capabilityApi.manage.mockRejectedValue(new CapabilityRequestError({
      status: 503,
      reason: CAPABILITY_ERROR.RUNTIME_PENDING,
      safeMessage: 'runtime_pending',
      retryable: true,
      requestId: 'manage-request-1',
    }));
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.action.disable' }));
    expect(await screen.findByText('capabilities.state.runtime_pending')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('runtime_pending');
    const pendingStatus = screen.getByRole('status');
    expect(pendingStatus.textContent).toContain('capabilities.readiness.runtime_pending');
    expect(within(pendingStatus).getByRole('button', { name: 'capabilities.retry' })).toBeDefined();
    expect(screen.queryByText('capabilities.state.disabled')).toBeNull();
  });

  it('ignores a replayed same-revision manage response instead of flipping lifecycle state', async () => {
    capabilityApi.manage.mockResolvedValue({ ...summary, state: CAPABILITY_STATE.DISABLED });
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.action.disable' }));
    await waitFor(() => expect(capabilityApi.manage).toHaveBeenCalledOnce());
    expect(screen.getByText('capabilities.state.active')).toBeDefined();
    expect(screen.queryByText('capabilities.state.disabled')).toBeNull();
  });

  it('shows an expired candidate as failed while preserving the old active capability', async () => {
    capabilityApi.list.mockResolvedValue({
      items: [summary],
      operations: [{ ...operation, state: 'failed', revision: 8, errorCode: CAPABILITY_ERROR.CONFLICT }],
    });
    render(<McpSkillsPanel serverId="server-1" />);
    expect(await screen.findByText('capabilities.state.failed')).toBeDefined();
    expect(screen.getByText('capabilities.state.active')).toBeDefined();
    expect(screen.getByText('capabilities.operationError:conflict')).toBeDefined();
  });

  it('updates an exact project/session binding using only user-provided content', async () => {
    const multiBinding = {
      ...summary,
      bindings: [
        { id: 'binding-project', scope: CAPABILITY_SCOPE.PROJECT, scopeId: 'project-1', providers: ['codex'], machines: ['server-1'], active: true },
        { id: 'binding-session', scope: CAPABILITY_SCOPE.SESSION, scopeId: 'session-1', providers: ['pi'], machines: ['server-2'], active: true },
      ],
    };
    capabilityApi.list.mockResolvedValue({ items: [multiBinding] });
    capabilityApi.install.mockResolvedValue({ ...operation, kind: CAPABILITY_KIND.SKILL });
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.action.update' }));
    fireEvent.input(screen.getByLabelText('capabilities.chooseBinding'), { target: { value: 'binding-session' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.continueUpdate' }));
    fireEvent.input(screen.getByPlaceholderText('capabilities.manualSourcePlaceholder'), { target: { value: 'https://example.test/review-v4.zip' } });
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.scanUpdateAndReview' }));
    await waitFor(() => expect(capabilityApi.install).toHaveBeenCalledOnce());
    expect(capabilityApi.install.mock.calls[0]?.[0]).toMatchObject({
      request: {
        capabilityId: 'cap-1',
        kind: CAPABILITY_KIND.SKILL,
        scope: CAPABILITY_SCOPE.SESSION,
        scopeId: 'session-1',
        providers: ['pi'],
        machines: ['server-2'],
        source: { kind: 'url', value: 'https://example.test/review-v4.zip' },
      },
    });
  });

  it('traps focus in the rollback version picker, closes with Escape, and restores the trigger', async () => {
    capabilityApi.list.mockResolvedValue({ items: [{ ...summary, availableVersions: [{ id: 'version-2', label: '2' }] }] });
    render(<McpSkillsPanel />);
    await screen.findByText('Review helper');
    const trigger = screen.getByRole('button', { name: 'capabilities.action.rollback' }) as HTMLButtonElement;
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    const version = dialog.querySelector('select') as HTMLSelectElement;
    const cancel = screen.getByRole('button', { name: 'common.cancel' }) as HTMLButtonElement;
    await waitFor(() => expect(document.activeElement).toBe(version));
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(version);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(capabilityApi.manage).not.toHaveBeenCalled();
  });

  it.each([
    [CAPABILITY_STATE.DEGRADED, CAPABILITY_READINESS.PROVIDER_UNSUPPORTED],
    [CAPABILITY_STATE.RUNTIME_PENDING, CAPABILITY_READINESS.RUNTIME_PENDING],
  ])('renders truthful %s inventory readiness without presenting it as active', async (state, readiness) => {
    capabilityApi.list.mockResolvedValue({ items: [{ ...summary, state, readiness }] });
    render(<McpSkillsPanel />);
    await screen.findByText('Review helper');
    expect(screen.getByText(`capabilities.state.${state}`)).toBeDefined();
    expect(screen.getByText(`capabilities.readiness.${readiness}`)).toBeDefined();
    expect(screen.queryByText('capabilities.state.active')).toBeNull();
  });

  it('keeps the inventory visible and reports a management conflict safely', async () => {
    capabilityApi.manage.mockRejectedValue(new Error('conflict'));
    render(<McpSkillsPanel />);
    await screen.findByText('Review helper');
    fireEvent.click(screen.getByRole('button', { name: 'capabilities.action.disable' }));
    expect(await screen.findByText('capabilities.manageError')).toBeDefined();
    expect(screen.getByText('Review helper')).toBeDefined();
  });

  it.each(['queued', 'auditing'] as const)('cancels a %s install through the operation cancellation endpoint', async (state) => {
    const activeOperation = { ...operation, state, artifactDigest: undefined, auditDigest: undefined };
    capabilityApi.list.mockResolvedValue({ items: [summary], operations: [activeOperation] });
    capabilityApi.cancelOperation.mockResolvedValue({ ...activeOperation, state: 'cancelled', terminal: true });
    render(<McpSkillsPanel serverId="server-1" />);
    await screen.findByText('capabilities.operationTitle');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(capabilityApi.cancelOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'op-1', revision: operation.revision, state }),
      'server-1',
    ));
    expect(capabilityApi.decide).not.toHaveBeenCalled();
  });
});

describe('CapabilityOperationCard', () => {
  afterEach(cleanup);

  it('keeps stdio/executable and high findings prominent on the single confirmation card', () => {
    render(<CapabilityOperationCard operation={{
      ...operation,
      sourceLabel: 'local-mcp.json',
      artifactDigest: 'sha256:authoritative-artifact',
      tools: ['review'],
      permissions: ['repository read'],
      updateDiff: ['Added review tool'],
    }} onInstall={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('capabilities.warning.executables')).toBeDefined();
    expect(screen.getByText('capabilities.warning.stdio')).toBeDefined();
    expect(screen.getByText('node server.js')).toBeDefined();
    expect(screen.getByText('Runs a local command')).toBeDefined();
    expect(screen.getByText('local-mcp.json')).toBeDefined();
    expect(screen.getByText('sha256:authoritative-artifact')).toBeDefined();
    expect(screen.getByText('codex')).toBeDefined();
    expect(screen.getByText('machine-1')).toBeDefined();
    expect(screen.getByText('review')).toBeDefined();
    expect(screen.getByText('repository read')).toBeDefined();
    expect(screen.getByText('Added review tool')).toBeDefined();
    expect(screen.getByRole('button', { name: 'capabilities.installConfirm' })).not.toHaveProperty('disabled', true);
  });

  it('states that empty confirmation filters mean every compatible target', () => {
    render(<CapabilityOperationCard operation={{ ...operation, providers: [], machines: [] }} />);
    expect(screen.getByText('capabilities.allCompatibleProviders')).toBeDefined();
    expect(screen.getByText('capabilities.allAllowedMachines')).toBeDefined();
  });

  it('also renders medium and low audit findings instead of hiding them', () => {
    render(<CapabilityOperationCard operation={{
      ...operation,
      findings: [...operation.findings, {
        code: 'network-note', severity: CAPABILITY_FINDING_SEVERITY.MEDIUM, message: 'Connects to an external host', source: 'auditor', blocking: false,
      }],
    }} />);
    expect(screen.getByText('Runs a local command')).toBeDefined();
    expect(screen.getByText('Connects to an external host')).toBeDefined();
    expect(screen.getByText('capabilities.otherFindings')).toBeDefined();
  });

  it('disables install when digest-bound evidence is incomplete', () => {
    render(<CapabilityOperationCard operation={{ ...operation, auditDigest: undefined }} onInstall={vi.fn()} />);
    expect(screen.getByText('capabilities.confirmationEvidenceMissing')).toBeDefined();
    expect(screen.getByRole('button', { name: 'capabilities.installConfirm' })).toHaveProperty('disabled', true);
  });

  it('keeps authoritative cancellation available while offline', () => {
    const onCancel = vi.fn();
    render(<CapabilityOperationCard operation={operation} offline onCancel={onCancel} />);
    const cancel = screen.getByRole('button', { name: 'common.cancel' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each(['queued', 'auditing', 'awaiting_confirmation'] as const)('shows Cancel only in the explicit cancellable %s state', (state) => {
    render(<CapabilityOperationCard operation={{ ...operation, state }} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDefined();
  });

  it.each(['installing', 'syncing', 'installed'] as const)('hides Cancel at and after the irreversible %s state', (state) => {
    render(<CapabilityOperationCard operation={{ ...operation, state }} onCancel={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'common.cancel' })).toBeNull();
  });
});
