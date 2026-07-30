import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTransportResumeLaunchOpts,
  findLegacyProviderResumeId,
  usesDirectoryScopedSessionListing,
  usesProviderResumeId,
} from '../../src/agent/transport-resume-opts.js';
import type { SessionRecord } from '../../src/store/session-store.js';

function rec(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    name: 'deck_demo_brain',
    projectName: 'demo',
    role: 'brain',
    agentType: 'claude-code-sdk',
    projectDir: '/tmp/demo',
    runtimeType: 'transport',
    state: 'idle',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as SessionRecord;
}

describe('buildTransportResumeLaunchOpts', () => {
  it('classifies Grok with the generic provider-resume family', () => {
    expect(usesProviderResumeId('grok-sdk')).toBe(true);
    expect(usesProviderResumeId('kimi-sdk')).toBe(true);
    expect(usesProviderResumeId('opencode-sdk')).toBe(true);
    expect(usesProviderResumeId('gemini-sdk')).toBe(false);
  });

  it('carries core identity (name/projectName/role/projectDir/agentType) from the record', () => {
    const opts = buildTransportResumeLaunchOpts(rec({ name: 'deck_sub_abc', projectName: 'p', role: 'w1', projectDir: '/x' }));
    expect(opts).toMatchObject({ name: 'deck_sub_abc', projectName: 'p', role: 'w1', projectDir: '/x', agentType: 'claude-code-sdk' });
  });

  it('threads ccSessionId only for claude-code-sdk', () => {
    expect(buildTransportResumeLaunchOpts(rec({ agentType: 'claude-code-sdk', ccSessionId: 'cc-1' }))).toMatchObject({ ccSessionId: 'cc-1' });
    expect(buildTransportResumeLaunchOpts(rec({ agentType: 'codex-sdk', ccSessionId: 'cc-1' })).ccSessionId).toBeUndefined();
  });

  it('threads codexSessionId only for codex-sdk', () => {
    expect(buildTransportResumeLaunchOpts(rec({ agentType: 'codex-sdk', codexSessionId: 'cx-1' }))).toMatchObject({ codexSessionId: 'cx-1' });
    expect(buildTransportResumeLaunchOpts(rec({ agentType: 'claude-code-sdk', codexSessionId: 'cx-1' })).codexSessionId).toBeUndefined();
  });

  it('threads providerResumeId for cursor-headless / copilot-sdk / OpenCode SDK / Kimi / Grok', () => {
    for (const agentType of ['cursor-headless', 'copilot-sdk', 'opencode-sdk', 'kimi-sdk', 'grok-sdk'] as const) {
      expect(buildTransportResumeLaunchOpts(rec({ agentType, providerResumeId: 'pr-1' }))).toMatchObject({ providerResumeId: 'pr-1' });
    }
  });

  it('does not thread unproven qoder-sdk durable resume identifiers', () => {
    const opts = buildTransportResumeLaunchOpts(rec({
      agentType: 'qoder-sdk',
      providerSessionId: 'route-old',
      providerResumeId: 'resume-old',
      codexSessionId: 'codex-old',
      ccSessionId: 'cc-old',
    }));

    expect(opts.providerResumeId).toBeUndefined();
    expect(opts.bindExistingKey).toBeUndefined();
    expect(opts.codexSessionId).toBeUndefined();
    expect(opts.ccSessionId).toBeUndefined();
  });

  it('threads providerSessionId as bindExistingKey only for openclaw + qwen', () => {
    expect(buildTransportResumeLaunchOpts(rec({ agentType: 'openclaw', providerSessionId: 'key-oc' }))).toMatchObject({ bindExistingKey: 'key-oc' });
    expect(buildTransportResumeLaunchOpts(rec({ agentType: 'qwen', providerSessionId: 'key-qw' }))).toMatchObject({ bindExistingKey: 'key-qw' });
    expect(buildTransportResumeLaunchOpts(rec({ agentType: 'claude-code-sdk', providerSessionId: 'x' })).bindExistingKey).toBeUndefined();
  });

  it('preserves parentSession so a sub-session resumes attached to its parent', () => {
    expect(buildTransportResumeLaunchOpts(rec({ name: 'deck_sub_x', parentSession: 'deck_demo_brain' })))
      .toMatchObject({ parentSession: 'deck_demo_brain' });
  });
});

describe('findLegacyProviderResumeId', () => {
  it('prefers an exact persisted legacy id when it still exists remotely', () => {
    expect(findLegacyProviderResumeId(
      rec({ providerSessionId: 'remote-exact', label: 'Monitor' }),
      [
        { key: 'remote-exact', displayName: 'Different title' },
        { key: 'remote-other', displayName: 'Monitor' },
      ],
    )).toBe('remote-exact');
  });

  it('recovers one uniquely named legacy conversation', () => {
    expect(findLegacyProviderResumeId(
      rec({ name: 'deck_service_monitor', label: 'Monitor', providerSessionId: 'local-route' }),
      [
        { key: 'remote-monitor', displayName: 'Monitor' },
        { key: 'remote-worker', displayName: 'Worker' },
      ],
    )).toBe('remote-monitor');
  });

  it('fails closed when multiple remote conversations share the legacy label', () => {
    expect(findLegacyProviderResumeId(
      rec({ label: 'Monitor', providerSessionId: 'local-route' }),
      [
        { key: 'remote-monitor-1', displayName: 'Monitor' },
        { key: 'remote-monitor-2', displayName: 'Monitor' },
      ],
    )).toBeUndefined();
  });

  it('accepts only sessions from the exact expected directory', () => {
    expect(findLegacyProviderResumeId(
      rec({ label: 'Monitor', providerSessionId: 'local-route' }),
      [
        { key: 'project-a-monitor', displayName: 'Monitor', directory: '/srv/project-a' },
        { key: 'project-b-monitor', displayName: 'Monitor', directory: '/srv/project-b' },
      ],
      '/srv/project-a/',
    )).toBe('project-a-monitor');
  });

  it('treats symlinked and canonical forms of the same directory as identical', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-transport-resume-'));
    const canonical = join(root, 'canonical');
    const alias = join(root, 'alias');
    try {
      mkdirSync(canonical);
      symlinkSync(canonical, alias, 'dir');
      expect(findLegacyProviderResumeId(
        rec({ label: 'Monitor', providerSessionId: 'local-route' }),
        [{ key: 'remote-monitor', displayName: 'Monitor', directory: realpathSync(canonical) }],
        alias,
      )).toBe('remote-monitor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an exact legacy id when it belongs to another directory', () => {
    expect(findLegacyProviderResumeId(
      rec({ label: 'Monitor', providerSessionId: 'remote-exact' }),
      [
        { key: 'remote-exact', displayName: 'Monitor', directory: '/srv/other' },
      ],
      '/srv/expected',
    )).toBeUndefined();
  });

  it('fails closed when directory-scoped results omit directory metadata', () => {
    expect(findLegacyProviderResumeId(
      rec({ label: 'Monitor', providerSessionId: 'local-route' }),
      [{ key: 'remote-monitor', displayName: 'Monitor' }],
      '/srv/expected',
    )).toBeUndefined();
  });

  it('does not fall back to the store name when a user label exists', () => {
    expect(findLegacyProviderResumeId(
      rec({ name: 'deck_service_monitor', label: 'Renamed monitor', providerSessionId: 'local-route' }),
      [{ key: 'stranger', displayName: 'deck_service_monitor' }],
    )).toBeUndefined();
  });

  it('still uses the store name when no user label exists', () => {
    expect(findLegacyProviderResumeId(
      rec({ name: 'deck_service_monitor', label: undefined, providerSessionId: 'local-route' }),
      [{ key: 'legacy', displayName: 'deck_service_monitor' }],
    )).toBe('legacy');
  });
});

describe('usesDirectoryScopedSessionListing', () => {
  it('scopes every provider listing that exposes directory-aware sessions', () => {
    expect(usesDirectoryScopedSessionListing('opencode-sdk')).toBe(true);
    expect(usesDirectoryScopedSessionListing('copilot-sdk')).toBe(true);
    expect(usesDirectoryScopedSessionListing('kimi-sdk')).toBe(true);
    expect(usesDirectoryScopedSessionListing('grok-sdk')).toBe(true);
    expect(usesDirectoryScopedSessionListing('cursor-headless')).toBe(false);
  });
});
