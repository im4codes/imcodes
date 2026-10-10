import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkload, sessionName } from './load-generator.mjs';

test('workload generation is deterministic and uses guarded session names', () => {
  const first = buildWorkload({ seed: 1234 });
  const second = buildWorkload({ seed: 1234 });
  assert.deepEqual(first, second);
  assert.equal(first.sessions.length, 20);
  assert.equal(first.sessions.filter((session) => session.streaming).length, 5);
  assert.equal(first.sessions.filter((session) => !session.full).length, 10);
  assert.match(sessionName(1234, 0), /^deck_perflat_[a-z0-9-]+_(brain|w\d+)$/);
  for (const event of first.sessions.flatMap((session) => session.events)) {
    if (event.type === 'tool.result') assert.ok(event.bodyBytes >= 19_000 && event.bodyBytes <= 59_000);
  }
});
