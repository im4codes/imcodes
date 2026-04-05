/**
 * @vitest-environment jsdom
 *
 * Tests for P2P status → UI state mapping function.
 * Covers the bug where 'dispatched' was mapped to 'setup' instead of 'running'.
 */
import { describe, it, expect } from 'vitest';
import { mapP2pStatusToUiState as mapP2pState } from '@shared/p2p-status.js';

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
