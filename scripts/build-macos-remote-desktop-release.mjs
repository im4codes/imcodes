#!/usr/bin/env node
/**
 * Build, sign, notarize and describe one architecture's macOS remote-desktop
 * component set.
 *
 * This is the step that was missing: `macos-remote-desktop-build.mjs` produced
 * a plan that only tests and the release guard ever read, and nothing executed
 * it. The components are compiled by `build-worker-from-sdk.sh` against the
 * published libwebrtc SDK, signed one file at a time with their own
 * entitlements, notarized one file at a time, verified with the same guards
 * the daemon applies on a user's Mac, and finally described by a manifest
 * the shared strict validator accepts.
 *
 * Notarization is injected rather than called directly, for a reason that is
 * not testability theatre: it needs an Apple notary key that exists only as a
 * CI secret, and a driver that could not be exercised without one would be a
 * driver nobody runs until release day.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER,
  buildMacosRemoteDesktopBuildPlan,
  buildMacosRemoteDesktopManifest,
  verifyBuiltMacosRemoteDesktopComponent,
} from './macos-remote-desktop-build.mjs';
import { notarizeExecutable } from './macos-release-signing.mjs';
import { isModuleEntry } from './module-entry.mjs';
// From the packaging module, not the TypeScript originals: this runs as
// `node scripts/build-macos-remote-desktop-release.mjs` on a build machine,
// where a .ts import does not resolve. A test asserts the two agree.
import {
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
} from './remote-desktop-worker-artifacts.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
}

/**
 * Compile the components, then publish only the components.
 *
 * The build leaves its object files, response files and compile list beside
 * the executables. A release directory must contain EXACTLY the manifest and
 * the components it names -- `assertExactComponentSetEntries` refuses anything
 * else, and rightly: an extra file ships alongside signed artifacts while
 * nothing describes or verifies it. So the build gets a scratch directory of
 * its own, which also keeps its intermediates available for debugging, and the
 * named executables are copied out into the clean one.
 */
export function compileComponents(input, dependencies = {}) {
  const { sdkRoot, artifactRoot, arch, jobs, fileNames } = input;
  const execute = dependencies.run ?? run;
  const work = dependencies.workDirectory ?? mkdtempSync(join(tmpdir(), 'imcodes-macos-rd-build-'));
  execute('/bin/bash', [
    join(repositoryRoot, 'native', 'macos-remote-desktop', 'build-worker-from-sdk.sh'),
    '--sdk-root', sdkRoot,
    '--artifact-root', work,
    '--target-cpu', arch,
    ...(jobs === undefined ? [] : ['--jobs', String(jobs)]),
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  for (const fileName of fileNames) {
    const built = join(work, fileName);
    if (!existsSync(built)) throw new Error(`build produced no ${fileName}`);
    copyFileSync(built, join(artifactRoot, fileName));
    // Preserved explicitly: a component that arrives without its executable
    // bit is signed and verified perfectly and then cannot be launched.
    chmodSync(join(artifactRoot, fileName), 0o755);
  }
  return work;
}

/**
 * Sign one component with its own entitlements.
 *
 * The plan owns the argument list, including the `--identifier` that pins the
 * signature to this component's bundle identifier: two components signed with
 * the same identifier would each satisfy the other's designated requirement.
 */
export function signComponent(component, executablePath, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const entitlementsPath = join(
    repositoryRoot, 'native', 'macos-remote-desktop', component.entitlementsFile,
  );
  const [tool, ...args] = component.codesign;
  // Matched against `entitlementsFile`, the repository-relative PATH. The
  // plan's `entitlements` field is the parsed plist -- an object -- so
  // comparing against it never matches and codesign is handed a relative path
  // that resolves only when the process happens to be running inside
  // native/macos-remote-desktop.
  const resolved = args.map((argument) => (
    argument === component.entitlementsFile ? entitlementsPath : argument
  ));
  if (!resolved.includes(entitlementsPath)) {
    throw new Error(`codesign arguments for ${component.kind} carry no entitlements path to resolve`);
  }
  execute(tool, [...resolved, executablePath]);
}

/**
 * Notarize each component on its own.
 *
 * Per component rather than one archive of the set, because the record this
 * produces binds a ticket to BYTES: `notarizeExecutable` hashes the artifact
 * it was given. Submitting a zip of all four would record that zip's hash four
 * times -- a number describing none of the components it was attached to.
 *
 * The zipping that Apple's submission format requires is the helper's job, not
 * this one's: `notarytool` accepts only .zip, .pkg and .dmg, so a bare
 * executable is packed for the trip and the ticket record still describes the
 * executable.
 */
export function notarizeComponents(input, dependencies = {}) {
  const notarize = dependencies.notarize ?? notarizeExecutable;
  const { artifactRoot, components, notaryCredentials } = input;
  const evidence = {};
  for (const component of components) {
    evidence[component.kind] = notarize({
      artifactPath: join(artifactRoot, component.fileName),
      ...notaryCredentials,
    });
  }
  return evidence;
}

/**
 * Run a verification tool and report what it did, including its exit status.
 *
 * `commandText` refuses a result without a numeric `status` -- and an adapter
 * that returned only stdout and stderr made `status` undefined, so every guard
 * failed identically with "build tool reported failure" before reading a byte
 * of output. A non-zero exit is returned rather than thrown so the guard that
 * asked can say which check failed and on what.
 */
export function commandResult(tool, args) {
  try {
    return {
      stdout: run(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
      stderr: '',
      status: 0,
    };
  } catch (error) {
    return {
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
      status: typeof error?.status === 'number' ? error.status : 1,
    };
  }
}

/**
 * Everything the daemon checks on a user's Mac, run here instead.
 *
 * Returned measurements are what the manifest describes, so the file that is
 * measured is the file that was verified -- not one re-read afterwards.
 */
export async function verifyComponents(plan, artifactRoot, dependencies = {}) {
  const measured = {};
  for (const component of plan.components) {
    const executablePath = join(artifactRoot, component.fileName);
    measured[component.kind] = await verifyBuiltMacosRemoteDesktopComponent(
      plan, component, executablePath, {
        run: dependencies.run ?? commandResult,
        readFile: dependencies.readFile ?? ((path) => readFile(path)),
      },
    );
  }
  return measured;
}

export async function buildMacosRemoteDesktopRelease(input, dependencies = {}) {
  const plan = await buildMacosRemoteDesktopBuildPlan({
    arch: input.arch,
    teamId: input.teamId,
    signingIdentity: input.signingIdentity,
    workerVersion: input.workerVersion,
  });
  const artifactRoot = resolve(input.artifactRoot);
  await mkdir(artifactRoot, { recursive: true });

  // Awaited, even though the built-in implementation is synchronous: a hook
  // that silently ignores a returned promise runs the next stage against files
  // that do not exist yet, and the failure surfaces as a missing artifact
  // several steps later.
  await (dependencies.compile ?? compileComponents)({
    sdkRoot: resolve(input.sdkRoot),
    artifactRoot,
    arch: input.arch,
    jobs: input.jobs,
    fileNames: plan.components.map((component) => component.fileName),
  });

  for (const component of plan.components) {
    await (dependencies.sign ?? signComponent)(
      component, join(artifactRoot, component.fileName), dependencies,
    );
  }

  const evidence = await (dependencies.notarizeAll ?? notarizeComponents)({
    artifactRoot,
    components: plan.components,
    notaryCredentials: input.notaryCredentials,
  }, dependencies);
  for (const kind of MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER) {
    if (evidence[kind] === undefined) {
      throw new Error(`notarization produced no evidence for ${kind}`);
    }
  }

  // After notarization, because notarizing does not alter the file but the
  // verification must describe the bytes that shipped, and `spctl` can only
  // reach its verdict once Apple has seen them.
  const measured = await (dependencies.verifyAll ?? verifyComponents)(
    plan, artifactRoot, dependencies,
  );
  for (const component of plan.components) {
    if (measured[component.kind] === undefined) {
      throw new Error(`verification produced no measurement for ${component.kind}`);
    }
  }

  const manifest = buildMacosRemoteDesktopManifest(
    plan, measured, evidence, input.toolchain,
    {
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    },
  );
  await writeFile(
    join(artifactRoot, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return { plan, manifest, artifactRoot };
}

/**
 * Named up front rather than discovered as an undefined deep inside notarytool.
 *
 * A missing credential otherwise surfaces as an Apple-side rejection minutes
 * into a release build, with a message about the submission rather than about
 * the variable nobody set.
 */
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const [, , ...argv] = process.argv;
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/u, '');
    if (!key || argv[index + 1] === undefined) {
      throw new Error(
        'usage: build-macos-remote-desktop-release.mjs --arch <arm64|x64> --sdk-root DIR '
        + '--artifact-root DIR --worker-version V [--jobs N]',
      );
    }
    options[key] = argv[index + 1];
  }
  const teamId = requireEnv('IMCODES_MACOS_TEAM_ID');
  const signingIdentity = requireEnv('IMCODES_MACOS_SIGNING_IDENTITY');
  const result = await buildMacosRemoteDesktopRelease({
    arch: options.arch,
    sdkRoot: options['sdk-root'],
    artifactRoot: options['artifact-root'],
    workerVersion: options['worker-version'],
    jobs: options.jobs === undefined ? undefined : Number(options.jobs),
    teamId,
    signingIdentity,
    // The same three names `macos-release-signing.mjs` already requires, so one
    // set of secrets serves the app bundle and the components.
    notaryCredentials: {
      apiKeyPath: requireEnv('IMCODES_MACOS_NOTARY_KEY_PATH'),
      apiKeyId: requireEnv('IMCODES_MACOS_NOTARY_KEY_ID'),
      apiIssuer: requireEnv('IMCODES_MACOS_NOTARY_ISSUER'),
    },
    toolchain: JSON.parse(readFileSync(join(resolve(options['sdk-root']), 'sdk-build.json'), 'utf8')).toolchain,
  });
  process.stdout.write(`${result.artifactRoot}\n`);
}

if (isModuleEntry(import.meta.url)) {
  await main();
}
