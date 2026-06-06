import { describe, expect, it } from 'vitest';
import {
  SHARE_ACTION_ID_IS_IDEMPOTENCY_KEY,
  SHARE_BROWSER_COMMANDS,
  SHARE_DAEMON_RELAY_INVENTORY,
  SHARE_HTTP_ROUTE_POLICY_INVENTORY,
  SHARE_SCOPED_DAEMON_MESSAGE_POLICY,
  SHARE_SCOPED_COMMAND_POLICY,
  buildShareAuditIdempotencyKey,
  getShareScopedCommandPolicy,
  getShareScopedDaemonMessagePolicy,
  isActiveShareGrant,
  isShareCommandAllowed,
  normalizeShareTargetInput,
  resolveEffectiveActor,
  resolveEffectiveCoverageForTarget,
  shareTargetKey,
} from '../../shared/tab-sharing.js';

describe('shared tab sharing contract', () => {
  it('normalizes sub-session display ids to raw ids and fails closed for invalid ids', () => {
    expect(normalizeShareTargetInput({ kind: 'subsession', serverId: 'srv', sessionName: 'deck_sub_abc' })).toEqual({
      ok: true,
      target: { kind: 'subsession', serverId: 'srv', subSessionId: 'abc' },
    });
    expect(normalizeShareTargetInput({ kind: 'subsession', serverId: 'srv', subSessionId: 'abc' })).toEqual({
      ok: true,
      target: { kind: 'subsession', serverId: 'srv', subSessionId: 'abc' },
    });
    expect(
      normalizeShareTargetInput({
        kind: 'subsession',
        serverId: 'srv',
        subSessionId: 'abc',
        sessionName: 'deck_sub_abc',
      }),
    ).toEqual({ ok: false, reason: 'conflicting-identifiers' });
    expect(normalizeShareTargetInput({ kind: 'subsession', serverId: 'srv', sessionName: 'deck_sub_deck_sub_abc' }))
      .toEqual({ ok: false, reason: 'malformed-subsession-id' });
    expect(
      normalizeShareTargetInput(
        { kind: 'subsession', serverId: 'srv', sessionName: 'deck_sub_missing' },
        { subSessionExists: () => false },
      ),
    ).toEqual({ ok: false, reason: 'target-not-found' });
    expect(
      normalizeShareTargetInput({
        kind: 'subsession',
        serverId: 'srv',
        sessionName: 'deck_sub_abc',
        subSessionDisplayName: 'Friendly label',
      }),
    ).toEqual({ ok: true, target: { kind: 'subsession', serverId: 'srv', subSessionId: 'abc' } });
  });

  it('applies the canonical active share predicate with strict expiry boundary', () => {
    expect(isActiveShareGrant({ revokedAt: null, expiresAt: null }, 100)).toBe(true);
    expect(isActiveShareGrant({ revokedAt: null, expiresAt: 101 }, 100)).toBe(true);
    expect(isActiveShareGrant({ revokedAt: null, expiresAt: 100 }, 100)).toBe(false);
    expect(isActiveShareGrant({ revokedAt: 99, expiresAt: 101 }, 100)).toBe(false);
  });

  it('combines overlapping grants by strongest role while exposing full scoped history', () => {
    const target = { kind: 'main' as const, serverId: 'srv', sessionName: 'main' };
    const coverage = resolveEffectiveCoverageForTarget(target, [
      {
        id: 'server-view',
        target: { kind: 'server', serverId: 'srv' },
        role: 'viewer',
        createdAt: 10,
        expiresAt: 80,
      },
      {
        id: 'tab-participant',
        target,
        role: 'participant',
        createdAt: 20,
        expiresAt: 120,
      },
      {
        id: 'expired',
        target,
        role: 'participant',
        createdAt: 1,
        expiresAt: 50,
      },
    ], 60);
    expect(coverage).toMatchObject({
      target,
      effectiveRole: 'participant',
      historyCutoffAt: 0,
      nextCoverageRecheckAt: 80,
      coveringShareIds: ['server-view', 'tab-participant'],
      primaryShareId: 'tab-participant',
      authorizedAt: 60,
    });
  });

  it('uses server membership before share coverage for effective actors', () => {
    const target = { kind: 'server' as const, serverId: 'srv' };
    const coverage = resolveEffectiveCoverageForTarget(target, [{
      id: 'share',
      target,
      role: 'participant',
      createdAt: 10,
      expiresAt: null,
    }], 20);
    expect(resolveEffectiveActor('admin', coverage)).toEqual({
      kind: 'server-member',
      effectiveActorRole: 'server-manager',
    });
    expect(resolveEffectiveActor('member', coverage)).toEqual({
      kind: 'server-member',
      effectiveActorRole: 'server-member',
    });
    expect(resolveEffectiveActor(null, coverage)).toEqual({
      kind: 'share',
      effectiveActorRole: 'participant',
      coverage,
    });
  });

  it('denies unknown share-scoped browser commands and drops unknown daemon messages by default', () => {
    expect(getShareScopedCommandPolicy('brand.new.command')).toMatchObject({
      disposition: 'deny',
      reason: 'share-direct-surface-denied',
    });
    expect(getShareScopedDaemonMessagePolicy('brand.new.message')).toMatchObject({
      delivery: 'drop',
      reason: 'share-direct-surface-denied',
      type: 'brand.new.message',
    });
  });

  it('classifies viewer and participant command capabilities from a single policy', () => {
    expect(isShareCommandAllowed(SHARE_BROWSER_COMMANDS.DISCUSSION_COMMENT, 'viewer')).toBe(true);
    expect(isShareCommandAllowed(SHARE_BROWSER_COMMANDS.SESSION_SEND, 'viewer')).toBe(false);
    expect(isShareCommandAllowed(SHARE_BROWSER_COMMANDS.SESSION_SEND, 'participant')).toBe(true);
    expect(getShareScopedCommandPolicy(SHARE_BROWSER_COMMANDS.SESSION_CANCEL)).toMatchObject({
      disposition: 'allow',
      minRole: 'participant',
      requiresObservedDispatchId: true,
      transportOnly: true,
    });
    expect(getShareScopedCommandPolicy(SHARE_BROWSER_COMMANDS.TERMINAL_RESIZE)).toMatchObject({
      disposition: 'deny',
      reason: 'share-direct-surface-denied',
    });
  });

  it('denies direct filesystem, repo, memory, cron, provider, membership, and admin surfaces for all share roles', () => {
    const deniedCommands = [
      SHARE_BROWSER_COMMANDS.FILE_READ,
      SHARE_BROWSER_COMMANDS.FILE_WRITE,
      SHARE_BROWSER_COMMANDS.FILE_EDIT,
      SHARE_BROWSER_COMMANDS.FILE_DELETE,
      SHARE_BROWSER_COMMANDS.FILE_PATCH,
      SHARE_BROWSER_COMMANDS.FILE_BROWSE,
      SHARE_BROWSER_COMMANDS.FILE_SEARCH,
      SHARE_BROWSER_COMMANDS.REPO_STATUS,
      SHARE_BROWSER_COMMANDS.REPO_DIFF,
      SHARE_BROWSER_COMMANDS.REPO_COMMIT,
      SHARE_BROWSER_COMMANDS.REPO_PUSH,
      SHARE_BROWSER_COMMANDS.REPO_PULL,
      SHARE_BROWSER_COMMANDS.REPO_BRANCH,
      SHARE_BROWSER_COMMANDS.REPO_SEARCH,
      SHARE_BROWSER_COMMANDS.MEMORY_QUERY,
      SHARE_BROWSER_COMMANDS.MEMORY_MUTATE,
      SHARE_BROWSER_COMMANDS.CRON_LIST,
      SHARE_BROWSER_COMMANDS.CRON_MUTATE,
      SHARE_BROWSER_COMMANDS.CREDENTIALS,
      SHARE_BROWSER_COMMANDS.BILLING,
      SHARE_BROWSER_COMMANDS.MEMBERSHIP,
      SHARE_BROWSER_COMMANDS.ADMIN_SETTINGS,
      SHARE_BROWSER_COMMANDS.PROVIDER_STATUS,
      SHARE_BROWSER_COMMANDS.PROVIDER_LIST,
      SHARE_BROWSER_COMMANDS.CHAT_APPROVAL_RESPONSE,
      SHARE_BROWSER_COMMANDS.P2P_RUN_START,
      SHARE_BROWSER_COMMANDS.P2P_CANCEL,
    ];

    for (const command of deniedCommands) {
      const policy = getShareScopedCommandPolicy(command);
      expect(policy, command).toMatchObject({
        disposition: 'deny',
        reason: 'share-direct-surface-denied',
      });
      expect(isShareCommandAllowed(command, 'viewer'), command).toBe(false);
      expect(isShareCommandAllowed(command, 'participant'), command).toBe(false);
    }
  });

  it('keeps every shared browser command covered by the command policy', () => {
    expect(Object.keys(SHARE_SCOPED_COMMAND_POLICY).sort()).toEqual(Object.values(SHARE_BROWSER_COMMANDS).sort());
  });

  it('classifies share-relevant HTTP routes as share-aware, share-denied, or not-applicable', () => {
    const ids = SHARE_HTTP_ROUTE_POLICY_INVENTORY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SHARE_HTTP_ROUTE_POLICY_INVENTORY.length).toBeGreaterThan(25);

    for (const entry of SHARE_HTTP_ROUTE_POLICY_INVENTORY) {
      expect(getShareScopedCommandPolicy(entry.command)).toBeDefined();
      if (entry.disposition === 'share-aware') {
        expect(getShareScopedCommandPolicy(entry.command).disposition).toBe('allow');
      }
      if (entry.disposition === 'share-denied') {
        expect(entry.reason).toBe('share-direct-surface-denied');
      }
    }

    for (const requiredId of [
      'recipient-share-open',
      'recipient-share-ws-ticket',
      'timeline-history',
      'timeline-history-full',
      'timeline-text-tail',
      'discussion-comment',
      'discussion-runs',
      'session-send',
      'session-cancel',
      'session-start',
      'session-stop',
      'session-group-clone',
      'subsession-list',
      'subsession-create',
      'subsession-reorder',
      'local-web-preview-create',
      'local-web-preview-close',
      'file-upload',
      'file-download',
      'memory-sources',
      'cron-list',
      'cron-create',
      'share-management-list',
      'share-audit',
    ]) {
      expect(ids).toContain(requiredId);
    }
  });

  it('keeps the daemon relay inventory covered by daemon-message policy entries', () => {
    expect(SHARE_DAEMON_RELAY_INVENTORY.length).toBeGreaterThan(0);
    for (const messageType of SHARE_DAEMON_RELAY_INVENTORY) {
      expect(SHARE_SCOPED_DAEMON_MESSAGE_POLICY[messageType]).toBeDefined();
    }
  });

  it('treats actionId as correlation-only and uses a separate audit idempotency key', () => {
    expect(SHARE_ACTION_ID_IS_IDEMPOTENCY_KEY).toBe(false);
    const targetRef = shareTargetKey({ kind: 'main', serverId: 'srv', sessionName: 'main' });
    const keyA = buildShareAuditIdempotencyKey({
      actionType: 'session.send',
      targetKind: 'main',
      targetRef,
      primaryShareId: 'share-a',
      transitionEpochMs: 100,
      decision: 'accepted',
      attemptId: 'audit-a',
    });
    const keyB = buildShareAuditIdempotencyKey({
      actionType: 'session.send',
      targetKind: 'main',
      targetRef,
      primaryShareId: 'share-a',
      transitionEpochMs: 100,
      decision: 'rejected',
      attemptId: 'audit-a',
    });
    expect(keyA).not.toEqual(keyB);
    const keyC = buildShareAuditIdempotencyKey({
      actionType: 'session.send',
      targetKind: 'main',
      targetRef,
      primaryShareId: 'share-a',
      transitionEpochMs: 100,
      decision: 'accepted',
      attemptId: 'audit-b',
    });
    expect(keyA).not.toEqual(keyC);
  });
});
