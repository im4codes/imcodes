import { describe, expect, it } from 'vitest';
import {
  CODEX_FAST_OFF_COMMAND,
  CODEX_FAST_ON_COMMAND,
  CODEX_SERVICE_TIER,
  classifyCodexFastCommand,
  isCodexFastServiceTier,
} from '../../shared/codex-service-tier.js';

describe('codex service tier', () => {
  it('leaves Codex\'s own bare /fast alone', () => {
    // Codex owns `/fast`; typing it means the Codex toggle, not this product's
    // switch. Claiming it here would be exactly the interception the transport
    // contract forbids for SDK-native commands.
    expect(classifyCodexFastCommand('/fast')).toBeNull();
    expect(classifyCodexFastCommand('/fast ')).toBeNull();
  });

  it('classifies the explicit switch in both directions', () => {
    expect(classifyCodexFastCommand(CODEX_FAST_OFF_COMMAND)).toBe(CODEX_SERVICE_TIER.DEFAULT);
    expect(classifyCodexFastCommand(CODEX_FAST_ON_COMMAND)).toBe(CODEX_SERVICE_TIER.FAST);
    expect(classifyCodexFastCommand('  /FAST Off  ')).toBe(CODEX_SERVICE_TIER.DEFAULT);
  });

  it('ignores prose that merely mentions the command', () => {
    expect(classifyCodexFastCommand('run /fast off after the build')).toBeNull();
    expect(classifyCodexFastCommand('/fastoff')).toBeNull();
    expect(classifyCodexFastCommand('/fast offline')).toBeNull();
  });

  it('recognises only the tier Codex bills faster', () => {
    expect(isCodexFastServiceTier(CODEX_SERVICE_TIER.FAST)).toBe(true);
    expect(isCodexFastServiceTier(CODEX_SERVICE_TIER.DEFAULT)).toBe(false);
    expect(isCodexFastServiceTier(null)).toBe(false);
    expect(isCodexFastServiceTier(undefined)).toBe(false);
  });
});
