import { describe, expect, it } from 'vitest';
import { canReadTaskPairTitle, TASK_PAIR_TITLE_ACCESS_MAX_USERS } from '../../shared/task-pair-title-access.js';

const actor = { serverId: 'server-a', userId: 'alice' };
const grant = { version: 1, serverId: 'server-a', userIds: ['alice'] };
describe('title-only task authorization', () => {
  it('accepts the exact authorized user and server', () => expect(canReadTaskPairTitle(grant, actor)).toBe(true));
  it.each([
    undefined, {}, { ...grant, version: 2 }, { ...grant, serverId: 'server-b' },
    { ...grant, userIds: ['bob'] }, { ...grant, userIds: ['alice', null] },
    { ...grant, userIds: Array(TASK_PAIR_TITLE_ACCESS_MAX_USERS + 1).fill('alice') },
  ])('keeps legacy/unknown/malformed/foreign grants private: %j', (value) => expect(canReadTaskPairTitle(value, actor)).toBe(false));
  it('requires an identified actor, not just a session role', () => expect(canReadTaskPairTitle(grant, undefined)).toBe(false));
  it('accepts the maximum-sized grant', () => expect(canReadTaskPairTitle({ ...grant, userIds: ['alice', ...Array(63).fill('bob')] }, actor)).toBe(true));
});
