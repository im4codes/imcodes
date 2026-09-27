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
});
