import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Job = {
  name?: string;
  if?: string;
  'runs-on'?: string;
  needs?: string | string[];
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
  strategy?: { 'fail-fast'?: boolean; 'max-parallel'?: number; matrix: { node?: string[] | string; shard: number[] } };
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
      expect(job.strategy?.['max-parallel']).toBe(id === 'unit-tests' ? 8 : 3);
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
    expect(covShard.if).toBe("github.ref != 'refs/heads/dev' || github.event_name == 'workflow_dispatch'");
    expect(covShard['timeout-minutes']).toBe(30);
    expect(covShard.strategy?.matrix.shard).toEqual([1, 2, 3, 4]);
    expect(covShard.strategy?.['fail-fast']).toBe(false);
    expect(covShard.steps.filter((step) => step.run?.includes('npm run test:coverage:ci')).map((step) => step.run))
      .toEqual(['npm run test:coverage:ci -- --shard=${{ matrix.shard }}/4 --coverage.reportsDirectory=coverage/shard-${{ matrix.shard }} --reporter=blob --reporter=default']);
    const covReport = jobs.coverage!;
    expect(covReport.if).toBe("github.ref != 'refs/heads/dev' || github.event_name == 'workflow_dispatch'");
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

  it('retains both Node versions and existing per-runner worker limits, fast-pathing dev pushes cleanly via matrix expression', () => {
    const unitJob = ci().jobs['unit-tests']!;
    // Job-level `if:` cannot reference `matrix.*` in GitHub Actions (fails workflow expression validation).
    expect(unitJob.if).toBeUndefined();
    const expectedExpr =
      "${{ fromJSON((github.ref == 'refs/heads/dev' && github.event_name != 'workflow_dispatch') && '[\"24\"]' || '[\"22\", \"24\"]') }}";
    expect(unitJob.strategy?.matrix.node).toBe(expectedExpr);

    const match = /^\$\{\{\s*fromJSON\(\((.+)\)\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'\)\s*\}\}$/.exec(
      String(unitJob.strategy?.matrix.node ?? ''),
    );
    expect(match).not.toBeNull();
    const [, conditionExpr, devJson, fullJson] = match!;
    expect(JSON.parse(devJson!)).toEqual(['24']);
    expect(JSON.parse(fullJson!)).toEqual(['22', '24']);

    const evalMatrixNode = (github: { ref: string; event_name: string }): string[] => {
      const cond = conditionExpr!
        .replace(/github\.ref\s*==\s*'([^']+)'/g, (_, v: string) => String(github.ref === v))
        .replace(/github\.event_name\s*!=\s*'([^']+)'/g, (_, v: string) => String(github.event_name !== v));
      const isDevFastPath = cond === 'true && true';
      const selectedJson = (isDevFastPath && devJson!) || fullJson!;
      return JSON.parse(selectedJson) as string[];
    };

    expect(evalMatrixNode({ ref: 'refs/heads/dev', event_name: 'push' })).toEqual(['24']);
    expect(evalMatrixNode({ ref: 'refs/heads/dev', event_name: 'workflow_dispatch' })).toEqual(['22', '24']);
    expect(evalMatrixNode({ ref: 'refs/heads/master', event_name: 'push' })).toEqual(['22', '24']);
    expect(evalMatrixNode({ ref: 'refs/pull/42/merge', event_name: 'pull_request' })).toEqual(['22', '24']);

    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(scripts['test:unit']).toContain('--maxWorkers=3 --project daemon');
    expect(scripts['test:unit:macos']).toContain('--maxWorkers=2 --project daemon');
  });

  it('rejects invalid job-level if contexts and invalid/cyclic needs across all GitHub workflow files', () => {
    const workflowDir = '.github/workflows';
    const files = readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const parsed = parse(readFileSync(join(workflowDir, file), 'utf8')) as {
        jobs?: Record<string, Job>;
      };
      const jobs = parsed.jobs ?? {};
      const jobIds = new Set(Object.keys(jobs));

      for (const [jobId, job] of Object.entries(jobs)) {
        if (job.if) {
          expect(
            job.if,
            `${file} jobs.${jobId}.if must not reference matrix/steps/job/env contexts`,
          ).not.toMatch(/\b(matrix|steps|job|env)\./);
        }
        const needs = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
        for (const dep of needs) {
          expect(jobIds.has(dep), `${file} jobs.${jobId}.needs references unknown job "${dep}"`).toBe(true);
        }
      }

      // Verify needs DAG has no cycles.
      const state = new Map<string, 'visiting' | 'visited'>();
      const visit = (id: string) => {
        if (state.get(id) === 'visited') return;
        expect(state.get(id), `${file} job "${id}" has a cyclic needs dependency`).not.toBe('visiting');
        state.set(id, 'visiting');
        const rawNeeds = jobs[id]?.needs;
        const deps = Array.isArray(rawNeeds) ? rawNeeds : rawNeeds ? [rawNeeds] : [];
        for (const dep of deps) visit(dep);
        state.set(id, 'visited');
      };
      for (const id of jobIds) visit(id);
    }
  });

  it('starts self-contained E2E without waiting for unit tests, runs publish in parallel with docker, and gates releases on test suites', () => {
    const jobs = ci().jobs;
    expect(jobs['e2e-tests']!.needs ?? []).not.toContain('unit-tests');
    const commands = jobs['e2e-tests']!.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('./scripts/ci-npm-ci.sh .');
    expect(commands).toContain('./scripts/ci-npm-ci.sh web');
    expect(commands).toContain('npm run test:e2e');
    for (const id of ['docker', 'android-release', 'publish']) {
      expect(jobs[id]!.needs).toEqual(expect.arrayContaining(['unit-tests', 'e2e-tests', 'release_version']));
    }
    expect(jobs.docker!.needs).toContain('macos-unit-tests');
    expect(jobs.publish!.needs).toContain('macos-unit-tests');
    expect(jobs.publish!.needs).not.toContain('docker');
    expect(jobs['android-release']!.if).toContain("needs.release_version.outputs.android_changed == 'true'");
    expect(jobs['android-release']!.if).toContain("github.ref == 'refs/heads/master'");
    expect(jobs['android-release']!.if).toContain("github.event_name == 'workflow_dispatch'");
  });

  it('builds docker once into local daemon, skips GHA cache upload on dev, and pushes verified tags with fail-closed digest output', () => {
    const jobs = ci().jobs;
    const dockerSteps = jobs.docker!.steps;
    const buildActions = dockerSteps.filter((s) => s.uses === 'docker/build-push-action@v6');
    expect(buildActions).toHaveLength(1);
    expect(buildActions[0]!.with?.load).toBe(true);
    expect(buildActions[0]!.with?.push).toBe(false);
    expect(String(buildActions[0]!.with?.['cache-to'] ?? '')).toContain("github.ref == 'refs/heads/master'");
    expect(String(buildActions[0]!.with?.['cache-to'] ?? '')).not.toContain("refs/heads/dev");

    const smokeIdx = dockerSteps.findIndex((s) => s.name === 'Container startup smoke test');
    const pushStepIdx = dockerSteps.findIndex((s) => s.name === 'Push verified image');
    expect(smokeIdx).toBeGreaterThan(-1);
    expect(pushStepIdx).toBeGreaterThan(smokeIdx);
    const pushStep = dockerSteps[pushStepIdx]!;
    expect(pushStep.run).toContain('docker tag imcodes-smoke:test "$tag"');
    expect(pushStep.run).toContain('docker push "$tag"');
    expect(pushStep.run).toContain('^sha256:[0-9a-f]{64}$');
    expect(pushStep.run).toContain('echo "digest=${digest}" >> "$GITHUB_OUTPUT"');
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
    expect(rd['runs-on']).toBe('macos-26');
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
    expect(macUnit.strategy?.matrix.shard).toEqual([1, 2, 3]);
    expect(macUnit.strategy?.['max-parallel']).toBe(3);
    expect(macUnit['timeout-minutes']).toBe(45);
    expect(jobs.docker!.needs).toContain('macos-unit-tests');
    const tmuxInstallRun = macUnit.steps.find((s) => s.name === 'Install tmux')?.run ?? '';
    expect(tmuxInstallRun).toContain('command -v tmux >/dev/null 2>&1');

    // Sibling mobile-speech workflow triggers on speech paths for both push and pull_request.
    const mobileSpeech = parse(readFileSync('.github/workflows/mobile-speech.yml', 'utf8')) as {
      on?: { push?: { paths?: string[] }; pull_request?: { paths?: string[] } };
      jobs: Record<string, Job>;
    };
    const mobileMacJobs = Object.values(mobileSpeech.jobs).filter((job) => (job['runs-on'] ?? '').startsWith('macos-'));
    expect(mobileMacJobs).toHaveLength(1);
    expect(mobileMacJobs[0]!['runs-on']).toBe('macos-26');
    const speechTriggerPaths = ['web/plugins/streaming-speech/**', 'web/ios/**'];
    expect(mobileSpeech.on?.push?.paths).toEqual(expect.arrayContaining(speechTriggerPaths));
    expect(mobileSpeech.on?.pull_request?.paths).toEqual(expect.arrayContaining(speechTriggerPaths));

    // Total simultaneous repo-wide macOS jobs (Intel + arm64) must stay <= GitHub's 5-runner cap
    // even when a push or PR touches speech paths and overlaps with mobile-speech.yml:
    // - dev/main push touching web/ios/**: 3 macos-15-intel + 1 controlled-node-executables (macos-26) + 1 mobile-speech (macos-26) = 5 <= 5
    // - PR touching web/ios/**: 3 macos-15-intel + 1 macos-remote-desktop-components (macos-26) + 1 mobile-speech (macos-26) = 5 <= 5
    const macUnitMaxParallel = macUnit.strategy?.['max-parallel'] ?? macUnit.strategy!.matrix.shard.length;
    const isArm64MacRunner = (label?: string) => Boolean(label && label.startsWith('macos-') && !label.endsWith('-intel'));
    const speechOverlapOnPush = macUnitMaxParallel + 1 + mobileMacJobs.length;
    const speechOverlapOnPr = macUnitMaxParallel + (isRdEnabledForRef('refs/pull/42/merge') ? 1 : 0) + mobileMacJobs.length;
    expect(speechOverlapOnPush).toBeLessThanOrEqual(5);
    expect(speechOverlapOnPr).toBeLessThanOrEqual(5);

    const installSmoke = parse(readFileSync('.github/workflows/install-smoke.yml', 'utf8')) as {
      jobs: Record<string, { strategy?: { matrix?: { os?: string[] } }; steps?: Array<{ if?: string; run?: string }> }>;
    };
    const smokeOs = installSmoke.jobs['install-smoke']!.strategy?.matrix?.os ?? [];
    expect(smokeOs).toContain('macos-15-intel');
    expect(smokeOs).not.toContain('macos-latest');
    expect(smokeOs).not.toContain('macos-15');
    expect(installSmoke.jobs['install-smoke']!.steps?.some((s) => s.if === "runner.os == 'macOS'")).toBe(true);

    // Peak simultaneous macOS arm64 jobs on a dev push or PR touching speech paths:
    // macos-unit-tests runs on macos-15-intel (0 arm64) + 1 CI macos-26 leg + 1 mobile-speech macos-26 = 2 (<= 2).
    const devPlannedMacosArm64Concurrency =
      (isArm64MacRunner(macUnit['runs-on']) ? macUnitMaxParallel : 0) +
      1 + // controlled-node-executables macos-26 leg
      (isRdEnabledForRef('refs/heads/dev') && isArm64MacRunner(rd['runs-on']) ? 1 : 0) +
      mobileMacJobs.filter((job) => isArm64MacRunner(job['runs-on'])).length;
    const prPlannedMacosArm64Concurrency =
      (isArm64MacRunner(macUnit['runs-on']) ? macUnitMaxParallel : 0) +
      (isRdEnabledForRef('refs/pull/42/merge') && isArm64MacRunner(rd['runs-on']) ? 1 : 0) +
      mobileMacJobs.filter((job) => isArm64MacRunner(job['runs-on'])).length;
    expect(devPlannedMacosArm64Concurrency).toBeLessThanOrEqual(2);
    expect(prPlannedMacosArm64Concurrency).toBeLessThanOrEqual(2);

    // Windows controlled-node-executables stays enabled across dev, main, and master, and macOS leg uses macos-26.
    const releaseVersionScript = jobs.release_version!.steps.map((s) => s.run ?? '').join('\n');
    expect(releaseVersionScript).toMatch(
      /CONTROLLED_NODE_MATRIX='\[\{"key":"linux"[^'\n]*\{"key":"macos","runner":"macos-26"[^'\n]*\{"key":"windows"[^'\n]*\]'/u,
    );
    expect(releaseVersionScript).not.toContain('"runner":"macos-15"');

    const buildNodeExe = parse(readFileSync('.github/workflows/build-node-exe.yml', 'utf8')) as {
      jobs: { build: { strategy: { matrix: { include: Array<{ os: string; artifact: string }> } } } };
    };
    const macBuildEntry = buildNodeExe.jobs.build.strategy.matrix.include.find((entry) => entry.artifact === 'imcodes-node-macos');
    expect(macBuildEntry?.os).toBe('macos-26');
  });

  it('parallelizes macOS dual-arch daemon-runtime and .pkg notarization safely with shared build once and sequential sign-pkg', () => {
    const jobs = ci().jobs;
    const cneSteps = jobs['controlled-node-executables']!.steps;
    const posixRuntimeRun = cneSteps.find((s) => s.name === 'Build, verify and smoke-test POSIX daemon-runtime bundle')?.run ?? '';
    expect(posixRuntimeRun).toContain('npm run build');
    expect(posixRuntimeRun).toContain('--skip-build');
    expect(posixRuntimeRun.indexOf('npm run build')).toBeLessThan(posixRuntimeRun.indexOf('--skip-build'));
    expect(posixRuntimeRun).toContain('pids+=("$!")');
    expect(posixRuntimeRun).toContain('wait "$pid"');

    const macPkgRun = cneSteps.find((s) => (s.name ?? '').includes('macOS .pkg installer'))?.run ?? '';
    expect(macPkgRun).toContain('build_pids+=("$!")');
    expect(macPkgRun).toContain('notary_pids+=("$!")');
    expect(macPkgRun.indexOf('sign-pkg "$PKG"')).toBeLessThan(macPkgRun.indexOf('notarize "$PKG"'));
  });

  it('computes release_version.outputs.android_changed fail-open while skipping android-release on unrelated dev pushes', () => {
    const versionStep = ci().jobs.release_version!.steps.find((s) => (s as { id?: string }).id === 'version');
    expect(versionStep?.run).toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'imcodes-ci-android-gate-'));
    try {
      const repo = join(dir, 'repo');
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, 'web', 'android'), { recursive: true });
      const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git(['init']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      git(['add', '.']);
      git(['commit', '-m', 'base']);
      const baseSha = git(['rev-parse', 'HEAD']);

      // Commit 2: change only src/
      writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
      git(['add', '.']);
      git(['commit', '-m', 'daemon only']);
      const daemonSha = git(['rev-parse', 'HEAD']);

      // Commit 3: change web/android/
      writeFileSync(join(repo, 'web', 'android', 'marker.txt'), 'change\n');
      git(['add', '.']);
      git(['commit', '-m', 'android change']);
      const androidSha = git(['rev-parse', 'HEAD']);

      const evalAndroidChanged = (params: { ref: string; eventName: string; before: string; sha: string }) => {
        const out = join(dir, `out-${Math.random().toString(36).slice(2)}.txt`);
        writeFileSync(out, '');
        execFileSync('bash', ['--noprofile', '--norc', '-c', versionStep!.run!], {
          cwd: repo,
          env: {
            ...process.env,
            GITHUB_REF: params.ref,
            GITHUB_EVENT_NAME: params.eventName,
            GITHUB_EVENT_BEFORE: params.before,
            GITHUB_SHA: params.sha,
            GITHUB_RUN_NUMBER: '10',
            GITHUB_OUTPUT: out,
          },
          stdio: 'pipe',
        });
        const line = readFileSync(out, 'utf8').trim().split('\n').find((l) => l.startsWith('android_changed='));
        return line?.slice('android_changed='.length);
      };

      expect(evalAndroidChanged({ ref: 'refs/heads/dev', eventName: 'push', before: baseSha, sha: daemonSha })).toBe('false');
      expect(evalAndroidChanged({ ref: 'refs/heads/dev', eventName: 'push', before: daemonSha, sha: androidSha })).toBe('true');
      expect(evalAndroidChanged({ ref: 'refs/heads/dev', eventName: 'workflow_dispatch', before: baseSha, sha: daemonSha })).toBe('true');
      expect(evalAndroidChanged({ ref: 'refs/heads/dev', eventName: 'push', before: '0'.repeat(40), sha: daemonSha })).toBe('true');
      expect(evalAndroidChanged({ ref: 'refs/heads/dev', eventName: 'push', before: 'f'.repeat(40), sha: daemonSha })).toBe('true');
      expect(evalAndroidChanged({ ref: 'refs/heads/master', eventName: 'push', before: baseSha, sha: daemonSha })).toBe('true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
