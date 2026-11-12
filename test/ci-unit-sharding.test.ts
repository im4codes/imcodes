import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Job = {
  name?: string;
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
  it.each([['unit-tests', 4], ['macos-unit-tests', 3]] as const)(
    '%s executes every contiguous shard once, without masking failures', (id, count) => {
      const job = ci().jobs[id]!;
      expect(job.name).toContain(`shard \${{ matrix.shard }}/${count}`);
      expect(job.strategy?.matrix.shard).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      expect(job.strategy?.['fail-fast']).toBe(false);
      expect(job.strategy?.['max-parallel']).toBe(id === 'unit-tests' ? 4 : 3);
      expect(job.steps.filter((step) => step.run?.includes('npm run test:unit')).map((step) => step.run))
        .toEqual([`npm run test:unit -- --shard=\${{ matrix.shard }}/${count}`]);
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
});
