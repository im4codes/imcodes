import { describe, expect, it } from 'vitest';
import { TIMELINE_DETAIL_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TimelineDetailStore, TIMELINE_DETAIL_VALUE_MAX_BYTES } from '../../src/daemon/timeline-detail-store.js';

describe('timeline detail store', () => {
  it('binds details to session, epoch, event, and field path', () => {
    const store = new TimelineDetailStore({ now: () => 1_000, ttlMs: 60_000 });
    const ref = store.put({
      sessionName: 'deck_hist',
      epoch: 2,
      eventId: 'evt-1',
      fieldPath: 'payload.output',
      value: 'full output',
      previewBytes: 1024,
    });

    expect(ref?.detailId).toMatch(/^td_/);
    expect(ref).toMatchObject({
      sessionName: 'deck_hist',
      epoch: 2,
      detailStoreGeneration: store.generation,
      eventId: 'evt-1',
      fieldPath: 'payload.output',
    });
    expect(ref).not.toHaveProperty('value');
    expect(ref).not.toHaveProperty('contentHash');

    expect(store.get({
      sessionName: 'deck_hist',
      epoch: 2,
      detailStoreGeneration: ref!.detailStoreGeneration,
      detailId: ref!.detailId,
      eventId: 'evt-1',
      fieldPath: 'payload.output',
    })).toMatchObject({
      ok: true,
      entry: { value: 'full output' },
    });

    expect(store.get({
      sessionName: 'other_session',
      epoch: 2,
      detailId: ref!.detailId,
      eventId: 'evt-1',
      fieldPath: 'payload.output',
    })).toEqual({ ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.MISSING });
    expect(store.get({
      sessionName: 'deck_hist',
      epoch: 2,
      detailStoreGeneration: 'tdg_other_generation',
      detailId: ref!.detailId,
      eventId: 'evt-1',
      fieldPath: 'payload.output',
    })).toEqual({ ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.MISSING });
    expect(store.get({
      sessionName: 'deck_hist',
      epoch: 3,
      detailStoreGeneration: ref!.detailStoreGeneration,
      detailId: ref!.detailId,
      eventId: 'evt-2',
      fieldPath: 'payload.output',
    })).toEqual({ ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.MISSING });
    expect(store.get({
      sessionName: 'deck_hist',
      epoch: 2,
      detailStoreGeneration: ref!.detailStoreGeneration,
      detailId: ref!.detailId,
      eventId: 'evt-2',
      fieldPath: 'payload.output',
    })).toEqual({ ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.MISSING });
  });

  it('expires details and reports oversized details without returning content', () => {
    let now = 1_000;
    const store = new TimelineDetailStore({ now: () => now, ttlMs: 10 });
    const expired = store.put({
      sessionName: 'deck_hist',
      epoch: 1,
      eventId: 'evt-expire',
      fieldPath: 'payload.output',
      value: 'expires',
    });
    now = 2_000;
    expect(store.get({
      sessionName: 'deck_hist',
      epoch: 1,
      detailId: expired!.detailId,
    })).toEqual({ ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.EXPIRED });

    now = 3_000;
    const oversized = store.put({
      sessionName: 'deck_hist',
      epoch: 1,
      eventId: 'evt-big',
      fieldPath: 'payload.output',
      value: 'x'.repeat(TIMELINE_DETAIL_VALUE_MAX_BYTES + 1),
    });
    expect(store.get({
      sessionName: 'deck_hist',
      epoch: 1,
      detailId: oversized!.detailId,
    })).toEqual({ ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED });
  });
});
