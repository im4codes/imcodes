/**
 * The web dialogs offer a filtered agent-type list when "custom provider SDK"
 * is on. That list has to match the types the daemon can actually resolve a
 * preset for.
 *
 * A drift here is silent and user-visible in the worst way: the dropdown offers
 * a type, the session starts, and the preset is quietly ignored — or the type
 * is snapped back to `claude-code-sdk` and the user gets a different agent than
 * the one they picked. Neither throws.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUSTOM_PROVIDER_SDK_AGENT_TYPES } from '../../shared/cc-presets.js';

const ROOT = join(import.meta.dirname, '..', '..');

describe('custom provider SDK agent types', () => {
  it('is the single source of truth — no dialog redefines it', () => {
    for (const file of [
      'web/src/components/NewSessionDialog.tsx',
      'web/src/components/StartSubSessionDialog.tsx',
    ]) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src).not.toMatch(/const\s+CUSTOM_PROVIDER_SDK_AGENT_TYPES\s*[:=]/);
      expect(src).toMatch(/CUSTOM_PROVIDER_SDK_AGENT_TYPES/);
    }
  });

  it('matches the agent types the daemon resolves presets for', () => {
    const src = readFileSync(join(ROOT, 'src/agent/session-manager.ts'), 'utf8');
    // Scoped to lines that actually mention `ccPreset`. Matching the whole file
    // is useless: `session-manager` branches on nearly every agent type for
    // unrelated reasons, so a plain search reports success for any type at all.
    const presetBranches = new Set(
      src
        .split('\n')
        .filter((line) => line.includes('ccPreset'))
        .flatMap((line) => [...line.matchAll(/agentType === '([a-z-]+)'/g)].map((m) => m[1])),
    );

    for (const agentType of CUSTOM_PROVIDER_SDK_AGENT_TYPES) {
      expect(
        presetBranches.has(agentType),
        `${agentType} is offered in the dialogs but no daemon preset branch handles it`,
      ).toBe(true);
    }
  });

  it('covers the transports that build preset transport configs', () => {
    // Preset-to-transport-config builders exist per provider; each one's
    // provider must be offered, or the daemon supports a preset the user can
    // never select.
    const presets = readFileSync(join(ROOT, 'src/daemon/cc-presets.ts'), 'utf8');
    if (presets.includes('getQwenPresetTransportConfig')) {
      expect(CUSTOM_PROVIDER_SDK_AGENT_TYPES.has('qwen')).toBe(true);
    }
    if (presets.includes('getDshPresetTransportConfig')) {
      expect(CUSTOM_PROVIDER_SDK_AGENT_TYPES.has('deepseek-harness')).toBe(true);
    }
    if (presets.includes('getPiPresetTransportConfig')) {
      expect(CUSTOM_PROVIDER_SDK_AGENT_TYPES.has('pi')).toBe(true);
    }
  });
});
