import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Job = {
  name?: string;
  if?: string;
  'runs-on'?: string;
  needs?: string[];
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
  strategy?: { 'fail-fast'?: boolean; 'max-parallel'?: number; matrix: { node?: string[]; shard: number[] } };
  steps: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown>; 'continue-on-error'?: boolean }>;
};
const ci = () => parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: Record<string, Job>;
};

describe('bounded parallel daemon CI, with unchanged release safety', () => {
  it.each([['unit-tests', 4], ['macos-unit-tests', 6]] as const)(
    '%s executes every contiguous shard once, without masking failures', (id, count) => {
      const job = ci().jobs[id]!;
      expect(job.name).toContain(`shard \${{ matrix.shard }}/${count}`);
      expect(job.strategy?.matrix.shard).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      expect(job.strategy?.['fail-fast']).toBe(false);
      expect(job.strategy?.['max-parallel']).toBe(id === 'unit-tests' ? 4 : 6);
      const script = id === 'macos-unit-tests' ? 'test:unit:macos' : 'test:unit';
      expect(job.steps.filter((step) => step.run?.includes('npm run test:unit')).map((step) => step.run))
        .toEqual([`npm run ${script} -- --shard=\${{ matrix.shard }}/${count}`]);
      expect(job['continue-on-error']).not.toBe(true);
      expect(job.steps.find((step) => step.run?.includes('npm run test:unit'))?.['continue-on-error']).not.toBe(true);
    },
  );

  it('configures coverage-shard across 1..4 shards with 30-minute timeout and aggregates all 4 shard artifacts in coverage', () => {
    const jobs = ci().jobs;
    const covShard = jobs['coverage-shard']!;
    expect(covShard['timeout-minutes']).toBe(30);
    expect(covShard.strategy?.matrix.shard).toEqual([1, 2, 3, 4]);
    expect(covShard.strategy?.['fail-fast']).toBe(false);
    expect(covShard.steps.filter((step) => step.run?.includes('npm run test:coverage:ci')).map((step) => step.run))
      .toEqual(['npm run test:coverage:ci -- --shard=${{ matrix.shard }}/4 --coverage.reportsDirectory=coverage/shard-${{ matrix.shard }} --reporter=blob --reporter=default']);
    const covReport = jobs.coverage!;
    expect(covReport.needs).toEqual(['coverage-shard']);
    const downloadedArtifacts = covReport.steps
      .filter((step) => step.uses === 'actions/download-artifact@v4')
      .map((step) => step.with?.name);
    expect(downloadedArtifacts).toEqual([
      'coverage-shard-1',
      'coverage-shard-2',
      'coverage-shard-3',
      'coverage-shard-4',
    ]);
  });

  it('retains both Node versions and existing per-runner worker limits', () => {
    expect(ci().jobs['unit-tests']!.strategy?.matrix.node).toEqual(['22', '24']);
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts['test:unit']).toContain('--maxWorkers=3 --project daemon');
    expect(scripts['test:unit:macos']).toContain('--maxWorkers=2 --project daemon');
  });

  it('starts self-contained E2E without waiting for unit tests, but gates releases on both', () => {
    const jobs = ci().jobs;
    expect(jobs['e2e-tests']!.needs ?? []).not.toContain('unit-tests');
    const commands = jobs['e2e-tests']!.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('./scripts/ci-npm-ci.sh .');
    expect(commands).toContain('./scripts/ci-npm-ci.sh web');
    expect(commands).toContain('npm run test:e2e');
    for (const id of ['docker', 'android-release']) {
      expect(jobs[id]!.needs).toEqual(expect.arrayContaining(['unit-tests', 'e2e-tests']));
    }
    expect(jobs.docker!.needs).toContain('macos-unit-tests');
    expect(jobs.publish!.needs).toEqual(['docker']);
  });

  it('does not cancel an in-progress dev release to reduce the queue', () => {
    expect(ci().concurrency.group).toBe('ci-${{ github.ref }}');
    expect(ci().concurrency['cancel-in-progress']).not.toMatch(/refs\/heads\/dev/);
    expect(ci().concurrency['cancel-in-progress']).toContain("startsWith(github.ref, 'refs/heads/repro/')");
  });

  it('caps simultaneous macOS jobs on dev pushes below GitHub 5-runner limit while keeping PR/repro RD builds and Windows dev exclusion', () => {
    const workflow = ci();
    const jobs = workflow.jobs;
    const rd = jobs['macos-remote-desktop-components']!;
    expect(rd.if).toBe("github.ref != 'refs/heads/master' && github.ref != 'refs/heads/main' && github.ref != 'refs/heads/dev'");
    expect(rd['runs-on']).toBe('macos-15');
    expect(rd['timeout-minutes']).toBe(60);

    const isRdEnabledForRef = (ref: string) =>
      ref !== 'refs/heads/master' && ref !== 'refs/heads/main' && ref !== 'refs/heads/dev';
    expect(isRdEnabledForRef('refs/heads/master')).toBe(false);
    expect(isRdEnabledForRef('refs/heads/main')).toBe(false);
    expect(isRdEnabledForRef('refs/heads/dev')).toBe(false);
    expect(isRdEnabledForRef('refs/pull/42/merge')).toBe(true);
    expect(isRdEnabledForRef('refs/heads/repro/macos-ci')).toBe(true);

    const macUnit = jobs['macos-unit-tests']!;
    expect(macUnit['runs-on']).toBe('macos-15-intel');
    expect(macUnit.strategy?.matrix.shard).toEqual([1, 2, 3, 4, 5, 6]);
    expect(macUnit.strategy?.['max-parallel']).toBe(6);
    expect(macUnit['timeout-minutes']).toBe(45);
    expect(jobs.docker!.needs).toContain('macos-unit-tests');

    const installSmoke = parse(readFileSync('.github/workflows/install-smoke.yml', 'utf8')) as {
      jobs: Record<string, { strategy?: { matrix?: { os?: string[] } }; steps?: Array<{ if?: string; run?: string }> }>;
    };
    const smokeOs = installSmoke.jobs['install-smoke']!.strategy?.matrix?.os ?? [];
    expect(smokeOs).toContain('macos-15-intel');
    expect(smokeOs).not.toContain('macos-latest');
    expect(smokeOs).not.toContain('macos-15');
    expect(installSmoke.jobs['install-smoke']!.steps?.some((s) => s.if === "runner.os == 'macOS'")).toBe(true);

    // Also inspect sibling mobile-speech workflow macOS job count on dev pushes (stays on macos-26 for Xcode 26).
    const mobileSpeech = parse(readFileSync('.github/workflows/mobile-speech.yml', 'utf8')) as { jobs: Record<string, Job> };
    const mobileMacJobs = Object.values(mobileSpeech.jobs).filter((job) => (job['runs-on'] ?? '').startsWith('macos-'));
    expect(mobileMacJobs).toHaveLength(1);
    expect(mobileMacJobs[0]!['runs-on']).toBe('macos-26');

    // Peak simultaneous macOS arm64 jobs on a dev push:
    // macos-unit-tests runs on macos-15-intel (0 arm64) + controlled-node-executables macos-15 leg (1) + mobile-speech macos-26 (1) = 2 (<= 2).
    const isArm64MacRunner = (label?: string) => Boolean(label && label.startsWith('macos-') && !label.endsWith('-intel'));
    const devPlannedMacosArm64Concurrency =
      (isArm64MacRunner(macUnit['runs-on']) ? (macUnit.strategy?.['max-parallel'] ?? macUnit.strategy!.matrix.shard.length) : 0) +
      1 + // controlled-node-executables macos-15 leg
      (isRdEnabledForRef('refs/heads/dev') && isArm64MacRunner(rd['runs-on']) ? 1 : 0) +
      mobileMacJobs.filter((job) => isArm64MacRunner(job['runs-on'])).length;
    expect(devPlannedMacosArm64Concurrency).toBeLessThanOrEqual(2);

    // Windows controlled-node-executables remains disabled on refs/heads/dev.
    const releaseVersionScript = jobs.release_version!.steps.map((s) => s.run ?? '').join('\n');
    expect(releaseVersionScript).toContain('if [ "${GITHUB_REF}" = "refs/heads/dev" ]; then');
    expect(releaseVersionScript).toMatch(
      /if \[ "\$\{GITHUB_REF\}" = "refs\/heads\/dev" \]; then[\s\S]*?CONTROLLED_NODE_MATRIX='\[\{"key":"linux"[^'\n]*\{"key":"macos"[^'\n]*\]'[\s\S]*?else[\s\S]*?\{"key":"windows"/u,
    );
  });
});
