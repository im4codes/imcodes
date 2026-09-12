import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildMacosRemoteDesktopRelease,
  commandResult,
  compileComponents,
  notarizeComponents,
  signComponent,
} from '../../scripts/build-macos-remote-desktop-release.mjs';
import {
  MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER,
  buildMacosRemoteDesktopBuildPlan,
  macosRemoteDesktopDesignatedRequirement,
} from '../../scripts/macos-remote-desktop-build.mjs';
import {
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  validateRemoteDesktopWorkerReleaseManifest,
} from '../../shared/remote-desktop-worker.js';

const TEAM_ID = 'M675E26Q67';
const SIGNING_IDENTITY = 'A'.repeat(40);
const WORKER_VERSION = '2026.9.4200';
const TOOLCHAIN = { xcode: '26.6', macosSdk: '26.5', clang: 'llvmorg-23-init-19482-g53d18800-1' };

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function unstapledRecord(bytes: Buffer) {
  return {
    status: 'accepted' as const,
    submissionId: '3e6a1c2d-9f4b-4a7c-8d1e-5b6c7d8e9f01',
    ticketSha256: createHash('sha256').update(bytes).digest('hex'),
    stapled: false as const,
    stapleValidated: false as const,
    unstapledReason: 'artifact_format_cannot_carry_a_ticket' as const,
  };
}

/**
 * Drives the real release script with the two things a build machine has and a
 * test does not: a Developer ID certificate and an Apple notary key. Everything
 * else -- the plan, the entitlements, the manifest assembly and the strict
 * validator -- is the production code path.
 */
async function runDriver(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-rd-release-'));
  roots.push(root);
  const artifactRoot = join(root, 'darwin-arm64');
  const built: Record<string, Buffer> = {};
  const signed: string[] = [];
  let verifiedRoot = '';

  const result = await buildMacosRemoteDesktopRelease({
    arch: 'arm64',
    sdkRoot: root,
    artifactRoot,
    workerVersion: WORKER_VERSION,
    teamId: TEAM_ID,
    signingIdentity: SIGNING_IDENTITY,
    notaryCredentials: {},
    toolchain: TOOLCHAIN,
  }, {
    compile: async ({ fileNames }: { fileNames: string[] }) => {
      for (const fileName of fileNames) {
        const bytes = Buffer.from(`signed arm64 ${fileName} ${WORKER_VERSION}`);
        built[fileName] = bytes;
        await writeFile(join(artifactRoot, fileName), bytes, { mode: 0o755 });
      }
    },
    sign: (component: { fileName: string }) => { signed.push(component.fileName); },
    notarize: ({ artifactPath }: { artifactPath: string }) => (
      unstapledRecord(built[artifactPath.split('/').at(-1) as string])
    ),
    // The component guards -- thin architecture, minimum OS, signature,
    // hardened runtime, identifier, team, designated requirement, Gatekeeper
    // -- have their own tests against emulated tool output. What is under test
    // here is the orchestration around them, so verification is injected and
    // its measurements are the ones the manifest must carry.
    verifyAll: async (_plan: unknown, root: string) => {
      verifiedRoot = root;
      return Object.fromEntries(Object.entries(built).map(([fileName, bytes]) => [
        MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER.find(
          (kind) => fileName.includes(kind === 'launchAgent' ? 'launch-agent'
            : kind === 'virtualDisplayHelper' ? 'virtual-display-helper' : kind),
        ) as string,
        { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      ]));
    },
    ...overrides,
  });
  return { result, artifactRoot, signed, built, verifiedRoot };
}

describe('macOS remote-desktop release driver', () => {
  it('publishes only the components it names, beside the manifest', async () => {
    // `assertExactComponentSetEntries` refuses a release directory holding
    // anything else, and the build leaves object files, response files and a
    // compile list behind. An extra file would ship next to signed artifacts
    // with nothing describing or verifying it.
    const { result, artifactRoot } = await runDriver();
    const entries = (await readdir(artifactRoot)).sort();
    expect(entries).toEqual([
      REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
      ...result.plan.components.map((component: { fileName: string }) => component.fileName),
    ].sort());
  });

  it('signs every component, each with its own entitlements', async () => {
    // One file at a time, never `--deep`: each component carries a different
    // entitlement set, and a single signature over the set would give the
    // disclosure helper the worker's screen-recording entitlement.
    const { result, signed } = await runDriver();
    expect(signed.sort()).toEqual(
      result.plan.components
        .map((component: { fileName: string }) => component.fileName)
        .sort(),
    );
    const entitlements = new Set(
      result.plan.components.map((component: { entitlementsFile: string }) => component.entitlementsFile),
    );
    expect(entitlements.size).toBe(MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER.length);
  });

  it('reports an exit status with every command it runs', () => {
    // `commandText` refuses a result without a numeric `status`. An adapter
    // returning only stdout and stderr left it undefined, so every guard threw
    // "build tool reported failure" before reading a byte of output -- and it
    // did so after the components had been compiled, signed and notarized,
    // which is a long way to travel for a missing field.
    // One command that writes to both streams and exits non-zero, so all
    // three properties are asserted at once -- and on any Unix, because this
    // suite also runs on Linux where codesign does not exist.
    const both = commandResult('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3']);
    expect(both.stdout.trim()).toBe('out');
    expect(both.stderr.trim()).toBe('err');
    // Returned, not thrown, so the guard that asked is the one that names
    // which check failed rather than the adapter deciding for it.
    expect(both.status).toBe(3);

    const ok = commandResult('/bin/sh', ['-c', 'exit 0']);
    expect(ok.status).toBe(0);
  });

  it.runIf(process.platform === 'darwin')(
    'reads the signing details codesign prints only to stderr',
    () => {
      // The real motivation, and macOS-only: `codesign --display --verbose=4`
      // puts Identifier, TeamIdentifier and the CodeDirectory flags on stderr
      // and leaves stdout empty. An adapter returning stdout alone reported a
      // correctly hardened binary as "not signed with the Hardened Runtime" --
      // it had discarded the stream that said so, and the release build got as
      // far as notarizing four components before saying it.
      const display = commandResult('/usr/bin/codesign', ['--display', '--verbose=4', '/bin/ls']);
      expect(display.status).toBe(0);
      expect(display.stderr).toContain('CodeDirectory');
      expect(display.stdout).toBe('');
    },
  );

  it('builds the requirement codesign actually emits for Developer ID', () => {
    // Checked against a real Developer ID signature rather than against
    // itself. The two marker extensions sit BETWEEN the anchor and the team
    // clause, so the previous string -- identifier, anchor, team -- appeared
    // nowhere in what codesign prints, and the substring comparison could not
    // match any Developer-ID-signed binary. Three release builds compiled,
    // signed and notarized four components each before saying so.
    //
    // They are not cosmetic either: 1.2.840.113635.100.6.2.6 marks the
    // Developer ID intermediate and 1.2.840.113635.100.6.1.13 the Developer ID
    // Application leaf. Without them an Apple Development certificate from the
    // same team satisfies the requirement, and one of those is issued to every
    // individual developer on the account.
    const requirement = macosRemoteDesktopDesignatedRequirement(
      'cc.imcodes.node.remote-desktop-worker', TEAM_ID,
    );
    expect(requirement).toBe(
      'identifier "cc.imcodes.node.remote-desktop-worker" and anchor apple generic'
      + ' and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */'
      + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */'
      + ` and certificate leaf[subject.OU] = "${TEAM_ID}"`,
    );
    // And the same text the shared runtime validator demands, since the
    // manifest carries it across that boundary.
    expect(validateRemoteDesktopWorkerReleaseManifest).toBeTypeOf('function');
  });

  it('hands codesign an absolute entitlements path', async () => {
    // The plan's `entitlements` field is the PARSED plist, an object; the path
    // is `entitlementsFile`. Substituting against the wrong one silently left
    // codesign a relative path that resolves only when the process happens to
    // be running inside native/macos-remote-desktop -- so it worked from one
    // directory and signed with no entitlements from anywhere else.
    const plan = await buildMacosRemoteDesktopBuildPlan({
      arch: 'arm64', teamId: TEAM_ID, signingIdentity: SIGNING_IDENTITY, workerVersion: WORKER_VERSION,
    });
    for (const component of plan.components) {
      const args: string[] = [];
      signComponent(component, '/release/component', {
        run: (_tool: string, given: string[]) => { args.push(...given); },
      });
      const value = args[args.indexOf('--entitlements') + 1];
      expect(value.startsWith('/')).toBe(true);
      expect(value.endsWith(component.entitlementsFile)).toBe(true);
    }
  });

  it('emits a manifest the shared strict validator accepts', async () => {
    const { result, artifactRoot } = await runDriver();
    const written = JSON.parse(
      await readFile(join(artifactRoot, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME), 'utf8'),
    );
    expect(written).toEqual(JSON.parse(JSON.stringify(result.manifest)));
    const validated = validateRemoteDesktopWorkerReleaseManifest(written, {
      os: 'darwin',
      arch: 'arm64',
    });
    expect(validated).not.toBeNull();
    expect(validated?.minimumOsVersion).toBe('12.3');
  });

  it('records a ticket bound to each component, not one shared number', async () => {
    // The evidence hashes the artifact it was given. Notarizing an archive of
    // the set would record that archive's digest for all four -- a number
    // describing none of the components it was attached to.
    const { result } = await runDriver();
    const digests = MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER.map(
      (kind) => result.manifest.components[kind].notarization.ticketSha256,
    );
    expect(new Set(digests).size).toBe(digests.length);
    for (const kind of MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER) {
      expect(result.manifest.components[kind].notarization).toMatchObject({
        stapled: false,
        unstapledReason: 'artifact_format_cannot_carry_a_ticket',
      });
    }
  });

  it('verifies the directory it published, not the one it built in', async () => {
    // The build writes its object files beside the executables, so the two
    // directories are deliberately different. Verifying the scratch one would
    // measure files that are not the ones shipped.
    const { artifactRoot, verifiedRoot } = await runDriver();
    expect(verifiedRoot).toBe(artifactRoot);
  });

  it('copies out only the named components, leaving build debris behind', async () => {
    // This is the part the mocked compile above cannot exercise, and it is the
    // one that keeps a release directory exact: the real build leaves an obj/
    // tree, response files and a compile list, none of which any manifest
    // describes.
    const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-rd-copyout-'));
    roots.push(root);
    const work = join(root, 'work');
    const release = join(root, 'release');
    await mkdir(work, { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(join(work, 'imcodes-remote-desktop-worker'), 'worker', { mode: 0o755 });
    await writeFile(join(work, 'compile-flags.rsp'), 'flags');
    await mkdir(join(work, 'obj'), { recursive: true });

    compileComponents(
      {
        sdkRoot: root,
        artifactRoot: release,
        arch: 'arm64',
        fileNames: ['imcodes-remote-desktop-worker'],
      },
      { run: () => '', workDirectory: work },
    );

    expect(await readdir(release)).toEqual(['imcodes-remote-desktop-worker']);
    // And still executable: a component that arrives without its executable
    // bit signs and verifies perfectly and then cannot be launched.
    expect((await stat(join(release, 'imcodes-remote-desktop-worker'))).mode & 0o111).not.toBe(0);
  });

  it('refuses to describe a set some component was never notarized for', async () => {
    // A missing record would otherwise reach the manifest builder as an
    // undefined notarization and be reported as a generic missing-evidence
    // error, long after the point where the omission happened.
    await expect(runDriver({
      notarizeAll: () => ({ worker: unstapledRecord(Buffer.from('x')) }),
    })).rejects.toThrow(/notarization produced no evidence for/u);
  });

  it('hands each component its own path to the notary', async () => {
    const seen: string[] = [];
    const components = [
      { kind: 'worker', fileName: 'imcodes-remote-desktop-worker' },
      { kind: 'disclosure', fileName: 'imcodes-remote-desktop-disclosure' },
    ];
    notarizeComponents(
      { artifactRoot: '/release', components, notaryCredentials: {} },
      {
        notarize: ({ artifactPath }: { artifactPath: string }) => {
          seen.push(artifactPath);
          return unstapledRecord(Buffer.from(artifactPath));
        },
      },
    );
    expect(seen).toEqual([
      '/release/imcodes-remote-desktop-worker',
      '/release/imcodes-remote-desktop-disclosure',
    ]);
  });
});
