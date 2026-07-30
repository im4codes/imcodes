import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KimiSdkProvider } from '../../src/agent/providers/kimi-sdk.js';
import { normalizeTransportCwd } from '../../src/agent/transport-paths.js';

// Regression lock for the cross-message streaming text-bleed bug class.
//
// SDK providers accumulate streaming text in `state.currentText` and emit the
// CUMULATIVE text as a MessageDelta `{ messageId, delta }`. The downstream relay
// replaces the chat bubble by messageId. If `currentText` is NOT reset when a
// new assistant message (new messageId) begins mid-turn, message 2's deltas
// render prefixed with message 1's full text — visible bleed.
//
// kimi-sdk.ts handleAgentChunk resets `state.currentText = ''` when the
// incoming messageId differs from the current one. This test locks that reset
// so a future edit that removes it fails CI.

function attachRoute(provider: KimiSdkProvider, routeId = 'kimi-route') {
  const acpSessionId = `acp-${routeId}`;
  const state = {
    routeId,
    cwd: '/tmp/project',
    model: 'kimi-k2',
    acpSessionId,
    loaded: true,
    modeApplied: true,
    promptInFlight: true,
    replaying: false,
    cancelled: false,
    currentMessageId: null,
    currentText: '',
    toolCalls: new Map(),
    emittedToolSignatures: new Map(),
    lastStatusSignature: null,
  };
  (provider as any).sessions.set(routeId, state);
  (provider as any).registerAcpRoute(acpSessionId, routeId);
  return { state, acpSessionId };
}

function driveChunk(provider: KimiSdkProvider, acpSessionId: string, messageId: string, text: string) {
  (provider as any).handleSessionUpdate({
    sessionId: acpSessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text },
    },
  });
}

describe('KimiSdkProvider cross-message streaming', () => {
  it('resets the streaming accumulator across messages so a second message is not prefixed with the first', () => {
    const provider = new KimiSdkProvider();
    const { acpSessionId } = attachRoute(provider);

    const deltas: Array<{ id: string; text: string }> = [];
    provider.onDelta((_sid, delta) => deltas.push({ id: delta.messageId, text: delta.delta }));

    // First assistant message in the turn.
    driveChunk(provider, acpSessionId, 'm1', 'Let me check.');
    // ── tool round happens here; the model then continues in a NEW message ──
    driveChunk(provider, acpSessionId, 'm2', 'The answer');
    driveChunk(provider, acpSessionId, 'm2', ' is 42.');

    // Message 1 emitted its own cumulative text.
    const m1Deltas = deltas.filter((d) => d.id === 'm1').map((d) => d.text);
    expect(m1Deltas).toEqual(['Let me check.']);

    // Message 2's deltas must be its OWN text only, never prefixed with m1.
    const m2Deltas = deltas.filter((d) => d.id === 'm2').map((d) => d.text);
    expect(m2Deltas).toEqual(['The answer', 'The answer is 42.']);

    // Guard: no delta should ever contain both messages concatenated (the bleed).
    expect(deltas.every((d) => !d.text.includes('Let me check.The answer'))).toBe(true);
  });

  it('lists all remote ACP session pages for the requested directory', async () => {
    const provider = new KimiSdkProvider();
    const listSessions = vi.fn()
      .mockResolvedValueOnce({
        sessions: [{
          sessionId: 'acp-project-a',
          title: 'Project A',
          cwd: '/tmp/project-a',
          updatedAt: '2026-07-30T03:00:00.000Z',
        }, {
          sessionId: 'acp-project-b',
          title: 'Project B',
          cwd: '/tmp/project-b',
          updatedAt: '2026-07-30T04:00:00.000Z',
        }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        sessions: [{
          sessionId: 'acp-project-b-2',
          title: 'Project B second page',
          cwd: '/tmp/project-b',
        }],
        nextCursor: null,
      });
    (provider as any).connection = { listSessions };
    (provider as any).sessionListSupported = true;

    await expect(provider.listSessions({ directory: '/tmp/project-b' })).resolves.toEqual([
      expect.objectContaining({
        key: 'acp-project-b',
        displayName: 'Project B',
        directory: '/tmp/project-b',
        updatedAt: Date.parse('2026-07-30T04:00:00.000Z'),
      }),
      expect.objectContaining({
        key: 'acp-project-b-2',
        displayName: 'Project B second page',
        directory: '/tmp/project-b',
      }),
    ]);
    expect(listSessions).toHaveBeenNthCalledWith(1, {
      cwd: '/tmp/project-b',
    });
    expect(listSessions).toHaveBeenNthCalledWith(2, {
      cwd: '/tmp/project-b',
      cursor: 'page-2',
    });
  });

  it('fails closed when ACP session/list was not negotiated', async () => {
    const provider = new KimiSdkProvider();
    const listSessions = vi.fn();
    (provider as any).connection = { listSessions };

    await expect(provider.listSessions({ directory: '/tmp/project' })).resolves.toEqual([]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('preserves a symlink directory spelling in the ACP session/list request', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kimi-list-symlink-'));
    const realDirectory = path.join(root, 'real');
    const aliasDirectory = path.join(root, 'alias');
    await mkdir(realDirectory);
    await symlink(
      realDirectory,
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    try {
      const normalizedAlias = normalizeTransportCwd(aliasDirectory)!;
      const provider = new KimiSdkProvider();
      const listSessions = vi.fn(async ({ cwd }: { cwd?: string }) => ({
        sessions: cwd === normalizedAlias
          ? [{
            sessionId: 'acp-symlink-session',
            title: 'Symlink session',
            cwd: normalizedAlias,
          }]
          : [],
        nextCursor: null,
      }));
      (provider as any).connection = { listSessions };
      (provider as any).sessionListSupported = true;

      await expect(provider.listSessions({ directory: aliasDirectory })).resolves.toEqual([
        expect.objectContaining({
          key: 'acp-symlink-session',
          directory: normalizedAlias,
        }),
      ]);
      expect(listSessions).toHaveBeenCalledWith({ cwd: normalizedAlias });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detaches a stale route without closing or unmapping its replacement conversation', async () => {
    const provider = new KimiSdkProvider();
    const { state: staleState, acpSessionId } = attachRoute(provider, 'route-stale');
    const replacementState = {
      ...staleState,
      routeId: 'route-replacement',
      toolCalls: new Map(),
      emittedToolSignatures: new Map(),
    };
    (provider as any).sessions.set(replacementState.routeId, replacementState);
    (provider as any).registerAcpRoute(acpSessionId, replacementState.routeId);
    const closeSession = vi.fn(async () => ({}));
    (provider as any).connection = { closeSession };

    await provider.detachSession('route-stale');

    expect((provider as any).sessions.has('route-stale')).toBe(false);
    expect((provider as any).sessions.get('route-replacement')).toBe(replacementState);
    expect((provider as any).acpToRoute.get(acpSessionId)).toBe('route-replacement');
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('restores the newest remaining route when a stale ACP binding finishes last', async () => {
    const provider = new KimiSdkProvider();
    const oldest = attachRoute(provider, 'route-oldest');
    const newerState = {
      ...oldest.state,
      routeId: 'route-newer',
      toolCalls: new Map(),
      emittedToolSignatures: new Map(),
    };
    const staleState = {
      ...oldest.state,
      routeId: 'route-stale-last',
      toolCalls: new Map(),
      emittedToolSignatures: new Map(),
    };
    (provider as any).sessions.set(newerState.routeId, newerState);
    (provider as any).registerAcpRoute(oldest.acpSessionId, newerState.routeId);
    (provider as any).sessions.set(staleState.routeId, staleState);
    (provider as any).registerAcpRoute(oldest.acpSessionId, staleState.routeId);

    await provider.detachSession(staleState.routeId);

    expect((provider as any).acpToRoute.get(oldest.acpSessionId)).toBe(newerState.routeId);
    expect((provider as any).sessions.has(staleState.routeId)).toBe(false);
  });
});
