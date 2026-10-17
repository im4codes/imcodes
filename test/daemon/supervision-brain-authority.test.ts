import { describe, expect, it } from 'vitest';
import {
  isUsableSupervisionIdentity,
  supervisionIdentityMatches,
} from '../../shared/supervision-participant-authority.js';
import { resolveAuthoritativeBrainIdentity } from '../../src/daemon/supervision-brain-authority.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const brain = (
  name: string,
  options: { parentSession?: string; projectName?: string } = {},
): SessionRecord => ({
  name,
  projectName: options.projectName ?? 'alpha',
  role: 'brain',
  parentSession: options.parentSession,
  state: 'idle',
  sessionInstanceId: `${name}-instance`,
  runtimeEpoch: `${name}-epoch`,
  agentType: 'codex-sdk',
} as SessionRecord);

describe('supervision Brain authority guards', () => {
  it('rejects an empty durable sessionName before identity matching', () => {
    const empty = {
      sessionName: '   ', sessionInstanceId: 'instance', runtimeEpoch: 'epoch',
      agentType: 'codex-sdk', providerFamily: 'openai',
    };
    const valid = { ...empty, sessionName: 'deck_alpha_brain' };
    expect(isUsableSupervisionIdentity(empty)).toBe(false);
    expect(supervisionIdentityMatches(empty, valid)).toBe(false);
  });

  it('excludes a brain-role sub-session from project Brain authority', () => {
    const topLevel = brain('deck_alpha_brain');
    const nested = brain('deck_alpha_nested_brain', { parentSession: topLevel.name });
    expect(resolveAuthoritativeBrainIdentity('alpha', [nested])).toBeUndefined();
    expect(resolveAuthoritativeBrainIdentity('alpha', [nested, topLevel]))
      .toMatchObject({ sessionName: topLevel.name });
  });

  it('fails closed when multiple top-level Brains make project authority ambiguous', () => {
    expect(resolveAuthoritativeBrainIdentity('alpha', [
      brain('deck_alpha_brain_a'),
      brain('deck_alpha_brain_b'),
    ])).toBeUndefined();
  });
});
