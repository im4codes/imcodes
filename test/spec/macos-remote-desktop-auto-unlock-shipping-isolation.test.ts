/**
 * Auto unlock must stay OUT of the default macOS shipping graph.
 *
 * 5.10-5.12 and 11.9 are unchecked, nothing is signed or installed, and there is
 * no production enroller or installer — so the feature is deliberately
 * unreachable from every shipped root while its code stays in the tree.
 *
 * These are reachability counterexamples over the real BUILD.gn, not a reading
 * of intent: a single re-added dep edge from worker/launch-agent/disclosure/
 * helper fails this suite. The mirror assertion is that the verification-only
 * group still covers every auto-unlock target, so the pinned toolchain keeps
 * compiling them — that coverage is what caught the `-fno-exceptions` defect
 * standalone clang did not reproduce.
 */
import { runNativeOrThrow } from './support/native-exec.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BUILD_GN = resolve(__dirname, '../../native/macos-remote-desktop/BUILD.gn');

/** Shipped roots the daemon/agent actually installs and runs. */
const SHIPPED_ROOTS = [
  'imcodes_remote_desktop_worker',
  'imcodes_remote_desktop_launch_agent',
  'imcodes_remote_desktop_disclosure',
  'imcodes_virtual_display_helper',
] as const;

const VERIFICATION_GROUP = 'macos_auto_unlock_all';

function parseTargets(source: string): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const target = /^\w+\("([^"]+)"\) \{([\s\S]*?)^\}/gm;
  for (let m = target.exec(source); m; m = target.exec(source)) {
    graph.set(m[1]!, new Set([...m[2]!.matchAll(/"\:([A-Za-z0-9_]+)"/g)].map((d) => d[1]!)));
  }
  return graph;
}

function reachable(graph: Map<string, Set<string>>, root: string): Set<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    const deps = graph.get(node);
    if (!deps) continue;
    seen.add(node);
    stack.push(...deps);
  }
  return seen;
}

const isAutoUnlock = (name: string): boolean =>
  name.startsWith('macos_auto_unlock') || name === 'aiDeskAutoUnlock';

describe('macOS auto-unlock shipping isolation', () => {
  const source = readFileSync(BUILD_GN, 'utf8');
  const graph = parseTargets(source);

  it('parses a non-trivial graph (guards against a vacuous pass)', async () => {
    expect(graph.size).toBeGreaterThan(30);
    expect(graph.has(VERIFICATION_GROUP)).toBe(true);
    for (const root of SHIPPED_ROOTS) expect(graph.has(root), root).toBe(true);
    // The subtree must exist, else "0 reachable" would be trivially true.
    expect([...graph.keys()].filter(isAutoUnlock).length).toBeGreaterThan(5);
  });

  it.each(SHIPPED_ROOTS)('shipped root %s reaches zero auto-unlock targets', async (root) => {
    const leaked = [...reachable(graph, root)].filter(isAutoUnlock).sort();
    expect(leaked, `${root} must not pull unqualified auto-unlock into the shipped graph`).toEqual([]);
  });

  it('the verification group still covers every declared auto-unlock target', async () => {
    const covered = new Set([...reachable(graph, VERIFICATION_GROUP)].filter(isAutoUnlock));
    const declared = [...graph.keys()].filter(isAutoUnlock).sort();
    expect(declared.filter((t) => !covered.has(t))).toEqual([]);
    expect(covered.has('aiDeskAutoUnlock')).toBe(true);
  });

  it('a default build purges any stale auto-unlock bundle from a reused out dir', async () => {
    const spike = readFileSync(resolve(__dirname, '../../scripts/macos-remote-desktop-build-spike.sh'), 'utf8');
    // Ninja keeps outputs of targets that left the graph. Without an explicit
    // purge, a bundle from an earlier verification run survives in a reused out
    // dir and reads as a shipped artifact to anything checking existence.
    expect(spike).toContain('if ! $AUTO_UNLOCK_VERIFY; then');
    expect(spike).toMatch(/rm -f "\$AUTO_UNLOCK_ARTIFACT"/u);
    // ...and it still must never be hashed into shipped provenance.
    const executable = spike.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(executable).not.toContain('hash_artifact autoUnlockBundle');
  });

  // ── public contract must not contradict the isolation ───────────────────
  //
  // Prose drifts out of sync with the graph, and a reader trusts prose. These
  // phrases each asserted the opposite of what ships, and all three survived an
  // earlier pass because only the executable lines were reviewed. Assembled at
  // runtime so this guard never matches itself.
  const CONTRADICTORY = [
    ['is a shipped', 'component too'],
    ['only artifact', 'permitted to execute'],
    ['the evidence chain', 'depends on'],
  ].map(([a, b]) => `${a} ${b}`);

  const CONTRACT_SURFACES = [
    'scripts/macos-remote-desktop-build-spike.sh',
    'test/spec/macos-remote-desktop-virtual-display-authority.test.ts',
    'test/spec/macos-remote-desktop-build.test.ts',
    'test/spec/macos-remote-desktop-build-spike-overlay.test.ts',
  ] as const;

  it.each(CONTRACT_SURFACES)('%s claims nothing that contradicts non-shipping', async (relative) => {
    const text = readFileSync(resolve(__dirname, '../../', relative), 'utf8').toLowerCase();
    for (const phrase of CONTRADICTORY) {
      expect(text, `${relative} still claims: "${phrase}"`).not.toContain(phrase);
    }
  });

  it('--print-contract publishes machine-readable non-shipping / non-qualification metadata', async () => {
    const out = await runNativeOrThrow('bash', [
      resolve(__dirname, '../../scripts/macos-remote-desktop-build-spike.sh'),
      '--print-contract',
    ], { encoding: 'utf8' });
    const contract = JSON.parse(out) as {
      targets: Record<string, string>;
      autoUnlock?: Record<string, unknown>;
    };
    const auto = contract.autoUnlock;
    // Consumers must assert this WITHOUT parsing prose.
    expect(auto, 'contract must publish an autoUnlock status block').toBeDefined();
    expect(auto!.shipped, 'shipped must be explicitly false').toBe(false);
    expect(auto!.qualified, 'qualified must be explicitly false').toBe(false);
    expect(auto!.builtByDefault).toBe(false);
    expect(auto!.inDefaultProvenance).toBe(false);
    expect(auto!.provenanceComponentCount).toBe(4);
    // The opt-in must be discoverable, or the verification path is unusable.
    expect(auto!.verificationFlag).toBe('--auto-unlock-verification');
    expect(String(auto!.verificationGroup)).toContain('macos_auto_unlock_all');
    // ...and the bundle must NOT be a default target.
    expect(Object.values(contract.targets).some((t) => t.includes('aiDeskAutoUnlock'))).toBe(false);
    expect(Object.keys(contract.targets).sort())
      .toEqual(['disclosure', 'launchAgent', 'mediaProbe', 'virtualDisplayHelper', 'worker']);
  });

  it('has no dangling local dep after the decoupling', async () => {
    const referenced = new Set([...source.matchAll(/"\:([A-Za-z0-9_]+)"/g)].map((m) => m[1]!));
    expect([...referenced].filter((r) => !graph.has(r)).sort()).toEqual([]);
  });

  it('the worker no longer carries any auto-unlock call site', async () => {
    const worker = readFileSync(
      resolve(__dirname, '../../native/macos-remote-desktop/macos_remote_desktop_worker_main.mm'),
      'utf8',
    );
    expect(worker).not.toContain('AutoUnlock');
    expect(worker).not.toContain('macos_auto_unlock');
  });
});
