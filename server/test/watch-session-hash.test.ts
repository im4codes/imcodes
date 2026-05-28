import { describe, it, expect } from 'vitest';
import { hashSessionName } from '../src/routes/watch.js';

/**
 * Privacy contract for timeline watch-route logging (descoped change
 * `timeline-catchup-cursor-coordination`, R4): raw `sessionName` (which can
 * encode project/role context) MUST NOT land in logs; only a stable hash does.
 * Pins the helper used by the 5 logger sites in watch.ts.
 */
describe('hashSessionName (timeline log privacy)', () => {
  it('produces a stable, prefixed, fixed-length hash', () => {
    const h = hashSessionName('deck_myapp_brain');
    expect(h).toBe(hashSessionName('deck_myapp_brain'));
    expect(h).toMatch(/^s_[0-9a-f]{12}$/);
  });

  it('never reveals the raw session name', () => {
    const name = 'deck_secret_project_w1';
    const h = hashSessionName(name);
    expect(h).not.toBe(name);
    expect(h.includes(name)).toBe(false);
    expect(name.includes(h.slice(2))).toBe(false);
  });

  it('hashes distinct names distinctly', () => {
    expect(hashSessionName('deck_a_brain')).not.toBe(hashSessionName('deck_b_brain'));
  });
});
