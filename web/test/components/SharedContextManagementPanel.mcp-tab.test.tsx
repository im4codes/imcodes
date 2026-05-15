/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_WS } from '@shared/memory-ws.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mcpTranslations = vi.hoisted(() => ({
  sharedContext: {
    refresh: 'Refresh',
    management: {
      noneValue: 'None',
      tabs: { mcp: 'MCP' },
      mcpTitle: 'Model Context Protocol',
      mcpSummaryLine1: 'Managed providers can expose the IM.codes memory, send, and cron tool families through the daemon-controlled MCP server.',
      mcpSummaryLine2: 'This view shows provider readiness, degraded setup reasons, feature gates, and recent redacted tool calls when the daemon reports them.',
      mcpSummaryLine3: 'If no MCP status has been reported yet, the cards stay explicit instead of assuming the tools are healthy.',
      mcpProviderStatusTitle: 'Provider MCP status',
      mcpProviderStatusDescription: 'Six managed providers are tracked for the ten-tool stdio MCP MVP.',
      mcpToolGatesTitle: 'Tool family gates',
      mcpToolGatesDescription: 'Memory, Send, and Cron tools must pass both their underlying feature gates and the MCP kill-switches.',
      mcpRecentCallsTitle: 'Recent redacted MCP calls',
      mcpRecentCallsDescription: 'Only daemon-redacted request and result snippets are shown here.',
      mcpStatusLoading: 'Waiting for MCP status from the daemon...',
      mcpNoDaemon: 'Connect the local daemon to load MCP status.',
      mcpStatusTimeout: 'No MCP status response yet. The backend may not expose this view on the current daemon.',
      mcpStatusError: 'MCP status could not be loaded.',
      mcpUpdatedAt: 'Updated',
      mcpUpdatedNever: 'Not reported',
      mcpProvidersReported: 'Providers reported',
      mcpCallsReported: 'Calls reported',
      mcpProviderConnected: 'Provider connected',
      mcpProviderDisconnected: 'Provider disconnected',
      mcpProviderNoSignal: 'No provider signal',
      mcpProviderNoDegradedReasons: 'No degraded reasons reported.',
      mcpProviderStatusHint: 'MCP-specific status is reported separately from provider connectivity.',
      mcpProviderClaudeSdk: 'Claude SDK',
      mcpProviderGeminiAcp: 'Gemini ACP',
      mcpProviderCopilotSdk: 'Copilot SDK',
      mcpProviderCodexSdk: 'Codex SDK',
      mcpProviderCursorHeadless: 'Cursor headless',
      mcpProviderQwen: 'Qwen',
      mcpProviderUnknown: '{{provider}}',
      mcpDisabledFlag: 'Disabled flag: {{flag}}',
      mcpDisabledFlagNone: 'No disabled flag reported',
      mcpDegradedReasons: 'Reasons: {{reasons}}',
      mcpGateNoDetails: 'No gate details reported.',
      mcpRecentCallsEmpty: 'No redacted MCP calls have been reported yet.',
      mcpCallProvider: 'Provider',
      mcpCallTool: 'Tool',
      mcpCallStatus: 'Status',
      mcpCallDuration: 'Duration',
      mcpCallDurationValue: '{{ms}} ms',
      mcpCallTime: 'Time',
      mcpCallFamily: 'Family',
      mcpCallInput: 'Redacted input',
      mcpCallResult: 'Redacted result',
      mcpStatus: {
        ready: 'Ready',
        degraded: 'Degraded',
        disabled: 'Disabled',
        unknown: 'Unknown',
      },
      mcpToolFamily: {
        memory: 'Memory',
        send: 'Send',
        cron: 'Cron',
      },
      mcpCallStatusValue: {
        ok: 'OK',
        error: 'Error',
        disabled: 'Disabled',
        unknown: '{{status}}',
      },
      mcpReason: {
        env_forwarding_unverified: 'Per-session MCP env forwarding is not proven.',
        feature_disabled: 'A required feature gate is disabled.',
        mcp_registration_failed: 'Managed MCP registration failed.',
        provider_not_connected: 'Provider is not connected.',
        status_not_reported: 'MCP status has not been reported.',
        unknown: '{{reason}}',
      },
    },
  },
}));

function readPath(source: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
  ), source);
  return typeof value === 'string' ? value : undefined;
}

function t(key: string, options?: Record<string, unknown>): string {
  let value = readPath(mcpTranslations, key) ?? key;
  for (const [name, replacement] of Object.entries(options ?? {})) {
    value = value.replaceAll(`{{${name}}}`, String(replacement));
  }
  return value;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: () => null,
}));

const apiMock = vi.hoisted(() => ({
  listTeams: vi.fn(),
  createTeam: vi.fn(),
  getTeam: vi.fn(),
  createTeamInvite: vi.fn(),
  joinTeamByToken: vi.fn(),
  updateTeamMemberRole: vi.fn(),
  removeTeamMember: vi.fn(),
  listSharedWorkspaces: vi.fn(),
  createSharedWorkspace: vi.fn(),
  listSharedProjects: vi.fn(),
  enrollSharedProject: vi.fn(),
  updateSharedProjectPolicy: vi.fn(),
  getSharedProjectPolicy: vi.fn(),
  listSharedDocuments: vi.fn(),
  createSharedDocument: vi.fn(),
  createSharedDocumentVersion: vi.fn(),
  activateSharedDocumentVersion: vi.fn(),
  listSharedDocumentBindings: vi.fn(),
  createSharedDocumentBinding: vi.fn(),
  fetchSharedContextRuntimeConfig: vi.fn(),
  updateSharedContextRuntimeConfig: vi.fn(),
  getPersonalCloudMemory: vi.fn(),
  getEnterpriseSharedMemory: vi.fn(),
  deletePersonalCloudMemory: vi.fn(),
  deleteEnterpriseSharedMemory: vi.fn(),
}));

vi.mock('../../src/api.js', () => ({
  ApiError: class ApiError extends Error {
    code: string | null;
    constructor(public status: number, public body: string) {
      super(body);
      this.code = body;
    }
  },
  listTeams: (...args: unknown[]) => apiMock.listTeams(...args),
  createTeam: (...args: unknown[]) => apiMock.createTeam(...args),
  getTeam: (...args: unknown[]) => apiMock.getTeam(...args),
  createTeamInvite: (...args: unknown[]) => apiMock.createTeamInvite(...args),
  joinTeamByToken: (...args: unknown[]) => apiMock.joinTeamByToken(...args),
  updateTeamMemberRole: (...args: unknown[]) => apiMock.updateTeamMemberRole(...args),
  removeTeamMember: (...args: unknown[]) => apiMock.removeTeamMember(...args),
  listSharedWorkspaces: (...args: unknown[]) => apiMock.listSharedWorkspaces(...args),
  createSharedWorkspace: (...args: unknown[]) => apiMock.createSharedWorkspace(...args),
  listSharedProjects: (...args: unknown[]) => apiMock.listSharedProjects(...args),
  enrollSharedProject: (...args: unknown[]) => apiMock.enrollSharedProject(...args),
  updateSharedProjectPolicy: (...args: unknown[]) => apiMock.updateSharedProjectPolicy(...args),
  getSharedProjectPolicy: (...args: unknown[]) => apiMock.getSharedProjectPolicy(...args),
  listSharedDocuments: (...args: unknown[]) => apiMock.listSharedDocuments(...args),
  createSharedDocument: (...args: unknown[]) => apiMock.createSharedDocument(...args),
  createSharedDocumentVersion: (...args: unknown[]) => apiMock.createSharedDocumentVersion(...args),
  activateSharedDocumentVersion: (...args: unknown[]) => apiMock.activateSharedDocumentVersion(...args),
  listSharedDocumentBindings: (...args: unknown[]) => apiMock.listSharedDocumentBindings(...args),
  createSharedDocumentBinding: (...args: unknown[]) => apiMock.createSharedDocumentBinding(...args),
  fetchSharedContextRuntimeConfig: (...args: unknown[]) => apiMock.fetchSharedContextRuntimeConfig(...args),
  updateSharedContextRuntimeConfig: (...args: unknown[]) => apiMock.updateSharedContextRuntimeConfig(...args),
  getPersonalCloudMemory: (...args: unknown[]) => apiMock.getPersonalCloudMemory(...args),
  getEnterpriseSharedMemory: (...args: unknown[]) => apiMock.getEnterpriseSharedMemory(...args),
  deletePersonalCloudMemory: (...args: unknown[]) => apiMock.deletePersonalCloudMemory(...args),
  deleteEnterpriseSharedMemory: (...args: unknown[]) => apiMock.deleteEnterpriseSharedMemory(...args),
}));

import { SharedContextManagementPanel } from '../../src/components/SharedContextManagementPanel.js';

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('SharedContextManagementPanel MCP tab', () => {
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiMock.listTeams.mockResolvedValue([]);
    apiMock.getPersonalCloudMemory.mockResolvedValue({ stats: {}, records: [], pendingRecords: [], projects: [] });
    apiMock.getEnterpriseSharedMemory.mockResolvedValue({ stats: {}, records: [], pendingRecords: [], projects: [] });
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  it('renders MCP status, degraded reasons, disabled gates, and redacted calls without console warnings', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const messageHandlers = new Set<(message: Record<string, unknown>) => void>();
    const ws = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
      onMessage(handler: (message: Record<string, unknown>) => void) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };

    render(<SharedContextManagementPanel serverId="srv-1" ws={ws as never} />);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('MCP'));
    });

    expect(await screen.findByText('Model Context Protocol')).toBeDefined();
    expect(screen.queryByText('sharedContext.management.mcpTitle')).toBeNull();
    await waitFor(() => expect(sent.some((message) => message.type === MEMORY_WS.MCP_STATUS_QUERY)).toBe(true));

    const requestId = [...sent].reverse().find((message) => message.type === MEMORY_WS.MCP_STATUS_QUERY)?.requestId as string | undefined;
    expect(requestId).toBeTruthy();

    await act(async () => {
      for (const handler of messageHandlers) {
        handler({ type: TRANSPORT_MSG.PROVIDER_STATUS, providerId: 'qwen', connected: true });
        handler({
          type: MEMORY_WS.MCP_STATUS_RESPONSE,
          requestId,
          updatedAt: 1700000000000,
          providers: [
            { providerId: 'cursor-headless', status: 'degraded', degradedReasons: ['env_forwarding_unverified'] },
            { providerId: 'qwen', status: 'ready' },
          ],
          toolFamilies: [
            { family: 'memory', status: 'ready', enabled: true },
            { family: 'send', status: 'disabled', enabled: false, disabledFlag: 'send.feature.mcp_dispatch', degradedReasons: ['feature_disabled'] },
            { family: 'cron', status: 'degraded', enabled: false, disabledFlag: 'cron.feature.mcp_write', degradedReasons: ['feature_disabled'] },
          ],
          recentCalls: [
            {
              id: 'call-1',
              providerId: 'qwen',
              family: 'memory',
              toolName: 'search_memory',
              status: 'ok',
              occurredAt: 1700000001000,
              durationMs: 42,
              redactedInput: '{"query":"***"}',
              redactedResult: '{"records":[]}',
            },
          ],
        });
      }
    });

    expect(await screen.findByText('Cursor headless')).toBeDefined();
    expect(screen.getByText((content) => content.includes('Per-session MCP env forwarding is not proven.'))).toBeDefined();
    expect(screen.getByText((content) => content.includes('Disabled flag: send.feature.mcp_dispatch'))).toBeDefined();
    expect(screen.getByText((content) => content.includes('Disabled flag: cron.feature.mcp_write'))).toBeDefined();
    expect(screen.getByText('search_memory')).toBeDefined();
    expect(screen.getByText('{"query":"***"}')).toBeDefined();
    expect(screen.getByText('42 ms')).toBeDefined();
    expect(screen.getByText((content) => content.includes('Provider connected'))).toBeDefined();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps MCP locale keys resolvable in every supported locale', () => {
    const localeDir = join(process.cwd(), 'web/src/i18n/locales');
    const locales = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'];
    const requiredKeys = [
      'sharedContext.management.tabs.mcp',
      'sharedContext.management.mcpTitle',
      'sharedContext.management.mcpStatus.degraded',
      'sharedContext.management.mcpStatus.disabled',
      'sharedContext.management.mcpToolFamily.send',
      'sharedContext.management.mcpReason.env_forwarding_unverified',
      'sharedContext.management.mcpRecentCallsEmpty',
    ];

    for (const locale of locales) {
      const parsed = JSON.parse(readFileSync(join(localeDir, `${locale}.json`), 'utf8')) as unknown;
      for (const key of requiredKeys) {
        expect(readPath(parsed, key), `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});
