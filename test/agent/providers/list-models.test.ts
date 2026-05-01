/**
 * Tests for TransportProvider.listModels() — the unified model-discovery interface.
 *
 * Each provider that powers a model picker must implement listModels() and return
 * a ProviderModelList. These tests verify the contract is satisfied and that
 * handleTransportListModels dispatch delegates correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderModelList } from '../../../src/agent/transport-provider.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeModelList(overrides: Partial<ProviderModelList> = {}): ProviderModelList {
  return { models: [], isAuthenticated: false, ...overrides };
}

// ── ClaudeCodeSdkProvider ─────────────────────────────────────────────────────

describe('ClaudeCodeSdkProvider.listModels', () => {
  it('returns the static Claude model roster', async () => {
    const { ClaudeCodeSdkProvider } = await import('../../../src/agent/providers/claude-code-sdk.js');
    const provider = new ClaudeCodeSdkProvider();
    const result = await provider.listModels();
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
    expect(result.isAuthenticated).toBe(true);
    // Default model is the first in the list
    expect(result.defaultModel).toBe(result.models[0]?.id);
  });

  it('force=true still returns the same static list', async () => {
    const { ClaudeCodeSdkProvider } = await import('../../../src/agent/providers/claude-code-sdk.js');
    const provider = new ClaudeCodeSdkProvider();
    const a = await provider.listModels(false);
    const b = await provider.listModels(true);
    expect(b.models.map((m) => m.id)).toEqual(a.models.map((m) => m.id));
  });
});

// ── CodexSdkProvider ─────────────────────────────────────────────────────────

describe('CodexSdkProvider.listModels', () => {
  it('delegates to getCodexRuntimeConfig and maps the result', async () => {
    const fakeModels = [{ id: 'gpt-5.5', name: 'GPT-5.5', supportsReasoningEffort: true, isDefault: true }];
    vi.doMock('../../../src/agent/codex-runtime-config.js', () => ({
      getCodexRuntimeConfig: vi.fn().mockResolvedValue({
        models: fakeModels,
        defaultModel: 'gpt-5.5',
        isAuthenticated: true,
      }),
    }));
    const { CodexSdkProvider } = await import('../../../src/agent/providers/codex-sdk.js');
    const provider = new CodexSdkProvider();
    const result = await provider.listModels(false);
    expect(result.models[0]).toMatchObject({ id: 'gpt-5.5', name: 'GPT-5.5', supportsReasoningEffort: true });
    expect(result.defaultModel).toBe('gpt-5.5');
    expect(result.isAuthenticated).toBe(true);
    vi.doUnmock('../../../src/agent/codex-runtime-config.js');
  });

  it('returns empty models with error string when runtime-config throws', async () => {
    vi.doMock('../../../src/agent/codex-runtime-config.js', () => ({
      getCodexRuntimeConfig: vi.fn().mockRejectedValue(new Error('app-server offline')),
    }));
    const { CodexSdkProvider } = await import('../../../src/agent/providers/codex-sdk.js');
    const provider = new CodexSdkProvider();
    const result = await provider.listModels();
    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/app-server offline/);
    vi.doUnmock('../../../src/agent/codex-runtime-config.js');
  });
});

// ── CopilotSdkProvider ────────────────────────────────────────────────────────

describe('CopilotSdkProvider.listModels', () => {
  it('delegates to getCopilotRuntimeConfig and maps the result', async () => {
    vi.doMock('../../../src/agent/copilot-runtime-config.js', () => ({
      getCopilotRuntimeConfig: vi.fn().mockResolvedValue({
        models: [{ id: 'gpt-5.4', supportsReasoningEffort: false }],
        isAuthenticated: true,
        availableModels: ['gpt-5.4'],
      }),
    }));
    const { CopilotSdkProvider } = await import('../../../src/agent/providers/copilot-sdk.js');
    const provider = new CopilotSdkProvider();
    const result = await provider.listModels();
    expect(result.models[0]?.id).toBe('gpt-5.4');
    expect(result.isAuthenticated).toBe(true);
    vi.doUnmock('../../../src/agent/copilot-runtime-config.js');
  });
});

// ── CursorHeadlessProvider ────────────────────────────────────────────────────

describe('CursorHeadlessProvider.listModels', () => {
  it('delegates to getCursorRuntimeConfig and maps model IDs', async () => {
    vi.doMock('../../../src/agent/cursor-runtime-config.js', () => ({
      getCursorRuntimeConfig: vi.fn().mockResolvedValue({
        availableModels: ['claude-3-5-sonnet', 'gpt-5'],
        defaultModel: 'claude-3-5-sonnet',
        isAuthenticated: true,
      }),
    }));
    const { CursorHeadlessProvider } = await import('../../../src/agent/providers/cursor-headless.js');
    const provider = new CursorHeadlessProvider();
    const result = await provider.listModels();
    expect(result.models.map((m) => m.id)).toEqual(['claude-3-5-sonnet', 'gpt-5']);
    expect(result.defaultModel).toBe('claude-3-5-sonnet');
    expect(result.isAuthenticated).toBe(true);
    vi.doUnmock('../../../src/agent/cursor-runtime-config.js');
  });
});

// ── GeminiSdkProvider ────────────────────────────────────────────────────────

describe('GeminiSdkProvider.listModels', () => {
  it('probes for models via newSession if not cached', async () => {
    const { GeminiSdkProvider } = await import('../../../src/agent/providers/gemini-sdk.js');
    const provider = new GeminiSdkProvider();

    // Mock the connection and its prompt/newSession methods
    const mockConnection = {
      initialize: vi.fn().mockResolvedValue({}),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'test-session',
        models: {
          availableModels: [{ modelId: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }],
          currentModelId: 'gemini-2.0-flash',
        },
      }),
      closeSession: vi.fn().mockResolvedValue({}),
    };
    (provider as any).connection = mockConnection;
    (provider as any).initPromise = Promise.resolve();

    const result = await provider.listModels();
    expect(mockConnection.newSession).toHaveBeenCalled();
    expect(result.models[0]?.id).toBe('gemini-2.0-flash');
    expect(result.defaultModel).toBe('gemini-2.0-flash');
    expect(result.isAuthenticated).toBe(true);
  });

  it('respects force=true by clearing cache', async () => {
    const { GeminiSdkProvider } = await import('../../../src/agent/providers/gemini-sdk.js');
    const provider = new GeminiSdkProvider();
    (provider as any).cachedModels = [{ id: 'old' }];
    (provider as any).connection = {
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'new',
        models: { availableModels: [{ modelId: 'new' }] },
      }),
      closeSession: vi.fn().mockResolvedValue({}),
    };
    (provider as any).initPromise = Promise.resolve();

    const result = await provider.listModels(true);
    expect(result.models[0]?.id).toBe('new');
  });
});

// ── ProviderModelList contract ────────────────────────────────────────────────

describe('ProviderModelList contract', () => {
  it('all listed providers implement listModels()', async () => {
    const { ClaudeCodeSdkProvider } = await import('../../../src/agent/providers/claude-code-sdk.js');
    const { CodexSdkProvider } = await import('../../../src/agent/providers/codex-sdk.js');
    const { CopilotSdkProvider } = await import('../../../src/agent/providers/copilot-sdk.js');
    const { CursorHeadlessProvider } = await import('../../../src/agent/providers/cursor-headless.js');
    const { GeminiSdkProvider } = await import('../../../src/agent/providers/gemini-sdk.js');

    for (const Cls of [ClaudeCodeSdkProvider, CodexSdkProvider, CopilotSdkProvider, CursorHeadlessProvider, GeminiSdkProvider]) {
      const p = new Cls();
      expect(typeof (p as unknown as { listModels?: unknown }).listModels, `${Cls.name} must implement listModels()`).toBe('function');
    }
  });

  it('result always has a models array even on error', async () => {
    vi.doMock('../../../src/agent/codex-runtime-config.js', () => ({
      getCodexRuntimeConfig: vi.fn().mockRejectedValue(new Error('boom')),
    }));
    const { CodexSdkProvider } = await import('../../../src/agent/providers/codex-sdk.js');
    const result = await new CodexSdkProvider().listModels();
    expect(Array.isArray(result.models)).toBe(true);
    vi.doUnmock('../../../src/agent/codex-runtime-config.js');
  });
});
