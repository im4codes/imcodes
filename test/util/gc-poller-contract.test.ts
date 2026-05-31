/**
 * Contract test: the daemon must proactively trigger V8 major GC, and
 * the systemd / launchctl install paths must enable `--expose-gc` so
 * the trigger actually runs.
 *
 * Why: production daemon on a self-hosted server (211, 2026-05-10) hit
 * OOM at default 4 GB V8 heap every 1–9 hours. Manual SIGUSR2-driven
 * heap snapshot freed 779 MB of pending old-gen garbage in one cycle —
 * i.e. V8 was hoarding garbage waiting for major GC, until the heap
 * limit forced it (too late: a transient live-data spike during the
 * GC window aborted the process). Symptom: web UI shows daemon
 * "always offline" because every restart costs ~30 s of downtime.
 *
 * Fix has two parts that MUST stay paired:
 *   (a) lifecycle.ts startGcPoller() — periodic global.gc() call.
 *   (b) NODE_OPTIONS containing --expose-gc — without this, gc is
 *       undefined and startGcPoller is a silent no-op.
 *
 * Either one without the other is dead code. This test pins both.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('GC poller wiring', () => {
  it('lifecycle.ts defines startGcPoller and wires it from start()', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/daemon/lifecycle.ts'), 'utf8');
    expect(src).toMatch(/function startGcPoller\(/);
    // Must call global.gc (with the existence check that lets it be a no-op
    // when --expose-gc isn't enabled — defensive for dev-mode invocations).
    expect(src).toMatch(/globalThis as \{ gc\?\: \(\) => void \}/);
    // Must register a clearInterval cleanup in shutdown.
    expect(src).toMatch(/if \(gcTimer\) clearInterval\(gcTimer\)/);
    // Must be invoked from the start path next to the other pollers.
    expect(src).toMatch(/startContextMaterializationPoller[^]*startGcPoller\(\);/);
  });

  // Both install paths must include --expose-gc in NODE_OPTIONS, otherwise
  // startGcPoller silently no-ops on every fresh install.
  const INSTALL_TARGETS = [
    'src/setup/setup-flow.ts',
    'src/bind/bind-flow.ts',
  ];

  for (const rel of INSTALL_TARGETS) {
    it(`${rel} sets NODE_OPTIONS=--expose-gc in the systemd unit template`, () => {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(src).toMatch(/NODE_OPTIONS=--expose-gc/);
      // Pair with --max-old-space-size to give V8 headroom for transient
      // working-set spikes (so we never OOM between GC poll firings).
      expect(src).toMatch(/--max-old-space-size=\d{4,}/);
    });

    // The 1 GB-RSS / 247 MB-heapUsed split measured on 215 (2026-05-31) was
    // off-heap glibc malloc-arena fragmentation, NOT a V8 leak — onnxruntime
    // + sharp native thread pools scatter allocations across ~64 MB arenas
    // glibc never returns to the OS. MALLOC_ARENA_MAX=2 caps that and is the
    // global backstop; it MUST be in the unit env because glibc reads it at
    // process init (unsettable from JS). Pairs with the onnxruntime
    // intraOpNumThreads cap in src/context/embedding.ts.
    it(`${rel} sets MALLOC_ARENA_MAX=2 in the systemd unit template`, () => {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(src).toMatch(/MALLOC_ARENA_MAX=2/);
    });
  }

  it('bind-flow.ts plist includes NODE_OPTIONS in EnvironmentVariables (macOS path)', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/bind/bind-flow.ts'), 'utf8');
    // The plist template must register NODE_OPTIONS as a <key>/<string>
    // pair inside <key>EnvironmentVariables</key><dict>...</dict>.
    expect(src).toMatch(/<key>NODE_OPTIONS<\/key>[\s\S]*--expose-gc/);
  });
});
