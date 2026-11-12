import { describe, expect, it } from 'vitest';
import { parseSyncedPreference } from '@shared/synced-preference.js';

describe('synced preference wire envelope', () => {
  it.each([{ v: [], t: 0 }, { v: null, t: 1 }, { v: ['pin'], t: Number.MAX_SAFE_INTEGER }])('accepts object/string legacy shapes: %j', (value) => {
    expect(parseSyncedPreference(value)).toEqual(value);
    expect(parseSyncedPreference(JSON.stringify(value))).toEqual(value);
  });
  it.each([null, undefined, 'not-json', [], { t: 10 }, { v: [] }, { v: [], t: '10' }, { v: [], t: NaN }, { v: [], t: Infinity }, { v: [], t: -1 }, { v: [], t: 0.1 }])('rejects malformed envelopes %j without manufacturing an empty list', (value) => {
    expect(parseSyncedPreference(value)).toBeNull();
  });
});
