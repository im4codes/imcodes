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
 * `setup-flow.ts.installSystemdService` had this since 2026-04 (line
 * 415); `bind-flow.ts.installSystemdService` was missing it,
 * fingerprint-mapping every server installed via `imcodes bind` to
 * the same recurring outage. Adding the line is one trivial edit, but
 * the FAILURE MODE is "silent until the user is offline for a few
 * hours" — exactly the kind of thing that regresses unnoticed if a
 * future refactor removes the call.
 *
 * jsdom-style mock-the-world tests would need a heavy execSync mock
 * harness for a single line. A source-content scan catches the
 * regression with one regex per file — cheap, deterministic, no
 * runtime dependencies on systemctl/loginctl actually existing.
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
    it(`${rel} calls loginctl enable-linger`, () => {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      // Must reference loginctl enable-linger somewhere in the file.
      // Allow both with and without an explicit user argument
      // (`loginctl enable-linger` defaults to the calling user, and
      // both call sites today rely on that default).
      expect(src).toMatch(/loginctl\s+enable-linger\b/);
      // And it must be passed to execSync (so it actually runs at
      // install time — not just in a comment).
      expect(src).toMatch(/execSync\([^)]*loginctl\s+enable-linger/);
    });
  }

  it('the contract test itself names the failure mode (so future readers know why)', () => {
    // Self-pin: if someone deletes the rationale comment, the test
    // file no longer documents the failure mode and a future reader
    // might "simplify" the install flow by removing the linger call.
    const self = readFileSync(__filename, 'utf8');
    expect(self).toMatch(/systemd-logind/);
    expect(self).toMatch(/lingering/i);
  });
});
