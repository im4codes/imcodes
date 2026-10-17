/**
 * What launchd runs for the macOS daemon: the pure decision and the plist text edit.
 * The rule these pin: the program in the plist is node ITSELF, never a script, because macOS attributes Full Disk Access to the
 * program launchd starts (measured: a script in front of node was recorded as /usr/bin/env on macOS 12.7.6).
 */
import { describe, expect, it } from 'vitest';
import {
  MACOS_DAEMON_LAUNCH,
  MACOS_LAUNCH_MIGRATION_MODE,
  MACOS_LAUNCH_PROGRAM_KIND,
  classifyMacosLaunchProgram,
  macosLaunchNeedsMigration,
  parsePlistProgramArguments,
  planMacosDaemonLaunch,
  replacePlistProgramArguments,
  xmlEscapeText,
} from '../../shared/macos-daemon-launch.js';

const facts = { node: '/opt/homebrew/bin/node', entry: '/pkg/dist/src/index.js', bootstrap: '/pkg/bin/imcodes-launch.mjs' };
const kind = MACOS_LAUNCH_PROGRAM_KIND;

describe('classifyMacosLaunchProgram', () => {
  it('a file with an interpreter line is a script whatever it is called; node is node', () => {
    expect(classifyMacosLaunchProgram({ exists: true, head: '#!', basename: 'imcodes-launch.sh' })).toBe(kind.SCRIPT);
    expect(classifyMacosLaunchProgram({ exists: true, head: '#!', basename: 'node' })).toBe(kind.SCRIPT);
    expect(classifyMacosLaunchProgram({ exists: true, head: '\xcf\xfa', basename: 'node' })).toBe(kind.NODE);
    expect(classifyMacosLaunchProgram({ exists: true, head: '\xca\xfe', basename: 'node22' })).toBe(kind.NODE);
    expect(classifyMacosLaunchProgram({ exists: true, head: '\xcf\xfa', basename: 'python3' })).toBe(kind.OTHER);
    expect(classifyMacosLaunchProgram({ exists: false, head: '', basename: 'node' })).toBe(kind.MISSING);
  });
});

describe('planMacosDaemonLaunch', () => {
  it('runs node, then the bootstrap (self-healing inside node), or the entry when the install has no bootstrap', () => {
    expect(planMacosDaemonLaunch(facts)).toEqual(['/opt/homebrew/bin/node', '/pkg/bin/imcodes-launch.mjs', 'start', '--foreground']);
    expect(planMacosDaemonLaunch({ ...facts, bootstrap: undefined })).toEqual(['/opt/homebrew/bin/node', '/pkg/dist/src/index.js', 'start', '--foreground']);
  });

  it('keeps a node binary the plist already runs (a grant made on it keeps applying) but never keeps a script', () => {
    const handMade = { programArguments: ['/usr/local/bin/node', '/pkg/dist/src/index.js', 'start', '--foreground'], kind: kind.NODE };
    expect(planMacosDaemonLaunch(facts, handMade)[0]).toBe('/usr/local/bin/node');
    const script = { programArguments: ['/pkg/bin/imcodes-launch.sh', 'start', '--foreground'], kind: kind.SCRIPT };
    expect(planMacosDaemonLaunch(facts, script)[0]).toBe('/opt/homebrew/bin/node');
    const gone = { programArguments: ['/old/nvm/v20/bin/node', 'x'], kind: kind.MISSING };
    expect(planMacosDaemonLaunch(facts, gone)[0]).toBe('/opt/homebrew/bin/node');
  });

  it('the launch target never contains the shell supervisor, whatever the existing plist said', () => {
    for (const existing of [undefined, { programArguments: ['/pkg/bin/imcodes-launch.sh'], kind: kind.SCRIPT }]) {
      const args = planMacosDaemonLaunch(facts, existing);
      expect(args.some((arg) => arg.endsWith(MACOS_DAEMON_LAUNCH.PREFLIGHT_RELATIVE.split('/').pop()!))).toBe(false);
    }
  });
});

describe('macosLaunchNeedsMigration', () => {
  const planned = planMacosDaemonLaunch(facts);
  const script = { programArguments: ['/pkg/bin/imcodes-launch.sh', 'start', '--foreground'], kind: kind.SCRIPT };
  const direct = { programArguments: ['/usr/local/bin/node', '/pkg/dist/src/index.js', 'start', '--foreground'], kind: kind.NODE };

  it('at daemon start only a script or a vanished node is fixed: a working direct-node plist (the manual fix on pro) is never touched', () => {
    expect(macosLaunchNeedsMigration(script, planned, MACOS_LAUNCH_MIGRATION_MODE.STARTUP)).toBe(true);
    expect(macosLaunchNeedsMigration({ ...direct, kind: kind.MISSING }, planned, MACOS_LAUNCH_MIGRATION_MODE.STARTUP)).toBe(true);
    expect(macosLaunchNeedsMigration(direct, planned, MACOS_LAUNCH_MIGRATION_MODE.STARTUP)).toBe(false);
    expect(macosLaunchNeedsMigration({ programArguments: ['/x/other'], kind: kind.OTHER }, planned, MACOS_LAUNCH_MIGRATION_MODE.STARTUP)).toBe(false);
  });

  it('on bind / upgrade / restart everything that differs from the generator output is brought to it, and an equal plist is left', () => {
    expect(macosLaunchNeedsMigration(direct, planMacosDaemonLaunch(facts, direct), MACOS_LAUNCH_MIGRATION_MODE.REGENERATE)).toBe(true);
    const current = { programArguments: planned, kind: kind.NODE };
    expect(macosLaunchNeedsMigration(current, planned, MACOS_LAUNCH_MIGRATION_MODE.REGENERATE)).toBe(false);
  });
});

describe('the plist ProgramArguments text edit', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>imcodes.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/pkg/bin/imcodes-launch.sh</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin</string></dict>
  <!-- a comment the user added -->
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;

  it('reads the items, unescaped', () => {
    expect(parsePlistProgramArguments(xml)).toEqual(['/pkg/bin/imcodes-launch.sh', 'start', '--foreground']);
    expect(parsePlistProgramArguments('<plist><dict><key>ProgramArguments</key><array><string>/a &amp; b/node</string></array></dict></plist>')).toEqual(['/a & b/node']);
    expect(parsePlistProgramArguments('<plist><dict></dict></plist>')).toBeUndefined();
  });

  it('replaces only that array: every other key, comment and the order stay byte for byte; a path with & < > is escaped', () => {
    const next = replacePlistProgramArguments(xml, ['/Users/a&b/node', '/pkg/bin/imcodes-launch.mjs', 'start', '--foreground'])!;
    expect(parsePlistProgramArguments(next)).toEqual(['/Users/a&b/node', '/pkg/bin/imcodes-launch.mjs', 'start', '--foreground']);
    expect(next).toContain('<string>/Users/a&amp;b/node</string>');
    expect(next.replace(/<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/u, '')).toBe(xml.replace(/<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/u, ''));
    expect(replacePlistProgramArguments('<plist><dict></dict></plist>', ['x'])).toBeUndefined();
    expect(xmlEscapeText('a&b<c>')).toBe('a&amp;b&lt;c&gt;');
  });
});
