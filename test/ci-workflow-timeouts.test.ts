/**
 * A hung CI job holds the run's concurrency group until GitHub's 6 h limit, and
 * with it every newer push run on the branch (run 37664607739: the Web Chat
 * Timeline Perf Guard sat in `playwright install --with-deps` for hours while
 * the next run on dev never started a job and the Docker image could not be
 * built). Every job therefore ends itself, every step that waits on the
 * network is bounded, and none of that may be dropped by a later edit.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const run = promisify(execFile);
const WORKFLOW_DIR = '.github/workflows';
/** GitHub's own ceiling for a job; a limit at or above it bounds nothing. */
const GITHUB_MAX_JOB_MINUTES = 360;
/** The slack a job needs on top of a deliberate wait before it may be cut off. */
const WAIT_SLACK_MINUTES = 10;

type Step = { name?: string; run?: string; 'timeout-minutes'?: unknown };
type Job = { 'timeout-minutes'?: unknown; steps?: Step[]; needs?: string | string[] };
type Workflow = { jobs: Record<string, Job> };

function loadWorkflows(): Array<{ file: string; workflow: Workflow }> {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({ file, workflow: parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as Workflow }));
}

/** Jobs with no usable limit: missing, not a whole number, or not below GitHub's own 6 h ceiling. */
function jobsWithoutTimeout(workflow: Workflow): string[] {
  return Object.entries(workflow.jobs)
    .filter(([, job]) => {
      const limit = job['timeout-minutes'];
      return typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > GITHUB_MAX_JOB_MINUTES;
    })
    .map(([name]) => name);
}

/** A deliberate `--wait-seconds N` inside a job needs a limit that outlasts it. */
function jobsCutOffBeforeTheirWait(workflow: Workflow): string[] {
  return Object.entries(workflow.jobs)
    .filter(([, job]) => {
      const limit = typeof job['timeout-minutes'] === 'number' ? job['timeout-minutes'] : 0;
      return (job.steps ?? []).some((step) => {
        const seconds = /--wait-seconds\s+(\d+)/.exec(step.run ?? '')?.[1];
        return seconds !== undefined && limit < Math.ceil(Number(seconds) / 60) + WAIT_SLACK_MINUTES;
      });
    })
    .map(([name]) => name);
}

describe('every CI job ends itself', () => {
  it.each(loadWorkflows().map(({ file, workflow }) => [file, workflow] as const))(
    '%s: every job has a whole-number timeout-minutes below the 6 h default',
    (_file, workflow) => {
      expect(jobsWithoutTimeout(workflow)).toEqual([]);
    },
  );

  it('flags a job that would hold the concurrency group for the default 6 h (counterexample)', () => {
    const workflow: Workflow = { jobs: { fine: { 'timeout-minutes': 10 }, forgotten: {}, unbounded: { 'timeout-minutes': 360 + 1 }, expression: { 'timeout-minutes': '${{ 5 }}' } } };
    expect(jobsWithoutTimeout(workflow)).toEqual(['forgotten', 'unbounded', 'expression']);
  });

  it.each(loadWorkflows().map(({ file, workflow }) => [file, workflow] as const))(
    '%s: a job that waits on purpose is not cut off before the wait ends',
    (_file, workflow) => {
      expect(jobsCutOffBeforeTheirWait(workflow)).toEqual([]);
    },
  );

  it('flags a limit shorter than the deliberate wait it contains (counterexample)', () => {
    const workflow: Workflow = { jobs: { waits: { 'timeout-minutes': 30, steps: [{ run: 'node scripts/resolve-libwebrtc-sdk-release.mjs --wait-seconds 15000' }] } } };
    expect(jobsCutOffBeforeTheirWait(workflow)).toEqual(['waits']);
  });
});

describe('steps that wait on the network are bounded', () => {
  const ci = () => parse(readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8')) as Workflow;

  it('the browser install is bounded by apt timeouts, a per-attempt limit, retries and a step limit', () => {
    const step = (ci().jobs['web-chat-perf']!.steps ?? []).find((candidate) => /playwright install/.test(candidate.run ?? ''));
    expect(step, 'the perf job installs a browser').toBeDefined();
    expect(step!.run).toContain('./scripts/ci-apt-hardening.sh');
    expect(step!.run).toMatch(/ci-retry\.sh \d+ \d+ npx playwright install/);
    expect(typeof step!['timeout-minutes']).toBe('number');
    // 3 attempts x 240 s plus the waits between them must fit inside the step limit.
    expect(step!['timeout-minutes'] as number).toBeGreaterThanOrEqual(Math.ceil((3 * (240 + 15) + 15) / 60));
  });

  it.each(loadWorkflows().map(({ file, workflow }) => [file, workflow] as const))(
    '%s: no run block calls apt-get before bounding apt\'s network waits',
    (_file, workflow) => {
      const offenders: string[] = [];
      for (const [name, job] of Object.entries(workflow.jobs)) {
        let hardened = false;
        for (const step of job.steps ?? []) {
          const script = step.run ?? '';
          const hardeningAt = script.indexOf('ci-apt-hardening.sh');
          const aptAt = script.search(/\bapt(-get)?\s+(install|update)\b/);
          if (hardeningAt >= 0) hardened = true;
          if (aptAt >= 0 && !hardened) offenders.push(`${name}: ${step.name ?? script.slice(0, 40)}`);
          if (aptAt >= 0 && hardeningAt > aptAt) offenders.push(`${name}: hardening comes after apt in ${step.name ?? ''}`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it('does not loosen the release gate: the Docker image still needs every job, including the perf guard', () => {
    const docker = ci().jobs.docker!;
    const needs = Array.isArray(docker.needs) ? docker.needs : [docker.needs];
    expect([...needs].sort()).toEqual([
      'controlled-node-executables', 'e2e-tests', 'lint', 'macos-unit-tests', 'release_version', 'secret-scan',
      'server-db-tests', 'server-tests', 'typecheck', 'unit-tests', 'web-chat-perf', 'web-tests-components',
      'web-tests-unit', 'windows-conpty-tests', 'windows-unit-tests',
    ]);
  });
});

async function hasGnuTimeout(): Promise<boolean> {
  try { await run('timeout', ['--version']); return true; } catch { return false; }
}
const RUN_SCRIPTS = process.platform !== 'win32' && await hasGnuTimeout();

describe.skipIf(!RUN_SCRIPTS)('ci-retry.sh and ci-apt-hardening.sh', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'ci-retry-')); dirs.push(dir); return dir; };
  const env = { ...process.env, CI_RETRY_SLEEP_SECONDS: '0' };

  it('kills an attempt that stalls and succeeds on the next one', async () => {
    const dir = scratch();
    const marker = join(dir, 'first-attempt-seen');
    const startedAt = Date.now();
    const result = await run('bash', ['scripts/ci-retry.sh', '3', '1', 'bash', '-c', `if [ ! -e "${marker}" ]; then : > "${marker}"; exec sleep 60; fi; echo recovered`], { env });
    expect(result.stdout).toContain('recovered');
    expect(result.stderr).toContain('attempt 1 timed out after 1s');
    expect(Date.now() - startedAt, 'the stalled attempt was cut at its limit, not waited out').toBeLessThan(20_000);
  });

  it('gives up after the last attempt with that attempt\'s exit code', async () => {
    const failure = await run('bash', ['scripts/ci-retry.sh', '2', '5', 'bash', '-c', 'exit 7'], { env }).catch((error) => error as { code: number; stderr: string });
    expect((failure as { code: number }).code).toBe(7);
    expect((failure as { stderr: string }).stderr).toContain('giving up after 2 attempts');
  });

  it('runs the between-attempts command only before a retry', async () => {
    const dir = scratch();
    const log = join(dir, 'between');
    await run('bash', ['scripts/ci-retry.sh', '2', '5', 'bash', '-c', 'exit 1'], { env: { ...env, CI_RETRY_BETWEEN_ATTEMPTS: `echo settled >> "${log}"` } }).catch(() => undefined);
    expect(readFileSync(log, 'utf8')).toBe('settled\n');
  });

  it('rejects arguments that are not whole numbers', async () => {
    const failure = await run('bash', ['scripts/ci-retry.sh', 'x', '5', 'true'], { env }).catch((error) => error as { code: number });
    expect((failure as { code: number }).code).toBe(2);
  });

  it('writes the apt network timeouts to the configured directory', async () => {
    const dir = scratch();
    await run('bash', ['scripts/ci-apt-hardening.sh'], { env: { ...process.env, CI_APT_CONF_DIR: dir } });
    const conf = join(dir, '99ci-network-timeouts');
    expect(existsSync(conf)).toBe(true);
    const text = readFileSync(conf, 'utf8');
    expect(text).toContain('Acquire::http::Timeout "30";');
    expect(text).toContain('Acquire::Retries "3";');
    writeFileSync(conf, '');
  });
});
