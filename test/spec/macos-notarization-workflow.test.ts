import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { readSource } from '../helpers/read-source.js';

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync }));
import { MACOS_RELEASE_SIGNING_TOOLS, notarizeAndStaple } from '../../scripts/macos-release-signing.mjs';

describe('release workflows use the validated notarization result once', () => {
  it.each(['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml'])(
    '%s keeps app and disk-image checks inside the bounded retry gate', (file) => {
      const workflow = parse(readSource(file));
      const steps = Object.values(workflow.jobs as Record<string, { steps?: Array<{ name?: string; run?: string }> }>)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.name === 'Build and notarize the aiDesk application bundle'
          || step.name === 'Build, sign and notarize the aiDesk disk image');
      expect(steps).toHaveLength(2);
      for (const step of steps) {
        expect(step.run).toMatch(/^\s*set -euo pipefail$/m);
        expect(step.run).toMatch(/^\s*node scripts\/macos-release-signing\.mjs notarize "\$(APP|DMG)"$/m);
        // That command returns only after acceptance, staple AND validation.
        // A second, un-retried validate crosses CloudKit again and can fail an
        // already validated release with NSURLErrorDomain -1005 / exit 68.
        expect(step.run).not.toMatch(/^\s*xcrun stapler validate\b/m);
        expect(step.run).not.toMatch(/\|\|\s*true|continue-on-error/);
      }
    },
  );
});

describe('notarization gate under CloudKit validation failures', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'imcodes-test-notarization-'));
    execFileSync.mockReset();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function artifact(kind: 'app' | 'dmg') {
    const artifactPath = join(dir, `aiDesk.to by IM.codes.${kind}`);
    if (kind === 'app') {
      mkdirSync(join(artifactPath, 'Contents'), { recursive: true });
      writeFileSync(join(artifactPath, 'Contents', 'Info.plist'), 'test app');
    } else writeFileSync(artifactPath, 'test disk image');
    return { artifactPath, apiKeyPath: join(dir, 'test-notary.p8'), apiKeyId: 'test-id', apiIssuer: 'test-issuer' };
  }

  function injectValidationFailure(failures: number, accepted = true) {
    const failure = Object.assign(new Error('stapler validate exited 68'), {
      status: 68, stderr: 'NSURLErrorDomain Code=-1005 "The network connection was lost."',
    });
    let validations = 0;
    execFileSync.mockImplementation((tool: string, args: string[]) => {
      if (tool === MACOS_RELEASE_SIGNING_TOOLS.xcrun && args[0] === 'notarytool') {
        return JSON.stringify({ id: 'test-submission', status: accepted ? 'Accepted' : 'Invalid' });
      }
      if (tool === MACOS_RELEASE_SIGNING_TOOLS.xcrun && args[1] === 'validate' && validations++ < failures) throw failure;
      return '';
    });
    return failure;
  }

  const commands = (subcommand: string) => execFileSync.mock.calls.filter(
    ([tool, args]) => tool === MACOS_RELEASE_SIGNING_TOOLS.xcrun && args[1] === subcommand,
  );

  it.each(['app', 'dmg'] as const)('validates a normal %s exactly once', (kind) => {
    injectValidationFailure(0);
    expect(notarizeAndStaple(artifact(kind))).toMatchObject({ status: 'accepted', stapled: true, stapleValidated: true });
    expect(commands('submit')).toHaveLength(1);
    expect(commands('validate')).toHaveLength(1);
    expect(execFileSync.mock.calls.filter(([tool]) => tool === 'sleep')).toHaveLength(0);
  });

  it.each(['app', 'dmg'] as const)('retries the exact CI CloudKit failure before accepting %s', (kind) => {
    injectValidationFailure(1);
    expect(notarizeAndStaple(artifact(kind))).toMatchObject({ status: 'accepted', stapled: true, stapleValidated: true });
    expect(commands('submit')).toHaveLength(1); // Never notarize the artifact twice for a validation failure.
    expect(commands('staple')).toHaveLength(2);
    expect(commands('validate')).toHaveLength(2);
    expect(execFileSync).toHaveBeenCalledWith('sleep', ['5']);
  });

  it.each(['app', 'dmg'] as const)('fails closed after the bounded validation attempts for %s', (kind) => {
    const failure = injectValidationFailure(Infinity);
    expect(() => notarizeAndStaple(artifact(kind))).toThrow(failure);
    expect(commands('submit')).toHaveLength(1);
    expect(commands('validate')).toHaveLength(6);
    expect(execFileSync.mock.calls.filter(([tool]) => tool === 'sleep').map(([, args]) => args))
      .toEqual([['5'], ['10'], ['15'], ['20'], ['25']]);
  });

  it.each(['app', 'dmg'] as const)('does not accept or staple an Apple-rejected %s', (kind) => {
    injectValidationFailure(0, false);
    expect(() => notarizeAndStaple(artifact(kind))).toThrow(/not accepted.*Invalid/);
    expect(commands('submit')).toHaveLength(1);
    expect(commands('staple')).toHaveLength(0);
    expect(commands('validate')).toHaveLength(0);
  });
});
