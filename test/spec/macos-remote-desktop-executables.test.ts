import { runNative } from './support/native-exec.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

const COMPONENTS = [
  { key: 'worker', target: 'imcodes_remote_desktop_worker', main: 'macos_remote_desktop_worker_main.mm' },
  { key: 'launchAgent', target: 'imcodes_remote_desktop_launch_agent', main: 'macos_launch_agent_main.mm' },
  { key: 'disclosure', target: 'imcodes_remote_desktop_disclosure', main: 'macos_remote_desktop_disclosure_main.mm' },
] as const;

describe('macOS remote-desktop executable entry points', () => {
  const build = read('native/macos-remote-desktop/BUILD.gn');
  const identity = JSON.parse(read('native/macos-remote-desktop/code-identity.json')) as {
    executableTargetsDefined: boolean;
    executableTargetsPendingReason: string;
    components: Record<string, { gnTarget: string; bundleIdentifier: string }>;
  };
  const worker = read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm');
  const onboarding = read('native/macos-remote-desktop/macos_permission_onboarding.mm');
  const onboardingHeader = read('native/macos-remote-desktop/macos_permission_onboarding.h');
  const disclosure = read('native/macos-remote-desktop/macos_remote_desktop_disclosure_main.mm');
  // HOST_COMMAND handling was extracted so it could be linked by the standalone
  // native test binary; the admission rule now lives with the dispatcher.
  const dispatch = read('native/macos-remote-desktop/macos_host_command_dispatch.cc');
  const dispatchHeader = read('native/macos-remote-desktop/macos_host_command_dispatch.h');
  const directory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'imcodes-macos-rd-exe-'))
    : null;

  afterAll(async () => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });

  it('defines every declared component target and only then claims it', async () => {
    const defined = new Set(
      [...build.matchAll(/^\s*(?:rtc_executable|executable)\("([A-Za-z0-9_]+)"\)?\s*\{/gmu)]
        .map((match) => match[1]),
    );
    for (const component of COMPONENTS) {
      expect(identity.components[component.key].gnTarget.split(':')[1]).toBe(component.target);
      expect(defined.has(component.target)).toBe(true);
      // Each declared target must actually build its own main.
      const targetBody = build.slice(build.indexOf(`rtc_executable("${component.target}")`));
      const declaration = targetBody.slice(0, targetBody.indexOf('}'));
      expect(declaration).toContain(component.main);
      expect(declaration).toContain(
        `output_name = "${identity.components[component.key].fileName}"`,
      );
    }
    // The claim and the build graph must agree in both directions.
    expect(identity.executableTargetsDefined).toBe(true);
    expect(identity.executableTargetsPendingReason).toBe('');
  });

  it('keeps the three component identities distinct and stable', async () => {
    const ids = COMPONENTS.map((component) => identity.components[component.key].bundleIdentifier);
    expect(new Set(ids).size).toBe(ids.length);
    // TCC grants are bound to these identities; a rename silently drops them.
    expect(identity.components.worker.bundleIdentifier).toBe('cc.imcodes.node.remote-desktop-worker');
    expect(identity.components.launchAgent.bundleIdentifier).toBe('cc.imcodes.node.remote-desktop-agent');
    expect(identity.components.disclosure.bundleIdentifier).toBe('cc.imcodes.node.remote-desktop-disclosure');
  });

  it('refuses to run either privileged-sensitive component as root', async () => {
    // A root worker would hold TCC grants and input-synthesis authority for the
    // wrong principal; a root disclosure would have no Aqua session and its
    // window would never appear while remote access proceeded.
    for (const source of [worker, disclosure]) {
      expect(source).toContain('geteuid() == 0');
      expect(source).toContain('EX_NOPERM');
    }
  });

  it('reaches the live generation for cleanup instead of a fresh empty process', async () => {
    // Integration defect: the daemon runs the cleanup verbs as a *fresh*
    // sibling with env: {}. Answering from that process's own state would make
    // every cleanup fail, or falsely succeed while releasing nothing.
    expect(worker).toContain('class ControlSocketCleanupTarget final');
    expect(worker).toContain('macos::BuildControlSocketPath');
    expect(worker).toContain('macos::ParseControlResponse');
    // Success must be proven by a generation-stamped reply.
    expect(worker).toContain('acted_generation_ = response.generation;');
    // No listener means no live worker, which must be distinguishable.
    expect(worker).toContain('last_error_ = macos::kControlErrorNoActiveSession;');
    // The long-lived side must actually serve it.
    expect(worker).toContain('class SessionControlServer');
    expect(worker).toContain('control.Listen(static_cast<std::uint32_t>(::geteuid()))');
    expect(worker).toContain('control.ServeOnce(session.get(), context.worker_generation)');
    // Peer must be this user; socket mode alone is not the only gate.
    expect(worker).toContain('::getpeereid(peer, &peer_uid, &peer_gid)');
    expect(worker).toContain('macos::kControlSocketMode');
    // A worker that cannot serve cleanup must not run a session at all.
    expect(worker).toContain('macos_remote_desktop_worker_control_listen_failed');
  });

  it('actually launches and consumes the separate disclosure process', async () => {
    // Integration defect: DisclosureAdmission was constructed but nothing ever
    // fed it, so route_admissible() stayed false forever.
    expect(worker).toContain('class DisclosureSupervisor');
    expect(worker).toContain('posix_spawn');
    expect(worker).toContain('disclosure_process.EnsureVisible(context.worker_generation');
    expect(worker).toContain('disclosure_process.Drain(&disclosure)');
    expect(worker).toContain('macos::ParseDisclosureEvent');
    // Failing to launch disclosure is fatal, not a degraded run.
    expect(worker).toContain('macos_remote_desktop_worker_disclosure_launch_failed');
    expect(worker).toContain('macos_remote_desktop_worker_disclosure_lost');
    expect(worker).toContain('macos_remote_desktop_worker_local_stop');
    // The child inherits no environment.
    expect(worker).toContain('char* empty_environment[] = {nullptr};');
    // All three descriptors are multiplexed, so disclosure loss is observed
    // while the host socket is idle.
    expect(worker).toContain('std::array<pollfd, 3> poll_set{}');
    // Disclosure is examined before host frames are acted on.
    const disclosureAt = worker.indexOf('poll_set[2].revents');
    const hostAt = worker.indexOf('poll_set[0].revents');
    expect(disclosureAt).toBeGreaterThanOrEqual(0);
    expect(disclosureAt).toBeLessThan(hostAt);
  });

  it('derives readiness session state from real graphical-session evidence', async () => {
    // Integration defect: active_unlocked was inferred from Screen Recording,
    // which can advertise a usable desktop while the machine is locked.
    expect(worker).toContain('CGSessionCopyCurrentDictionary');
    expect(worker).toContain('kCGSessionOnConsoleKey');
    expect(worker).toContain('CGSSessionScreenIsLocked');
    expect(worker).toContain('macos::kNativeSessionStateLocked');
    expect(worker).not.toMatch(/session_state\s*=\s*out->screen_recording/);
    expect(worker).toContain('kReadinessProbeGeneration = 1');
    expect(worker).not.toContain('kReadinessProbeGeneration = 0');
    // lifecycleObservation must be a runtime probe, not a compiled-in true.
    expect(worker).toContain('macos::MacosSessionMonitor monitor;');
    expect(worker).toContain('monitor.ProbeReadiness() == rd::common::ReadinessState::kReady');
    expect(worker).not.toMatch(/out->lifecycle_observation\s*=\s*true/);
  });

  it('gives every rtc_executable a deps list for the pinned GN template', async () => {
    // webrtc.gni dereferences invoker.deps; an executable without one fails at
    // GN time on a real pinned checkout.
    const targets = [...build.matchAll(/rtc_executable\("([A-Za-z0-9_]+)"\)?\s*\{/gu)];
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const target of targets) {
      const body = build.slice(target.index!);
      expect(body.slice(0, body.indexOf('\n}\n')), target[1]).toContain('deps =');
    }
  });

  it('consumes the exact daemon v1 commands in the worker executable', async () => {
    // Production counterfactual: the worker must dispatch the three commands,
    // not merely mention them. RunNativeCommandV1 is the only dispatcher, and
    // it runs before any launch-agent handling.
    expect(worker).toContain(
      'macos::RunNativeCommandV1(argc, argv, &probe, &cleanup, onboarding.get())',
    );
    expect(onboarding).toContain('CGRequestScreenCaptureAccess()');
    expect(onboarding).toContain('AXIsProcessTrustedWithOptions(options)');
    expect(onboarding).toContain('[NSApplication sharedApplication]');
    expect(onboarding).toContain('[NSApp finishLaunching]');
    expect(onboarding).toContain('CGPreflightScreenCaptureAccess()');
    expect(onboarding).toContain('AXIsProcessTrusted()');
    expect(onboarding).toContain('runUntilDate:');
    expect(onboarding).toContain('std::chrono::minutes(10)');
    expect(onboarding).not.toMatch(/CFRelease\(options\);\s*return true;/u);
    expect(worker).toContain('IsLocalOnboardingAppLaunch(argc, argv)');
    expect(worker).toContain('IsMacosPermissionResponsibleApplication()');
    expect(worker).toContain('PrepareMacosPermissionResponsibleApplication()');
    expect(worker).toContain('kNativeCommandRequestPermissionsV1');
    expect(onboardingHeader).toContain('to.aidesk.app');
    const commandAt = worker.indexOf('RunNativeCommandV1');
    const launchAt = worker.indexOf('kLaunchAgentArgument');
    expect(commandAt).toBeGreaterThanOrEqual(0);
    expect(commandAt).toBeLessThan(worker.indexOf('launch_agent = true'));
    expect(launchAt).toBeGreaterThanOrEqual(0);
    // Cleanup must be able to report "nothing to act on"; a target that always
    // succeeds would make the daemon unable to tell released from absent.
    expect(worker).toContain('macos::RunNativeCommandV1');
  });

  it('runs a real bounded IPC loop rather than reporting not-implemented', async () => {
    // The previous delivery pinned an `ipc_loop_not_implemented` string. That
    // token must be gone, and the real seams present instead.
    expect(worker).not.toContain('ipc_loop_not_implemented');
    expect(worker).toContain('ReadWorkerLaunchContext');
    expect(worker).toContain('ConnectProtectedSocket');
    expect(worker).toContain('BuildHelloFrame');
    expect(worker).toContain('macos::FrameReader');
    expect(worker).toContain('ParseHostCommandFrame');
    expect(worker).toContain('BuildWorkerMessageFrame');
    // Fail-closed terminations, each distinct so a supervisor can tell them
    // apart.
    for (const token of [
      'macos_remote_desktop_worker_launch_context_invalid',
      'macos_remote_desktop_worker_socket_connect_failed',
      'macos_remote_desktop_worker_hello_failed',
      'macos_remote_desktop_worker_host_eof',
      'macos_remote_desktop_worker_frame_overflow',
      'macos_remote_desktop_worker_malformed_host_frame',
      'macos_remote_desktop_worker_stale_generation',
    ]) {
      expect(worker, token).toContain(token);
    }
    // Every loop exit must stop the session before returning.
    expect(worker).toMatch(/session->Stop\(\);\s*\n\s*::close\(descriptor\);/);
  });

  it('never receives or persists a controlled-node credential', async () => {
    // The worker's only inputs are argv, the fixed launch environment and
    // socket frames. Any credential read here would cross a boundary the
    // sidecar design exists to keep closed.
    //
    // Comments are stripped first: the property under test is that no *code*
    // touches a credential, not that the file may never name the concept it
    // is documenting.
    const code = worker
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    // WebRTC ICE credentials are bounded route-scoped authority and are
    // intentionally consumed here. Remove only that exact expression before
    // checking that no long-lived controlled-node credential crossed in.
    expect([...code.matchAll(/server\.credential/g)]).toHaveLength(1);
    expect(code.replace(/server\.credential/g, ''))
      .not.toMatch(/credential|api[_-]?key|secret|keychain/i);
    // getenv is used exactly once, through the single lookup helper.
    expect([...worker.matchAll(/std::getenv/g)]).toHaveLength(1);
  });

  it('requires a live separate disclosure before admitting a route', async () => {
    expect(worker).toContain('macos::DisclosureAdmission disclosure(');
    // The worker still owns the live admission object and hands it to the
    // dispatcher, which is where the route is actually refused.
    expect(worker).toContain('DisclosureSeamAdapter');
    expect(worker).toContain('configuration.disclosure = &disclosure_adapter');
    expect(worker).toContain('configuration.begin_disclosure =');
    expect(worker).toContain('class WorkerDisclosureAdapter');
    expect(worker).toContain('supervisor_->EnsureVisible(');
    expect(dispatch).toContain('disclosure->route_admissible()');
    expect(dispatchHeader).toContain('macos_remote_desktop_worker_disclosure_not_admissible');
    // The worker must not satisfy the disclosure advertisement with its own
    // in-process AppKit code when code identity says it is a separate
    // component.
    expect(worker).toContain('DisclosureSiblingPresent()');
    expect(worker).not.toMatch(/#import\s*<AppKit/);
  });

  it('keeps a real long-running AppKit loop in the disclosure component', async () => {
    expect(disclosure).not.toContain('Honest limitation');
    expect(disclosure).toContain('#import <AppKit/AppKit.h>');
    expect(disclosure).toContain('nextEventMatchingMask');
    expect(disclosure).toContain('[NSApp sendEvent:event]');
    expect(disclosure).toMatch(/while \(!stop_requested && !window_gone\)/);
    // Reports every outcome over the bounded control seam.
    for (const token of ['kReady', 'kStop', 'kClosed', 'kFailed']) {
      expect(disclosure, token).toContain(`macos::DisclosureEvent::${token}`);
    }
    // Ready may only follow the shared startup seam, whose native behavioral
    // test pins BeginSession -> Show -> visibility/readiness confirmation.
    const showAt = disclosure.indexOf('macos::RunDisclosureStartup(');
    const readyAt = disclosure.indexOf('EmitEvent(macos::DisclosureEvent::kReady');
    expect(showAt).toBeGreaterThanOrEqual(0);
    expect(readyAt).toBeGreaterThan(showAt);
    expect(disclosure).not.toContain('adapter.ProbeReadiness()');
  });

  it('binds the worker composition to the real pinned transport adapter', async () => {
    expect(worker).toContain('CreatePinnedLibwebrtcTransportBackend()');
    expect(worker).toContain('BindAdapter(adapter.get())');
    expect(worker).toContain('configuration.transport = adapter.get()');
    // A missing transport aborts the session rather than degrading to a
    // view-only run the daemon would read as healthy.
    expect(worker).toContain('macos_remote_desktop_worker_transport_absent');
  });

  it('consumes browser DataChannel payloads through the common parser and session core', async () => {
    expect(worker).toContain('imcodes::rd::ParseDataChannelMessage(payload, &message)');
    expect(worker).not.toMatch(
      /OnDataChannelMessage[\s\S]{0,500}ReportTransportFailure\(\)/,
    );
    for (const call of [
      'session_->ApplyPointerMove',
      'session_->ApplyButton',
      'session_->ClickButton',
      'session_->ApplyWheel',
      'session_->ApplyKey',
      'session_->ApplyText',
      'session_->ReleaseController',
      'session_->SelectDisplay',
      'session_->CopySelection',
      'session_->RecordRouteActivity',
    ]) {
      expect(worker, call).toContain(call);
    }
    expect(worker).toContain('SendInputAck(message.correlation.sequence)');
    expect(worker).toContain('SendControlRejected');
    expect(worker).toContain('SendTopology()');
    expect(worker).toContain('session_->UpdateTransportQuality(');
    expect(worker).toContain('SendQuality()');
    expect(worker).toContain('EmitStatus()');
    expect(worker).toContain('terminal_.exchange(true)');
    expect(worker).toContain('TerminalEnvelope(');
    expect(worker).toContain('const char* wire_reason = "peer_failed"');
    expect(worker).toContain('if (sink.terminal())');
  });

  it('starts exactly one native session for each accepted PREPARE', async () => {
    // The host-command dispatcher owns retries at a fresh route generation.
    // Retrying Start inside this seam could initialize capture/disclosure
    // twice after a partially failed first attempt.
    expect([...worker.matchAll(/session_->Start\(request\)/g)]).toHaveLength(1);
  });

  it('rejects malformed disclosure counts and requires a generation', async () => {
    expect(disclosure).toContain('macos_remote_desktop_disclosure_generation_required');
    expect(disclosure).toContain('macos_remote_desktop_disclosure_bad_generation');
    expect(disclosure).toContain('ParseBoundedCount');
    expect(disclosure).toContain('EX_USAGE');
    expect(disclosure).toContain('macos_remote_desktop_disclosure_counts_out_of_range');
    // No visible window means no disclosure, which must block remote access.
    expect(disclosure).toContain('macos_remote_desktop_disclosure_not_ready');
    expect(disclosure).toContain('macos_remote_desktop_disclosure_not_visible');
    expect(disclosure).toContain('probe_only && generation == 0 ? 1 : generation');
  });

  it('syntax-checks every executable main against the real headers', async () => {
    if (process.platform !== 'darwin') return;
    const jsoncpp = resolve(
      process.env.HOME ?? '',
      '.cache/imcodes-webrtc-macos/checkout/src/third_party/jsoncpp/source/include',
    );
    for (const component of COMPONENTS) {
      // The worker consumes the common JsonCpp signaling contract. A machine
      // without the pinned checkout cannot syntax-check that one target; the
      // pinned build test remains the authoritative compile/link gate there.
      if (component.main === 'macos_remote_desktop_worker_main.mm'
        && !existsSync(jsoncpp)) continue;
      const compile = await runNative('xcrun', [
        'clang++',
        '-std=c++20',
        '-fsyntax-only',
        '-fobjc-arc',
        '-x', 'objective-c++',
        '-Wall', '-Wextra',
        '-mmacosx-version-min=12.3',
        '-I', NATIVE,
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        ...(existsSync(jsoncpp) ? ['-I', jsoncpp] : []),
        resolve(NATIVE, component.main),
      ], { cwd: directory! });
      expect(compile.status, `${component.main}: ${compile.stdout}\n${compile.stderr}`).toBe(0);
    }
  }, 120_000);
});
