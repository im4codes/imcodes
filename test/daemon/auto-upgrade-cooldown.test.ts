/**
 * Tests for `evaluateAutoUpgradeCooldown` — the rate-limiter that stops
 * server-driven auto-upgrades from cascading every time a new dev tag
 * publishes.
 *
 * Production observation (211, 2026-05-10): CI publishes every ~5 min
 * during active dev work; the server pushes daemon.upgrade on every
 * new dev tag; 4 daemons each restart for ~7 s; the human operator
 * sees "always offline" because the windows tile. Cooldown declines
 * an auto-upgrade if a previous one completed within the last
 * IMCODES_UPGRADE_COOLDOWN_MS (default 10 min).
 *
 * The cooldown MUST NOT block operator-driven pinned-version upgrades
 * (`imcodes upgrade --version X`) — those are explicit intent and
 * should always be honoured.
 *
 * Pure-function harness — file IO is injected via `readSentinel` so
 * the tests don't need a tmpdir. Production wiring in
 * handleDaemonUpgrade reads ~/.imcodes/last-upgrade-at; upgrade.sh
 * writes it on a successful step 5 health check.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAutoUpgradeCooldown } from '../../src/daemon/command-handler.js';

const MIN = 60 * 1000;
const COOLDOWN = 10 * MIN;
const NOW = 1_700_000_000_000;

describe('evaluateAutoUpgradeCooldown', () => {
  it('lets through when sentinel is missing (first install / never upgraded)', () => {
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: undefined,
      now: NOW,
      cooldownMs: COOLDOWN,
      readSentinel: () => null,
    });
    expect(v.onCooldown).toBe(false);
    expect(v.lastAt).toBeNull();
  });

  it('lets through when sentinel is unreadable garbage', () => {
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: undefined,
      now: NOW,
      cooldownMs: COOLDOWN,
      readSentinel: () => 'not-a-number-xyz',
    });
    expect(v.onCooldown).toBe(false);
  });

  it('lets through when last upgrade was OUTSIDE the cooldown window', () => {
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: undefined,
      now: NOW,
      cooldownMs: COOLDOWN,
      readSentinel: () => String(NOW - 11 * MIN),  // 11 min ago, past 10-min cooldown
    });
    expect(v.onCooldown).toBe(false);
    expect(v.lastAt).toBe(NOW - 11 * MIN);
  });

  it('blocks AND reports remaining ms when last upgrade was INSIDE the cooldown window', () => {
    const lastAt = NOW - 3 * MIN;
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: undefined,
      now: NOW,
      cooldownMs: COOLDOWN,
      readSentinel: () => String(lastAt),
    });
    expect(v.onCooldown).toBe(true);
    expect(v.lastAt).toBe(lastAt);
    expect(v.remainingMs).toBe(7 * MIN); // 10 min - 3 min elapsed = 7 min remaining
  });

  it('treats `latest` and empty-string targetVersion the same as undefined (auto)', () => {
    const lastAt = NOW - 1 * MIN;
    for (const targetVersion of [undefined, '', 'latest']) {
      const v = evaluateAutoUpgradeCooldown({
        targetVersion,
        now: NOW,
        cooldownMs: COOLDOWN,
        readSentinel: () => String(lastAt),
      });
      expect(v.onCooldown).toBe(true);
    }
  });

  it('NEVER blocks an operator-pinned targetVersion (explicit intent wins)', () => {
    const lastAt = NOW - 1 * MIN; // would otherwise block
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: '2026.5.2099-dev.2087', // pinned
      now: NOW,
      cooldownMs: COOLDOWN,
      readSentinel: () => String(lastAt),
    });
    expect(v.onCooldown).toBe(false);
  });

  it('disables itself cleanly when cooldownMs <= 0 (operator opt-out)', () => {
    // IMCODES_UPGRADE_COOLDOWN_MS=0 → effectively no cooldown.
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: undefined,
      now: NOW,
      cooldownMs: 0,
      readSentinel: () => String(NOW - 1000),
    });
    expect(v.onCooldown).toBe(false);
  });

  it('disables itself when cooldownMs is non-finite (parseInt failure)', () => {
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: undefined,
      now: NOW,
      cooldownMs: NaN,
      readSentinel: () => String(NOW - 1000),
    });
    expect(v.onCooldown).toBe(false);
  });

  it('ignores future-dated sentinels (clock skew / corrupt write)', () => {
    // If the sentinel is somehow ahead of `now` (NTP jump backwards,
    // someone manually wrote a future timestamp), don't block forever.
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: undefined,
      now: NOW,
      cooldownMs: COOLDOWN,
      readSentinel: () => String(NOW + 2 * MIN),
    });
    expect(v.onCooldown).toBe(false);
  });

  it('handles whitespace + trailing newline in sentinel content', () => {
    // upgrade.sh writes via `date +%s%3N > file`, which appends a
    // newline. Our reader must trim it.
    const lastAt = NOW - 5 * MIN;
    const v = evaluateAutoUpgradeCooldown({
      targetVersion: undefined,
      now: NOW,
      cooldownMs: COOLDOWN,
      readSentinel: () => `  ${lastAt}\n`,
    });
    expect(v.onCooldown).toBe(true);
    expect(v.lastAt).toBe(lastAt);
  });
});
