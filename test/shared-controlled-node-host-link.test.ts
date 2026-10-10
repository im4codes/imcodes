import { describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../shared/daemon-events.js';
import {
  CONTROLLED_NODE_LOCAL_DAEMONS_MAX,
  validateControlledNodeLocalDaemonsMessage,
} from '../shared/controlled-node-host-link.js';

const type = DAEMON_MSG.CONTROLLED_NODE_LOCAL_DAEMONS;

describe('controlled node local-daemons report', () => {
  it('accepts exactly a type and a short list of plausible, distinct server ids', () => {
    expect(validateControlledNodeLocalDaemonsMessage({ type, serverIds: ['6f380811abc', 'b-2_c'] }))
      .toEqual({ type, serverIds: ['6f380811abc', 'b-2_c'] });
  });

  it.each([
    ['another type', { type: 'heartbeat', serverIds: ['a'] }],
    ['an extra field (a token must never ride along)', { type, serverIds: ['a'], token: 'x' }],
    ['no ids', { type, serverIds: [] }],
    ['a non-array', { type, serverIds: 'a' }],
    ['a non-string id', { type, serverIds: [1] }],
    ['an id with path characters', { type, serverIds: ['../etc'] }],
    ['an over-long id', { type, serverIds: ['a'.repeat(129)] }],
    ['duplicates', { type, serverIds: ['a', 'a'] }],
    ['too many ids', { type, serverIds: Array.from({ length: CONTROLLED_NODE_LOCAL_DAEMONS_MAX + 1 }, (_, i) => `id${i}`) }],
    ['null', null],
    ['an array', [type]],
  ])('rejects %s', (_label, value) => {
    expect(validateControlledNodeLocalDaemonsMessage(value)).toBeNull();
  });
});
