import { describe, it, expect } from 'vitest';
import {
  P2P_CONFIG_MODE,
  roundPrompt,
  BUILT_IN_MODES,
  getP2pMode,
} from '../../shared/p2p-modes.js';
import type { P2pSavedConfig, P2pSessionConfig, P2pSessionEntry } from '../../shared/p2p-modes.js';

describe('P2P_CONFIG_MODE', () => {
  it('is "config"', () => {
    expect(P2P_CONFIG_MODE).toBe('config');
  });
});

describe('roundPrompt', () => {
  it('returns empty string for single round', () => {
    expect(roundPrompt(1, 1)).toBe('');
  });

  it('returns empty string for zero totalRounds', () => {
    expect(roundPrompt(1, 0)).toBe('');
  });

  it('round 1 of multi-round mentions Initial Analysis', () => {
    const prompt = roundPrompt(1, 3);
    expect(prompt).toContain('Round 1/3');
    expect(prompt).toContain('Initial Analysis');
  });

  it('round 1 of multi-round asks for initial analysis based on original request', () => {
    const prompt = roundPrompt(1, 3);
    expect(prompt).toContain('initial analysis');
  });

  it('round 2 mentions Deepening', () => {
    const prompt = roundPrompt(2, 3);
    expect(prompt).toContain('Round 2/3');
    expect(prompt).toContain('Deepening');
  });

  it('round 2+ instructs not to repeat prior conclusions', () => {
    const prompt = roundPrompt(2, 3);
    expect(prompt).toMatch(/NOT repeat|Do NOT repeat/i);
  });

  it('round 3 of 3 produces Deepening heading', () => {
    const prompt = roundPrompt(3, 3);
    expect(prompt).toContain('Round 3/3');
    expect(prompt).toContain('Deepening');
  });

  it('round 2 of 5 contains correct fraction', () => {
    const prompt = roundPrompt(2, 5);
    expect(prompt).toContain('2/5');
  });

  it('round 1 of 2 ends with double newline', () => {
    const prompt = roundPrompt(1, 2);
    expect(prompt.endsWith('\n\n')).toBe(true);
  });

  it('round 2 of 2 ends with double newline', () => {
    const prompt = roundPrompt(2, 2);
    expect(prompt.endsWith('\n\n')).toBe(true);
  });
});

describe('P2pSavedConfig shape', () => {
  it('basic config round-trips through typed assignment', () => {
    const config: P2pSavedConfig = {
      sessions: {
        'deck_proj_w1': { enabled: true, mode: 'audit' },
        'deck_proj_w2': { enabled: false, mode: 'skip' },
      },
      rounds: 3,
    };
    expect(config.rounds).toBe(3);
    expect(config.sessions['deck_proj_w1'].enabled).toBe(true);
    expect(config.sessions['deck_proj_w1'].mode).toBe('audit');
    expect(config.sessions['deck_proj_w2'].enabled).toBe(false);
    expect(config.sessions['deck_proj_w2'].mode).toBe('skip');
  });

  it('supports all valid modes as strings', () => {
    const modes = ['audit', 'review', 'brainstorm', 'discuss', 'skip'];
    for (const mode of modes) {
      const entry: P2pSessionEntry = { enabled: true, mode };
      expect(entry.mode).toBe(mode);
    }
  });

  it('P2pSessionConfig is an empty record by default', () => {
    const cfg: P2pSessionConfig = {};
    expect(Object.keys(cfg).length).toBe(0);
  });

  it('rounds can be 1', () => {
    const config: P2pSavedConfig = { sessions: {}, rounds: 1 };
    expect(config.rounds).toBe(1);
  });
});

describe('BUILT_IN_MODES', () => {
  it('contains audit, review, brainstorm, discuss', () => {
    const keys = BUILT_IN_MODES.map((m) => m.key);
    expect(keys).toContain('audit');
    expect(keys).toContain('review');
    expect(keys).toContain('brainstorm');
    expect(keys).toContain('discuss');
  });

  it('does not contain skip as a built-in mode', () => {
    const keys = BUILT_IN_MODES.map((m) => m.key);
    expect(keys).not.toContain('skip');
  });

  it('each mode has a non-empty prompt', () => {
    for (const mode of BUILT_IN_MODES) {
      expect(mode.prompt.length).toBeGreaterThan(0);
    }
  });

  it('each mode has a positive defaultTimeoutMs', () => {
    for (const mode of BUILT_IN_MODES) {
      expect(mode.defaultTimeoutMs).toBeGreaterThan(0);
    }
  });

  it('audit mode has callbackRequired=true', () => {
    const audit = getP2pMode('audit');
    expect(audit).toBeDefined();
    expect(audit!.callbackRequired).toBe(true);
  });

  it('brainstorm mode has resultStyle free-form', () => {
    const brainstorm = getP2pMode('brainstorm');
    expect(brainstorm).toBeDefined();
    expect(brainstorm!.resultStyle).toBe('free-form');
  });

  it('discuss mode has resultStyle summary-first', () => {
    const discuss = getP2pMode('discuss');
    expect(discuss!.resultStyle).toBe('summary-first');
  });
});

describe('getP2pMode', () => {
  it('returns mode for known key', () => {
    const mode = getP2pMode('audit');
    expect(mode).toBeDefined();
    expect(mode!.key).toBe('audit');
  });

  it('returns undefined for unknown key', () => {
    expect(getP2pMode('nonexistent')).toBeUndefined();
  });

  it('returns undefined for "skip" (not a built-in mode)', () => {
    expect(getP2pMode('skip')).toBeUndefined();
  });

  it('returns undefined for P2P_CONFIG_MODE', () => {
    expect(getP2pMode(P2P_CONFIG_MODE)).toBeUndefined();
  });
});
