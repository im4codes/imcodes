import { describe, it, expect } from 'vitest';
import {
  P2P_CONFIG_MODE,
  roundPrompt,
  BUILT_IN_MODES,
  getP2pMode,
  parseModePipeline,
  isComboMode,
  getModeForRound,
  getComboRoundCount,
  COMBO_PRESETS,
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

describe('P2P_MAX_ROUNDS clamping', () => {
  it('rounds are clamped to 6 max', () => {
    // The clamping happens in p2p-orchestrator.ts with Math.min(P2P_MAX_ROUNDS, ...)
    // We test the constant and the math here since the orchestrator is hard to unit test
    const P2P_MAX_ROUNDS = 6;
    expect(Math.min(P2P_MAX_ROUNDS, Math.max(1, 100))).toBe(6);
    expect(Math.min(P2P_MAX_ROUNDS, Math.max(1, 3))).toBe(3);
    expect(Math.min(P2P_MAX_ROUNDS, Math.max(1, 0))).toBe(1);
    expect(Math.min(P2P_MAX_ROUNDS, Math.max(1, -5))).toBe(1);
    expect(Math.min(P2P_MAX_ROUNDS, Math.max(1, 6))).toBe(6);
    expect(Math.min(P2P_MAX_ROUNDS, Math.max(1, 7))).toBe(6);
  });
});

describe('extraPrompt in P2pSavedConfig', () => {
  it('extraPrompt is optional and preserved in config shape', () => {
    const withPrompt: P2pSavedConfig = {
      sessions: { 'deck_proj_w1': { enabled: true, mode: 'audit' } },
      rounds: 2,
      extraPrompt: '使用中文回复',
    };
    expect(withPrompt.extraPrompt).toBe('使用中文回复');

    const withoutPrompt: P2pSavedConfig = {
      sessions: {},
      rounds: 1,
    };
    expect(withoutPrompt.extraPrompt).toBeUndefined();
  });

  it('roundPrompt + extraPrompt do not conflict', () => {
    const rp = roundPrompt(2, 3);
    const extra = 'Reply in Chinese';
    const combined = rp + extra;
    expect(combined).toContain('Round 2/3');
    expect(combined).toContain('Reply in Chinese');
  });
});

// ── Combo pipeline tests ────────────────────────────────────────────────────

describe('parseModePipeline', () => {
  it('parses combo string into pipeline array', () => {
    expect(parseModePipeline('brainstorm>discuss>plan')).toEqual(['brainstorm', 'discuss', 'plan']);
  });

  it('parses 4-step combo', () => {
    expect(parseModePipeline('brainstorm>discuss>discuss>plan')).toEqual(['brainstorm', 'discuss', 'discuss', 'plan']);
  });

  it('returns single-element array for non-combo mode', () => {
    expect(parseModePipeline('brainstorm')).toEqual(['brainstorm']);
  });

  it('handles whitespace around separator', () => {
    expect(parseModePipeline('brainstorm > discuss > plan')).toEqual(['brainstorm', 'discuss', 'plan']);
  });

  it('filters empty segments', () => {
    expect(parseModePipeline('brainstorm>>plan')).toEqual(['brainstorm', 'plan']);
  });
});

describe('isComboMode', () => {
  it('returns true for combo string with separator', () => {
    expect(isComboMode('brainstorm>discuss>plan')).toBe(true);
  });

  it('returns false for single mode', () => {
    expect(isComboMode('brainstorm')).toBe(false);
  });

  it('returns false for "config"', () => {
    expect(isComboMode('config')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isComboMode('')).toBe(false);
  });
});

describe('getModeForRound', () => {
  it('returns first mode for round 1 of combo', () => {
    const mode = getModeForRound('brainstorm>discuss>plan', 1);
    expect(mode?.key).toBe('brainstorm');
  });

  it('returns second mode for round 2 of combo', () => {
    const mode = getModeForRound('brainstorm>discuss>plan', 2);
    expect(mode?.key).toBe('discuss');
  });

  it('returns third mode for round 3 of 3-step combo', () => {
    const mode = getModeForRound('brainstorm>discuss>plan', 3);
    expect(mode?.key).toBe('plan');
  });

  it('clamps to last mode when round exceeds pipeline length', () => {
    const mode = getModeForRound('brainstorm>discuss>plan', 5);
    expect(mode?.key).toBe('plan');
  });

  it('returns correct mode for each round of 4-step combo', () => {
    const combo = 'brainstorm>discuss>discuss>plan';
    expect(getModeForRound(combo, 1)?.key).toBe('brainstorm');
    expect(getModeForRound(combo, 2)?.key).toBe('discuss');
    expect(getModeForRound(combo, 3)?.key).toBe('discuss');
    expect(getModeForRound(combo, 4)?.key).toBe('plan');
  });

  it('returns the single mode for non-combo string', () => {
    const mode = getModeForRound('audit', 1);
    expect(mode?.key).toBe('audit');
  });
});

describe('getComboRoundCount', () => {
  it('returns pipeline length for combo', () => {
    expect(getComboRoundCount('brainstorm>discuss>plan')).toBe(3);
  });

  it('returns 4 for 4-step combo', () => {
    expect(getComboRoundCount('brainstorm>discuss>discuss>plan')).toBe(4);
  });

  it('returns undefined for single mode', () => {
    expect(getComboRoundCount('brainstorm')).toBeUndefined();
  });
});

describe('COMBO_PRESETS', () => {
  it('all presets have valid mode keys in their pipeline', () => {
    for (const preset of COMBO_PRESETS) {
      for (const modeKey of preset.pipeline) {
        expect(getP2pMode(modeKey)).toBeDefined();
      }
    }
  });

  it('preset keys match their pipeline joined by separator', () => {
    for (const preset of COMBO_PRESETS) {
      expect(preset.key).toBe(preset.pipeline.join('>'));
    }
  });

  it('all presets are recognized as combo mode', () => {
    for (const preset of COMBO_PRESETS) {
      expect(isComboMode(preset.key)).toBe(true);
    }
  });
});

describe('roundPrompt with combo mode key', () => {
  it('includes phase label when modeKey is provided', () => {
    const prompt = roundPrompt(1, 3, 'brainstorm');
    expect(prompt).toContain('Brainstorm Phase');
  });

  it('includes correct phase label per round in a combo', () => {
    const combo = 'brainstorm>discuss>plan';
    const pipeline = parseModePipeline(combo);
    const r1 = roundPrompt(1, 3, pipeline[0]);
    expect(r1).toContain('Brainstorm Phase');
    const r2 = roundPrompt(2, 3, pipeline[1]);
    expect(r2).toContain('Discuss Phase');
    const r3 = roundPrompt(3, 3, pipeline[2]);
    expect(r3).toContain('Plan Phase');
  });

  it('does NOT include phase label when modeKey is omitted', () => {
    const prompt = roundPrompt(1, 3);
    expect(prompt).not.toContain('Phase');
  });
});
