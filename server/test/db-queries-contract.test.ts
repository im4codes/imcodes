import { describe, expect, it, vi } from 'vitest';
import * as queries from '../src/db/queries.js';

function makeDb() {
  const db = {
    execute: vi.fn(async () => ({ changes: 1 })),
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  return db as any;
}

describe('db queries contracts', () => {
  it('bounds and classifies session text tail cache items', () => {
    const many = Array.from({ length: queries.SESSION_TEXT_TAIL_CACHE_LIMIT + 5 }, (_, index) => ({
      eventId: `evt-${index.toString().padStart(3, '0')}`,
      ts: index,
      type: index % 2 === 0 ? 'user.message' as const : 'assistant.text' as const,
      text: `message ${index}`,
    }));

    const merged = queries.mergeSessionTextTailCacheItems([many[3]!], many);
    expect(merged).toHaveLength(queries.SESSION_TEXT_TAIL_CACHE_LIMIT);
    expect(merged[0]?.eventId).toBe('evt-005');

    expect(queries.classifySessionTextTailEvent({
      sessionId: 'deck_alpha_brain',
      eventId: 'evt-a',
      ts: 10,
      type: 'assistant.text',
      source: ' jsonl ',
      confidence: ' high ',
      payload: { text: ' hello ', streaming: false },
    })).toEqual({
      sessionName: 'deck_alpha_brain',
      item: {
        eventId: 'evt-a',
        ts: 10,
        type: 'assistant.text',
        text: 'hello',
        source: 'jsonl',
        confidence: 'high',
      },
    });

    expect(queries.classifySessionTextTailEvent({
      sessionId: 'deck_alpha_brain',
      eventId: 'evt-stream',
      ts: 11,
      type: 'assistant.text',
      payload: { text: 'partial', streaming: true },
    })).toBeNull();

    expect(queries.collectSessionTextTailCacheItems('deck_alpha_brain', [
      { sessionId: 'deck_alpha_brain', eventId: 'evt-1', ts: 1, type: 'user.message', payload: { text: 'prompt' } },
      { sessionId: 'deck_other_brain', eventId: 'evt-2', ts: 2, type: 'user.message', payload: { text: 'ignored' } },
      null,
    ])).toEqual([{ eventId: 'evt-1', ts: 1, type: 'user.message', text: 'prompt' }]);
  });

  it('executes user, server, session, discussion, and preference wrappers', async () => {
    const db = makeDb();

    expect(await queries.createUser(db, 'user-1')).toMatchObject({ id: 'user-1', status: 'active' });
    await queries.getUserById(db, 'user-1');
    await queries.getUserByUsername(db, 'ada');
    await queries.listAllUsers(db);
    await queries.updateUserStatus(db, 'user-1', 'disabled');
    await queries.deleteUser(db, 'user-1');

    db.queryOne.mockResolvedValueOnce({ cnt: '2' });
    expect(await queries.countActiveAdmins(db)).toBe(2);
    db.queryOne.mockResolvedValueOnce({ value: 'dark' });
    expect(await queries.getSetting(db, 'theme')).toBe('dark');
    await queries.setSetting(db, 'theme', 'dark');
    db.query.mockResolvedValueOnce([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
    expect(await queries.getAllSettings(db)).toEqual({ a: '1', b: '2' });

    await queries.upsertPlatformIdentity(db, 'pid-1', 'user-1', 'github', '42');
    await queries.getUserByPlatformId(db, 'github', '42');

    expect(await queries.createServer(db, 'srv-1', 'user-1', 'Alpha', 'hash', 'key-1')).toMatchObject({
      id: 'srv-1',
      user_id: 'user-1',
      status: 'offline',
      bound_with_key_id: 'key-1',
    });
    await queries.getServerById(db, 'srv-1');
    await queries.updateServerSharedContextRuntimeConfig(db, 'srv-1', 'user-1', {
      primaryContextModel: 'gpt-5.4',
      primaryContextPreset: 'balanced',
    });
    await queries.updateServerHeartbeat(db, 'srv-1', '2026.5.11');
    await queries.updateServerHeartbeat(db, 'srv-1');
    await queries.updateServerStatus(db, 'srv-1', 'offline');
    await queries.updateProviderStatus(db, 'srv-1', 'codex-sdk', true);
    await queries.updateProviderStatus(db, 'srv-1', 'codex-sdk', false);
    await queries.clearProviderStatus(db, 'srv-1');
    await queries.updateProviderRemoteSessions(db, 'srv-1', 'codex-sdk', [{ id: 'remote-1' }]);
    expect(await queries.updateServerName(db, 'srv-1', 'user-1', 'Renamed')).toBe(true);
    expect(await queries.updateServerToken(db, 'srv-1', 'user-1', 'hash-2', 'Renamed', 'key-2')).toBe(true);
    expect(await queries.deleteServer(db, 'srv-1', 'user-1')).toBe(true);

    db.query.mockResolvedValueOnce([{ id: 'srv-1' }]).mockResolvedValueOnce([{ id: 'srv-1' }, { id: 'srv-2' }]);
    expect(await queries.getServersByUserId(db, 'user-1')).toEqual([{ id: 'srv-1' }, { id: 'srv-2' }]);

    await queries.upsertChannelBinding(db, 'bind-1', 'srv-1', 'slack', 'C1', 'session', 'deck_alpha_brain', 'bot-1');
    await queries.getChannelBinding(db, 'slack', 'C1', 'srv-1');
    await queries.findChannelBindingByPlatformChannel(db, 'slack', 'C1', 'bot-1');

    await queries.getDbSessionsByServer(db, 'srv-1');
    await queries.upsertDbSession(
      db,
      'sid-1',
      'srv-1',
      'deck_alpha_brain',
      'Alpha',
      'brain',
      'codex-sdk',
      '/work/alpha',
      'running',
      'Alpha Brain',
      '5.4',
      'transport',
      'openai',
      'remote-1',
      'Main session',
      'gpt-5.4',
      'gpt-5.4',
      'high',
      { supervision: { mode: 'supervised' } },
    );
    await queries.deleteDbSession(db, 'srv-1', 'deck_alpha_brain');
    await queries.updateSessionLabel(db, 'srv-1', 'deck_alpha_brain', 'Main');
    await queries.updateProjectName(db, 'srv-1', 'deck_alpha_brain', 'Renamed');
    await queries.updateSession(db, 'srv-1', 'deck_alpha_brain', {});
    await queries.updateSession(db, 'srv-1', 'deck_alpha_brain', {
      label: 'Main',
      description: 'desc',
      project_dir: '/work/renamed',
      requested_model: 'gpt-5.4',
      active_model: 'gpt-5.4',
      effort: 'medium',
      transport_config: { shell: '/bin/zsh' },
    });

    await queries.upsertQuickData(db, 'user-1', { history: ['h'], commands: ['c'], phrases: ['p'], sessionHistory: {} });
    await queries.getSubSessionsByServer(db, 'srv-1');
    await queries.getSubSessionByProviderSessionId(db, 'srv-1', 'remote-1');
    await queries.getSubSessionById(db, 'sub-1', 'srv-1');
    expect(await queries.createSubSession(
      db,
      'sub-1',
      'srv-1',
      'codex-sdk',
      '/bin/bash',
      '/work/alpha',
      'Helper',
      'cc-1',
      'gem-1',
      'deck_alpha_brain',
      'transport',
      'openai',
      'remote-1',
      'Helper desc',
      'preset-1',
      'gpt-5.4',
      'gpt-5.4',
      'medium',
      { cwd: '/work/alpha' },
    )).toMatchObject({ id: 'sub-1', parent_session: 'deck_alpha_brain' });
    await queries.updateSubSession(db, 'sub-1', 'srv-1', {});
    await queries.updateSubSession(db, 'sub-1', 'srv-1', {
      label: 'Helper 2',
      closed_at: null,
      gemini_session_id: 'gem-2',
      sort_order: 2,
      description: 'updated',
      cwd: '/work/other',
      cc_preset_id: 'preset-2',
      requested_model: 'gpt-5.4',
      active_model: 'gpt-5.4',
      effort: 'high',
      transport_config: { mode: 'safe' },
    });
    await queries.reorderSubSessions(db, 'srv-1', ['sub-2', 'sub-1']);
    await queries.deleteSubSession(db, 'sub-1', 'srv-1');

    await queries.getUserPref(db, 'user-1', 'shell');
    await queries.setUserPref(db, 'user-1', 'shell', '/bin/zsh');
    await queries.deleteUserPref(db, 'user-1', 'shell');

    await queries.getDiscussionsByServer(db, 'srv-1');
    await queries.getDiscussionById(db, 'disc-1', 'srv-1');
    await queries.upsertDiscussion(db, {
      id: 'disc-1',
      serverId: 'srv-1',
      topic: 'Topic',
      state: 'running',
      maxRounds: 2,
      currentRound: 1,
      totalRounds: 2,
      completedHops: 1,
      totalHops: 3,
      currentSpeaker: 'brain',
      participants: '[]',
      filePath: '/work/discussion.md',
      conclusion: 'done',
      fileContent: 'content',
      error: null,
      startedAt: 100,
      finishedAt: 200,
    });
    await queries.insertDiscussionRound(db, {
      id: 'round-1',
      discussionId: 'disc-1',
      serverId: 'srv-1',
      round: 1,
      speakerRole: 'brain',
      speakerAgent: 'codex-sdk',
      speakerModel: 'gpt-5.4',
      response: 'hello',
    });
    await queries.getDiscussionRounds(db, 'disc-1', 'srv-1');
    const commentSnapshot = {
      target: { kind: 'server' as const, serverId: 'srv-1' },
      effectiveRole: 'viewer' as const,
      historyCutoffAt: 100,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: 200,
    };
    db.queryOne.mockResolvedValueOnce({ id: 'comment-1', server_id: 'srv-1' });
    await queries.insertDiscussionComment(db, {
      id: 'comment-1',
      serverId: 'srv-1',
      threadId: 'disc-1',
      scope: { kind: 'server', serverId: 'srv-1' },
      createdByUserId: 'user-1',
      actorEnvelope: {
        actorUserId: 'user-1',
        actorDisplayName: 'User One',
        snapshot: commentSnapshot,
        primaryShareId: 'share-1',
        effectiveActorRole: 'viewer',
        actionId: 'action-1',
        origin: 'shared-server',
        authorizedAt: 200,
      },
      authorizationSnapshot: commentSnapshot,
      body: 'comment',
      createdAt: 300,
    });
    await queries.getDiscussionCommentsByThread(db, 'srv-1', 'disc-1');

    const run: queries.DbOrchestrationRun = {
      id: 'run-1',
      discussion_id: 'disc-1',
      server_id: 'srv-1',
      main_session: 'deck_alpha_brain',
      initiator_session: 'deck_alpha_brain',
      current_target_session: 'deck_alpha_worker',
      final_return_session: 'deck_alpha_brain',
      remaining_targets: '[]',
      mode_key: 'review',
      status: 'running',
      request_message_id: 'req-1',
      callback_message_id: null,
      context_ref: '{}',
      timeout_ms: 1000,
      result_summary: null,
      error: null,
      progress_snapshot: '{}',
      created_at: '2026-05-11T00:00:00Z',
      updated_at: '2026-05-11T00:00:01Z',
      completed_at: null,
    };
    await queries.upsertOrchestrationRun(db, run);
    await queries.getOrchestrationRunsByDiscussion(db, 'disc-1', 'srv-1');
    await queries.getOrchestrationRunById(db, 'run-1', 'srv-1');
    await queries.getActiveOrchestrationRuns(db, 'srv-1');
    await queries.getRecentOrchestrationRuns(db, 'srv-1', 5);
    await queries.getShareScopedOrchestrationRunsByDiscussion(db, 'disc-1', 'srv-1');
    await queries.getShareScopedOrchestrationRunById(db, 'run-1', 'srv-1');
    await queries.getShareScopedRecentOrchestrationRuns(db, 'srv-1', 5);
    await queries.writeAuditLog(db, 'audit-1', 'user-1', 'srv-1', 'server.rename', { ok: true }, '127.0.0.1');

    expect(db.execute).toHaveBeenCalled();
    expect(db.query).toHaveBeenCalled();
    expect(db.queryOne).toHaveBeenCalled();
  });

  it('parses JSON-backed query values and session text cache rows', async () => {
    const db = makeDb();

    db.queryOne.mockResolvedValueOnce({
      shared_context_runtime_config: JSON.stringify({
        primaryContextBackend: 'openai',
        primaryContextModel: 'gpt-5.4',
        primaryContextPreset: 'balanced',
        backupContextBackend: 'openai',
        backupContextModel: 'gpt-5.4-mini',
        backupContextPreset: 'cheap',
        memoryRecallMinScore: 0.72,
        memoryScoringWeights: { similarity: 0.5, recency: 0.3, frequency: 0.1, project: 0.1 },
        enablePersonalMemorySync: true,
      }),
    });
    expect(await queries.getServerSharedContextRuntimeConfig(db, 'srv-1')).toMatchObject({
      primaryContextModel: 'gpt-5.4',
      backupContextModel: 'gpt-5.4-mini',
      enablePersonalMemorySync: true,
    });

    db.queryOne.mockResolvedValueOnce({ shared_context_runtime_config: { primaryContextModel: '  ' } });
    expect(await queries.getServerSharedContextRuntimeConfig(db, 'srv-1')).toBeNull();

    db.queryOne.mockResolvedValueOnce({ connected_providers: '{"codex-sdk":true}' });
    expect(await queries.getProviderStatus(db, 'srv-1')).toEqual({ 'codex-sdk': true });
    db.queryOne.mockResolvedValueOnce({ provider_remote_sessions: { 'codex-sdk': [{ id: 'remote-1' }] } });
    expect(await queries.getProviderRemoteSessions(db, 'srv-1')).toEqual({ 'codex-sdk': [{ id: 'remote-1' }] });

    db.queryOne.mockResolvedValueOnce({ data: '{"history":["h"],"commands":[],"phrases":[]}' });
    expect(await queries.getQuickData(db, 'user-1')).toMatchObject({ history: ['h'] });
    db.queryOne.mockResolvedValueOnce({ data: '{not json' });
    expect(await queries.getQuickData(db, 'user-1')).toEqual({ history: [], sessionHistory: {}, commands: [], phrases: [] });

    db.queryOne.mockResolvedValueOnce({
      events: JSON.stringify([{ eventId: 'evt-1', ts: 1, type: 'user.message', text: ' prompt ' }]),
    });
    expect(await queries.getSessionTextTailCache(db, 'srv-1', 'deck_alpha_brain')).toEqual([
      { eventId: 'evt-1', ts: 1, type: 'user.message', text: 'prompt' },
    ]);

    await queries.replaceSessionTextTailCache(db, 'srv-1', 'deck_alpha_brain', [
      { eventId: 'evt-2', ts: 2, type: 'assistant.text', text: 'answer' },
    ]);

    db.queryOne.mockResolvedValueOnce({ events: '[]' });
    await queries.upsertSessionTextTailCacheEvent(db, 'srv-1', {
      sessionId: 'deck_alpha_brain',
      eventId: 'evt-3',
      ts: 3,
      type: 'assistant.text',
      payload: { text: 'final answer' },
    });
    await queries.upsertSessionTextTailCacheEvent(db, 'srv-1', {
      sessionId: 'deck_alpha_brain',
      eventId: 'evt-ignored',
      ts: 4,
      type: 'assistant.text',
      payload: { text: 'partial', streaming: true },
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
