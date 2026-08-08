/**
 * A `kind: 'server'` target names no session, so the per-session coverage check
 * cannot run on it. `filterShareDaemonMessage` used to answer that by skipping
 * the check entirely, which delivered the message to every share socket on the
 * server — a socket shared one tab, in viewer role, received whole-server
 * `discussion.*` and `p2p.run.*` payloads. Neither group has a redact, so the
 * round text, participant session names and hop output paths went out verbatim.
 *
 * The decision now rests on the RECEIVER's scope: a server-scoped share covers
 * everything, and a narrower one may only receive a server-targeted message
 * when the entry's own redact re-scopes it (`session_list` does; nothing else).
 */
import { describe, expect, it } from 'vitest';
import { filterShareDaemonMessage } from '../src/ws/share-policy.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import type { EffectiveCoverage, ShareTarget } from '../../shared/tab-sharing.js';

const serverId = 'srv-scope-1';
const now = 1_800_000_000_000;

function coverage(target: ShareTarget, effectiveRole: EffectiveCoverage['effectiveRole'] = 'viewer'): EffectiveCoverage {
  return {
    target,
    effectiveRole,
    historyCutoffAt: 0,
    nextCoverageRecheckAt: null,
    coveringShareIds: ['share-1'],
    primaryShareId: 'share-1',
    authorizedAt: now,
  };
}

function socket(target: ShareTarget, effectiveRole: EffectiveCoverage['effectiveRole'] = 'viewer') {
  return {
    userId: 'shared-user',
    target,
    connectedAt: now,
    ticketId: 'ticket-1',
    snapshot: coverage(target, effectiveRole),
  };
}

const tabScoped: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_proj_brain' };
const serverScoped: ShareTarget = { kind: 'server', serverId };

const serverStamped = { shareScope: { target: serverScoped } };

describe('server-targeted messages vs a narrower share', () => {
  it.each([
    ['discussion.started'],
    ['discussion.update'],
    ['discussion.done'],
    ['discussion.error'],
    ['discussion.list'],
  ])('drops %s carrying a server-wide scope', (type) => {
    const delivered = filterShareDaemonMessage(
      { type, ...serverStamped, response: 'whole-server discussion text' },
      socket(tabScoped),
    );
    expect(delivered).toBeNull();
  });

  it.each([
    [P2P_WORKFLOW_MSG.RUN_STARTED],
    [P2P_WORKFLOW_MSG.RUN_UPDATE],
    [P2P_WORKFLOW_MSG.RUN_COMPLETE],
    [P2P_WORKFLOW_MSG.RUN_ERROR],
  ])('drops %s carrying a server-wide scope', (type) => {
    const delivered = filterShareDaemonMessage(
      { type, run: { shareScope: { target: serverScoped }, hops: [{ output_path: '/Users/host/secret' }] } },
      socket(tabScoped),
    );
    expect(delivered).toBeNull();
  });

  it('still delivers a server-wide discussion to a server-scoped share', () => {
    const delivered = filterShareDaemonMessage(
      { type: 'discussion.started', ...serverStamped, response: 'text' },
      socket(serverScoped),
    );
    expect(delivered).not.toBeNull();
  });

  it('still delivers session_list to a narrower share, because its redact re-scopes it', () => {
    // The one server-targeted entry that opts in. Losing this would blank the
    // shared session list, so it is pinned here alongside the denials.
    const delivered = filterShareDaemonMessage(
      {
        type: 'session_list',
        serverId,
        sessions: [
          { name: 'deck_proj_brain', state: 'idle' },
          { name: 'deck_other_brain', state: 'idle' },
        ],
      },
      socket(tabScoped),
    );
    const names = (delivered?.sessions as Array<{ name: string }> | undefined)?.map((row) => row.name);
    expect(names).toEqual(['deck_proj_brain']);
  });
});

describe('session_list row redaction', () => {
  const row = {
    name: 'deck_proj_brain',
    state: 'idle',
    projectDir: '/Users/host/private/project',
    transportConfig: { apiBase: 'https://internal.example', env: { TOKEN: 'x' } },
    providerId: 'claude-code-sdk',
    providerSessionId: 'provider-session-abc',
    qwenAuthType: 'oauth',
    qwenAuthLimit: 100,
    qwenAvailableModels: ['qwen-max'],
    copilotAvailableModels: ['gpt-5'],
    cursorAvailableModels: ['cursor-fast'],
    codexAvailableModels: ['o3'],
    planLabel: 'Max 5x',
    permissionLabel: 'all',
    quotaLabel: '80%',
    quotaUsageLabel: '4/5',
    quotaMeta: { plan: 'enterprise' },
    contextNamespace: 'host-namespace',
    contextNamespaceDiagnostics: { note: 'host detail' },
    effort: 'high',
    ccPreset: 'preset-host',
    requestedModel: 'claude-opus-5',
  };

  it.each([
    ['a tab-scoped share', tabScoped],
    ['a server-scoped share', serverScoped],
  ])('strips host-side fields for %s', (_label, target) => {
    // Row filtering only ever chose which rows to send. Every covered row
    // shipped the host's absolute paths and provider config in full, and for a
    // server-scoped share the whole message was returned untouched.
    const delivered = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [row] },
      socket(target),
    );
    const [out] = delivered?.sessions as Array<Record<string, unknown>>;
    expect(out.name).toBe('deck_proj_brain');
    expect(out.state).toBe('idle');
    // Allowlist, so assert the complement: nothing outside the visible set may
    // survive. A denylist version of this test passed while planLabel,
    // permissionLabel and the *AvailableModels arrays still went out.
    const allowed = new Set(['name', 'state']);
    for (const key of Object.keys(out)) {
      expect(allowed.has(key), `${key} must not reach a share recipient`).toBe(true);
    }
  });

  it('exposes the cancel guard token only to participants', () => {
    const withDispatch = { ...row, activeDispatchId: 'dispatch-current' };
    const viewer = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [withDispatch] },
      socket(tabScoped, 'viewer'),
    );
    const participant = filterShareDaemonMessage(
      { type: 'session_list', serverId, sessions: [withDispatch] },
      socket(tabScoped, 'participant'),
    );

    expect((viewer?.sessions as Array<Record<string, unknown>>)[0]).not.toHaveProperty('activeDispatchId');
    expect((participant?.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({
      activeDispatchId: 'dispatch-current',
    });
    expect(filterShareDaemonMessage({
      type: 'command.ack',
      session: 'deck_proj_brain',
      commandId: 'command-1',
      status: 'accepted',
      activeDispatchId: 'dispatch-current',
    }, socket(tabScoped, 'viewer'))).not.toHaveProperty('activeDispatchId');
    expect(filterShareDaemonMessage({
      type: 'command.ack',
      session: 'deck_proj_brain',
      commandId: 'command-1',
      status: 'accepted',
      activeDispatchId: 'dispatch-current',
    }, socket(tabScoped, 'participant'))).toMatchObject({ activeDispatchId: 'dispatch-current' });
  });
});
