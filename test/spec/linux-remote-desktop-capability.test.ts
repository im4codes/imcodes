import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Compiles and runs the Linux capability counterexamples.
 *
 * The probe is pure C++ over the shared value types with no Linux-only
 * headers, so these advertisement rules are enforced on every platform rather
 * than only on a Linux runner. The rules decide whether Linux may be
 * advertised at all, so losing them on macOS/Windows CI would be the exact
 * failure they exist to prevent.
 *
 * The real X11 injection path cannot be proven here; that lives in
 * `linux-remote-desktop-x11-qualification.cc`, which requires a Linux host
 * with an X server.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const NATIVE = join(HERE, '..', '..', 'native', 'linux-remote-desktop');
const PROBE = join(NATIVE, 'linux_capability_probe.cc');
const SELECTION = join(NATIVE, 'linux_capture_selection.cc');
const TEST = join(HERE, 'linux-remote-desktop-capability-test.cc');

function compiler(): string | null {
  for (const candidate of ['clang++', 'g++']) {
    if (spawnSync(candidate, ['--version']).status === 0) return candidate;
  }
  return null;
}

describe('linux remote desktop capability probe', () => {
  it('passes every advertisement counterexample', () => {
    const cxx = compiler();
    expect(cxx, 'a C++20 compiler is required').not.toBeNull();

    const directory = mkdtempSync(join(tmpdir(), 'imcodes-linux-capability-'));
    try {
      const binary = join(directory, 'capability');
      const build = spawnSync(cxx!, [
        '-std=c++20', '-O0', '-Wall', '-Wextra', '-Werror',
        PROBE, SELECTION, TEST, '-o', binary,
      ], { encoding: 'utf8' });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const run = spawnSync(binary, [], { encoding: 'utf8' });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('linux capability probe: ok');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('behaviorally REDs a compile-clean always-ready substitution', () => {
    const cxx = compiler();
    expect(cxx).not.toBeNull();

    const directory = mkdtempSync(join(tmpdir(), 'imcodes-linux-capability-mutant-'));
    try {
      // Replace the single decision point so every capability reports ready.
      // This compiles cleanly, so only behavior can catch it.
      const mutant = join(directory, 'mutant.cc');
      const original = readFileSync(PROBE, 'utf8');
      const mutated = original.replace(
        'return proven ? ReadinessState::kReady : ReadinessState::kUnavailable;',
        '(void)proven; return ReadinessState::kReady;',
      );
      expect(mutated, 'mutation anchor must exist').not.toBe(original);
      writeFileSync(mutant, mutated);

      const binary = join(directory, 'mutant');
      // The mutant lives outside the source tree, so its relative include of
      // the probe header has to be resolved explicitly.
      const build = spawnSync(cxx!, [
        '-std=c++20', '-O0', '-w',
        '-I', NATIVE,
        mutant, SELECTION, TEST, '-o', binary,
      ], { encoding: 'utf8' });
      expect(build.status, `mutant must compile: ${build.stderr}`).toBe(0);

      const run = spawnSync(binary, [], { encoding: 'utf8' });
      expect(run.status, 'always-ready mutant must fail a counterexample').not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
