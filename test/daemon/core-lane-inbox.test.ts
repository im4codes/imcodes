import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreLaneInboundInbox, replayCoreLaneInbound } from '../../shared/core-lane-inbox.js';

describe('core-lane durable inbound inbox', () => {
  it('replays pending entries without recursion after a worker restart', () => {
    const seen: string[] = [];
    replayCoreLaneInbound([{ id: 'i1', commandId: 'c1', session: 'deck-a', payload: 'x', ts: 1 }], (entry) => seen.push(entry.id));
    expect(seen).toEqual(['i1']);
  });

  it('replays an fsynced handoff after a worker restart and removes it only on commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-lane-inbox-'));
    const file = join(dir, 'inbound.jsonl');
    const entry = { id: 'i1', commandId: 'c1', session: 'deck-a', payload: JSON.stringify({ type: 'session.send', commandId: 'c1', sessionName: 'deck-a', text: 'x' }), ts: Date.now() };
    const first = new CoreLaneInboundInbox(file);
    first.append(entry);
    expect(new CoreLaneInboundInbox(file).pending()).toEqual([entry]);
    expect(readFileSync(file, 'utf8')).toContain('"kind":"entry"');
    const restarted = new CoreLaneInboundInbox(file);
    restarted.acknowledge('i1');
    expect(new CoreLaneInboundInbox(file).pending()).toEqual([]);
  });
});
