import { runNative } from './support/native-exec.js';
import { readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/macos-remote-desktop-build-spike.sh');
const COMMON = resolve(ROOT, 'native', 'remote-desktop-common');
const script = readFileSync(SCRIPT_PATH, 'utf8');

/**
 * The two seams the overlay patch rewrites, reproduced exactly as they appear
 * in the pinned libwebrtc root BUILD.gn. If upstream ever changes them the
 * patch throws rather than silently producing a graph without the components,
 * so a fixture that drifts shows up as a thrown error here, not a false pass.
 */
const ROOT_BUILD_FIXTURE = [
  'group("default") {',
  '    testonly = true',
  '    deps = [ ":webrtc" ]',
  '}',
  '',
  'rtc_static_library("webrtc") {',
  '    visibility = [',
  '      "//:default",',
  '      "//:webrtc_lib_link_test",',
  '    ]',
  '}',
  '',
].join('\n');

/**
 * Extracts the script's real overlay section -- target selection, the mode
 * conditional and the patch heredoc -- and runs it verbatim.
 *
 * It executes the script's own text rather than re-describing it. Supplying the
 * target list from the test would have proved nothing about which targets the
 * script actually injects, and asserting on the source text around the heredoc
 * would not notice the patch being wrapped back inside a conditional. Both of
 * those weaker checks were written first and both stayed green against exactly
 * the regressions this file exists to catch.
 */
function extractOverlaySection(): string {
  const start = script.indexOf('OVERLAY_TARGETS=(');
  expect(start, 'overlay target selection not found').toBeGreaterThan(-1);
  const heredoc = script.indexOf("node <<'NODE'", start);
  expect(heredoc, 'overlay patch heredoc not found').toBeGreaterThan(-1);
  const end = script.indexOf('\nNODE\n', heredoc);
  expect(end, 'overlay patch heredoc is not terminated').toBeGreaterThan(-1);
  return script.slice(start, end + '\nNODE\n'.length);
}

/** The label assignments the section depends on, taken from the script. */
function extractLabelAssignments(): string {
  return script
    .split('\n')
    // AUTO_UNLOCK_GROUP_LABEL is not a *TARGET_LABEL: it names the NOT-SHIPPED
    // verification group. It must still reach the harness or the overlay section
    // aborts on an unbound variable under `set -u`.
    .filter((line) => /^(?:[A-Z_]*TARGET_(?:NAME|LABEL)|AUTO_UNLOCK_BUNDLE_NAME|AUTO_UNLOCK_GROUP_LABEL)="/u.test(line))
    .join('\n');
}

interface OverlayRun {
  status: number | null;
  stderr: string;
  rootBuild: string;
}

/**
 * Runs the real overlay section for one mode over a fixture root BUILD.gn.
 *
 * `AUTO_UNLOCK_VERIFY` is set explicitly for BOTH modes: the script runs under
 * `set -u`, and the overlay section reads that flag to decide whether the
 * NOT-SHIPPED auto-unlock verification group joins the graph. Leaving it unset
 * would abort the section on an unbound variable rather than exercise it.
 */
async function runOverlaySection(componentsOnly: boolean, autoUnlockVerify = false): Promise<OverlayRun> {
  const directory = mkdtempSync(join(tmpdir(), 'imcodes-overlay-section-'));
  try {
    const rootBuild = join(directory, 'BUILD.gn');
    writeFileSync(rootBuild, ROOT_BUILD_FIXTURE);
    const harness = join(directory, 'section.sh');
    writeFileSync(harness, [
      'set -euo pipefail',
      extractLabelAssignments(),
      `COMPONENTS_ONLY=${componentsOnly ? 'true' : 'false'}`,
      `AUTO_UNLOCK_VERIFY=${autoUnlockVerify ? 'true' : 'false'}`,
      `ROOT_BUILD=${JSON.stringify(rootBuild)}`,
      extractOverlaySection(),
      '',
    ].join('\n'));
    const run = await runNative('bash', [harness], {});
    return {
      status: run.status,
      stderr: `${run.stdout}\n${run.stderr}`,
      rootBuild: readFileSync(rootBuild, 'utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Reads a `NAME="..."` assignment out of the script, resolving one level of $VAR. */
function scriptLabel(name: string): string {
  const raw = new RegExp(`^${name}="([^"]*)"`, 'mu').exec(script);
  expect(raw, `${name} not found in the build spike script`).not.toBeNull();
  return raw![1].replace(/\$([A-Z_]+)/gu, (_match, referenced: string) => {
    const inner = new RegExp(`^${referenced}="([^"]*)"`, 'mu').exec(script);
    expect(inner, `${referenced} not found in the build spike script`).not.toBeNull();
    return inner![1];
  });
}

const SPIKE_LABEL = `//${scriptLabel('TARGET_LABEL')}`;
const SHIPPED_LABELS = [
  `//${scriptLabel('LAUNCH_AGENT_TARGET_LABEL')}`,
  `//${scriptLabel('WORKER_TARGET_LABEL')}`,
  `//${scriptLabel('DISCLOSURE_TARGET_LABEL')}`,
  `//${scriptLabel('HELPER_TARGET_LABEL')}`,
];

/** NOT a shipped component: verification-only, and only under the opt-in. */
const AUTO_UNLOCK_GROUP_LABEL = `//${scriptLabel('AUTO_UNLOCK_GROUP_LABEL')}`;

describe('macOS build spike root BUILD.gn overlay', () => {
  it('copies the exact common foundation manifest into a clean overlay', async () => {
    const commonBuild = readFileSync(resolve(COMMON, 'BUILD.gn'), 'utf8');
    const declared = [...new Set(
      [...commonBuild.matchAll(/"([^"\n]+\.(?:cc|h))"/gu)].map((match) => match[1]!),
    )].sort();
    const onDisk = readdirSync(COMMON).sort();

    expect(onDisk).toEqual(['BUILD.gn', ...declared].sort());
    const copy = script.slice(
      script.indexOf('cp -p "$REPOSITORY_ROOT/native/remote-desktop-common"'),
      script.indexOf('\n\n', script.indexOf('cp -p "$REPOSITORY_ROOT/native/remote-desktop-common"')),
    );
    expect(copy).toContain('/*.{cc,h}');
    expect(copy).toContain('/BUILD.gn"');
    expect(copy).toContain('"$COMMON_OVERLAY_DIR/"');
  });

  // ── auto-unlock is NOT SHIPPED ────────────────────────────────────────────
  // Both directions matter. Default must never put the unqualified plug-in in
  // the graph; the opt-in must actually put it there, or the pinned-toolchain
  // compile coverage it exists for is silently gone.
  it.each([[true], [false]])(
    'default mode keeps the auto-unlock group OUT of the graph (components-only=%s)',
    async (componentsOnly) => {
      const { rootBuild, status, stderr } = await runOverlaySection(componentsOnly, false);
      expect(status, stderr).toBe(0);
      expect(rootBuild, 'default build must not graph the unqualified auto-unlock group')
        .not.toContain(AUTO_UNLOCK_GROUP_LABEL);
      for (const label of SHIPPED_LABELS) expect(rootBuild).toContain(label);
    },
  );

  it.each([[true], [false]])(
    'the opt-in puts the auto-unlock group IN the graph (components-only=%s)',
    async (componentsOnly) => {
      const { rootBuild, status, stderr } = await runOverlaySection(componentsOnly, true);
      expect(status, stderr).toBe(0);
      expect(rootBuild, 'verification opt-in must graph the group or coverage is lost')
        .toContain(AUTO_UNLOCK_GROUP_LABEL);
      // The opt-in adds coverage; it must not drop any shipped component.
      for (const label of SHIPPED_LABELS) expect(rootBuild).toContain(label);
    },
  );

  it('installs the overlay in --components-only too, not only in the full probe', async () => {
    // The defect. The patch used to sit inside `if ! $COMPONENTS_ONLY`. GN only
    // generates ninja rules for targets reachable from the root, so the
    // overlay's BUILD.gn was never loaded and the run died at
    // `ninja: error: unknown target
    // third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_launch_agent`
    // -- while the mode's own help text promised every shipped component.
    const run = await runOverlaySection(true);
    expect(run.status, run.stderr).toBe(0);
    expect(
      run.rootBuild,
      'components-only left the root BUILD.gn unpatched: the overlay is not in the graph',
    ).not.toBe(ROOT_BUILD_FIXTURE);
    expect(script).toContain('this still installs the root BUILD.gn');
  });

  it('puts every shipped component in the graph in --components-only', async () => {
    const { rootBuild, status, stderr } = await runOverlaySection(true);
    expect(status, stderr).toBe(0);
    for (const label of SHIPPED_LABELS) {
      expect(rootBuild, `${label} is missing from //:default`)
        .toContain(`      "${label}",`);
    }
    expect(rootBuild).toContain('      ":webrtc",');
    // The unshipped upstream aggregate stays out of the build: skipping it is
    // the entire reason the mode exists.
    const deps = rootBuild.slice(rootBuild.indexOf('    deps = ['), rootBuild.indexOf('    ]'));
    expect(deps).not.toContain(SPIKE_LABEL);
  });

  it('adds the upstream aggregate only in the full probe', async () => {
    const { rootBuild, status, stderr } = await runOverlaySection(false);
    expect(status, stderr).toBe(0);
    const deps = rootBuild.slice(rootBuild.indexOf('    deps = ['), rootBuild.indexOf('    ]'));
    expect(deps).toContain(SPIKE_LABEL);
    for (const label of SHIPPED_LABELS) {
      expect(deps, label).toContain(label);
    }
  });

  it('keeps the :webrtc visibility seam in BOTH modes', async () => {
    // Not symmetry for its own sake. GN defines every target in a BUILD.gn once
    // that file is loaded and visibility-checks each one, so the build_spike's
    // dependency on //:webrtc is validated in --components-only too, where it
    // is never built. Dropping the seam there fails at `gn gen`, before ninja
    // is reached: "can not depend on //:webrtc ... not in //:webrtc's
    // visibility list". Confirmed against the pinned checkout, not assumed.
    for (const componentsOnly of [true, false]) {
      const { rootBuild, status, stderr } = await runOverlaySection(componentsOnly);
      expect(status, stderr).toBe(0);
      const visibility = rootBuild.slice(rootBuild.indexOf('    visibility = ['));
      expect(visibility, `components-only=${componentsOnly}`)
        .toContain(`      "${SPIKE_LABEL}",`);
    }
  });

  it('never hands ninja a label it did not put in the graph', async () => {
    // The invariant the old code broke.
    const { rootBuild } = await runOverlaySection(true);
    const ninjaBlock = script.slice(
      script.indexOf('SHIPPED_TARGET_LABELS=('),
      script.indexOf('NOTICES_OUTPUT='),
    );
    expect(ninjaBlock).toContain('"${SHIPPED_TARGET_LABELS[@]}"');
    const shippedInNinja = ninjaBlock
      .slice(0, ninjaBlock.indexOf(')'))
      .split('\n')
      .map((line) => /\$([A-Z_]+_TARGET_LABEL)/u.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
    expect(shippedInNinja.length).toBe(SHIPPED_LABELS.length);
    for (const name of shippedInNinja) {
      const label = `//${scriptLabel(name)}`;
      expect(rootBuild, `${label} handed to ninja but absent from the graph`)
        .toContain(`      "${label}",`);
    }
  });

  it('refuses to patch nothing rather than silently produce an empty graph', async () => {
    for (const label of [SPIKE_LABEL, ...SHIPPED_LABELS]) {
      expect(ROOT_BUILD_FIXTURE, label).not.toContain(label);
    }
    const directory = mkdtempSync(join(tmpdir(), 'imcodes-overlay-empty-'));
    try {
      const rootBuild = join(directory, 'BUILD.gn');
      writeFileSync(rootBuild, ROOT_BUILD_FIXTURE);
      const heredoc = script.indexOf("node <<'NODE'");
      const bodyStart = script.indexOf('\n', heredoc) + 1;
      const program = join(directory, 'patch.js');
      writeFileSync(program, script.slice(bodyStart, script.indexOf('\nNODE\n', bodyStart)));
      const run = await runNative(process.execPath, [program], {
        env: {
          ...process.env,
          ROOT_BUILD: rootBuild,
          OVERLAY_TARGETS: '',
          SPIKE_TARGET_LABEL: SPIKE_LABEL,
        },
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('inject no targets at all');
      expect(readFileSync(rootBuild, 'utf8')).toBe(ROOT_BUILD_FIXTURE);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restores the root BUILD.gn and removes the overlay on every exit path', async () => {
    // Success and failure alike: the pinned checkout is shared, and a run that
    // died holding a patched root BUILD.gn would poison every later build.
    const cleanup = script.slice(script.indexOf('cleanup() {'), script.indexOf('trap cleanup EXIT'));
    expect(cleanup).toContain('cp -p "$TEMP_DIR/BUILD.gn.original" "$ROOT_BUILD"');
    expect(cleanup).toContain('rm -rf "$OVERLAY_DIR" "$COMMON_OVERLAY_DIR" "$TEMP_DIR"');
    expect(script).toContain('trap cleanup EXIT');
    for (const signal of ['HUP', 'INT', 'TERM']) {
      expect(script, signal).toMatch(new RegExp(`trap 'exit \\d+' ${signal}`, 'u'));
    }
    expect(script.indexOf('cp -p "$ROOT_BUILD" "$TEMP_DIR/BUILD.gn.original"'))
      .toBeLessThan(script.indexOf('OVERLAY_TARGETS=('));
  });

  it('verifies the auto-unlock bundle by its exported entry point', async () => {
    // A bundle that builds but does not export AuthorizationPluginCreate loads
    // into loginwindow and then does nothing.
    expect(script).toContain('AUTO_UNLOCK_BUNDLE_NAME="aiDeskAutoUnlock.bundle"');
    expect(script).toMatch(/nm -g "\$AUTO_UNLOCK_ARTIFACT"/u);
    expect(script).toContain("grep -Fq 'AuthorizationPluginCreate'");
    // And deliberately absent from the libwebrtc notices: the bundle's whole
    // dependency closure is this project's own source_sets plus Security and
    // CoreFoundation, so it links no third-party code (nm on the built arm64
    // bundle reports zero webrtc symbols). The generator enforces an exact
    // three-executable set that the merge path re-checks, so adding it there
    // would break that contract in order to record nothing.
    expect(script).not.toContain('--target "//$AUTO_UNLOCK_TARGET_LABEL"');
    const notices = script.slice(script.indexOf('NOTICES_OUTPUT="'), script.indexOf('--output "$NOTICES_OUTPUT"'));
    expect(notices).toContain('--target "//$WORKER_TARGET_LABEL"');
    expect(notices).not.toContain('AUTO_UNLOCK');
  });
});
