import { describe, expect, it } from 'vitest';

import {
  canonicalWatchdogPath,
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
});
