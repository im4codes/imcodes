/**
 * Public node ID rules and rejection sampling. No database.
 *
 * These import the rule from the service rather than restating it, so a drifted
 * implementation fails here instead of quietly disagreeing with the allocator.
 */
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_NODE_ID_MAX,
  PUBLIC_NODE_ID_MIN,
  isAllocatablePublicNodeId,
  isProhibitedPublicNodeId,
  samplePublicNodeId,
  type PublicNodeIdRandom,
} from '../src/services/remote-desktop-host-identity.js';

/** Deterministic sampler that replays a fixed sequence, then repeats the last. */
function sequence(values: Array<number | string>): PublicNodeIdRandom {
  const queue = values.map((v) => Number(v));
  let index = 0;
  return () => {
    const value = queue[Math.min(index, queue.length - 1)];
    index += 1;
    return value;
  };
}

describe('public node ID range', () => {
  it('pins the inclusive range to the specified decimal window', () => {
    expect(PUBLIC_NODE_ID_MIN).toBe(5_000_000_000);
    expect(PUBLIC_NODE_ID_MAX).toBe(9_999_999_999);
    expect(String(PUBLIC_NODE_ID_MIN)).toHaveLength(10);
    expect(String(PUBLIC_NODE_ID_MAX)).toHaveLength(10);
  });

  it('rejects values outside the range or wrong length as unallocatable', () => {
    expect(isAllocatablePublicNodeId('4987654321')).toBe(false); // below range
    expect(isAllocatablePublicNodeId('598765432')).toBe(false); // nine digits
    expect(isAllocatablePublicNodeId('59876543210')).toBe(false); // eleven digits
    expect(isAllocatablePublicNodeId('59876a4321')).toBe(false); // non-decimal
  });
});

describe('prohibited pattern rules', () => {
  it('rejects four or more zero digits in total, even when scattered', () => {
    expect(isProhibitedPublicNodeId('5060708090')).toBe(true); // four zeros, non-adjacent
    expect(isProhibitedPublicNodeId('5000000000')).toBe(true); // range floor
    // Three scattered zeros alone must not trip this rule.
    expect(isProhibitedPublicNodeId('5306708912')).toBe(false);
  });

  it('rejects a run of four identical digits', () => {
    expect(isProhibitedPublicNodeId('5271111382')).toBe(true);
    expect(isProhibitedPublicNodeId('9999123456')).toBe(true);
    // Three in a row is allowed.
    expect(isProhibitedPublicNodeId('5271113826')).toBe(false);
  });

  it('rejects strictly ascending or descending runs of four without wrap', () => {
    expect(isProhibitedPublicNodeId('5712345839')).toBe(true); // ascending 1234
    expect(isProhibitedPublicNodeId('5765432819')).toBe(true); // descending 65432
    // A wrapping sequence (…8,9,0,1) is not a run and must pass.
    expect(isProhibitedPublicNodeId('5789012736')).toBe(false);
    // Three ascending digits is allowed.
    expect(isProhibitedPublicNodeId('5123859467')).toBe(false);
  });

  it('rejects a two- or three-digit motif spanning six or more digits', () => {
    expect(isProhibitedPublicNodeId('5312121213')).toBe(true); // "12" x3
    expect(isProhibitedPublicNodeId('5138138947')).toBe(true); // "138" x2 (six digits)
    // A motif repeated across only four digits is allowed.
    expect(isProhibitedPublicNodeId('5312125948')).toBe(false);
  });

  it('accepts an ordinary unremarkable value', () => {
    expect(isProhibitedPublicNodeId('5836294175')).toBe(false);
    expect(isAllocatablePublicNodeId('5836294175')).toBe(true);
  });
});

describe('rejection sampling', () => {
  it('skips prohibited candidates and returns the first acceptable one', () => {
    const random = sequence(['5000000000', '5271111382', '5712345839', '5836294175']);
    expect(samplePublicNodeId(random, 8)).toBe('5836294175');
  });

  it('returns null when the attempt budget is exhausted rather than falling back', () => {
    // Every draw is prohibited; the sampler must not relax the rule or increment.
    const random = sequence(['5000000000']);
    expect(samplePublicNodeId(random, 5)).toBeNull();
  });

  it('samples the inclusive upper bound as an exclusive-max call', () => {
    const seen: Array<[number, number]> = [];
    const random: PublicNodeIdRandom = (min, max) => { seen.push([min, max]); return 5_836_294_175; };
    expect(samplePublicNodeId(random, 1)).toBe('5836294175');
    expect(seen).toEqual([[PUBLIC_NODE_ID_MIN, PUBLIC_NODE_ID_MAX + 1]]);
  });
});
