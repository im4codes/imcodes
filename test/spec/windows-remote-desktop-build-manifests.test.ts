import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The worker's source list lives in three places -- BUILD.gn for the pinned
 * libwebrtc build, `$ProductionSources`/`$Tests` for the SDK build, and
 * `$ExpectedSources` for the file overlay copied into the checkout -- because
 * each consumer reads a different build system. Adding a translation unit to
 * only one of them still compiles locally and still passes every unit test: the
 * failure is an unresolved symbol at link time, on CI, on the one job that
 * produces the signed artifact nodes actually upgrade to. Keep them in step.
 */
const NATIVE = resolve(__dirname, '..', '..', 'native', 'windows-remote-desktop');

function read(name: string): string {
  return readFileSync(resolve(NATIVE, name), 'utf8');
}

function gnTargetSources(gn: string, target: string): string[] {
  const declaration = gn.indexOf(`"${target}"`);
  expect(declaration, `${target} is declared in BUILD.gn`).toBeGreaterThan(-1);
  const start = gn.indexOf('sources = [', declaration);
  const end = gn.indexOf(']', start);
  return [...gn.slice(start, end).matchAll(/"([^"]+\.(?:cc|h))"/g)].map((match) => match[1]!);
}

function powershellList(script: string, startMarker: string, endMarker: string): string[] {
  const start = script.indexOf(startMarker);
  expect(start, `${startMarker} exists`).toBeGreaterThan(-1);
  const end = script.indexOf(endMarker, start);
  return [...script.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe('windows remote-desktop build manifests', () => {
  const gn = read('BUILD.gn');
  const sdk = read('build-worker-from-sdk.ps1');
  const overlay = read('build-worker.ps1');

  const workerSources = gnTargetSources(gn, 'imcodes_remote_desktop_worker');
  const testTargets = [...gn.matchAll(/rtc_test\("([^"]+)"\)/g)].map((match) => match[1]!);
  const productionSources = powershellList(sdk, '$ProductionSources = @(', '$Tests = [ordered]@{');
  const expectedSources = powershellList(overlay, '$ExpectedSources = @(', '\n)');

  it('compiles every worker translation unit in the SDK build too', () => {
    const missing = workerSources
      .filter((source) => source.endsWith('.cc'))
      .filter((source) => !productionSources.includes(source));
    expect(missing).toEqual([]);
  });

  it('copies every worker source into the pinned checkout overlay', () => {
    const missing = workerSources.filter((source) => !expectedSources.includes(source));
    expect(missing).toEqual([]);
  });

  it('builds every declared unit test in the SDK build too', () => {
    const sdkTests = sdk.slice(sdk.indexOf('$Tests = [ordered]@{'), sdk.indexOf('$SystemLibraries'));
    for (const target of testTargets) {
      expect(sdkTests, `${target} is built by the SDK script`).toContain(`${target} = @(`);
      for (const source of gnTargetSources(gn, target).filter((name) => name.endsWith('.cc'))) {
        const entry = sdkTests.slice(sdkTests.indexOf(`${target} = @(`));
        expect(entry.slice(0, entry.indexOf(')')), `${target} compiles ${source}`).toContain(`'${source}'`);
      }
    }
  });

  it('has a unit-test target for every unit-test source on disk', () => {
    const onDisk = readdirSync(NATIVE).filter((name) => name.endsWith('_unittest.cc'));
    for (const source of onDisk) {
      expect(gn, `${source} has an rtc_test target`).toContain(`"${source}"`);
      expect(expectedSources, `${source} is copied into the checkout`).toContain(source);
    }
    expect(onDisk.length).toBe(testTargets.length);
  });
});
