import { runNative } from './support/native-exec.js';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_MACOS_TEAM_ID } from '../../shared/remote-desktop-worker.js';
import {
  buildMacosVirtualDisplayAuthority,
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS,
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_REQUIREMENT_BYTES as MAX_REQUIREMENT_BYTES,
  canonicalDesignatedRequirement,
  serializeMacosVirtualDisplayAuthority,
} from '../../shared/macos-virtual-display-authority.js';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = 'native/macos-remote-desktop';
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

/**
 * Suites this file compiles against the shared pre-built object set.
 *
 * Named once and used both to drive the loop and to prove coverage, so a suite
 * cannot be listed as covered without actually being run.
 */
const SHARED_OBJECT_SUITES = ['authority-link', 'link-posix', 'loop', 'control',
                              'control-server', 'route', 'resident'] as const;

/** Suites this file compiles with their own narrow source set. */
const OWN_SOURCE_SUITES = ['agent', 'ledger', 'policy'] as const;

/** Suites this file runs from a dedicated `it` with a literal source list. */
const EXPLICIT_SUITES = ['authority', 'grant', 'helper', 'supervisor'] as const;

/**
 * Suites deliberately owned by another spec file, with where to find them.
 *
 * Declared rather than silently excluded: an "elsewhere" that names no file is
 * indistinguishable from a suite nobody runs.
 */
const ELSEWHERE_SUITES: ReadonlyArray<readonly [string, string]> = [
  ['daemon-backend', 'test/spec/macos-remote-desktop-virtual-display-daemon-backend.test.ts'],
];

describe('macOS virtual-display authority', () => {
  const authority = read(`${NATIVE}/macos_virtual_display_authority.cc`);
  const authorityHeader = read(`${NATIVE}/macos_virtual_display_authority.h`);
  const skylightMm = read(`${NATIVE}/macos_virtual_display_skylight_runtime.mm`);
  const gate = read(`${NATIVE}/macos_virtual_display_version_gate.cc`);
  const helper = read(`${NATIVE}/macos_virtual_display_helper_main.mm`);
  const build = read(`${NATIVE}/BUILD.gn`);
  const directory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'aidesk-vd-authority-'))
    : null;

  afterAll(async () => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });

  // The native grammar, compiled once and reused. Every cross-language case
  // runs against the SAME binary the accept case does, so a matrix cannot pass
  // by testing a differently-built parser than the one that agreed.
  let grantCliPath: string | null = null;
  const grantCli = async (): Promise<string> => {
    if (grantCliPath !== null) return grantCliPath;
    const cli = resolve(directory!, 'grant-cli');
    const compile = await runNative('xcrun', [
      'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-mmacosx-version-min=12.3',
      '-I', resolve(ROOT, NATIVE),
      resolve(ROOT, 'test/spec/macos-remote-desktop-virtual-display-grant-cli.cc'),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_grant.cc`),
      '-o', cli,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    grantCliPath = cli;
    return cli;
  };
  /** What the native grammar made of one line: verdict plus diagnosis. */
  const askNative = async (line: string): Promise<{ ok: boolean; why: string; canon: string }> => {
    const run = await runNative(await grantCli(), [], { input: `${line}\n` });
    const field = (key: string): string => {
      const found = run.stdout.split('\n').find((row) => row.startsWith(`${key}=`));
      return found === undefined ? '' : found.slice(key.length + 1);
    };
    return {
      ok: run.stdout.includes('ACCEPTED'),
      why: field('why'),
      canon: field('canon'),
    };
  };

  /** The one encoding the wire admits, so a fixture cannot smuggle a space. */
  const percentSpaces = (value: string): string =>
    value.replace(/%/gu, '%25').replace(/ /gu, '%20');

  const TEAM = REMOTE_DESKTOP_MACOS_TEAM_ID;
  const BUNDLE = 'cc.imcodes.node.virtual-display-helper';
  const REQUIREMENT = canonicalDesignatedRequirement(BUNDLE, TEAM);

  /** A grant that is valid in every respect, so each case varies exactly one. */
  const goodInput = () => ({
    artifact: {
      setSha256: 'd'.repeat(64),
      releaseName: `sha256-${'d'.repeat(64)}`,
      manifest: {
        arch: 'arm64' as const,
        components: {
          virtualDisplayHelper: {
            fileName: 'imcodes-virtual-display-helper',
            size: 4096,
            sha256: 'e'.repeat(64),
          },
        },
        codeSignature: {
          teamId: TEAM,
          bundles: {
            virtualDisplayHelper: {
              bundleIdentifier: BUNDLE,
              designatedRequirement: REQUIREMENT,
              hardenedRuntime: true,
            },
          },
        },
      },
    },
    context: {
      uid: 501,
      auditSessionId: 100_003,
      sessionType: 'Aqua' as const,
      serviceGeneration: 7,
      challenge: 'A'.repeat(43),
    },
  });

  it('never links a private framework at build time', async () => {
    // A link against SkyLight would make the product fail to launch the day
    // Apple renames it, and would declare a dependency no notarised build
    // should carry. Resolution must be dlopen/dlsym only.
    expect(build).not.toMatch(/SkyLight\.framework/);
    expect(build).not.toMatch(/CoreGraphicsPrivate|PrivateFrameworks/);
    expect(skylightMm).toContain('dlopen(');
    expect(skylightMm).toContain('dlsym(');
    expect(skylightMm).toContain('PrivateFrameworks/SkyLight.framework/SkyLight');
    // No extern "C" forward declaration of a private symbol either: that is a
    // compile-time reference by another name.
    expect(skylightMm).not.toMatch(/extern\s+"C"[^;]*SLS[A-Za-z]+\s*\(/);
    expect(skylightMm).not.toMatch(/extern\s+"C"[^;]*CGSConfigureDisplayEnabled/);
  });

  it('fails closed when any private symbol is missing', async () => {
    expect(skylightMm).toContain('if (!symbols.complete_enough()) {');
    // The seam is returned wholesale-empty, never partially wired: a caller must
    // not be able to observe a display it has no way to disable.
    expect(skylightMm).toMatch(/complete_enough\(\)\) \{[\s\S]{0,400}?return seam;/);
    expect(authority).toContain('VirtualDisplayOutcome::kSeamUnavailable');
  });

  it('does not advertise capability without a real admitted display', async () => {
    // The 26.2 blocker had every selector resolvable and the feature was still
    // unusable, so resolvability is explicitly not qualification.
    expect(authority).toContain('return ever_admitted_ ? common::ReadinessState::kReady');
    expect(authority).toContain(': common::ReadinessState::kUnknown;');
    expect(authority).toContain('hooks_.capture_first_frame()');
  });

  it('treats registered-inactive as NOT removed', async () => {
    const skylight = read(`${NATIVE}/macos_virtual_display_skylight.cc`);
    expect(skylight).toContain('SkyLightDisplayPresence::kRegisteredInactive');
    // Route end disables and revokes authority; it must not claim a removal.
    expect(authority).toMatch(/ReleaseAuthority[\s\S]*?configure_display_enabled\(display_id_, false/);
    expect(authority).toMatch(/WaitForPresence\(SkyLightDisplayPresence::kRegisteredInactive\)/);
    // Only DestroyWarmDisplay may report removal, and only after enumeration.
    expect(authority).toContain('VirtualDisplayOutcome::kNotRemoved');
    expect(authority).toContain('is still registered after release');
  });

  it('refuses an unqualified macOS and names 26.x as removal-regressed', async () => {
    expect(gate).toContain('kRemovalRegressedMajor = 26');
    expect(gate).toContain('VirtualDisplayVersionVerdict::kAboveQualified');
    expect(gate).toContain('VirtualDisplayVersionVerdict::kUnknownVersion');
    // A newer major must be refused rather than probed optimistically.
    expect(gate).toMatch(/version\.major > kMaximumQualifiedMajor[\s\S]{0,200}kAboveQualified/);
    const gateHeader = read(`${NATIVE}/macos_virtual_display_version_gate.h`);
    // Removal capability must be derived, not hard-coded off for macOS 26.
    // SLVirtualDisplay (which HAS a real -destroy) was probed present on 26.2,
    // so a version-only "26 cannot remove" rule would permanently block the one
    // path measured to work.
    expect(gateHeader).toContain('legacy_release_removes');
    expect(gateHeader).toContain('modern_destroy_path_expected');
    expect(gate).toContain('kModernDestroyExpectedMajor');
    expect(gate).not.toMatch(/removal_supported\s*=\s*false;\s*\n\s*decision\.reason/);
  });

  it('holds the display in a separate long-lived helper that refuses root', async () => {
    expect(helper).toContain('geteuid() == 0');
    expect(helper).toContain('aidesk_virtual_display_helper_refuses_root');
    expect(helper).toContain('SIGTERM');
    // The probe path must never create a display.
    expect(helper).toMatch(/probe_only[\s\S]{0,600}?probe_ok/);
    expect(build).toContain('rtc_executable("imcodes_virtual_display_helper")');
    expect(build).toContain('"macos_virtual_display_helper_main.mm"');
  });

  it('caps the warm display at exactly one, including stranded ids', async () => {
    expect(authorityHeader).toContain('kMaxWarmVirtualDisplays = 1');
    expect(authority).toContain('kSingleInstanceViolation');
    expect(authority).toMatch(/stranded from a previous run; refusing to create/);
    // Authority must never outlive its holder.
    expect(authority).toContain('holder_.epoch = next_epoch_++;');
    expect(authority).toContain('VirtualDisplayOutcome::kStaleToken');
  });

  it('runs the authority and protocol counterfactuals under sanitizers', async () => {
    if (process.platform !== 'darwin') return;
    const executable = resolve(directory!, 'vd-authority-test');
    const compile = await runNative('xcrun', [
      // -fobjc-arc: this binary now links the production hold composition and
      // the SL/CG backends, whose .mm sources require ARC and enforce it with
      // a #error. Only this invocation gains it; the others link no ObjC++.
      'clang++', '-std=c++20', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-mmacosx-version-min=12.3',
      '-I', resolve(ROOT, NATIVE),
      '-I', resolve(ROOT, 'native/remote-desktop-common'),
      resolve(ROOT, 'test/spec/macos-remote-desktop-virtual-display-authority-test.cc'),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_authority.cc`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_skylight.cc`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_version_gate.cc`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_helper_protocol.cc`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_policy.cc`),
      // The production hold composition, linked so the counterexample drives
      // the exact callback helper_main installs.
      resolve(ROOT, `${NATIVE}/macos_virtual_display_hold_composition.cc`),
      resolve(ROOT, `${NATIVE}/macos_slvirtual_display_backend.cc`),
      resolve(ROOT, `${NATIVE}/macos_slvirtual_display_runtime.mm`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_adapter.cc`),
      resolve(ROOT, `${NATIVE}/apple_virtual_display_backend.mm`),
      resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
      '-framework', 'CoreGraphics',
      '-framework', 'Foundation',
      '-o', executable,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const run = await runNative(executable, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('macos virtual display authority counterfactual ok');
  }, 180_000);

  it('gates the single real-display experiment behind all ten guards', async () => {
    const script = read('scripts/macos-remote-desktop-virtual-display-experiment.sh');
    // Each of these is a specific way of fooling ourselves that review
    // identified; a missing one is not a style gap, it is a way to strand a
    // second display while investigating the first.
    const guards: Array<[string, RegExp]> = [
      ['tri-source baseline', /nsscreen_count=.*cg_online_count=.*sls_registered_count=/],
      ['aiDesk remnant abort', /vendor=\$AIDESK_VENDOR model=\$AIDESK_MODEL/],
      ['enumerator agreement', /enumerators disagree/],
      ['probe-only creates nothing', /PROBE_ONLY_OK: nothing was created/],
      ['per-boot stamp', /an experiment already ran on this boot/],
      ['unpredictable epoch', /od -An -N8 -tu8 \/dev\/urandom/],
      ['id from reply not grep', /Take the display id from the REPLY/],
      ['pre-mutation re-verify', /last-surface still allows a later removal/],
      ['real extend path', /SLWindowMirroringManager extend: path/],
      ['bounded first frame and input', /verify first frame and one logical input event/],
      ['single teardown, tri-source 5s', /Confirm with SLS \+ CG \+ NSScreen for up to 5 seconds/],
      ['registered-inactive is failure', /registered-inactive anywhere\s+-> FAILURE, reboot_required=true/],
      ['no companion', /do NOT create a companion/],
      ['no second display after failure', /Do not create a second display/],
      ['exit trap reports reboot debt', /trap on_exit EXIT/],
    ];
    for (const [name, pattern] of guards) {
      expect(script, `experiment guard missing: ${name}`).toMatch(pattern);
    }
    // The script itself must never perform the mutation: the destructive steps
    // are handed to a human precisely so no scheduler can trigger them.
    expect(script).toContain('MANUAL_STEPS_REQUIRED: nothing was created by this script');
    expect(script).not.toMatch(/\bhold\b.*\|.*"\$HELPER_BINARY"/);
    // Ordering: signed-helper release path first, SL destroy only as a fallback
    // against the SAME object, and never by creating another display.
    const cgFirst = script.indexOf('test the signed-helper CG + extend + runloop release path');
    const slSecond = script.indexOf('SLVirtualDisplay -destroy path be tried against the SAME object');
    expect(cgFirst).toBeGreaterThan(-1);
    expect(slSecond).toBeGreaterThan(cgFirst);
  });

  it('permanently forbids the retired plist/env authority channel', async () => {
    // This channel was removed by decision, not by accident, and was re-added
    // three times by a parallel worker before ownership was settled. Two
    // production authority channels is strictly worse than one, because the
    // weaker of the two is what an attacker uses -- so the ban is a contract,
    // not a convention.
    const forbidden = /IMCODES_REMOTE_DESKTOP_(RELEASE_IDENTITY|COMPLETE_SET_SHA256|VIRTUAL_DISPLAY_HELPER_SHA256|HELPER_SHA256)/;
    const symbols = /kEnv(ReleaseIdentity|CompleteSetSha256|VirtualDisplayHelperSha256)/;
    const files = [
      `${NATIVE}/macos_worker_ipc_client.h`,
      `${NATIVE}/macos_worker_ipc_client.cc`,
      `${NATIVE}/macos_remote_desktop_worker_main.mm`,
      `${NATIVE}/macos_launch_agent_main.mm`,
      'src/node/macos-remote-desktop-launch-agent.ts',
    ];
    for (const file of files) {
      const body = read(file);
      expect(body, `${file} re-introduces the retired env authority`).not.toMatch(forbidden);
      expect(body, `${file} re-introduces the retired env authority symbols`).not.toMatch(symbols);
    }
    // The launch context itself must not carry the authority fields again.
    const ipc = read(`${NATIVE}/macos_worker_ipc_client.h`);
    expect(ipc).not.toMatch(/release_identity|complete_set_sha256|virtual_display_helper_sha256/);
  });

  it('keeps the route worker out of helper ownership entirely', async () => {
    const worker = read(`${NATIVE}/macos_remote_desktop_worker_main.mm`);
    // The route worker is short-lived and per-route. A helper it owned would
    // die with the route, and any authority it minted would be one this process
    // invented rather than one the Node selector granted. Ownership belongs to
    // the resident agent.
    expect(worker).not.toContain('MacosVirtualDisplaySupervisor');
    expect(worker).not.toContain('CreatePosixSupervisorSeam');
    expect(worker).not.toContain('virtual_display_supervisor');
    // The backend is the daemon proxy, never an in-process display owner. It
    // was null until the proxy existed, which refused every request; it is now
    // a channel, and the invariant that survives is that neither shape can
    // construct a CGVirtualDisplay here.
    expect(worker).toContain('DaemonProxyVirtualDisplayBackend');
    expect(worker).not.toContain('CreateAppleMacosVirtualDisplayBackend');
    // What crosses is a ROUTE capability. The helper's own descriptor, epoch
    // and cookie seed have no member to arrive in.
    const ipcHeader = read(`${NATIVE}/macos_worker_ipc_client.h`);
    expect(ipcHeader).not.toMatch(/helper_(epoch|cookie|descriptor|fd)/u);
    // And the removed environment channel must not come back: two production
    // authority channels is strictly worse than one, because the weaker of the
    // two is the one an attacker uses.
    expect(worker).not.toMatch(/IMCODES_REMOTE_DESKTOP_(RELEASE_IDENTITY|COMPLETE_SET_SHA256|HELPER_SHA256)/);
    const ipc = read(`${NATIVE}/macos_worker_ipc_client.h`);
    expect(ipc).not.toMatch(/kEnv(ReleaseIdentity|CompleteSetSha256|VirtualDisplayHelperSha256)/);
    const agent = read('src/node/macos-remote-desktop-launch-agent.ts');
    expect(agent).not.toMatch(/RELEASE_IDENTITY|COMPLETE_SET_SHA256|HELPER_SHA256/);
    // Nor may the worker fall back to self-attestation from its own directory.
    expect(worker).not.toContain('SiblingManifestHelperSha256');
  });


  it('never leaks the worker environment or aliases the binding descriptor', async () => {
    const posix = read(`${NATIVE}/macos_virtual_display_supervisor_posix.cc`);
    // Empty env: passing `environ` handed the helper this worker's launch
    // challenge, control socket and generation -- the exact credentials the
    // fd-3 binding exists to keep out of readable places.
    // Asserted at the CALL, not merely that the symbol appears somewhere: an
    // earlier version of this check passed while the spawn had been changed to
    // hand posix_spawn a null envp instead.
    expect(posix).toMatch(/posix_spawn\([\s\S]{0,200}argv,\s*empty_environment\)/);
    expect(posix).not.toMatch(/argv,\s*environ\)/);
    expect(posix).not.toMatch(/argv,\s*nullptr\)/);
    // With 0/1/2 taken, pipe() typically returns 3 -- which IS the binding
    // target -- so dup2(3,3) then close(3) shut the child's binding fd.
    expect(posix).toContain('kRelocatedFdBase');
    expect(posix).toContain('F_DUPFD');
    expect(posix).toContain('relocated sources must not alias');
    // release_identity and the digest must be compared, not merely accepted.
    expect(posix).toContain('enclosing_name != release_identity');
    expect(posix).toContain('digest != expected_sha256');
  });

  it('keeps create-qualification separate from display-control advertisement', async () => {
    const backend = read(`${NATIVE}/macos_virtual_display_helper_backend.cc`);
    // The adapter gates Create on ProbeSupport; if ProbeSupport asked the
    // advertise question (which needs an ACTIVE display) a headless host could
    // never create its first one.
    expect(backend).toContain('QualifiedToCreate()');
    expect(backend).toMatch(/ProbeSupport\(\)[\s\S]{0,400}QualifiedToCreate\(\)/);
    // The external claim stays strict: held AND active.
    expect(backend).toMatch(/QueryAdmitted[\s\S]{0,400}HelperReplyProvesAdmission/);
  });

  it('fails closed rather than qualifying the measured-leaking backend', async () => {
    const helper = read(`${NATIVE}/macos_virtual_display_helper_main.mm`);
    // On a major where dropping the legacy owner does not remove the display,
    // creating anyway strands one per route. A version comment asserting the
    // modern path exists is not the path existing.
    //
    // The decision AND the backend factory now go through one seam,
    // AdmitVirtualDisplayHold, so that "a refused hold creates no backend" is a
    // property of code both production and the counterexample execute rather
    // than a condition spelled out twice. The wire literal therefore lives in
    // the seam's header, and the helper is checked for delegating to it.
    // RefusedHoldCreatesNoBackend in the native counterexample is what proves
    // the behaviour, including a backend-factory count of exactly zero.
    expect(helper).toContain('rd::AdmitVirtualDisplayHold(');
    // The helper must NOT authorise on a bare availability probe. That probe
    // reports that SLVirtualDisplay and `-destroy` resolve on this OS; it says
    // nothing about the backend this process would build, and the only factory
    // available is CG-backed and cannot destroy. Admitting on it authorised a
    // capability that was never created.
    expect(helper).not.toMatch(/AdmitVirtualDisplayHold\([\s\S]{0,400}return rd::DestroyCapableVirtualDisplayBackendAvailable\(\);/u);
    // The helper must NOT carry its own copy of the condition or the wire
    // string: two spellings of one rule is how they drift apart.
    expect(helper).not.toContain('removal_unsupported_on_this_os');
    const policy = read(`${NATIVE}/macos_virtual_display_policy.h`);
    expect(policy).toContain('"removal_unsupported_on_this_os"');
    // WIRED PATH: the helper must build through the exact endorsed factory,
    // keep the concrete type so DestroyAndVerify stays reachable at teardown,
    // and must not reintroduce a global availability probe or a CG fallback on
    // the 26.x branch.
    //
    // SECONDARY HYGIENE ONLY. The load-bearing proof now lives in the native
    // counterexample, which executes the real acquire order through the
    // injected seam (construct -> create_exact -> commit) instead of asserting
    // on source text. These lexical checks just catch an obvious regression
    // early; they are not what makes the ordering safe.
    const modernInstall = helper.slice(
      helper.indexOf('INSTALLED VERBATIM from the linkable production composition'),
      helper.indexOf('// Pre-26 legacy path, unchanged'),
    );
    expect(modernInstall.length, 'modern install site not found').toBeGreaterThan(0);
    expect(modernInstall).toContain('rd::MakeModernHoldCallback(');
    expect(modernInstall, '26.x must never fall back to the CG factory')
      .not.toContain('CreateAppleMacosVirtualDisplayBackend');
    // helper_main must hold NO admission policy: no verdict, no acquire call.
    expect(modernInstall, 'the helper must not decide admission itself')
      .not.toContain('acquired.admitted');
    expect(modernInstall, 'the helper must not run the acquire seam itself')
      .not.toContain('AcquireEndorsedVirtualDisplay');
    expect(helper).toContain('sl_backend_->DestroyAndVerify(');
    // Identity/configuration is prepared BEFORE admission and must not commit a
    // generation there: preparation reads the generation, never writes it.
    const prepare = helper.slice(
      helper.indexOf('bool PrepareHoldConfiguration('),
      helper.indexOf('rd::VirtualDisplayHelperReply Hold('),
    );
    expect(prepare.length, 'PrepareHoldConfiguration not found').toBeGreaterThan(0);
    expect(prepare, 'preparation must never persist an identity generation')
      .not.toContain('StoreIdentityGeneration');
    expect(prepare, 'preparation must never increment the generation')
      .not.toContain('++identity_generation_');
    // destroy_error must be reported, not write-only.
    expect(helper).toContain('destroy_error=%s');
    // A failed DestroyAndVerify must not set `removed`; only the presence poll
    // may. Assert the failure branch records the error and nothing else.
    //
    // Slice the DESTROY branch only. The wider TearDown() body legitimately
    // sets `removed = true` for "nothing was ever held" (target 0 / no
    // backend), so asserting over the whole function would fail on correct
    // code -- it did, on the first attempt.
    const destroyBranch = helper.slice(
      helper.indexOf('if (sl_backend_ != nullptr) {'),
      helper.indexOf('const auto deadline ='),
    );
    expect(destroyBranch.length, 'destroy branch not found').toBeGreaterThan(0);
    expect(destroyBranch).toContain('outcome.destroy_error = destroy_error;');
    expect(destroyBranch, 'a failed destroy must never claim removal')
      .not.toContain('outcome.removed = true');
    const runtime = read(`${NATIVE}/macos_virtual_display_skylight_runtime.mm`);
    expect(runtime).toContain('SLVirtualDisplay');
    expect(runtime).toContain('sel_registerName("destroy")');
  });

  it('wires persistent identity, self-heal and the last-surface guard into the helper', async () => {
    const helper = read(`${NATIVE}/macos_virtual_display_helper_main.mm`);
    // Persistent per-install id, NOT the per-spawn cookie seed: a seed-derived
    // serial drifts on every restart and can never re-adopt a warm display.
    expect(helper).toContain('LoadOrCreateInstanceId');
    // From the uid the verified binding carries, NOT from HOME: the helper is
    // spawned with an empty environment, so a HOME-derived path resolved to
    // nothing and made every first HOLD fail with identity_store_unavailable.
    expect(helper).toContain('InstanceIdPathForUid(binding_.uid)');
    expect(helper).not.toContain('DefaultInstanceIdPath()');
    // The generation must survive a restart, or the collision walk restarts at
    // zero and re-enters the poisoned identity every launch.
    expect(helper).toContain('LoadIdentityGeneration');
    expect(helper).toContain('StoreIdentityGeneration');
    // Enumeration must actually be waited on, or kCreateNewIdentity is
    // unreachable and the self-heal walk can never advance.
    expect(helper).toContain('heal.old_id_absent =');
    // RELEASE is terminal: no further command may act after revocation.
    expect(helper).toContain('authority_revoked');
    expect(helper).toContain('ShutdownRemovalAllowed()');
    expect(helper).not.toMatch(/DeriveVirtualDisplayIdentity\(\s*binding_\.cookie_seed/);
    // Bounded self-heal that refuses to create while the old id is registered.
    expect(helper).toContain('NextSelfHealStep');
    expect(helper).toContain('identity_generation_exhausted');
    expect(helper).toContain('stale_display_still_registered');
    expect(helper).toMatch(/\+\+identity_generation_/);
    // The last surface may not be removed, by disable or by release.
    expect(helper).toContain('EvaluateLastSurfaceGuard');
    expect(helper).toContain('would_leave_no_surface');
    // Admission success must be explicit; it was previously only ever false.
    expect(helper).toContain('reply.admitted = true;');
    // RELEASE is a real teardown, not a flag nothing reads.
    expect(helper).toMatch(/Release\(rd::VirtualDisplayHelperReply reply\)[\s\S]{0,600}TearDown\(\)/);
    // The approved mode is applied before enabling.
    expect(helper).toContain('backend_->ApplyMode(display_id_');
    const backend = read(`${NATIVE}/macos_virtual_display_helper_backend.cc`);
    expect(backend).toContain('command.pixels_wide = mode.pixels.width;');
    expect(backend).not.toMatch(/\(void\)mode;/);
  });

  it('produces a grant the NATIVE grammar actually accepts', async () => {
    if (process.platform !== 'darwin') return;
    // Cross-layer, not two independent assertions. The TypeScript serializer
    // and the C++ parser are the two halves of one wire contract; testing each
    // against its own idea of the format would let them agree on nothing.
    const cli = await grantCli();

    const requirement = 'identifier "cc.imcodes.node.virtual-display-helper" and anchor '
      + `apple generic and certificate leaf[subject.OU] = "${REMOTE_DESKTOP_MACOS_TEAM_ID}"`;
    const authority = buildMacosVirtualDisplayAuthority({
      setSha256: 'd'.repeat(64),
      releaseName: `sha256-${'d'.repeat(64)}`,
      manifest: {
        arch: 'arm64',
        components: {
          virtualDisplayHelper: {
            fileName: 'imcodes-virtual-display-helper', size: 4096, sha256: 'e'.repeat(64),
          },
        },
        codeSignature: {
          teamId: REMOTE_DESKTOP_MACOS_TEAM_ID,
          bundles: {
            virtualDisplayHelper: {
              bundleIdentifier: 'cc.imcodes.node.virtual-display-helper',
              designatedRequirement: requirement,
              hardenedRuntime: true,
            },
          },
        },
      },
    }, {
      uid: 501, auditSessionId: 100_003, sessionType: 'Aqua',
      serviceGeneration: 7, challenge: 'A'.repeat(43),
    });

    const line = serializeMacosVirtualDisplayAuthority(authority);
    const run = await runNative(cli, [], { input: `${line}\n` });
    expect(run.stdout, `native parser rejected the TypeScript grant:\n${line}`)
      .toContain('ACCEPTED');
    expect(run.status).toBe(0);
    // Every bound fact must survive the crossing, including the requirement's
    // spaces and quotes.
    expect(run.stdout).toContain('uid=501');
    expect(run.stdout).toContain('asid=100003');
    expect(run.stdout).toContain('session=Aqua');
    expect(run.stdout).toContain('svcgen=7');
    expect(run.stdout).toContain('arch=arm64');
    expect(run.stdout).toContain(`helpersha=${'e'.repeat(64)}`);
    expect(run.stdout).toContain(`dr=${requirement}`);

    // And a tampered line must be refused by the same parser.
    const tampered = line.replace('uid=501', 'uid=502 uid=501');
    const rejected = await runNative(cli, [], { input: `${tampered}\n` });
    expect(rejected.stdout).toContain('REJECTED');
  }, 180_000);

  it('validates at the serializer, not at the builder, the type or the freeze', async () => {
    // The builder is one of the ways a value reaches the serializer, the
    // interface is erased at runtime, and `Object.freeze` protects only the
    // object it was called on. `{ ...authority, uid: 0 }` defeats all three at
    // once: a brand-new unfrozen object that type-checks perfectly and never
    // went through the builder. So the serializer must re-derive every field
    // from the value it is actually handed.
    const base = goodInput();
    const good = buildMacosVirtualDisplayAuthority(base.artifact, base.context);
    expect(Object.isFrozen(good)).toBe(true);
    expect(() => serializeMacosVirtualDisplayAuthority(good)).not.toThrow();

    const corruptions: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      // Filename: the wire is whitespace-delimited, so a spaced value does not
      // survive the crossing as one field at all.
      ['a helper filename with a space', { helperFileName: 'helper binary' }],
      ['a helper filename with a control byte', { helperFileName: 'helper\x01bin' }],
      ['a helper filename carrying Unicode', { helperFileName: 'helper‐bin' }],
      ['an empty helper filename', { helperFileName: '' }],
      // Requirement.
      ['a requirement past the wire bound', {
        helperDesignatedRequirement: 'x'.repeat(MAX_REQUIREMENT_BYTES + 1),
      }],
      ['a requirement with a control byte', {
        helperDesignatedRequirement: `${REQUIREMENT}\x01`,
      }],
      ['a requirement with a non-ASCII byte', {
        helperDesignatedRequirement: `${REQUIREMENT}é`,
      }],
      ['a requirement that is merely a superset', {
        helperDesignatedRequirement: `${REQUIREMENT} or anchor apple`,
      }],
      // Expiry: representable, non-zero, and past what a double can carry.
      // The wire carries a TTL, not an absolute deadline: the daemon stamps
      // epoch time and the agent compares against CLOCK_MONOTONIC, so an
      // absolute deadline was never comparable at the receiving end.
      ['a TTL past the permitted lifetime', { ttlMs: 60_001 }],
      ['a non-integer TTL', { ttlMs: 1.5 }],
      ['a zero TTL', { ttlMs: 0 }],
      ['an infinite TTL', { ttlMs: Number.POSITIVE_INFINITY }],
      ['a NaN TTL', { ttlMs: Number.NaN }],
      // Team and bundle, each of which the requirement names.
      ['a team the requirement does not name', { teamId: 'ZZZZZ99999' }],
      ['a lower-case team', { teamId: 'abcde12345' }],
      ['a bundle the requirement does not name', {
        helperBundleIdentifier: 'cc.imcodes.node.other',
      }],
      // Release / set.
      ['a release from another set', {
        releaseIdentity: `sha256-${'c'.repeat(64)}`,
      }],
      ['a set digest from another release', { setSha256: 'c'.repeat(64) }],
      ['an upper-case set digest', { setSha256: 'D'.repeat(64) }],
      // Size.
      ['a helper size past the ceiling', { helperSize: 512 * 1024 * 1024 + 1 }],
      ['a zero helper size', { helperSize: 0 }],
      ['a negative helper size', { helperSize: -1 }],
      // uid / asid, including the kernel's "nobody" sentinel.
      ['a uid at UINT32_MAX', { uid: 0xffff_ffff }],
      ['a zero uid', { uid: 0 }],
      ['an asid at UINT32_MAX', { auditSessionId: 0xffff_ffff }],
      ['a zero asid', { auditSessionId: 0 }],
      // Enumerations that the type would have accepted.
      ['a session type nobody defined', { sessionType: 'Console' }],
      ['an architecture nobody ships', { arch: 'i386' }],
      // Wrong runtime types behind a correct static type.
      ['a stringified uid', { uid: '501' }],
      ['a missing challenge', { challenge: undefined }],
      ['a null requirement', { helperDesignatedRequirement: null }],
    ];

    for (const [what, patch] of corruptions) {
      // Spread: a NEW object, unfrozen, never built, statically indistinguishable.
      const corrupt = { ...good, ...patch } as unknown as typeof good;
      expect(Object.isFrozen(corrupt), `${what}: fixture was frozen, so the ` +
        'spread did not actually produce a fresh object').toBe(false);
      let line: string | null = null;
      expect(() => { line = serializeMacosVirtualDisplayAuthority(corrupt); },
        `the serializer accepted ${what}`).toThrow();
      // Not just "it threw": it must not have produced a line at all.
      expect(line, `the serializer emitted a line for ${what}`).toBeNull();
    }

    // A non-object, which the type system also cannot prevent at a boundary.
    for (const rubbish of [null, undefined, 'grant1', 42, []]) {
      expect(() => serializeMacosVirtualDisplayAuthority(rubbish as never)).toThrow();
    }
  });

  it('spells the bundle-identifier rule identically in both languages', async () => {
    if (process.platform !== 'darwin') return;
    // The identifier is interpolated into the designated requirement, so the
    // two ends disagreeing about which identifiers are spellable is not a
    // cosmetic difference. The dangerous direction is the consumer accepting
    // one the producer would never emit: that is an identifier chosen by
    // whoever wrote the line rather than by the release.
    //
    // The old native rule was IsToken, which also admits `_` and admits a
    // LEADING `.` or `-`. TypeScript's BUNDLE_RE admits neither.
    const rejected = [
      '.bad',          // leading dot: admissible characters, wrong position
      '-bad',          // leading hyphen, same
      '_bad',          // leading underscore, doubly wrong
      'cc_example',    // underscore anywhere
      'cc.example_x',
      '',
      'a'.repeat(129), // one past the shared 128-byte bound
      'has space',
      'has"quote',
      'café.app', // non-ASCII
      'cc.example\x01',
    ];
    const accepted = [
      'a',                                       // shortest legal
      '0',                                       // digits are alnum too
      'cc.imcodes.node.virtual-display-helper',  // the real one
      'cc.example-app.helper',
      'a'.repeat(128),                           // exactly the bound
      'a.-.-',                                   // punctuation is fine after the first byte
    ];

    // TypeScript, through the exported canonical builder: it returns '' for an
    // identifier it will not vouch for.
    for (const identifier of rejected) {
      expect(canonicalDesignatedRequirement(identifier, TEAM),
        `TypeScript accepted the bundle identifier ${JSON.stringify(identifier)}`)
        .toBe('');
    }
    for (const identifier of accepted) {
      expect(canonicalDesignatedRequirement(identifier, TEAM),
        `TypeScript refused the legal bundle identifier ${JSON.stringify(identifier)}`)
        .not.toBe('');
    }

    // Native, asked the same questions, must answer the same way.
    const probe = resolve(directory!, 'bundle-probe');
    const source = resolve(directory!, 'bundle-probe.cc');
    const literal = (value: string): string => `"${
      [...value].map((character) => {
        const code = character.codePointAt(0)!;
        return code < 0x20 || code > 0x7e || character === '"' || character === '\\'
          ? `\\x${code.toString(16).padStart(2, '0')}`
          : character;
      }).join('')
    }"`;
    writeFileSync(source, [
      '#include "macos_virtual_display_grant.h"',
      '#include <cstdio>',
      '#include <string>',
      'namespace rd = imcodes::remote_desktop::macos;',
      'int main() {',
      // A requirement is produced only for an identifier the rule vouches for,
      // so "did it produce one" IS the rule, observed through the seam that
      // production actually uses.
      ...[...rejected, ...accepted].map((identifier) =>
        `  std::printf("%d\\n", rd::CanonicalDesignatedRequirement(`
        + `${literal(identifier)}, "${TEAM}").empty() ? 0 : 1);`),
      '  return 0;',
      '}',
    ].join('\n'));
    const compile = await runNative('xcrun', [
      'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=12.3', '-I', resolve(ROOT, NATIVE), source,
      resolve(ROOT, `${NATIVE}/macos_virtual_display_grant.cc`), '-o', probe,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const answers = (await runNative(probe, [], {}))
      .stdout.trim().split('\n');
    const expected = [...rejected.map(() => '0'), ...accepted.map(() => '1')];
    expect(answers).toEqual(expected);
  }, 180_000);

  it('spells the canonical designated requirement identically in both languages', async () => {
    if (process.platform !== 'darwin') return;
    // Every other check on either side compares a requirement against whatever
    // its own canonical builder returns, so all of them stay green if a clause
    // silently disappears -- both sides of each comparison move together. The
    // TEXT therefore has to be asserted outright, in both languages, against
    // the same literal.
    const expected = 'identifier "cc.example.helper" and anchor apple generic '
      + 'and certificate leaf[subject.OU] = "ABCDE12345"';
    expect(canonicalDesignatedRequirement('cc.example.helper', 'ABCDE12345'))
      .toBe(expected);

    // And the native builder, asked the same question, must answer the same
    // bytes. A shared literal in one language is a convention; agreement across
    // the boundary is the contract.
    const probe = resolve(directory!, 'requirement-probe');
    const source = resolve(directory!, 'requirement-probe.cc');
    writeFileSync(source, [
      '#include "macos_virtual_display_grant.h"',
      '#include <cstdio>',
      'int main() {',
      '  std::printf("%s\\n", imcodes::remote_desktop::macos::',
      '      CanonicalDesignatedRequirement("cc.example.helper", "ABCDE12345")',
      '          .c_str());',
      '  // Inputs it cannot vouch for yield nothing at all, never a partially',
      '  // interpolated requirement.',
      '  std::printf("[%s]\\n", imcodes::remote_desktop::macos::',
      '      CanonicalDesignatedRequirement("has\\"quote", "ABCDE12345").c_str());',
      '  return 0;',
      '}',
    ].join('\n'));
    const compile = await runNative('xcrun', [
      'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=12.3', '-I', resolve(ROOT, NATIVE), source,
      resolve(ROOT, `${NATIVE}/macos_virtual_display_grant.cc`), '-o', probe,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const run = await runNative(probe, [], {});
    expect(run.stdout.split('\n')[0]).toBe(expected);
    expect(run.stdout.split('\n')[1]).toBe('[]');

    // Both ends must also REFUSE the same unvouched inputs rather than
    // interpolating them: a bundle identifier carrying a quote would close the
    // string early and turn the remainder into requirement syntax.
    for (const [bundle, team] of [
      ['cc.example.helper', 'abcde12345'],
      ['cc.example.helper', ''],
      ['', 'ABCDE12345'],
      ['has space', 'ABCDE12345'],
      ['has"quote', 'ABCDE12345'],
    ] as const) {
      expect(canonicalDesignatedRequirement(bundle, team),
        `TypeScript built a requirement from ${bundle}/${team}`).toBe('');
    }
  }, 180_000);

  it('refuses the SAME wire violations at both ends, for the same reason', async () => {
    if (process.platform !== 'darwin') return;
    // The point of a cross-language matrix is not that each side has rules. It
    // is that the two sides have the SAME rules. A value one end emits and the
    // other refuses is a grant that cannot be delivered; a value one end
    // refuses and the other accepts is a grant that bypasses a check by being
    // minted somewhere else. Both directions are tested here, in one place,
    // against one compiled parser.

    const base = goodInput();
    const line = serializeMacosVirtualDisplayAuthority(
      buildMacosVirtualDisplayAuthority(base.artifact, base.context),
    );

    // BYTE-IDENTICAL ROUND TRIP.
    //
    // TS-serialize -> native-parse -> native-serialize. Mutual acceptance is
    // not enough: two grammars can accept each other and still disagree about
    // the canonical spelling, and a canonical form the two sides do not share
    // is precisely where a second line naming the same authority survives.
    const accepted = await askNative(line);
    expect(accepted.ok, `native refused a well-formed grant: ${accepted.why}`).toBe(true);
    expect(accepted.canon).toBe(line);

    // --- Cases the TYPESCRIPT builder must refuse to construct at all. ---
    const builderRefuses: ReadonlyArray<readonly [string, () => void]> = [
      ['a helper filename with a space', () => {
        const input = goodInput();
        // A space is not cosmetic: the wire grammar is whitespace-delimited, so
        // a spaced value silently becomes two tokens and the tail is read as a
        // whole extra field.
        input.artifact.manifest.components.virtualDisplayHelper.fileName = 'helper binary';
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a helper filename carrying Unicode', () => {
        const input = goodInput();
        input.artifact.manifest.components.virtualDisplayHelper.fileName = 'helper‐binary';
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a helper larger than the mirrored ceiling', () => {
        const input = goodInput();
        input.artifact.manifest.components.virtualDisplayHelper.size = 512 * 1024 * 1024 + 1;
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a team identifier that is not a team identifier', () => {
        const input = goodInput();
        input.artifact.manifest.codeSignature.teamId = 'abcde12345';
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a bundle identifier the requirement does not name', () => {
        const input = goodInput();
        input.artifact.manifest.codeSignature.bundles.virtualDisplayHelper
          .bundleIdentifier = 'cc.imcodes.node.some-other-helper';
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a requirement longer than the wire bound', () => {
        const input = goodInput();
        input.artifact.manifest.codeSignature.bundles.virtualDisplayHelper
          .designatedRequirement = `${REQUIREMENT} or ${'x'.repeat(512)}`;
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a release name that is not the set digest', () => {
        const input = goodInput();
        input.artifact.releaseName = `sha256-${'c'.repeat(64)}`;
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      // The wire carries the DURATION, so what has to be bounded is the
      // lifetime itself. There is no sum here to overflow -- that is why the
      // builder no longer takes a clock reading -- but a lifetime longer than
      // the cap, or one that is not a positive whole number of milliseconds,
      // is still a promise the receiver must never be handed.
      ['a lifetime longer than the maximum', () => {
        const input = goodInput();
        input.context.lifetimeMs =
          MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS + 1;
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a zero lifetime', () => {
        const input = goodInput();
        input.context.lifetimeMs = 0;
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a negative lifetime', () => {
        const input = goodInput();
        input.context.lifetimeMs = -1;
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
      ['a fractional lifetime', () => {
        const input = goodInput();
        input.context.lifetimeMs = 1_000.5;
        buildMacosVirtualDisplayAuthority(input.artifact, input.context);
      }],
    ];
    for (const [what, construct] of builderRefuses) {
      expect(construct, `the builder accepted ${what}`).toThrow();
    }

    // --- The same violations, minted OUTSIDE the builder, on the wire. ---
    //
    // This is the half that matters for security. An attacker does not call the
    // TypeScript builder; they write a line. So every rule the builder enforces
    // must ALSO be enforced by the parser, and each must produce its own
    // diagnosis rather than collapsing into one generic refusal.
    const replaceField = (key: string, value: string): string => line
      .split(' ')
      .map((token) => (token.startsWith(`${key}=`) ? `${key}=${value}` : token))
      .join(' ');

    const wireRefuses: ReadonlyArray<readonly [string, string, string]> = [
      // Unicode in the requirement. The wire is bytes: this arrives as raw
      // UTF-8, not as an escape, and must fail the printable-ASCII rule.
      ['a unicode requirement', replaceField('dr', percentSpaces(
        `identifier “${BUNDLE}” and anchor apple generic`)),
        'grant_field_malformed'],
      // A control byte inside the requirement.
      ['a control byte in the requirement', replaceField('dr', percentSpaces(
        `identifier "${BUNDLE}"\x01 and anchor apple generic`)),
        'grant_field_malformed'],
      // A literal space in the filename splits the token, so the tail arrives
      // as a bare word with no `k=` -- which is exactly why the builder refuses
      // to emit a spaced value in the first place.
      ['a spaced helper filename', replaceField('helperfile', 'helper binary'),
        'grant_token_unstructured'],
      // And an outright unknown key, so "unstructured" is shown to be a
      // distinct verdict rather than the parser's one way of saying no.
      ['an unknown key', `${line} future=1`, 'grant_unknown_key'],
      // Over-long requirement: 513 decoded bytes, one past the bound, while the
      // whole line stays inside the 1024-byte frame. Sized deliberately so the
      // REQUIREMENT bound is what refuses it -- a fixture that also blew the
      // frame would be refused by the frame check and prove nothing about the
      // requirement rule.
      ['an oversized requirement', replaceField('dr', percentSpaces(
        `identifier "${'x'.repeat(476)}" and anchor apple generic`)),
        'grant_field_malformed'],
      // Beyond 2^53-1: a number the TypeScript producer could not have meant.
      ['a TTL past the permitted lifetime',
        replaceField('ttl', '60001'), 'grant_field_malformed'],
      ['a zero TTL', replaceField('ttl', '0'), 'grant_field_malformed'],
      ['a helper size past the mirrored ceiling',
        replaceField('helpersize', String(512 * 1024 * 1024 + 1)),
        'grant_field_malformed'],
      // Well-SHAPED but disagreeing: the cases a shape-only check would wave
      // through, each handing authority to a different signer or a different
      // release.
      ['a different team than the requirement names',
        replaceField('team', 'ZZZZZ99999'), 'grant_requirement_not_canonical'],
      ['a different bundle than the requirement names',
        replaceField('helperbundle', 'cc.imcodes.node.other'),
        'grant_requirement_not_canonical'],
      ['a release directory from another set',
        replaceField('release', `sha256-${'c'.repeat(64)}`),
        'grant_release_set_mismatch'],
      ['a set digest from another release',
        replaceField('set', 'c'.repeat(64)), 'grant_release_set_mismatch'],
    ];
    for (const [what, hostile, why] of wireRefuses) {
      // Guard the fixture itself: a case that accidentally exceeded the line
      // bound would be refused for the wrong reason and prove nothing.
      expect(Buffer.byteLength(hostile, 'utf8'), `${what}: fixture outgrew the line bound`)
        .toBeLessThanOrEqual(1024);
      expect(hostile, `${what}: fixture is identical to the good line`).not.toBe(line);
      const verdict = await askNative(hostile);
      expect(verdict.ok, `native ACCEPTED ${what}`).toBe(false);
      expect(verdict.why, `native refused ${what} for the wrong reason`).toBe(why);
    }
  }, 180_000);

  it('runs the agent ownership and ledger counterfactuals under sanitizers', async () => {
    if (process.platform !== 'darwin') return;
    for (const [name, sources, sanitizer] of [
      // The agent now requires the link's challenge to accept a grant, so the
      // predicate it calls must be linked in. That dependency is the fix: the
      // rule used to live in a free function production never called.
      ['agent', ['macos_virtual_display_agent.cc', 'macos_virtual_display_challenge_ledger.cc',
                 'macos_virtual_display_grant.cc',
                 'macos_virtual_display_authority_link.cc'], 'address,undefined'],
      // The ledger's whole point is atomicity under concurrency, so it is built
      // with the thread sanitizer rather than the address one.
      ['ledger', ['macos_virtual_display_challenge_ledger.cc'], 'thread'],
      // The policy/identity counterfactual existed on disk and no runner ever
      // compiled it, so eleven cases -- three-state presence, the last-surface
      // guard, serial collision escape, symlink/ownership safety on the
      // identity store -- were shipped unexecuted. The inventory guard below
      // is what stops that from recurring silently.
      ['policy', ['macos_virtual_display_policy.cc',
                  'macos_virtual_display_identity.cc'], 'address'],
    ] as const) {
      const executable = resolve(directory!, `vd-${name}-test`);
      const compile = await runNative('xcrun', [
        'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
        `-fsanitize=${sanitizer}`, '-fno-omit-frame-pointer',
        '-mmacosx-version-min=12.3',
        '-I', resolve(ROOT, NATIVE),
        resolve(ROOT, `test/spec/macos-remote-desktop-virtual-display-${name}-test.cc`),
        ...sources.map((source) => resolve(ROOT, `${NATIVE}/${source}`)),
        '-o', executable,
      ], { cwd: directory! });
      expect(compile.status, `${name}: ${compile.stdout}\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], { cwd: directory! });
      expect(run.status, `${name}: ${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain(`macos virtual display ${name} counterfactual ok`);
    }
  }, 300_000);

  // ONE TEST PER SUITE, and the shared sources compiled ONCE.
  //
  // Five suites each rebuilding the same fourteen translation units meant the
  // same code was compiled five times under the sanitizers, which pushed the
  // file past a minute of synchronous spawnSync and starved vitest's own RPC
  // heartbeat -- surfacing as an "unhandled error" that had nothing to do with
  // the code under test. Compiling to objects once and linking per suite is
  // both faster and honest: every suite links the identical objects, so a
  // suite cannot pass against a differently-built library than its neighbour.
  const CDE_SOURCES = [
    'macos_virtual_display_authority_link.cc',
    'macos_virtual_display_authority_link_posix.cc',
    'macos_virtual_display_resident_loop.cc',
    'macos_virtual_display_control_protocol.cc',
    'macos_virtual_display_control_server.cc',
    'macos_virtual_display_route_backend.cc',
    'macos_virtual_display_resident.cc',
    'macos_virtual_display_agent.cc',
    'macos_virtual_display_challenge_ledger.cc',
    'macos_virtual_display_grant.cc',
    'macos_virtual_display_helper_backend.cc',
    'macos_virtual_display_helper_binding.cc',
    'macos_virtual_display_helper_protocol.cc',
    'macos_virtual_display_supervisor.cc',
    'macos_virtual_display_supervisor_posix.cc',
    'macos_virtual_display_adapter.cc',
  ];
  const SANITIZER = ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'];
  const COMMON = ['-std=c++20', '-Wall', '-Wextra', '-Werror',
                  '-mmacosx-version-min=12.3'];

  let cdeObjects: string[] | null = null;
  const buildCdeObjects = async (): Promise<string[]> => {
    if (cdeObjects !== null) return cdeObjects;
    const objects = [
      ...CDE_SOURCES.map((source) => [`${NATIVE}/${source}`, source] as const),
      ['native/remote-desktop-common/value_types.cc', 'value_types.cc'] as const,
    ];
    // Sequential on purpose: the previous synchronous `.map` compiled these one
    // at a time, and Promise.all would change that to concurrent compiles.
    const built: string[] = [];
    for (const [source, name] of objects) {
      const object = resolve(directory!, `cde-${name}.o`);
      const compile = await runNative('xcrun', [
        'clang++', ...COMMON, ...SANITIZER,
        '-I', resolve(ROOT, NATIVE), '-I', ROOT,
        '-c', resolve(ROOT, source), '-o', object,
      ], { cwd: directory! });
      expect(compile.status, `${name}: ${compile.stdout}\n${compile.stderr}`).toBe(0);
      built.push(object);
    }
    cdeObjects = built;
    return built;
  };

  for (const suite of SHARED_OBJECT_SUITES) {
    it(`runs the ${suite} counterfactuals under sanitizers`, async () => {
      if (process.platform !== 'darwin') return;
      const executable = resolve(directory!, `vd-${suite}-test`);
      const compile = await runNative('xcrun', [
        'clang++', ...COMMON, ...SANITIZER,
        '-I', resolve(ROOT, NATIVE), '-I', ROOT,
        resolve(ROOT, `test/spec/macos-remote-desktop-virtual-display-${suite}-test.cc`),
        ...(await buildCdeObjects()),
        '-framework', 'CoreFoundation', '-framework', 'Security',
        '-o', executable,
      ], { cwd: directory! });
      expect(compile.status, `${suite}: ${compile.stdout}\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], { cwd: directory! });
      expect(run.status, `${suite}: ${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain(`macos virtual display ${suite} counterfactual ok`);
    }, 180_000);
  }


  it('runs the grant counterfactuals under sanitizers', async () => {
    if (process.platform !== 'darwin') return;
    const executable = resolve(directory!, 'grant-test');
    const compile = await runNative('xcrun', [
      'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-mmacosx-version-min=12.3',
      '-I', resolve(ROOT, NATIVE),
      resolve(ROOT, 'test/spec/macos-remote-desktop-virtual-display-grant-test.cc'),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_grant.cc`),
      '-o', executable,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const run = await runNative(executable, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('macos virtual display grant counterfactual ok');
  }, 180_000);

  it('runs the helper supervision counterfactuals under sanitizers', async () => {
    if (process.platform !== 'darwin') return;
    const executable = resolve(directory!, 'virtual-display-supervisor-test');
    const compile = await runNative('xcrun', [
      'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-mmacosx-version-min=12.3',
      '-I', resolve(ROOT, NATIVE),
      resolve(ROOT, 'test/spec/macos-remote-desktop-virtual-display-supervisor-test.cc'),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_supervisor.cc`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_helper_binding.cc`),
      '-o', executable,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const run = await runNative(executable, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('macos virtual display supervisor counterfactual ok');
  }, 180_000);


  it('runs the helper binding, admission and backend counterfactuals under sanitizers', async () => {
    if (process.platform !== 'darwin') return;
    const executable = resolve(directory!, 'virtual-display-helper-test');
    const compile = await runNative('xcrun', [
      'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-mmacosx-version-min=12.3',
      '-I', resolve(ROOT, NATIVE),
      '-I', resolve(ROOT, 'native/remote-desktop-common'),
      resolve(ROOT, 'test/spec/macos-remote-desktop-virtual-display-helper-test.cc'),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_helper_backend.cc`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_helper_binding.cc`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_helper_protocol.cc`),
      resolve(ROOT, `${NATIVE}/macos_virtual_display_adapter.cc`),
      resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
      '-o', executable,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    const run = await runNative(executable, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('macos virtual display helper counterfactual ok');
  }, 180_000);

  it('drives the helper from a real run loop instead of a blocking read', async () => {
    const helper = read(`${NATIVE}/macos_virtual_display_helper_main.mm`);
    // A CGVirtualDisplay's callbacks and the WindowServer connection are
    // serviced on the main run loop. Blocking it in fgetc(stdin) starves
    // exactly those callbacks, and slop-desk documents that a process without a
    // live run loop has its display torn down underneath it.
    expect(helper).toContain('CFRunLoopRun()');
    expect(helper).toContain('DISPATCH_SOURCE_TYPE_READ');
    expect(helper).toContain('DISPATCH_SOURCE_TYPE_SIGNAL');
    expect(helper).not.toMatch(/std::fgetc\(stdin\)/);
    // Signal handling must not run the teardown, which allocates and talks to
    // WindowServer -- neither is async-signal-safe.
    expect(helper).not.toMatch(/signal\(SIGTERM,\s*HandleSignal\)/);
    // Ordered shutdown: authority first, then the display, then enumeration.
    const revoke = helper.indexOf('state.RevokeAuthority()');
    const teardown = helper.indexOf('state.TearDown()');
    expect(revoke).toBeGreaterThan(-1);
    expect(teardown).toBeGreaterThan(revoke);
    // Binding is consumed at launch, never inferred from the first frame.
    expect(helper).toContain('--imcodes-bind-fd');
    expect(helper).toContain('ParseVirtualDisplayHelperBinding');
    expect(helper).not.toMatch(/FIRST verb binds/);
  });

  it('activates through SLWindowMirroringManager with a verified encoding', async () => {
    const runtime = read(`${NATIVE}/macos_virtual_display_skylight_runtime.mm`);
    expect(runtime).toContain('SLWindowMirroringManager');
    expect(runtime).toContain('sel_registerName("extend:")');
    // MEASURED on 26.2: -extend: is "B24@0:8@16". The argument is an OBJECT,
    // not a CGDirectDisplayID, so the id must be boxed; passing a raw integer
    // through an object parameter is UB that happens to look like it works.
    expect(runtime).toContain('"B24@0:8@16"');
    expect(runtime).toMatch(/NSNumber\*\s+boxed\s*=/);
    // No silent downgrade: only extend: can bring a registered-inactive display
    // into the topology, so reporting success from an origin/mirror change
    // would advertise activation that never happened.
    const extendStart = runtime.indexOf('seam.force_extend');
    const extendEnd = runtime.indexOf('seam.online_display_ids');
    const region = runtime.slice(extendStart, extendEnd);
    expect(region).not.toContain('CGConfigureDisplayOrigin');
    expect(region).not.toContain('CGConfigureDisplayMirrorOfDisplay');
  });


  it('makes readiness ask the helper, not the filesystem', async () => {
    const worker = read(`${NATIVE}/macos_remote_desktop_worker_main.mm`);
    const probeStart = worker.indexOf('class WorkerReadinessProbe final');
    // Stable production boundary, independent of auto unlock: the readiness
    // probe's own methods end where DisclosureSupervisor begins. The previous
    // anchor was an auto-unlock function, so decoupling collapsed this region.
    const probeEnd = worker.indexOf('class DisclosureSupervisor');
    const region = worker.slice(probeStart, probeEnd);
    // Sibling presence and seam resolution are PREREQUISITES. On their own they
    // prove only that a file and some selectors exist -- not that a helper is
    // running, was ever bound, or holds anything.
    expect(region).toContain('out->virtual_display = false;');
    // No environment-variable branch: nothing in production writes
    // IMCODES_VIRTUAL_DISPLAY_BIND_FD / _SOCKET, so that path was unreachable
    // and only served to imply a mechanism that does not exist. Readiness is a
    // separate short-lived process and genuinely cannot reach a helper owned by
    // a route worker over an anonymous socketpair.
    const regionCode = region.split('\n')
      .filter((l) => !l.trimStart().startsWith('//')).join('\n');
    expect(regionCode).not.toMatch(/IMCODES_VIRTUAL_DISPLAY_(BIND_FD|SOCKET)/);
    expect(worker).not.toContain('ReadInheritedHelperBinding');
    expect(region).not.toMatch(/out->virtual_display\s*=\s*VirtualDisplayHelperSiblingPresent/);
    // The reason is stated, not left to be inferred from a dead branch.
    expect(region).toMatch(/RESIDENT supervisor/);
  });

  it('hashes exactly the four shipped components in the build provenance', async () => {
    const script = read('scripts/macos-remote-desktop-build-spike.sh');
    const artifactsBlock = script.slice(
      script.indexOf(`printf '  "artifacts": {`),
      script.indexOf(`printf '  }`, script.indexOf(`printf '  "artifacts": {`)),
    );
    expect(artifactsBlock.length).toBeGreaterThan(0);
    const hashed = [...artifactsBlock.matchAll(/"([A-Za-z]+)":\s*"%s"/g)].map((m) => m[1]);
    // EXACT set: an extra entry is an unshipped artifact claiming provenance,
    // and a missing one breaks the chain that proves "what ran" is "what was
    // built". The auto-unlock bundle is deliberately NOT in that set: it is
    // unqualified and not shipped, so no evidence chain may rest on it and it
    // must never claim shipped provenance.
    expect([...hashed].sort()).toEqual([
      'disclosure',
      'launchAgent',
      'virtualDisplayHelper',
      'worker',
    ]);
    expect(hashed, 'the unqualified auto-unlock bundle must never claim shipped provenance')
      .not.toContain('autoUnlockBundle');
    // Still valid JSON: exactly one entry may omit the trailing comma.
    expect([...artifactsBlock.matchAll(/"%s"\\n'/g)]).toHaveLength(1);
  });

  it('verifies the auto-unlock bundle only under the opt-in, and never ships it', async () => {
    const script = read('scripts/macos-remote-desktop-build-spike.sh');
    const build = read(`${NATIVE}/BUILD.gn`);
    // GN emits a loadable_module with output_extension = "bundle": a FLAT
    // Mach-O file named aiDeskAutoUnlock.bundle, NOT a bundle directory. The
    // script's own existence check uses -f, which is the same claim.
    expect(build).toMatch(/loadable_module\("aiDeskAutoUnlock"\)[\s\S]{0,400}output_extension = "bundle"/);
    expect(script).toContain('if [[ ! -f "$AUTO_UNLOCK_ARTIFACT" ]]');
    // So the digest must be taken from the artifact itself. Reaching into
    // Contents/MacOS addresses a path that never exists.
    const executable = script.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(executable).not.toMatch(/AUTO_UNLOCK_ARTIFACT\/Contents/);
    // Existence + symbol check are gated behind the verification opt-in: a
    // default build does not produce this artifact, and its absence is the
    // intended state rather than a failure.
    expect(script).toContain('if $AUTO_UNLOCK_VERIFY; then');
    expect(script).toContain('AuthorizationPluginCreate');
    // ...and it is never hashed into the shipped provenance manifest.
    expect(executable, 'auto unlock must not be hashed as a shipped component')
      .not.toContain('hash_artifact autoUnlockBundle');
  });

  it('never lets a provenance digest be empty or silently swallowed', async () => {
    const script = read('scripts/macos-remote-desktop-build-spike.sh');
    const executable = script.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    // A `2>/dev/null` on the hashing substitution is exactly how a missing path
    // became an empty digest that still shipped.
    expect(executable).not.toContain('2>/dev/null');
    // The artifact must be a regular file before it is hashed at all.
    expect(script).toContain('is not a regular file');
    // Every digest is validated as 64 lower-case hex, twice: once from the
    // variables, and once by re-reading the file a consumer will actually see.
    expect(script).toMatch(/\^\[0-9a-f\]\{64\}\$/);
    expect(script).toContain('emitted manifest lacks a valid');
    for (const kind of ['worker', 'launchAgent', 'disclosure',
                        'virtualDisplayHelper']) {
      expect(script, `${kind} is not validated`).toMatch(
        new RegExp(`${kind}[^\\n]*\\$|for entry_label in[^\\n]*${kind}`),
      );
    }
    // Failure is exit 2, not a warning.
    expect(script).toMatch(/provenance:[\s\S]{0,200}exit 2/);
  });

  it('keeps every GN target to a single assignment per list', async () => {
    // GN treats a second assignment to a non-empty list as a hard error
    // ("Replacing nonempty list"), so appending a fresh `public_deps = [...]`
    // block to add one dependency breaks `gn gen` outright. This only surfaces
    // in a real gn run, never in a clang compile.
    const gn = read(`${NATIVE}/BUILD.gn`);
    const targets = [...gn.matchAll(
      /(?:source_set|rtc_executable|executable|loadable_module|static_library)\("([^"]+)"\)\s*\{/g)];
    expect(targets.length).toBeGreaterThan(0);
    for (const [index, match] of targets.entries()) {
      const start = match.index!;
      const end = index + 1 < targets.length ? targets[index + 1].index! : gn.length;
      const body = gn.slice(start, end);
      for (const key of ['public_deps', 'deps', 'sources', 'public',
                         'cflags_objcc', 'frameworks', 'libs', 'ldflags']) {
        const assignments = body.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[`, 'gm')) ?? [];
        expect(assignments.length,
          `GN target "${match[1]}" assigns ${key} ${assignments.length} times`)
          .toBeLessThanOrEqual(1);
      }
    }
  });

  it('refuses cross-architecture builds unless explicitly opted in, and never calls them qualified', async () => {
    const script = read('scripts/macos-remote-desktop-build-spike.sh');
    // Default is refusal. A binary that merely LINKED elsewhere has been shown
    // to build, not to run.
    expect(script).toContain('cross-linking is not qualification');
    expect(script).toContain('--allow-cross-build-diagnostic');
    // Opt-in is not sufficient on its own: the full probe is the artifact a
    // release is cut from, so it must stay native.
    expect(script).toContain('cross-build diagnostics are limited to --components-only');
    // Legal pairs only.
    expect(script).toContain('arm64:x86_64|x86_64:arm64');
    // The labels are mandatory and may not be faked as native.
    for (const field of ['"crossBuilt"', '"nativeBuild"', '"buildHostArch"',
                         '"targetArch"', '"sdk"', '"minOS"', '"provenanceVersion"']) {
      expect(script, `provenance is missing ${field}`).toContain(field);
    }
    expect(script).toContain('"qualified": false');
    // Belt and braces: the script refuses to emit a manifest claiming
    // qualification even if a future edit tried to.
    expect(script).toContain('build provenance must never claim qualification');
    // The only permitted occurrence of the literal is inside that refusal
    // guard; anywhere else it would be the script emitting the claim itself.
    const qualifiedTrue = [...script.matchAll(/"qualified":\s*true/g)];
    expect(qualifiedTrue).toHaveLength(1);
    const guardLine = script.split('\n').find((l) => l.includes('"qualified": true'));
    expect(guardLine).toMatch(/grep -q/);
  });

  it('never creates or destroys a display on the readiness path', async () => {
    // P0 REGRESSION GUARD.
    //
    // inspectReadiness -> LaunchAgent -> worker --imcodes-readiness-v1 used to
    // Create() a real virtual display, WaitUntilOnline() it, then Destroy() it.
    // Destroy() is an objc_release, and release-to-remove was MEASURED not to
    // remove on macOS 26.x. Because readiness runs on a timer, that stranded one
    // display per invocation, permanently. Advertising a capability must never
    // cost the user their display topology.
    const worker = read(`${NATIVE}/macos_remote_desktop_worker_main.mm`);
    const probeStart = worker.indexOf('class WorkerReadinessProbe final');
    // Stable production boundary, independent of auto unlock: the readiness
    // probe's own methods end where DisclosureSupervisor begins.
    const probeEnd = worker.indexOf('class DisclosureSupervisor');
    expect(probeStart).toBeGreaterThan(-1);
    expect(probeEnd).toBeGreaterThan(probeStart);
    const readinessRegion = worker.slice(probeStart, probeEnd);
    for (const forbidden of [
      'CreateAppleMacosVirtualDisplayBackend',
      '->Create(',
      'WaitUntilOnline',
      '->Destroy()',
    ]) {
      expect(readinessRegion, `readiness path performs "${forbidden}"`)
        .not.toContain(forbidden);
    }
    // What it does instead is state the truthful answer directly. There is no
    // resident supervisor this short-lived process can query, so the claim is
    // false -- asserted here so a future edit cannot quietly turn it into an
    // optimistic yes derived from file presence or selector resolution.
    expect(readinessRegion).toContain('out->virtual_display = false;');
  });

  it('never reintroduces companion-display creation as a teardown mechanism', async () => {
    // Chromium's paired-removal workaround (create a second display, drop both
    // owners together) was implemented here, measured on macOS 26.2, and FAILED:
    // `primary id=5 / companion id=6 / removed=0 / LEAKED: 5 6`. The two ids
    // still stranded on the dev host are that run's primary and its companion,
    // so the workaround did not just fail to remove a display — it doubled the
    // leak. The module was deleted; this guard stops it coming back, because the
    // next person to read Chromium's source will find the same TODO and reach
    // for the same fix.
    expect(existsSync(resolve(ROOT, `${NATIVE}/macos_virtual_display_teardown.h`))).toBe(false);
    expect(existsSync(resolve(ROOT, `${NATIVE}/macos_virtual_display_teardown.cc`))).toBe(false);
    const sources = readdirSync(resolve(ROOT, NATIVE))
      .filter((f) => f.endsWith('.cc') || f.endsWith('.mm') || f.endsWith('.h'));
    for (const file of sources) {
      const body = read(`${NATIVE}/${file}`);
      // A companion is a SECOND display. One slot is the invariant that keeps a
      // failed teardown from compounding into two stranded displays.
      expect(body, `${file} reintroduces companion-display creation`)
        .not.toMatch(/create_companion|CreateCompanion|companion_display_id/);
    }
    // The single-slot invariant that makes the above impossible by construction.
    expect(read(`${NATIVE}/macos_virtual_display_identity.h`))
      .toContain('kAiDeskVirtualDisplayMaxSlots = 1');
  });

  it('never puts two same-basename sources in one GN target', async () => {
    // GN derives the object-file name from the source BASENAME, so a .cc and a
    // .mm differing only by extension collide as one .o and the build fails
    // with "generates two object files with the same name". This regressed once
    // already (macos_virtual_display_skylight.cc + .mm), and the failure only
    // surfaces in a real gn gen — not in any clang compile — so it needs its own
    // contract rather than being left to the native build to catch late.
    const gn = read(`${NATIVE}/BUILD.gn`);
    const targets = [...gn.matchAll(/(?:source_set|static_library|executable|shared_library|loadable_module)\("([^"]+)"\)\s*\{/g)];
    expect(targets.length).toBeGreaterThan(0);
    for (const [index, match] of targets.entries()) {
      const start = match.index!;
      const end = index + 1 < targets.length ? targets[index + 1].index! : gn.length;
      const body = gn.slice(start, end);
      const sourcesBlock = body.match(/sources\s*=\s*\[([\s\S]*?)\]/);
      if (!sourcesBlock) continue;
      const compiled = [...sourcesBlock[1].matchAll(/"([^"]+\.(?:cc|mm|c|m|cpp))"/g)].map((s) => s[1]);
      const basenames = compiled.map((f) => f.replace(/^.*\//, '').replace(/\.[^.]+$/, ''));
      const duplicates = basenames.filter((b, i) => basenames.indexOf(b) !== i);
      expect(duplicates, `GN target "${match[1]}" has same-basename sources: ${duplicates.join(', ')}`).toEqual([]);
    }
  });


  it('runs every virtual-display counterfactual on disk, and every one it names', async () => {
    // BIDIRECTIONAL, because each direction hides a different failure.
    //
    // A counterfactual on disk that no runner compiles is shipped unexecuted --
    // that is exactly how the policy suite's eleven cases sat dormant. A runner
    // naming a file that does not exist is a suite silently doing nothing.
    const onDisk = readdirSync(resolve(ROOT, 'test/spec'))
      .map((entry) => /^macos-remote-desktop-virtual-display-(.+)-test\.cc$/u.exec(entry)?.[1])
      .filter((name): name is string => Boolean(name))
      .sort();
    // A guard on the guard: a regex that matched nothing would make both
    // directions vacuously true.
    expect(onDisk.length).toBeGreaterThanOrEqual(14);

    const covered = [
      ...SHARED_OBJECT_SUITES,
      ...OWN_SOURCE_SUITES,
      ...EXPLICIT_SUITES,
      ...ELSEWHERE_SUITES.map(([name]) => name),
    ].sort();
    expect(new Set(covered).size, 'a suite is claimed twice').toBe(covered.length);

    const unrun = onDisk.filter((name) => !covered.includes(name));
    expect(unrun, `counterfactual(s) on disk that no runner compiles: ${unrun.join(', ')}`)
      .toEqual([]);
    const missing = covered.filter((name) => !onDisk.includes(name));
    expect(missing, `runner names counterfactual(s) that do not exist: ${missing.join(', ')}`)
      .toEqual([]);

    // The delegated ones must really be delegated, not just declared.
    for (const [name, owner] of ELSEWHERE_SUITES) {
      const spec = readFileSync(resolve(ROOT, owner), 'utf8');
      expect(spec, `${owner} does not actually run ${name}`)
        .toContain(`macos-remote-desktop-virtual-display-${name}-test.cc`);
    }
  });

});
