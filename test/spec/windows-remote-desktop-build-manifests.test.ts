import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WORKER_PRIVACY_FRAME } from '../../src/node/remote-desktop-privacy-ipc.js';
import {
  WORKER_CONSENT_FRAME,
  WORKER_CONSENT_OUTCOME,
} from '../../src/node/remote-desktop-consent-ipc.js';
import {
  CANONICAL_LOGO,
  GENERATED_HEADER,
  LOGO_SIZES,
  renderHeader,
} from '../../scripts/generate-remote-desktop-brand-asset.mjs';

/**
 * The worker's source list lives in three places -- BUILD.gn for the pinned
 * libwebrtc build, `$ProductionSources`/`$Tests` for the SDK build, and
 * `$ExpectedSources` for the file overlay copied into the checkout -- because
 * each consumer reads a different build system. Adding a translation unit to
 * only one of them still compiles locally and still passes every unit test: the
 * failure is an unresolved symbol at link time, on CI, on the one job that
 * produces the signed artifact nodes actually upgrade to. Keep them in step.
 */
const NATIVE = resolve(__dirname, '..', '..', 'native', 'windows-remote-desktop');

function read(name: string): string {
  return readFileSync(resolve(NATIVE, name), 'utf8');
}

function gnTargetSources(gn: string, target: string): string[] {
  const declaration = gn.indexOf(`"${target}"`);
  expect(declaration, `${target} is declared in BUILD.gn`).toBeGreaterThan(-1);
  const start = gn.indexOf('sources = [', declaration);
  const end = gn.indexOf(']', start);
  return [...gn.slice(start, end).matchAll(/"([^"]+\.(?:cc|h))"/g)].map((match) => match[1]!);
}

function powershellList(script: string, startMarker: string, endMarker: string): string[] {
  const start = script.indexOf(startMarker);
  expect(start, `${startMarker} exists`).toBeGreaterThan(-1);
  const end = script.indexOf(endMarker, start);
  return [...script.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe('windows remote-desktop build manifests', () => {
  const gn = read('BUILD.gn');
  const sdk = read('build-worker-from-sdk.ps1');
  const overlay = read('build-worker.ps1');

  const workerSources = gnTargetSources(gn, 'imcodes_remote_desktop_worker');
  const testTargets = [...gn.matchAll(/rtc_test\("([^"]+)"\)/g)].map((match) => match[1]!);
  const productionSources = powershellList(sdk, '$ProductionSources = @(', '$Tests = [ordered]@{');
  const expectedSources = powershellList(overlay, '$ExpectedSources = @(', '\n)');

  it('compiles every worker translation unit in the SDK build too', () => {
    const missing = workerSources
      .filter((source) => source.endsWith('.cc'))
      .filter((source) => !productionSources.includes(source));
    expect(missing).toEqual([]);
  });

  it('copies every worker source into the pinned checkout overlay', () => {
    const missing = workerSources.filter((source) => !expectedSources.includes(source));
    expect(missing).toEqual([]);
  });

  it('builds every declared unit test in the SDK build too', () => {
    const sdkTests = sdk.slice(sdk.indexOf('$Tests = [ordered]@{'), sdk.indexOf('$SystemLibraries'));
    for (const target of testTargets) {
      expect(sdkTests, `${target} is built by the SDK script`).toContain(`${target} = @(`);
      for (const source of gnTargetSources(gn, target).filter((name) => name.endsWith('.cc'))) {
        const entry = sdkTests.slice(sdkTests.indexOf(`${target} = @(`));
        expect(entry.slice(0, entry.indexOf(')')), `${target} compiles ${source}`).toContain(`'${source}'`);
      }
    }
  });

  it('has a unit-test target for every unit-test source on disk', () => {
    const onDisk = readdirSync(NATIVE).filter((name) => name.endsWith('_unittest.cc'));
    for (const source of onDisk) {
      expect(gn, `${source} has an rtc_test target`).toContain(`"${source}"`);
      expect(expectedSources, `${source} is copied into the checkout`).toContain(source);
    }
    expect(onDisk.length).toBe(testTargets.length);
  });
});

/**
 * The indicator is an always-on-top window the local user cannot close, shown
 * for the whole session. Two properties have to hold at the source level
 * because there is no Windows host in CI to observe them at runtime.
 */
describe('windows remote-desktop indicator branding', () => {
  const indicator = read('local_indicator.cc');
  const indicatorHeader = read('local_indicator.h');
  const gn = read('BUILD.gn');
  const sdk = read('build-worker-from-sdk.ps1');

  it('derives the compiled logo from the one canonical web asset', async () => {
    // Fails if either the canonical PNG or the generated header moves without
    // the other, which is what keeps this from becoming a second logo.
    expect(CANONICAL_LOGO.endsWith('imcodes-robot-avatar.png')).toBe(true);
    expect(GENERATED_HEADER.endsWith('brand_logo_generated.h')).toBe(true);
    expect(readFileSync(GENERATED_HEADER, 'utf8')).toBe(await renderHeader());
  });

  it('compiles a bitmap for every DPI bucket the indicator selects from', () => {
    const generated = read('brand_logo_generated.h');
    for (const size of LOGO_SIZES) {
      expect(generated, `kLogoBgra${size} is compiled in`).toContain(`kLogoBgra${size}[]`);
      expect(generated, `${size} is in the lookup table`).toContain(`{${size}, kLogoBgra${size}}`);
    }
    // 20 logical px at 300% needs 60; anything smaller would upscale.
    expect(Math.max(...LOGO_SIZES)).toBeGreaterThanOrEqual(60);
  });

  it('shows the product name in text, not only as a mark', () => {
    // A logo alone is unreadable to a screen magnifier user and disappears
    // entirely when the bitmap cannot be composited.
    expect(indicator).toContain('kProductName[] = L"IM.codes"');
    expect(indicator).toContain('kSurfaceName[] = L"Remote Desktop"');
  });

  it('keeps a text-only fallback when the bitmap cannot be composited', () => {
    // DrawBrandLogo returns false on DIB/AlphaBlend failure; both call sites
    // must branch on it so a failed image never costs the disclosure itself.
    expect(indicator).toContain('if (!DrawBrandLogo(');
    expect(indicator).toContain('const bool logo_drawn = DrawBrandLogo(');
    expect(indicator).toContain('if (!logo_drawn)');
  });

  it('scales its own geometry, not only its fonts', () => {
    // Fonts scaled with GetDpiForWindow while the window stayed 368x148, so
    // at 200% the layout overflowed. Every literal now goes through Scaled().
    expect(indicator).toContain('int Scaled(UINT dpi, int logical)');
    expect(indicator).toContain('CollapseRect(const RECT& client, UINT dpi)');
    expect(indicator).toContain('StopRect(const RECT& client, UINT dpi)');
    expect(indicator).not.toMatch(/RECT\s+detail_rect\{18,/);
  });

  it('honours high contrast instead of forcing the brand palette', () => {
    expect(indicator).toContain('SPI_GETHIGHCONTRAST');
    expect(indicator).toContain('HCF_HIGHCONTRASTON');
    expect(indicator).toContain('GetSysColor(');
  });

  it('renders no requester-supplied text', () => {
    // The public surface is the enforcement point: counts in, no strings.
    expect(indicatorHeader).toContain('void Update(int viewers, int controllers);');
    expect(indicatorHeader).not.toMatch(/void Update\([^)]*(wchar_t|std::wstring|std::u16string|char)/);
    // Every DrawTextW argument is either a literal or built from the two
    // atomic counters; a std::wstring built from anything else is a red flag.
    for (const [, argument] of indicator.matchAll(/DrawTextW\(dc,\s*([^,]+),/g)) {
      expect(
        /^(L"|stopping \?|heading\.c_str\(\)|detail\.c_str\(\))/.test(argument.trim()),
        `DrawTextW renders a constant or a counter-derived string, got: ${argument.trim()}`,
      ).toBe(true);
    }
  });

  it('links the blend import the mark needs', () => {
    // AlphaBlend lives in msimg32; the SDK build already had it, the pinned
    // libwebrtc build did not, and the failure is a link error only on CI.
    expect(gn).toContain('"msimg32.lib"');
    expect(sdk).toContain("'msimg32.lib'");
  });
});

/**
 * The consent prompt is the local human's Allow/Deny gate. It cannot be
 * exercised on a non-Windows host, so the properties that make it safe are
 * asserted at the source level instead of left to a Windows-only review.
 */
describe('windows remote-desktop consent prompt', () => {
  const prompt = read('consent_prompt.cc');
  const promptHeader = read('consent_prompt.h');
  const indicator = read('local_indicator.cc');

  it('is a separate window from the Stop indicator', () => {
    // Folding consent into the indicator would either hide Stop behind the
    // question or make one window mean two things. Stop must stay clickable
    // exactly when a prompt is up.
    expect(prompt).toContain('kWindowClass[] = L"IMCodesRemoteDesktopConsent"');
    expect(indicator).toContain('kWindowClass[] = L"IMCodesRemoteDesktopIndicator"');
  });

  it('refuses to prompt on a protected or non-interactive desktop', () => {
    // A prompt "shown" while Winlogon is in front is invisible, and an
    // invisible prompt that later times out looks like nothing happened.
    expect(prompt).toContain('OpenInputDesktop(');
    expect(prompt).toContain('UOI_NAME');
    expect(prompt).toContain('Outcome::kUnavailable');
    expect(prompt).toMatch(/if \(!InteractiveDesktopAvailable\(\)\) return Outcome::kUnavailable;/);
  });

  it('treats silence and dismissal as refusal, never as consent', () => {
    expect(prompt).toContain('Finish(Outcome::kTimedOut)');
    // Escape and the close box deny rather than dismiss.
    expect(prompt).toMatch(/VK_ESCAPE\) Finish\(Outcome::kDenied\)/);
    expect(prompt).toMatch(/case WM_CLOSE:\s*\n\s*Finish\(Outcome::kDenied\)/);
    expect(prompt).toContain('No answer denies the request.');
  });

  it('lets the first terminal state win', () => {
    // A late click must not overwrite a timeout already reported upstream.
    expect(prompt).toContain('if (finished_.exchange(true)) return;');
  });

  it('states the mode in words rather than only a verb', () => {
    expect(prompt).toContain('Allow remote CONTROL of this computer?');
    expect(prompt).toContain("Allow someone to VIEW this computer's screen?");
  });

  it('renders the requester label as inert, bounded text', () => {
    // The label is the only attacker-influenced string on this surface.
    expect(prompt).toContain('L"Requested by: " + requester_label_');
    const labelDraw = prompt.slice(prompt.indexOf('who.c_str()'));
    expect(labelDraw.slice(0, 200)).toContain('DT_NOPREFIX');
    expect(labelDraw.slice(0, 200)).toContain('DT_END_ELLIPSIS');
    // No path may build chrome out of it.
    expect(promptHeader).toContain('untrusted');
  });

  it('carries the brand mark with a text-only fallback', () => {
    expect(prompt).toContain('kProductName[] = L"IM.codes"');
    expect(prompt).toContain('if (!DrawBrandLogo(');
  });

  it('scales its geometry and honours high contrast', () => {
    expect(prompt).toContain('int Scaled(UINT dpi, int logical)');
    expect(prompt).toContain('SPI_GETHIGHCONTRAST');
    expect(prompt).toContain('GetSysColor(');
  });
});

/**
 * The consent IPC literals exist three times -- the Node adapter, the native
 * header, and (for the outward-facing contract) shared/. C++ cannot import the
 * TS module, so duplication is unavoidable; silent drift is not. A mismatch
 * here means the worker and the daemon would disagree about what a frame is
 * called, and the daemon would wait for an answer that can never arrive.
 */
describe('consent IPC literals agree across the language boundary', () => {
  const nativeHeader = read('consent_ipc.h');

  it.each(Object.entries(WORKER_CONSENT_FRAME))('frame %s matches the native header', (_key, literal) => {
    expect(nativeHeader).toContain(`"${literal}"`);
  });

  it.each(Object.entries(WORKER_CONSENT_OUTCOME))('outcome %s matches the native header', (_key, literal) => {
    expect(nativeHeader).toContain(`"${literal}"`);
  });

  it('keeps consent frames out of the authenticated session union', () => {
    // Routing consent through Signal would mean forging a session or
    // weakening the check that protects real ones.
    const signal = read('json_protocol.h');
    expect(signal).toContain('enum class Kind { kPrepare, kOffer, kIce, kLease, kMode, kStop }');
    for (const literal of Object.values(WORKER_CONSENT_FRAME)) {
      expect(signal).not.toContain(literal);
    }
  });

  it('refuses an unbounded or absent prompt deadline', () => {
    const parser = read('consent_ipc.cc');
    expect(nativeHeader).toContain('kMaxDeadlineMs');
    expect(parser).toContain('deadline <= 0');
    expect(parser).toContain('consent_ipc::kMaxDeadlineMs');
  });

  it('rejects an oversized requester label instead of truncating it', () => {
    // A silently shortened label is still drawn as the whole truth about who
    // is asking.
    const parser = read('consent_ipc.cc');
    expect(parser).toContain('kMaxRequesterLabelBytes');
    expect(parser).toMatch(/requester_label\.size\(\) > kMaxRequesterLabelBytes/);
  });

  it('never maps an unrecognised outcome onto a decision', () => {
    const parser = read('consent_ipc.cc');
    const tail = parser.slice(parser.indexOf('const char* ConsentOutcomeLiteral'));
    expect(tail).toContain('return consent_ipc::kOutcomeCancelled;');
    expect(tail.trimEnd().endsWith('}  // namespace imcodes::rd')).toBe(true);
  });

  it('routes consent frames through the native main loop and serializes pipe writes', () => {
    const main = read('worker_main.cc');
    expect(main).toContain('ConsentDispatcher consent(&writer);');
    // Intent, not an exact string: consent must be offered the frame before
    // the session runtime, and additional dispatchers may sit between them.
    // Pinning the literal chain made adding one a test failure rather than a
    // review question.
    const consentAt = main.indexOf('consent.Handle(root)');
    const privacyAt = main.indexOf('privacy.Handle(root)', consentAt);
    const runtimeAt = main.indexOf('runtime.Handle(root)', privacyAt);
    expect(consentAt).toBeGreaterThan(-1);
    expect(consentAt).toBeLessThan(privacyAt);
    expect(privacyAt).toBeLessThan(runtimeAt);
    expect(main).toContain('consent.Shutdown();');
    expect(main).toMatch(/bool Emit\([^)]*\) \{\s*std::lock_guard<std::mutex> lock\(mutex_\);/);
  });

  it('does not lose a dismiss that arrives before the prompt thread starts', () => {
    const main = read('worker_main.cc');
    const promptHeader = read('consent_prompt.h');
    const prompt = read('consent_prompt.cc');
    expect(main).toContain('prompt_.cancellation_generation()');
    expect(promptHeader).toContain('cancellation_generation_');
    expect(prompt).toContain('cancellation_generation_.fetch_add(1)');
    expect(prompt).toContain('cancellation_generation_.load() != cancellation_generation');
  });

  it('treats an unreadable Windows lock state as protected', () => {
    const main = read('worker_main.cc');
    expect(main).toContain('std::optional<bool> CurrentSessionLockedState()');
    expect(main).toContain('return CurrentSessionLockedState().value_or(true);');
  });
});

/**
 * The management-privacy shield. The owner is typing a password into a shell
 * on this machine while remote viewers watch it, so these are the properties
 * that decide whether the password reaches them.
 */
describe('windows remote-desktop privacy shield', () => {
  const capture = read('display_capture.cc');
  const captureHeader = read('display_capture.h');

  it('gates at the single broadcast chokepoint, not per capture path', () => {
    // DXGI, the GDI fallback and any future source all funnel through
    // BroadcastFrame(); gating per path means a new path can forget to.
    const broadcast = capture.slice(capture.indexOf('void DxgiDesktopSource::BroadcastFrame'));
    const body = broadcast.slice(0, broadcast.indexOf('\n}'));
    expect(body).toContain('privacy_shielded_.load()');
    expect(body).toContain('PrivacyFrame(');
    // The real buffer must not reach the broadcaster while shielded.
    expect(body).toContain('.set_video_frame_buffer(outgoing)');
    expect(body).not.toContain('.set_video_frame_buffer(buffer)');
  });

  it('drops the frame rather than falling back to real pixels', () => {
    // No picture is an acceptable outcome; the owner's password is not.
    const broadcast = capture.slice(capture.indexOf('void DxgiDesktopSource::BroadcastFrame'));
    expect(broadcast.slice(0, 900)).toContain('if (!outgoing) return;');
  });

  it('generates the opaque frame locally, with no captured or requester input', () => {
    const privacy = capture.slice(capture.indexOf('DxgiDesktopSource::PrivacyFrame'));
    const body = privacy.slice(0, privacy.indexOf('\n}'));
    // Constants only: no memcpy from a captured surface, no caller string.
    expect(body).not.toMatch(/cursor_bits_|mapped\.pData|staging_/);
    expect(body).toContain('I420Buffer::Create');
  });

  it('advances the generation on shielded frames too', () => {
    // END proves freshness with a generation strictly newer than the one the
    // shield went up at; a counter that stalled while shielded could never
    // satisfy it, and one that only counted real frames would let a cached
    // pre-end frame pass.
    expect(capture).toContain('shield_generation_.fetch_add(1);');
    expect(captureHeader).toContain('uint64_t shield_generation() const');
  });

  it('exposes engage/release as explicit operations', () => {
    expect(captureHeader).toContain('void EngagePrivacyShield();');
    expect(captureHeader).toContain('void ReleasePrivacyShield();');
  });
});

describe('privacy IPC literals agree across the language boundary', () => {
  it('keeps privacy frames out of the authenticated session union', () => {
    const signal = read('json_protocol.h');
    for (const literal of Object.values(WORKER_PRIVACY_FRAME)) {
      expect(signal).not.toContain(literal);
    }
  });
});

/**
 * The native side of the privacy barrier. None of this can be executed on a
 * non-Windows host, so the ordering properties that decide whether the owner's
 * password reaches a viewer are asserted at the source level.
 */
describe('windows remote-desktop privacy dispatcher', () => {
  const worker = read('worker_main.cc');
  const protocolHeader = read('json_protocol.h');
  const protocol = read('json_protocol.cc');
  const peerSession = read('peer_session.cc');
  const ipcHeader = read('privacy_ipc.h');
  const ipc = read('privacy_ipc.cc');

  it('keeps the concurrent ConsentDispatcher and adds privacy beside it', () => {
    expect(worker).toContain('class ConsentDispatcher');
    expect(worker).toContain('class PrivacyDispatcher');
    expect(worker).toContain('bool handled = consent.Handle(root) || privacy.Handle(root);');
    expect(worker).toContain('if (!handled && runtime.Handle(root))');
    expect(worker).toContain('privacy.Shutdown();');
  });

  it('frame literals match the Node adapter', () => {
    for (const literal of Object.values(WORKER_PRIVACY_FRAME)) {
      expect(ipcHeader, `${literal} exists natively`).toContain(`"${literal}"`);
    }
  });

  it('releases held input BEFORE engaging the shield, and reports the real result', () => {
    // A viewer whose key is still down would keep typing into a secret
    // surface it can no longer see. The order is enforced inside
    // EngagePrivacyShield, not left to its caller.
    const engage = worker.slice(worker.indexOf('PrivacyShieldResult EngagePrivacyShield('));
    const body = engage.slice(0, engage.indexOf('\n  }'));
    const releaseAt = body.indexOf('ReleaseAllSupportedInput()');
    const shieldAt = body.indexOf('source.source->EngagePrivacyShield()');
    expect(releaseAt).toBeGreaterThan(-1);
    expect(shieldAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeLessThan(shieldAt);
    // The flag must be the real return value, never a constant.
    expect(body).toContain('result.input_released = ReleaseAllSupportedInput();');
  });

  it('does not acknowledge when input could not be released', () => {
    const reconcile = worker.slice(worker.indexOf('void ReconcileLocked(bool force)'));
    const body = reconcile.slice(0, reconcile.indexOf('\n  }'));
    expect(body).toContain('!result.epoch_accepted || !result.input_released ||');
    expect(body).toContain('!result.route_generations_complete');
    // The ack must come after that guard.
    expect(body.indexOf('!result.input_released'))
      .toBeLessThan(body.indexOf('PrivacyShieldedEnvelope('));
  });

  it('uses a distinct privacy-only pre-PREPARE lifecycle and exact expected route snapshot', () => {
    expect(worker).toContain('key == L"--privacy-only"');
    expect(worker).toContain('bool privacy_only = false;');
    expect(worker).toContain('(consent_only && privacy_only)');
    expect(ipcHeader).toContain('std::vector<PrivacyRouteGeneration> expected_routes;');
    expect(ipc).toContain('RouteListField(root, "routes", &frame.expected_routes)');
    expect(worker).toContain('expected_routes_ = frame.expected_routes;');
    expect(worker).toContain('frame.revision > active_revision_');
    expect(worker).toContain('if (!SameRoutes(routes, expected_routes_)) return;');
    expect(ipc).toContain('root[key].size() == 0');
    expect(ipc).toContain('(!is_shield && members.size() != 3)');
    expect(worker).toContain('runtime.Maintenance();\n        privacy.Reconcile();');

    const requirements = [
      'key == L"--privacy-only"',
      'expected_routes_ = frame.expected_routes;',
      'frame.revision > active_revision_',
      'if (!SameRoutes(routes, expected_routes_)) return;',
      'root[key].size() == 0',
      'if (privacy_active_.load()) source->EngagePrivacyShield();',
      'runtime.Maintenance();\n        privacy.Reconcile();',
    ] as const;
    const sources = [worker, worker, worker, worker, ipc, worker, worker];
    const satisfies = (values: readonly string[]) => requirements.every(
      (needle, index) => values[index]!.includes(needle),
    );
    expect(satisfies(sources)).toBe(true);
    for (let index = 0; index < requirements.length; index += 1) {
      const mutated = [...sources];
      mutated[index] = mutated[index]!.replace(requirements[index]!, '');
      expect(satisfies(mutated),
        `pre-PREPARE privacy guard ${requirements[index]} is non-vacuous`).toBe(false);
    }
  });

  it('uses an independent route generation and never daemon generation for privacy ACK', () => {
    expect(protocolHeader).toContain('std::optional<int64_t> route_generation;');
    expect(protocol).toContain('root.isMember("routeGeneration")');
    expect(protocol).toContain('{"routeGeneration", "reconnectAttempt"}');
    expect(protocol).toContain('{"routeGeneration"})');
    expect(peerSession).toContain('renewal.route_generation != authority_.route_generation');
    expect(worker).toContain('route.route_generation = *session->authority().route_generation;');
    expect(worker).not.toContain('route.route_generation = session->authority().daemon_generation;');
  });

  it('blocks remote clipboard reads for the entire privacy epoch', () => {
    const sequenceGate = '!privacy_active_.load() &&\n                           ClipboardAllowedOnDesktop(indicator_->BoundDesktop())\n                       ? indicator_->ClipboardSequence()';
    const readGate = '!privacy_active_.load() &&\n                           ClipboardAllowedOnDesktop(indicator_->BoundDesktop())\n                       ? indicator_->ReadClipboardText(previous_sequence)';
    expect(worker).toContain(sequenceGate);
    expect(worker).toContain(readGate);

    const satisfies = (source: string) => source.includes(sequenceGate)
      && source.includes(readGate);
    expect(satisfies(worker)).toBe(true);
    expect(satisfies(worker.replace(sequenceGate, 'indicator_->ClipboardSequence()'))).toBe(false);
    expect(satisfies(worker.replace(readGate, 'indicator_->ReadClipboardText(previous_sequence)'))).toBe(false);
  });

  it('keeps legacy authenticated access parseable but excludes it from privacy ACK', () => {
    expect(protocolHeader).toContain('Missing remains parseable for legacy v2');
    expect(worker).toContain('if (!session->authority().route_generation)');
    expect(worker).toContain('result.route_generations_complete = false;');
    expect(worker).toContain('!result.epoch_accepted || !result.input_released ||');
    expect(worker).toContain('!result.route_generations_complete');

    const requirements = [
      'std::optional<int64_t> route_generation;',
      'renewal.route_generation != authority_.route_generation',
      'result.route_generations_complete = false;',
      '!result.epoch_accepted || !result.input_released ||',
    ] as const;
    const originals = [protocolHeader, peerSession, worker, worker];
    const satisfies = (values: readonly string[]) => requirements.every((needle, index) => (
      values[index]!.includes(needle)
    ));
    expect(satisfies(originals)).toBe(true);
    for (let index = 0; index < requirements.length; index += 1) {
      const mutated = [...originals];
      mutated[index] = mutated[index]!.replace(requirements[index]!, '');
      expect(satisfies(mutated), `route-generation guard ${index} is non-vacuous`).toBe(false);
    }
  });

  it('collects the route set after the switch, not before', () => {
    const engage = worker.slice(worker.indexOf('PrivacyShieldResult EngagePrivacyShield('));
    const body = engage.slice(0, engage.indexOf('\n  }'));
    expect(body.indexOf('source.source->EngagePrivacyShield()'))
      .toBeLessThan(body.indexOf('result.routes.push_back'));
  });

  it('proves a strictly newer frame generation before reporting release', () => {
    // A cached pre-release frame must not satisfy it; the counter only
    // advances when BroadcastFrame actually runs again.
    const release = worker.slice(worker.indexOf('bool Release(const PrivacyFrame& frame)'));
    const body = release.slice(0, release.indexOf('\n  }'));
    expect(body).toContain('if (fresh > deadline_generation) break;');
    expect(body.indexOf('runtime_->ReleasePrivacyShield(frame.epoch_id, active_revision_)'))
      .toBeLessThan(body.indexOf('PrivacyReleasedEnvelope('));
    expect(body).toContain('runtime_->CompletePrivacyRelease(frame.epoch_id, active_revision_)');
  });

  it('re-engages and stays silent when freshness cannot be proven', () => {
    const release = worker.slice(worker.indexOf('bool Release(const PrivacyFrame& frame)'));
    const body = release.slice(0, release.indexOf('\n  }'));
    expect(body).toContain('kFreshFrameTimeoutMs');
    expect(body).toContain('runtime_->EngagePrivacyShield(frame.epoch_id, active_revision_);');
    expect(ipcHeader).toContain('kFreshFrameTimeoutMs');
  });

  it('ignores an unknown, stale or wrong epoch without touching the shield', () => {
    const release = worker.slice(worker.indexOf('bool Release(const PrivacyFrame& frame)'));
    const body = release.slice(0, release.indexOf('\n  }'));
    expect(body).toContain('if (!active_ || active_epoch_ != frame.epoch_id) return true;');
    expect(body).toContain('frame.revision != active_revision_');
  });

  it('keeps the shield up when the pipe dies', () => {
    // Shutdown forgets the epoch but never calls ReleasePrivacyShield.
    const shutdown = worker.slice(worker.indexOf('  void Shutdown() {\n    std::lock_guard<std::mutex> lock(mutex_);\n    active_ = false;'));
    expect(shutdown.slice(0, 200)).not.toContain('ReleasePrivacyShield');
  });

  it('keeps native privacy state across PREPARE and shields a new source before Start', () => {
    expect(worker).toContain('std::atomic<bool> privacy_active_{false};');
    expect(worker).toContain('std::string privacy_epoch_;');
    expect(worker).toContain('int64_t privacy_revision_ = 0;');
    const acquire = worker.slice(worker.indexOf('DxgiDesktopSource> AcquireSource('));
    const acquireBody = acquire.slice(0, acquire.indexOf('\n  }'));
    expect(acquireBody).toContain('if (privacy_active_.load()) source->EngagePrivacyShield();');
    expect(acquireBody.indexOf('source->EngagePrivacyShield()'))
      .toBeLessThan(acquireBody.indexOf('source->Start()'));
    expect(worker).toContain('if (privacy_active_.load() || !g_input_desktop_ready.load())');

    const requirements = [
      'std::atomic<bool> privacy_active_{false};',
      'if (privacy_active_.load()) source->EngagePrivacyShield();',
      'if (privacy_active_.load() || !g_input_desktop_ready.load())',
      'CompletePrivacyRelease(frame.epoch_id, active_revision_)',
    ] as const;
    expect(requirements.every((needle) => worker.includes(needle))).toBe(true);
    for (const needle of requirements) {
      const mutated = worker.replace(needle, '');
      expect(requirements.every((candidate) => mutated.includes(candidate)),
        `privacy lifecycle guard ${needle} is non-vacuous`).toBe(false);
    }
  });

  it('always emits the routes array so an absent set cannot read as empty', () => {
    expect(ipc).toContain('root["routes"] = list;');
  });

  it('rejects a malformed epoch id rather than normalising it', () => {
    expect(ipc).toContain('if (!IsSafeId(frame.epoch_id)) return std::nullopt;');
  });
});

/**
 * The privacy frame is the only thing remote viewers see while the owner types
 * a password. It must be recognisably IM.codes -- a viewer has to be able to
 * tell "deliberately shielded" from "the feed broke" -- while carrying nothing
 * that could leak the screen it is covering.
 */
describe('windows remote-desktop privacy frame branding', () => {
  const capture = read('display_capture.cc');
  // The whole privacy helper block: the field constants, the bitmap picker
  // and the compositor are one unit, and a guard that only saw the compositor
  // would miss where the pixels actually come from.
  const privacy = capture.slice(capture.indexOf('constexpr int kBrandFieldR'));
  const composite = privacy.slice(0, privacy.indexOf('\n}  // namespace'));
  const frame = capture.slice(capture.indexOf('DxgiDesktopSource::PrivacyFrame'));
  const frameBody = frame.slice(0, frame.indexOf('\n}\n'));

  it('draws the canonical compiled logo, not a second editable asset', () => {
    // Same generated product the indicator and consent prompt use.
    expect(capture).toContain('third_party/imcodes_remote_desktop/brand_logo_generated.h');
    expect(composite).toContain('brand::kLogoBitmaps');
    expect(frameBody).toContain('CompositeBrandMark(');
  });

  it('uses no captured, requester or external bytes', () => {
    // The mark must not become a channel for the thing the epoch hides.
    expect(composite).not.toMatch(/cursor_bits_|mapped\.pData|staging_|GetDC|ReadFile|HttpSend/);
    // Its only inputs are the generated array and the field constants.
    expect(composite).toContain('bitmap->premultiplied_bgra');
    expect(composite).toContain('kBrandFieldR');
  });

  it('fails closed on odd dimensions rather than writing a half chroma block', () => {
    expect(composite).toContain('if ((width % 2) != 0 || (height % 2) != 0) return false;');
  });

  it('never assumes stride equals width', () => {
    // A stride narrower than the region would write into the next row.
    expect(composite).toContain('buffer->StrideY()');
    expect(composite).toContain('if (stride_y < width');
  });

  it('bounds-checks the destination rectangle and the source index', () => {
    expect(composite).toMatch(/left \+ edge > width \|\| top \+ edge > height/);
    expect(composite).toContain('sx >= size || sy >= size) return false;');
  });

  it('keeps the opaque field when the mark cannot be drawn', () => {
    // The flat fill happens BEFORE compositing, and a failed composite is not
    // propagated: PrivacyFrame still returns the shielded buffer.
    expect(frameBody.indexOf('SetBlack')).toBeLessThan(frameBody.indexOf('CompositeBrandMark('));
    expect(frameBody).not.toMatch(/CompositeBrandMark\([^)]*\)[^;]*\?|if \(!CompositeBrandMark/);
    expect(frameBody).toContain('return privacy_buffer_;');
  });

  it('derives the flat field and the mark from one set of constants', () => {
    // Two hand-tuned YUV triples would drift; the field is computed from RGB.
    expect(frameBody).toContain('RgbToY(kBrandFieldR, kBrandFieldG, kBrandFieldB)');
    expect(frameBody).not.toMatch(/MutableDataY\(\),\s*26,/);
  });

  it('replicates by an integer factor instead of resampling', () => {
    // A resampler would make the shielded frame host-dependent and add a
    // filtering path that could misread the source buffer.
    expect(composite).toContain('const int edge = bitmap->size * scale;');
    expect(composite).toMatch(/\(x \+ dx\) \/ scale/);
  });
});
