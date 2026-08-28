import { execFileSync } from 'node:child_process';
import { runNative, runNativeOrThrow } from './support/native-exec.js';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native', 'macos-remote-desktop');
const SCRIPT = resolve(ROOT, 'scripts', 'macos-remote-desktop-build-spike.sh');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

/**
 * The `cflags_objcc` of ONE exact GN target, parsed from its own block.
 *
 * Asserting on the whole BUILD.gn text cannot tell which target a flag belongs
 * to: `toContain('-fobjc-arc')` passes when the flag sits in any of the other
 * seventeen targets, or in a comment. Everything below compiles with the flags
 * this specific target really uses.
 */
async function objccFlagsOfTarget(buildGn: string, target: string): Promise<string[]> {
  const start = buildGn.indexOf(`source_set("${target}")`);
  if (start < 0) throw new Error(`no GN target ${target}`);
  let depth = 0;
  let end = start;
  for (let i = buildGn.indexOf('{', start); i < buildGn.length; i += 1) {
    if (buildGn[i] === '{') depth += 1;
    else if (buildGn[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const block = buildGn.slice(start, end);
  const flags = /cflags_objcc\s*=\s*\[([\s\S]*?)\]/u.exec(block);
  if (!flags) return [];
  return [...flags[1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

interface BuildContract {
  contractVersion: number;
  minimumMacosVersion: string;
  architectures: Array<{
    name: string;
    hostArchitecture: string;
    gnTargetCpu: string;
    clangArchitecture: string;
  }>;
  frameworks: string[];
  targets: {
    mediaProbe: string;
    launchAgent: string;
    worker: string;
    disclosure: string;
  };
  launchAgent: {
    peerVerifierMode: string;
    inheritedSocketFd: number;
    normalWorkerSibling: string;
    refusesRootWorkerStart: boolean;
  };
  libwebrtcRevision: string;
  depotToolsRevision: string;
  runtimeDownloadsAllowed: boolean;
  fullProbeRequiresNativeArchitecture: boolean;
}

/**
 * The exact set of shipped component labels the script hands ninja.
 *
 * Parsed out of the SHIPPED_TARGET_LABELS array rather than matched as a
 * substring. The previous assertions pinned two labels appearing *adjacent* in
 * the command line, which said nothing about the set actually built: it went
 * red the moment the labels moved into an array, and it would have stayed green
 * if a component had been dropped while the surviving two stayed neighbours.
 */
function shippedTargetLabelVariables(source: string): string[] {
  const open = source.indexOf('SHIPPED_TARGET_LABELS=(');
  expect(open, 'SHIPPED_TARGET_LABELS array not found').toBeGreaterThan(-1);
  const close = source.indexOf(')', open);
  expect(close, 'SHIPPED_TARGET_LABELS array is not closed').toBeGreaterThan(-1);
  return source
    .slice(open, close)
    .split('\n')
    .map((line) => /^\s*"\$([A-Z_]+_TARGET_LABEL)"\s*$/u.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

/** Every `--target` the libwebrtc notices generator is given. */
function noticesTargetVariables(source: string): string[] {
  const open = source.indexOf('NOTICES_OUTPUT="');
  const close = source.indexOf('--output "$NOTICES_OUTPUT"', open);
  expect(close, 'notices invocation not found').toBeGreaterThan(-1);
  return source
    .slice(open, close)
    .split('\n')
    .map((line) => /--target "\/\/\$([A-Z_]+_TARGET_LABEL)"/u.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

/**
 * Runs a long compile WITHOUT blocking the worker thread.
 *
 * `spawnSync` holds the event loop for the whole compile, so vitest's worker
 * cannot answer its own `onTaskUpdate` RPC and the run fails with an internal
 * timeout even though every test passed.
 */
async function runTool(
  command: string, args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveRun) => {
    const child = spawn(command, [...args]);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', (error) => resolveRun({ status: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolveRun({ status: code, stdout, stderr }));
  });
}

describe('macOS remote-desktop build spike contract', () => {
  const source = read('native/macos-remote-desktop/build_spike.mm');
  const build = read('native/macos-remote-desktop/BUILD.gn');
  const script = read('scripts/macos-remote-desktop-build-spike.sh');
  const documentation = read('native/macos-remote-desktop/README.md');
  const pins = JSON.parse(read('shared/remote-desktop-native-pins.json')) as {
    libwebrtcRevision: string;
    depotToolsRevision: string;
  };
  const contract = JSON.parse(execFileSync('bash', [SCRIPT, '--print-contract'], {
    encoding: 'utf8',
  })) as BuildContract;

  it('loads concrete ScreenCaptureKit and VideoToolbox symbols and links both frameworks', async () => {
    expect(source).toContain('#import <ScreenCaptureKit/ScreenCaptureKit.h>');
    expect(source).toContain('#import <VideoToolbox/VideoToolbox.h>');
    expect(source).toContain('[SCShareableContent class]');
    expect(source).toContain('VTCompressionSessionCreate(');
    expect(build).toContain('"ScreenCaptureKit.framework"');
    expect(build).toContain('"VideoToolbox.framework"');
    expect(script).toContain('-framework ScreenCaptureKit');
    expect(script).toContain('-framework VideoToolbox');
  });

  it('forces one pinned upstream WebRTC foundation into the executable link', async () => {
    expect(build).toContain('deps = [ "//:webrtc" ]');
    expect(source).toContain('#include "api/create_modular_peer_connection_factory.h"');
    expect(source).toContain('webrtc::CreateModularPeerConnectionFactory(');
    expect(script).toContain('git -C "$WEBRTC_ROOT" rev-parse HEAD');
    expect(script).toContain('"$ACTUAL_LIBWEBRTC_REVISION" != "$PINNED_LIBWEBRTC_REVISION"');
    // With pipefail enabled, `nm | grep -q` can report failure after grep
    // closes the pipe early and nm receives SIGPIPE. Capture first so a real
    // linked factory symbol cannot be misclassified as absent.
    expect(script).toContain('ARTIFACT_SYMBOLS="$(xcrun nm "$ARTIFACT")"');
    expect(script).not.toContain('xcrun nm "$ARTIFACT" | grep -Fq');
    expect(script).toContain("grep -Fq 'CreateModularPeerConnectionFactory'");
    expect(contract.libwebrtcRevision).toBe(pins.libwebrtcRevision);
    expect(contract.depotToolsRevision).toBe(pins.depotToolsRevision);
    expect(contract.runtimeDownloadsAllowed).toBe(false);
    expect(`${build}\n${source}`).not.toMatch(/libdatachannel|GStreamer|LiveKit|mediasoup/i);
  });

  it('accepts only an explicit absolute SDK override for native build runners', async () => {
    expect(script).toContain(
      'IMCODES_MACOS_SDK_PATH must name an absolute SDK directory.',
    );
    expect(script).toContain(
      'SDK_LINK_RELATIVE="$OUT_DIR/sdk/imcodes_override/MacOSX.sdk"',
    );
    expect(script).toContain('SDK_GN_PATH="//$SDK_LINK_RELATIVE"');
    expect(script).toContain('mac_sdk_path=\\"$SDK_GN_PATH\\"');
    expect(script).toContain('ln -sfn "$IMCODES_MACOS_SDK_PATH"');
    expect(script).not.toMatch(/curl|wget|softwareupdate/);
  });

  it('qualifies every shipped component on an old supported SDK', async () => {
    expect(script).toContain('--components-only');
    expect(script).toContain('if $COMPONENTS_ONLY; then');
    // Exactly this set, no more and no less. Set equality rather than substring
    // presence: dropping a component is the failure mode worth catching, and a
    // `toContain` on the survivors cannot see it.
    expect(new Set(shippedTargetLabelVariables(script))).toEqual(new Set([
      'LAUNCH_AGENT_TARGET_LABEL',
      'WORKER_TARGET_LABEL',
      'DISCLOSURE_TARGET_LABEL',
      'HELPER_TARGET_LABEL',
    ]));
    // auto unlock is unqualified and NOT SHIPPED: it must never appear in the
    // default shipped array, only behind --auto-unlock-verification.
    expect(shippedTargetLabelVariables(script)).not.toContain('AUTO_UNLOCK_TARGET_LABEL');
    // BOTH modes build that same array. --components-only differs only by
    // omitting the unshipped upstream aggregate, which is the reason the mode
    // exists; it must not quietly ship fewer components than the full probe.
    const ninja = script.slice(
      script.indexOf('SHIPPED_TARGET_LABELS=('),
      script.indexOf('NOTICES_OUTPUT='),
    );
    const consumers = ninja.split('"${SHIPPED_TARGET_LABELS[@]}"').length - 1;
    expect(consumers, 'both modes must consume the shipped array').toBe(2);
    const componentsOnlyBranch = ninja.slice(
      ninja.indexOf('if $COMPONENTS_ONLY; then'),
      ninja.indexOf('else'),
    );
    expect(componentsOnlyBranch).toContain('"${SHIPPED_TARGET_LABELS[@]}"');
    expect(componentsOnlyBranch).not.toContain('"$TARGET_LABEL"');
    expect(script).toContain(
      'Pinned libwebrtc shipped-component compile/link probe passed',
    );
    expect(script).not.toMatch(/COMPONENTS_ONLY[^\n]*runtimeDownloadsAllowed/u);
  });

  it('gives the libwebrtc notices only the targets that link third-party code', async () => {
    // The auto-unlock bundle is built and verified, but its whole dependency
    // closure is this project's own source_sets plus Security and
    // CoreFoundation. `nm` on the built arm64 bundle reports zero webrtc
    // symbols, so it has nothing to declare in a libwebrtc notices file, and
    // the generator enforces an exact executable set that its own merge path
    // re-checks.
    //
    // The virtual-display helper IS a notices target: its closure reaches
    // //third_party/jsoncpp through remote-desktop-common, exactly as the
    // disclosure executable does. The auto-unlock bundle is not, because its
    // closure really is project source_sets plus system frameworks. The
    // distinction is "does third-party code link in", not "is it shipped".
    expect(new Set(noticesTargetVariables(script))).toEqual(new Set([
      'LAUNCH_AGENT_TARGET_LABEL',
      'WORKER_TARGET_LABEL',
      'DISCLOSURE_TARGET_LABEL',
      'HELPER_TARGET_LABEL',
    ]));
    expect(noticesTargetVariables(script)).not.toContain('AUTO_UNLOCK_TARGET_LABEL');
  });

  it('requires every qualified output to be one exact thin architecture', async () => {
    expect(script).toContain('[[ "$architectures" != "$CLANG_ARCHITECTURE" ]]');
    expect(script).toContain('probe artifact is not a thin $CLANG_ARCHITECTURE slice');
  });

  it('builds the signed LaunchAgent with the inherited-fd verifier before normal worker exec', async () => {
    const main = read('native/macos-remote-desktop/macos_launch_agent_main.mm');
    const identity = JSON.parse(read('native/macos-remote-desktop/code-identity.json')) as {
      components: { launchAgent: { gnTarget: string; fileName: string } };
    };
    expect(identity.components.launchAgent.gnTarget).toBe(
      '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_launch_agent',
    );
    const targetStart = build.indexOf('rtc_executable("imcodes_remote_desktop_launch_agent")');
    const targetEnd = build.indexOf('\n}', targetStart);
    const target = build.slice(targetStart, targetEnd);
    expect(targetStart).toBeGreaterThan(-1);
    expect(target).toContain('"macos_launch_agent_main.mm"');
    expect(target).toContain('"macos_peer_verifier_command.mm"');
    expect(target).toContain('"macos_peer_identity.mm"');
    // The session identity is shared with the worker rather than restated: both
    // sides must derive the session type the same way or the worker's
    // cross-check would reject every launch.
    expect(target).toContain('":macos_session_identity"');
    const verifier = main.indexOf('MaybeRunMacosPeerVerifierCommand(');
    const normalStartup = main.indexOf('ExecVerifiedSiblingWorker(argc, argv)');
    expect(verifier).toBeGreaterThan(-1);
    expect(normalStartup).toBeGreaterThan(verifier);
    expect(main).toContain('execv(worker_path.c_str(), forwarded.data())');
    expect(main.indexOf('if (geteuid() == 0)')).toBeGreaterThan(verifier);
    expect(main.indexOf('if (geteuid() == 0)')).toBeLessThan(normalStartup);
    expect(main).toContain('constexpr char kWorkerFileName[] = "imcodes-remote-desktop-worker"');
    expect(script).toContain('"$LAUNCH_AGENT_TARGET_LABEL"');
    expect(script).toContain("'MaybeRunMacosPeerVerifierCommand'");
    expect(contract.targets.launchAgent).toBe(
      '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_launch_agent',
    );
    expect(contract.targets.worker).toBe(
      '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_worker',
    );
    expect(contract.targets.disclosure).toBe(
      '//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_disclosure',
    );
    // The worker and disclosure are both shipped components, so they are built
    // from the shared array rather than named adjacently on one command line.
    expect(shippedTargetLabelVariables(script)).toContain('WORKER_TARGET_LABEL');
    expect(shippedTargetLabelVariables(script)).toContain('DISCLOSURE_TARGET_LABEL');
    expect(script).toContain('WORKER_SYMBOLS="$(xcrun nm "$WORKER_ARTIFACT")"');
    expect(script).toContain('DISCLOSURE_SYMBOLS="$(xcrun nm "$DISCLOSURE_ARTIFACT")"');
    expect(contract.launchAgent).toEqual({
      peerVerifierMode: '--imcodes-verify-peer-v1',
      inheritedSocketFd: 3,
      normalWorkerSibling: 'imcodes-remote-desktop-worker',
      refusesRootWorkerStart: true,
    });
  });

  it.each([
    ['arm64', 'arm64'],
    ['x64', 'x86_64'],
  ] as const)('compile/links the peer-verifying LaunchAgent for %s', async (architecture, binaryArch) => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-rd-launch-agent-'));
    const output = resolve(directory, 'imcodes-remote-desktop-launch-agent');
    try {
      const result = await runTool('xcrun', [
        '--sdk', 'macosx', 'clang++', '-std=c++20', '-fobjc-arc',
        '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror',
        '-arch', binaryArch, '-mmacosx-version-min=12.3',
        '-Werror=unguarded-availability-new',
        resolve(NATIVE, 'macos_launch_agent_main.mm'),
        resolve(NATIVE, 'macos_peer_verifier_command.mm'),
        resolve(NATIVE, 'macos_peer_identity.mm'),
        // The agent discovers which session launchd loaded it into before it
        // execs the worker: one plist serves both Aqua and LoginWindow, so the
        // installed artifact cannot carry the answer.
        resolve(NATIVE, 'macos_session_identity.mm'),
        // Global LaunchAgent one-shot bootstrap and legacy rollback context
        // share the worker's exact bounded frame parser.
        resolve(NATIVE, 'macos_worker_ipc_client.cc'),
        // The resident agent loop and its authority link: the agent is the
        // supervisor, so these are part of its executable, not the worker's.
        resolve(NATIVE, 'macos_virtual_display_resident_loop.cc'),
        resolve(NATIVE, 'macos_virtual_display_resident.cc'),
        resolve(NATIVE, 'macos_virtual_display_authority_link.cc'),
        resolve(NATIVE, 'macos_virtual_display_authority_link_posix.cc'),
        resolve(NATIVE, 'macos_virtual_display_agent.cc'),
        resolve(NATIVE, 'macos_virtual_display_control_server.cc'),
        resolve(NATIVE, 'macos_virtual_display_helper_backend.cc'),
        resolve(NATIVE, 'macos_virtual_display_supervisor.cc'),
        resolve(NATIVE, 'macos_virtual_display_supervisor_posix.cc'),
        resolve(NATIVE, 'macos_virtual_display_control_protocol.cc'),
        resolve(NATIVE, 'macos_virtual_display_helper_binding.cc'),
        resolve(NATIVE, 'macos_virtual_display_helper_protocol.cc'),
        resolve(NATIVE, 'macos_virtual_display_grant.cc'),
        resolve(NATIVE, 'macos_virtual_display_adapter.cc'),
        resolve(NATIVE, 'screen_capture_kit_limits.cc'),
        resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
        resolve(NATIVE, 'macos_virtual_display_challenge_ledger.cc'),
        '-framework', 'CoreFoundation', '-framework', 'Security',
        '-framework', 'CoreGraphics', '-framework', 'Foundation', '-lbsm',
        '-o', output,
      ], {});
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const architectures = await runNativeOrThrow('xcrun', ['lipo', '-archs', output], {});
      expect(architectures.trim().split(/\s+/)).toEqual([binaryArch]);
      const undefinedSymbols = await runNativeOrThrow('xcrun', ['nm', '-u', output], {});
      expect(undefinedSymbols).toContain('___asan_init');
      expect(undefinedSymbols).toMatch(/___ubsan_handle_/u);
      if ((process.arch === 'arm64' ? 'arm64' : 'x86_64') !== binaryArch) return;

      const worker = resolve(directory, 'imcodes-remote-desktop-worker');
      writeFileSync(worker, '#!/bin/sh\nprintf "worker:%s\\n" "$*"\n');
      chmodSync(worker, 0o755);
      const normal = await runNative(output, ['--macos-remote-desktop-launch-agent', 'generation-7'], {
        env: {
          ...process.env,
          IMCODES_REMOTE_DESKTOP_SOCKET: '/tmp/imcodes-build-test.sock',
          IMCODES_REMOTE_DESKTOP_LAUNCH_CHALLENGE: 'C'.repeat(43),
          IMCODES_REMOTE_DESKTOP_WORKER_GENERATION: '7',
        },
      });
      expect(normal.status, normal.stderr).toBe(0);
      expect(normal.stdout).toContain('worker:--macos-remote-desktop-launch-agent generation-7');

      const verifier = await runNative(output, ['--imcodes-verify-peer-v1'], {});
      expect(verifier.status).toBe(64);
      expect(verifier.stdout).not.toContain('worker:');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    // The agent's source closure is large -- the resident loop, supervisor,
    // control server, grant, ledger and adapter all link into this one probe --
    // and it measures ~19s alone, which overruns the 20s default once the rest
    // of the suite is competing for cores. Sized to the real work rather than
    // trimmed, because every source here is one the agent genuinely needs.
  }, 120_000);

  it('requires separate native arm64 and Intel x64 CI links', async () => {
    expect(contract.architectures).toEqual([
      {
        name: 'arm64',
        hostArchitecture: 'arm64',
        gnTargetCpu: 'arm64',
        clangArchitecture: 'arm64',
      },
      {
        name: 'x64',
        hostArchitecture: 'x86_64',
        gnTargetCpu: 'x64',
        clangArchitecture: 'x86_64',
      },
    ]);
    expect(contract.fullProbeRequiresNativeArchitecture).toBe(true);
    expect(script).toContain('target_cpu=\\"$GN_TARGET_CPU\\"');
    expect(script).toContain('full $ARCHITECTURE probe requires a native $HOST_ARCHITECTURE CI runner');
    expect(documentation).toContain('| Apple Silicon | `arm64` | `arm64` | `arm64` |');
    expect(documentation).toContain('| Intel Mac | `x86_64` | `x64` | `x64` |');
    expect(documentation).toMatch(/does\s+not replace the native Intel job/);
  });

  it('fixes macOS 12.3 in the compiler, GN plan, binary verifier and docs', async () => {
    expect(contract.minimumMacosVersion).toBe('12.3');
    expect(script).toContain('MINIMUM_MACOS_VERSION="12.3"');
    expect(script).toContain('"-mmacosx-version-min=$MINIMUM_MACOS_VERSION"');
    expect(script).toContain('mac_deployment_target=\\"$MINIMUM_MACOS_VERSION\\"');
    expect(script).toContain('mac_min_system_version=\\"$MINIMUM_MACOS_VERSION\\"');
    expect(build).toContain('cflags_objcc = [ "-Werror=unguarded-availability-new" ]');
    expect(script).toContain('-Werror=unguarded-availability-new');
    expect(script).toContain('minos[[:space:]]+$MINIMUM_MACOS_VERSION');
    expect(documentation).toContain('Minimum deployment target: **macOS 12.3**');
  });

  it('compiles cg_display_stream_backend with ARC, proven with the target own flags', async () => {
    // cg_display_stream_backend.mm creates a dispatch queue and a dispatch
    // semaphore and deliberately calls no dispatch_release, on the stated
    // grounds that "this file is compiled with ARC, which owns dispatch
    // objects". That was true of the SOURCE and false of the TARGET: this
    // source_set never passed -fobjc-arc, so both objects leaked on every
    // handle/Stop. The repair belongs in the build -- adding manual
    // dispatch_release would become a use-after-free the moment ARC is on.
    const flags = await objccFlagsOfTarget(build, 'cg_display_stream_backend');
    expect(flags, 'target must declare its own objcc flags').not.toEqual([]);

    // The source-level half of this test is pure text and must run on every
    // platform, so a Linux CI still catches a target that loses ARC. Only the
    // clang probe below is darwin-only: `xcrun` does not exist elsewhere, and
    // spawnSync then yields status === null, which made the positive assertion
    // fail while the negative one passed VACUOUSLY (null !== 0). Gate the
    // compile, never the invariant.
    const backend = read('native/macos-remote-desktop/cg_display_stream_backend.mm');
    expect(backend).toContain('dispatch_queue_create');
    expect(backend).toContain('dispatch_semaphore_create');
    expect(backend).not.toMatch(/^\s*dispatch_release\(/mu);
    expect(await objccFlagsOfTarget(build, 'screen_capture_kit_adapter'))
      .toEqual(['-fobjc-arc', '-Werror=unguarded-availability-new']);
    expect(flags).toContain('-fobjc-arc');

    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-rd-arc-'));
    const probe = resolve(directory, 'arc-probe.mm');
    writeFileSync(probe, [
      '#if !__has_feature(objc_arc)',
      '#error "cg_display_stream_backend must be compiled with ARC"',
      '#endif',
      'int main(void) { return 0; }',
      '',
    ].join('\n'));

    const compiled = await runNative('xcrun', ['clang++', '-fsyntax-only', ...flags, probe], {
    });
    // `toBeTypeOf('number')` first: a failure to SPAWN yields null, and null
    // would otherwise slip through the negative assertion below as a pass.
    expect(compiled.status, 'the ARC probe must actually run on darwin')
      .toBeTypeOf('number');
    expect(compiled.status, compiled.stderr).toBe(0);

    // The other direction, so this is load-bearing rather than a tautology:
    // with -fobjc-arc dropped, the very same probe must FAIL. If someone
    // removes the flag from the target, the positive case above stops passing
    // for exactly this reason.
    const withoutArc = flags.filter((flag) => flag !== '-fobjc-arc');
    expect(withoutArc.length, 'the flag under test must actually be present').toBe(flags.length - 1);
    const negative = await runNative('xcrun', ['clang++', '-fsyntax-only', ...withoutArc, probe], {
    });
    expect(negative.status, 'the negative ARC probe must actually run')
      .toBeTypeOf('number');
    expect(negative.status, 'removing -fobjc-arc must break the ARC probe').not.toBe(0);
  });

  it('is syntactically executable and rejects a full cross-architecture qualification', async () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    expect((await runNative('bash', ['-n', SCRIPT])).status).toBe(0);
    if (process.platform !== 'darwin') return;

    const requested = process.arch === 'arm64' ? 'x64' : 'arm64';
    const result = await runNative('bash', [
      SCRIPT,
      '--arch', requested,
      '--webrtc-root', '/does/not/exist',
      '--depot-tools-root', '/does/not/exist',
    ], {});
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cross-linking is not qualification');
  });

  it('rejects an unpinned WebRTC checkout before invoking the build tools', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-rd-pin-test-'));
    const webrtc = resolve(directory, 'src');
    const depotTools = resolve(directory, 'depot_tools');
    try {
      for (const checkout of [webrtc, depotTools]) {
        await runNativeOrThrow('git', ['init', '--quiet', checkout]);
        await runNativeOrThrow('git', ['-C', checkout, '-c', 'user.name=IM.codes Test',
          '-c', 'user.email=test@invalid.example', 'commit', '--quiet',
          '--allow-empty', '-m', 'fixture']);
      }
      const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
      const result = await runNative('bash', [
        SCRIPT,
        '--arch', architecture,
        '--webrtc-root', webrtc,
        '--depot-tools-root', depotTools,
      ], {});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('libwebrtc revision mismatch');
      expect(result.stderr).toContain(`expected ${pins.libwebrtcRevision}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['arm64', 'arm64'],
    ['x64', 'x86_64'],
  ] as const)('compile/links the Apple framework sub-probe for %s', async (architecture, binaryArch) => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-rd-build-test-'));
    const output = resolve(directory, `probe-${architecture}`);
    try {
      const result = await runNative('bash', [
        SCRIPT,
        '--apple-framework-only',
        '--arch', architecture,
        '--output', output,
      ], {});
      expect(result.stderr, result.stdout).toBe('');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Apple framework compile/link probe passed');
      const architectures = await runNativeOrThrow('xcrun', ['lipo', '-archs', output], {});
      expect(architectures.trim().split(/\s+/)).toContain(binaryArch);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
