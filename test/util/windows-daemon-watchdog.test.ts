import { describe, expect, it } from 'vitest';

import {
  canonicalWatchdogPath,
  daemonCommandLineMatchesHome,
  parseDaemonProcessListing,
  parseWatchdogProcessListing,
  watchdogCommandLineMatchesHome,
} from '../../src/util/windows-daemon-watchdog.mjs';

const defaultHome = 'C:\\Users\\tester\\.imcodes';
const scopedA = 'C:\\Temp\\lock\\.imcodes';
const scopedB = 'C:\\Temp\\lock2\\.imcodes';

describe('Windows watchdog home matcher', () => {
  it('isolates default and scoped A/B artifacts in both directions', () => {
    const defaultCommand = `cmd.exe /c "${canonicalWatchdogPath(defaultHome)}"`;
    const aCommand = `cmd.exe /c "${canonicalWatchdogPath(scopedA)}"`;
    const bCommand = `cmd.exe /c "${canonicalWatchdogPath(scopedB)}"`;
    expect(watchdogCommandLineMatchesHome(defaultCommand, defaultHome, defaultHome)).toBe(true);
    expect(watchdogCommandLineMatchesHome(aCommand, defaultHome, defaultHome)).toBe(false);
    expect(watchdogCommandLineMatchesHome(defaultCommand, scopedA, defaultHome)).toBe(false);
    expect(watchdogCommandLineMatchesHome(aCommand, scopedA, defaultHome)).toBe(true);
    expect(watchdogCommandLineMatchesHome(bCommand, scopedA, defaultHome)).toBe(false);
    expect(watchdogCommandLineMatchesHome(aCommand, scopedB, defaultHome)).toBe(false);
  });

  it('retains only the default-home no-path legacy exception', () => {
    const legacy = 'cmd.exe /c "daemon-watchdog.cmd"';
    expect(watchdogCommandLineMatchesHome(legacy, defaultHome, defaultHome)).toBe(true);
    expect(watchdogCommandLineMatchesHome(legacy, scopedA, defaultHome)).toBe(false);
  });

  it('does not confuse prefix-related homes', () => {
    const bCommand = `cmd.exe /c "${canonicalWatchdogPath(scopedB)}"`;
    expect(watchdogCommandLineMatchesHome(bCommand, scopedA, defaultHome)).toBe(false);
    expect(watchdogCommandLineMatchesHome(bCommand, scopedB, defaultHome)).toBe(true);
  });

  it('filters process listings through the same matcher', () => {
    const output = [
      `101\tcmd.exe /c "${canonicalWatchdogPath(defaultHome)}"`,
      `102\tcmd.exe /c "${canonicalWatchdogPath(scopedA)}"`,
      `103\tcmd.exe /c "daemon-watchdog.cmd"`,
    ].join('\n');
    expect(parseWatchdogProcessListing(output, defaultHome, defaultHome)).toEqual([101, 103]);
    expect(parseWatchdogProcessListing(output, scopedA, defaultHome)).toEqual([102]);
  });

  it('isolates daemon process listings by canonical state home in both directions', () => {
    const defaultDaemon = `node.exe node_modules\\imcodes\\dist\\src\\index.js --home "${defaultHome}"`;
    const aDaemon = `node.exe node_modules\\imcodes\\dist\\src\\index.js --home "${scopedA}"`;
    const bDaemon = `node.exe node_modules\\imcodes\\dist\\src\\index.js --home "${scopedB}"`;
    expect(daemonCommandLineMatchesHome(defaultDaemon, defaultHome, defaultHome)).toBe(true);
    expect(daemonCommandLineMatchesHome(aDaemon, defaultHome, defaultHome)).toBe(false);
    expect(daemonCommandLineMatchesHome(aDaemon, scopedA, defaultHome)).toBe(true);
    expect(daemonCommandLineMatchesHome(bDaemon, scopedA, defaultHome)).toBe(false);
    expect(daemonCommandLineMatchesHome(bDaemon, scopedB, defaultHome)).toBe(true);
    // A package path without a state-home identity is never safe to kill.
    expect(daemonCommandLineMatchesHome(
      'node.exe node_modules\\imcodes\\dist\\src\\index.js', defaultHome, defaultHome,
    )).toBe(false);
  });

  it('filters default/scoped daemon listings without prefix or legacy leakage', () => {
    const output = [
      `201\tnode.exe node_modules\\imcodes\\dist\\src\\index.js --home "${defaultHome}"`,
      `202\tnode.exe node_modules\\imcodes\\dist\\src\\index.js --home "${scopedA}"`,
      `203\tnode.exe node_modules\\imcodes\\dist\\src\\index.js --home "${scopedB}"`,
      '204\tnode.exe node_modules\\imcodes\\dist\\src\\index.js',
    ].join('\n');
    expect(parseDaemonProcessListing(output, defaultHome, defaultHome)).toEqual([201]);
    expect(parseDaemonProcessListing(output, scopedA, defaultHome)).toEqual([202]);
    expect(parseDaemonProcessListing(output, scopedB, defaultHome)).toEqual([203]);
  });
});
