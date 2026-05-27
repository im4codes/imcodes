/**
 * Contract test: every code path that installs the imcodes systemd
 * `--user` service MUST also call `loginctl enable-linger`.
 *
 * Why: without lingering, systemd-logind tears down the per-user
 * `systemd --user` instance after the last session ends, and any
 * `--user` services (including imcodes) go down with it. Symptom in
 * the wild: daemon "mysteriously disappears" overnight on every
 * server set up by `imcodes bind` — exactly the 212/213/215 family of
 * incidents on 2026-05-09 ("怎么又挂了").
 *
 * The install flows share `src/util/systemd-linger.ts` so they also
 * share the explicit-user and passwordless-sudo fallback behavior
 * needed on servers where plain `loginctl enable-linger` fails.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('systemd user-service install paths must enable lingering', () => {
  // Both files install the imcodes.service unit at
  // ~/.config/systemd/user/imcodes.service. After the install, both
  // MUST call `loginctl enable-linger` so the daemon survives logout.
  const targets = [
    'src/setup/setup-flow.ts',
    'src/bind/bind-flow.ts',
  ];

  for (const rel of targets) {
    it(`${rel} calls the shared linger helper`, () => {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(src).toMatch(/enableSystemdUserLinger\(/);
      expect(src).toMatch(/formatSystemdLingerFailureMessage/);
    });
  }

  it('the shared helper tries explicit-user loginctl plus sudo fallback', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/util/systemd-linger.ts'), 'utf8');
    expect(src).toMatch(/loginctl/);
    expect(src).toMatch(/enable-linger/);
    expect(src).toMatch(/sudo/);
    expect(src).toMatch(/'-n'/);
  });

  it('the contract test itself names the failure mode (so future readers know why)', () => {
    // Self-pin: if someone deletes the rationale comment, the test
    // file no longer documents the failure mode and a future reader
    // might "simplify" the install flow by removing the linger call.
    const self = readFileSync(__filename, 'utf8');
    expect(self).toMatch(/systemd-logind/);
    expect(self).toMatch(/lingering/i);
  });
});
