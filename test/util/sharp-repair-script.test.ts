import { describe, expect, it } from 'vitest';
import {
  SHARP_REQUIRED_DEPS,
  buildBashSharpRepair,
  buildBatchSharpRepair,
} from '../../src/util/sharp-repair-script.js';

describe('SHARP_REQUIRED_DEPS', () => {
  // Anchored against sharp@0.34.5's actual `dependencies` field. If this
  // ever drifts (e.g. sharp drops detect-libc) update both this constant
  // and the upgrade-time install to a matching sharp version.
  it('lists sharp itself plus each runtime dep that left empty placeholders in 2026.4', () => {
    expect(SHARP_REQUIRED_DEPS).toEqual(['sharp', 'detect-libc', 'semver', '@img/colour']);
  });
});

describe('buildBashSharpRepair', () => {
  const block = buildBashSharpRepair();

  it('checks every required dep, not just sharp/package.json', () => {
    // Regression: 2026.4.1948-dev.1927 only checked sharp/package.json,
    // missed detect-libc / semver / @img/colour as empty dirs, daemon
    // still crashed on `Cannot find module 'detect-libc'`.
    for (const dep of SHARP_REQUIRED_DEPS) {
      expect(block).toContain(`/imcodes/node_modules/$dep/package.json`);
      expect(block).toContain(dep);
    }
  });

  it('iterates the full dep list inside the for-loop', () => {
    expect(block).toContain(`for dep in ${SHARP_REQUIRED_DEPS.join(' ')}`);
  });

  it('breaks out of the check loop on the first missing dep', () => {
    expect(block).toMatch(/SHARP_BROKEN=1[\s\S]*?SHARP_BROKEN_DEP="\$dep"[\s\S]*?break/);
  });

  it('runs the nested npm install only when SHARP_BROKEN flag is set', () => {
    const repairIdx = block.indexOf('install --no-save --ignore-scripts sharp@0.34.5');
    const guardIdx = block.indexOf('if [ "$SHARP_BROKEN" = "1" ]');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(repairIdx).toBeGreaterThan(guardIdx);
  });

  it('cleans up empty placeholder dirs before the nested install', () => {
    // npm install will refuse to repopulate a dir that exists with bad
    // metadata; rmdir fails silently if the dir is non-empty (real
    // installs) — exactly what we want.
    const cleanupIdx = block.indexOf('rmdir');
    const installIdx = block.indexOf('install --no-save');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(installIdx);
  });

  it('logs success and failure under the same step prefix for grep-ability', () => {
    expect(block).toContain('[step 2.1] sharp repair succeeded');
    expect(block).toContain('[step 2.1] sharp repair FAILED');
  });

  it('embeds the failing dep name in the diagnostic log line', () => {
    // Operators reading upgrade.log need to see WHICH dep was empty,
    // not just "something was wrong".
    expect(block).toContain('${SHARP_BROKEN_DEP}');
  });
});

describe('buildBatchSharpRepair', () => {
  const block = buildBatchSharpRepair({ npmCmd: 'C:\\Program Files\\nodejs\\npm.cmd' });

  it('emits CRLF line endings (Windows batch is line-ending-sensitive)', () => {
    // Each non-blank line must end with \r before \n, otherwise cmd.exe
    // sometimes parses tokens across lines.
    const lines = block.split('\n');
    // Last line in the join may be empty due to trailing \n — skip it.
    for (const line of lines.slice(0, -1)) {
      expect(line.endsWith('\r')).toBe(true);
    }
  });

  it('checks every required dep with an explicit `if not exist` block', () => {
    // Batch's quoted-token semantics make a runtime loop fragile, so we
    // unroll the check at build time.
    for (const dep of SHARP_REQUIRED_DEPS) {
      const winDep = dep.replace(/\//g, '\\');
      expect(block).toContain(`\\node_modules\\${winDep}\\package.json`);
    }
  });

  it('translates @img/colour to @img\\colour for Windows path semantics', () => {
    // POSIX uses /, Windows uses \. The check has to use the OS-native
    // path separator or `if not exist` returns a false negative.
    expect(block).toContain('\\node_modules\\@img\\colour\\package.json');
    expect(block).not.toContain('node_modules\\@img/colour');
  });

  it('uses delayed expansion (!VAR!) so the per-iteration flag updates take effect', () => {
    expect(block).toContain('!SHARP_BROKEN!');
    expect(block).toContain('!SHARP_BROKEN_DEP!');
    expect(block).toContain('!GLOBAL_ROOT_CHECK!');
  });

  it('runs the nested install only when SHARP_BROKEN flag is set', () => {
    const guardIdx = block.indexOf('if "!SHARP_BROKEN!"=="1"');
    const installIdx = block.indexOf('install --no-save --ignore-scripts sharp@0.34.5');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(guardIdx);
  });

  it('logs the broken dep name into upgrade.log for post-mortem grep', () => {
    expect(block).toContain('!SHARP_BROKEN_DEP!');
    expect(block).toContain('repairing via nested npm install');
  });

  it('clears prior values of SHARP_BROKEN / SHARP_BROKEN_DEP / GLOBAL_ROOT_CHECK before reuse', () => {
    // Without `set "VAR="` the prior upgrade run's leftover env can
    // poison this run (e.g. SHARP_BROKEN=1 from last time → unconditional
    // repair on a clean install).
    expect(block).toContain('set "GLOBAL_ROOT_CHECK="');
    expect(block).toContain('set "SHARP_BROKEN="');
    expect(block).toContain('set "SHARP_BROKEN_DEP="');
  });

  it('respects the npmCmd argument (different on each Windows install)', () => {
    const customNpm = 'D:\\custom\\node\\npm.cmd';
    const customBlock = buildBatchSharpRepair({ npmCmd: customNpm });
    expect(customBlock).toContain(customNpm);
  });
});
