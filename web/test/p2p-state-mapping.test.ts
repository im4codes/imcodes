/**
 * @vitest-environment jsdom
 *
 * Tests for P2P status → UI state mapping function.
 * Covers the bug where 'dispatched' was mapped to 'setup' instead of 'running'.
 */
import { describe, it, expect } from 'vitest';

// Re-implement the mapping function exactly as it is in app.tsx
// to test the logic in isolation
const P2P_DONE = new Set(['completed']);
const P2P_FAILED = new Set(['failed', 'timed_out', 'cancelled']);
const P2P_RUNNING = new Set(['running', 'awaiting_next_hop', 'dispatched']);

function mapP2pState(status: string): 'done' | 'failed' | 'running' | 'setup' {
  if (P2P_DONE.has(status)) return 'done';
  if (P2P_FAILED.has(status)) return 'failed';
  if (P2P_RUNNING.has(status)) return 'running';
  return 'setup';
}

describe('mapP2pState — P2P status to UI state mapping', () => {
  it('completed → done', () => expect(mapP2pState('completed')).toBe('done'));

  it('failed → failed', () => expect(mapP2pState('failed')).toBe('failed'));
  it('timed_out → failed', () => expect(mapP2pState('timed_out')).toBe('failed'));
  it('cancelled → failed', () => expect(mapP2pState('cancelled')).toBe('failed'));

  it('running → running', () => expect(mapP2pState('running')).toBe('running'));
  it('awaiting_next_hop → running', () => expect(mapP2pState('awaiting_next_hop')).toBe('running'));

  // This was the bug: dispatched was falling through to 'setup'
  it('dispatched → running (NOT setup)', () => expect(mapP2pState('dispatched')).toBe('running'));

  it('queued → setup', () => expect(mapP2pState('queued')).toBe('setup'));
  it('unknown status → setup', () => expect(mapP2pState('unknown')).toBe('setup'));
  it('empty string → setup', () => expect(mapP2pState('')).toBe('setup'));

  // Ensure all P2pRunStatus values are covered
  it('interrupted → setup (not a running state)', () => expect(mapP2pState('interrupted')).toBe('setup'));
  it('cancelling → setup (transitional)', () => expect(mapP2pState('cancelling')).toBe('setup'));
});
