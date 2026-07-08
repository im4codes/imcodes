import { describe, it, expect } from 'vitest';
import { buildTransportResumeLaunchOpts } from '../../src/agent/transport-resume-opts.js';
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

  it('threads providerResumeId for cursor-headless / copilot-sdk / kimi-sdk', () => {
    for (const agentType of ['cursor-headless', 'copilot-sdk', 'kimi-sdk'] as const) {
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
