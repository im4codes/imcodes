import { describe, expect, it } from 'vitest';
import {
  OpenSpecAutoDeliverProjectionCache,
  sanitizeOpenSpecAutoDeliverProjection,
} from '../src/openspec-auto-deliver-projection.js';

describe('OpenSpec Auto Deliver server projection sanitizer', () => {
  it('constructs a narrow allowlisted projection and redacts sensitive text', () => {
    const projection = sanitizeOpenSpecAutoDeliverProjection({
      runId: 'auto-run-1',
      changeName: 'deliver-feature',
      owningMainSessionName: 'deck_proj_brain',
      launchedFromSessionName: 'deck_sub_alpha',
      targetImplementationSessionName: 'deck_sub_alpha',
      projectionVersion: 3,
      status: 'running',
      stage: 'implementation_task_loop',
      taskStats: { total: 4, checked: 2, unchecked: 2, uncheckedLabels: ['secret'] },
      moduleScores: [
        { module: 'tests', score: 7, max_score: 10, summary: 'ran with Bearer abcdefghijklmnopqrstuvwxyz' },
      ],
      evidence: [
        { source: 'daemon', summary: 'changed /Users/k/project/file.ts', command: 'npm test', exitCode: 0 },
      ],
      validationEvidenceProvenance: ['daemon', 'implementation_reported'],
      lastMessage: 'implementation_prompt_dispatched',
      latestRepairSummary: 'removed password=hunter2 from config',
      rawPrompt: 'do not leak',
      env: { API_KEY: 'secret' },
      providerState: { token: 'secret' },
      uncheckedTaskLabels: ['raw private task label'],
    });

    expect(projection).toMatchObject({
      runId: 'auto-run-1',
      changeName: 'deliver-feature',
      owningMainSessionName: 'deck_proj_brain',
      launchedFromSessionName: 'deck_sub_alpha',
      targetImplementationSessionName: 'deck_sub_alpha',
      projectionVersion: 3,
      status: 'running',
      stage: 'implementation_task_loop',
      taskStats: { total: 4, checked: 2, unchecked: 2 },
      validationEvidenceProvenance: ['daemon', 'implementation_reported'],
      recentFinding: 'implementation_prompt_dispatched',
    });
    expect(projection?.evidence?.[0]).toMatchObject({
      source: 'daemon',
      summary: 'changed [REDACTED:path]',
      command: 'npm test',
      exitCode: 0,
    });
    expect(JSON.stringify(projection)).not.toContain('rawPrompt');
    expect(JSON.stringify(projection)).not.toContain('API_KEY');
    expect(JSON.stringify(projection)).not.toContain('hunter2');
    expect(JSON.stringify(projection)).toContain('[REDACTED:password]');
    expect(projection?.moduleScores?.[0]).toMatchObject({
      module: 'tests',
      score: 7,
      maxScore: 10,
    });
    expect(projection?.moduleScores?.[0]?.summary).toContain('[REDACTED:bearer]');
  });

  it('does not clone secret-like findings, task labels, paths, or validation output from raw projections', () => {
    const projection = sanitizeOpenSpecAutoDeliverProjection({
      runId: 'auto-run-secret-surface',
      changeName: 'deliver-feature',
      owningMainSessionName: 'deck_proj_brain',
      projectionVersion: 9,
      latestRepairSummary: 'fixed token=abc1234567890abcdef',
      recentFinding: 'blocked by password=hunter2',
      terminalReason: 'validation output had Bearer abcdefghijklmnopqrstuvwxyz',
      validationEvidenceProvenance: [
        'daemon',
        'audit_reported',
        'secret token=abc1234567890abcdef',
      ],
      moduleScores: [
        {
          module: 'implementation',
          score: 8,
          maxScore: 10,
          summary: 'path /tmp/private-token-file and password=hunter2 were found',
        },
      ],
      findings: [
        { severity: 'high', summary: 'raw secret finding token=abc1234567890abcdef' },
      ],
      uncheckedTaskLabels: ['[ ] deploy with API_KEY=secret'],
      taskLabels: ['[x] copy /Users/k/.ssh/id_rsa'],
      changedPaths: ['/Users/k/project/.env'],
      validationOutput: 'npm test printed password=hunter2',
      evidence: {
        rawOutput: 'Bearer abcdefghijklmnopqrstuvwxyz',
        files: ['/Users/k/project/.env'],
      },
    });

    expect(projection).toMatchObject({
      runId: 'auto-run-secret-surface',
      changeName: 'deliver-feature',
      owningMainSessionName: 'deck_proj_brain',
      projectionVersion: 9,
    });

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('findings');
    expect(serialized).not.toContain('uncheckedTaskLabels');
    expect(serialized).not.toContain('taskLabels');
    expect(serialized).not.toContain('changedPaths');
    expect(serialized).not.toContain('validationOutput');
    expect(serialized).not.toContain('rawOutput');
    expect(serialized).not.toContain('API_KEY');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('abc1234567890abcdef');
    expect(serialized).toContain('[REDACTED:password]');
    expect(serialized).toContain('[REDACTED:bearer]');
    expect(serialized).toContain('[REDACTED:token]');
  });

  it('rejects projections missing required routing identifiers', () => {
    expect(sanitizeOpenSpecAutoDeliverProjection({
      runId: 'run-1',
      changeName: 'change-1',
      projectionVersion: 1,
    })).toBeNull();
    expect(sanitizeOpenSpecAutoDeliverProjection({
      runId: 'run-1',
      owningMainSessionName: 'deck_proj_brain',
      projectionVersion: 1,
    })).toBeNull();
  });
});

describe('OpenSpec Auto Deliver server projection cache', () => {
  it('returns full projections only for participating sessions and conflict summaries by owner group', () => {
    const cache = new OpenSpecAutoDeliverProjectionCache();
    cache.remember({
      runId: 'run-1',
      changeName: 'change-1',
      owningMainSessionName: 'deck_proj_brain',
      launchedFromSessionName: 'deck_sub_launcher',
      targetImplementationSessionName: 'deck_sub_worker',
      projectionVersion: 1,
      status: 'running',
      stage: 'spec_audit_repair',
      latestRepairSummary: 'private repair summary',
    });

    expect(cache.getFullProjectionForSession('deck_proj_brain')?.runId).toBe('run-1');
    expect(cache.getFullProjectionForSession('deck_sub_launcher')?.runId).toBe('run-1');
    expect(cache.getFullProjectionForSession('deck_sub_worker')?.runId).toBe('run-1');
    expect(cache.getFullProjectionForSession('deck_sub_sibling')).toBeNull();

    const conflict = cache.getConflictSummaryForOwningMainSession('deck_proj_brain');
    expect(conflict).toEqual({
      runId: 'run-1',
      changeName: 'change-1',
      owningMainSessionName: 'deck_proj_brain',
      status: 'running',
      stage: 'spec_audit_repair',
      busy: true,
      reason: 'auto_deliver_active',
      conflictReason: 'auto_deliver_active',
      projectionVersion: 1,
      visibility: 'conflict',
      canStop: false,
    });
    expect(JSON.stringify(conflict)).not.toContain('private repair summary');
  });

  it('ignores stale projection versions for the same run', () => {
    const cache = new OpenSpecAutoDeliverProjectionCache();
    cache.remember({
      runId: 'run-1',
      changeName: 'change-1',
      owningMainSessionName: 'deck_proj_brain',
      projectionVersion: 5,
      stage: 'implementation_audit_repair',
    });
    cache.remember({
      runId: 'run-1',
      changeName: 'change-1',
      owningMainSessionName: 'deck_proj_brain',
      projectionVersion: 4,
      stage: 'spec_audit_repair',
    });

    expect(cache.getFullProjectionForSession('deck_proj_brain')).toMatchObject({
      projectionVersion: 5,
      stage: 'implementation_audit_repair',
    });
  });

  it('clears active projections without deleting latest terminal projections', () => {
    const cache = new OpenSpecAutoDeliverProjectionCache();
    cache.remember({
      runId: 'active-run',
      changeName: 'active-change',
      owningMainSessionName: 'deck_active_brain',
      projectionVersion: 1,
    });
    cache.remember({
      runId: 'terminal-run',
      changeName: 'terminal-change',
      owningMainSessionName: 'deck_terminal_brain',
      projectionVersion: 1,
      terminal: true,
    });

    cache.clearActive();

    expect(cache.getFullProjectionForSession('deck_active_brain')).toBeNull();
    expect(cache.getFullProjectionForSession('deck_terminal_brain')?.runId).toBe('terminal-run');
  });
});
