import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

function jobBlock(name: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return workflow.slice(start, next < 0 ? workflow.length : start + 1 + next);
}

describe('CI release-speed wiring', () => {
  it('shards Linux and macOS daemon unit tests without dropping the test command', () => {
    const linux = jobBlock('unit-tests');
    const mac = jobBlock('macos-unit-tests');
    for (const block of [linux, mac]) {
      expect(block).toContain('shard: [1, 2, 3]');
      expect(block).toContain('npm run test:unit -- --shard=${{ matrix.shard }}/3');
      expect(block).toContain('cancel-in-progress: true');
    }
    expect(linux).toContain("node: ['22', '24']");
  });

  it('lets independent e2e and repository integration tests start with unit tests', () => {
    expect(jobBlock('e2e-tests')).not.toContain('needs: [unit-tests]');
    expect(jobBlock('repo-integration-tests')).not.toContain('needs: [unit-tests]');
  });

  it('keeps dev-to-master pull requests lightweight while push runs retain full gates', () => {
    for (const name of ['unit-tests', 'macos-unit-tests', 'web-tests-unit', 'server-tests', 'e2e-tests']) {
      expect(jobBlock(name)).toContain("github.event_name != 'pull_request' || github.head_ref != 'dev'");
    }
    expect(jobBlock('docker')).not.toContain("github.event_name != 'pull_request' || github.head_ref != 'dev'");
  });

  it('uses a non-cancelling release group for every publish gate', () => {
    for (const name of ['release_version', 'controlled-node-executables', 'docker', 'publish']) {
      const block = jobBlock(name);
      expect(block).toContain('group: ci-release-${{ github.ref }}');
      expect(block).toContain('cancel-in-progress: false');
    }
  });

  it('caches version-independent macOS components by real inputs and verifies cache hits', () => {
    const controlled = jobBlock('controlled-node-executables');
    expect(controlled).toContain('actions/cache/restore@v4');
    expect(controlled).toContain('actions/cache/save@v4');
    expect(controlled).toContain('steps.mac_identity.outputs.sha1');
    expect(controlled).toContain('imcodes-macos-components-${{ runner.os }}-${{ env.NODE_VERSION_PRIMARY }}');
    // Keep the cache tied to the complete build-input closure. In particular,
    // changing the builder or an installer/verifier must force a miss rather
    // than reusing signed binaries produced by the old code.
    for (const input of [
      'package-lock.json',
      'native/macos-remote-desktop/**',
      'scripts/build-macos-remote-desktop-release.mjs',
      'scripts/macos-remote-desktop-build.mjs',
      'scripts/install-libwebrtc-sdk.mjs',
      'scripts/libwebrtc-sdk-artifacts.mjs',
      'scripts/libwebrtc-sdk-targets.mjs',
      'scripts/macos-release-signing.mjs',
      'scripts/module-entry.mjs',
      'scripts/remote-desktop-worker-artifacts.mjs',
      'shared/**',
      'native/macos-remote-desktop/libwebrtc-sdk-*.lock.json',
    ]) {
      expect(controlled, input).toContain(input);
    }
    expect(controlled).toContain('-v3');
    expect(controlled).not.toContain('imcodes-macos-components-${{ github.sha }}');
    expect(controlled).toContain('Verify the macOS remote-desktop component sets');
    expect(controlled).toContain('Verify restored macOS component signatures and trust');
    expect(controlled).toContain('codesign --verify --strict --deep --verbose=2');
    expect(controlled).toContain('spctl --assess --type execute -vv');
    expect(controlled).toContain('steps.macos_release_cache.outputs.cache-hit != \'true\'');
    expect(controlled).toContain('Notarize macOS executable and app in parallel');
    expect(controlled).toContain('node_pid=$!');
    expect(controlled).toContain('app_pid=$!');
    expect(controlled).toContain('wait "$node_pid"');
    expect(controlled).toContain('wait "$app_pid"');
  });
});
