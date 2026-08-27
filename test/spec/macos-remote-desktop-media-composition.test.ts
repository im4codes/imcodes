import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS remote-desktop production media composition', () => {
  const worker = read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm');
  const backend = read('native/macos-remote-desktop/pinned_libwebrtc_transport_backend.cc');
  const binder = read('native/macos-remote-desktop/macos_media_sender_binder.cc');
  const session = read('native/macos-remote-desktop/macos_remote_desktop_session.mm');
  const build = read('native/macos-remote-desktop/BUILD.gn');
  const directory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'imcodes-macos-rd-media-'))
    : null;

  afterAll(async () => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });

  it('supplies a real sender backend so composition cannot return nullptr', async () => {
    // CreateWithPinnedLibwebrtcSender refuses without it; the worker used to
    // omit it, so every ordinary launch failed composition.
    expect(session).toContain('!configuration.pinned_libwebrtc_sender_backend');
    expect(worker).toContain('configuration.pinned_libwebrtc_sender_backend = std::move(media_binder)');
    expect(worker).toContain('std::make_unique<macos::MacosMediaSenderBinder>()');
    // The transport must be told about the binder, or the encoder callback has
    // nowhere to go.
    expect(worker).toContain('backend_view->BindMediaSender(media_binder.get())');
  });

  it('feeds the H264 bridge from the real upstream EncodedImageCallback', async () => {
    // The callback may only come from VideoEncoder::RegisterEncodeCompleteCallback;
    // anything else would be a fabricated sender.
    expect(backend).toContain('RegisterEncodeCompleteCallback');
    expect(backend).toContain('CreatePinnedLibwebrtcH264Sender(callback)');
    expect(backend).toContain('binder_->Bind(std::move(sender))');
    // Detaching or releasing the encoder must unbind, so a later Submit cannot
    // reach a dead callback -- but only its OWN binding. libwebrtc may build the
    // replacement encoder before destroying the one it replaces, so an
    // unconditional `Unbind()` let a dead encoder detach the live sender that
    // had already taken its place. The binder then looked merely "not yet
    // bound", which is a normal state during negotiation, so every later frame
    // was dropped with no error recorded anywhere.
    expect(backend).toContain('binder_->Unbind(binding_)');
    // And no unconditional form survives anywhere in the encoder.
    expect(backend).not.toContain('binder_->Unbind()');
  });

  it('installs exactly one upstream media path and one advertised format', async () => {
    expect(backend).toContain('factory_dependencies.video_encoder_factory');
    expect(backend).toContain('PassthroughH264EncoderFactory');
    expect(backend).toContain('peer_->AddTrack(video_track_');
    // One SdpVideoFormat only: advertising more would let SDP negotiate a codec
    // this project cannot produce.
    const formats = [...backend.matchAll(/webrtc::SdpVideoFormat\s+\w+\("([A-Za-z0-9]+)"\)/g)];
    expect(formats).toHaveLength(1);
    expect(formats[0][1]).toBe('H264');
    // Upstream owns packetization/RTCP/PLI/pacing; nothing here reimplements them.
    expect(backend).not.toMatch(/RtpPacketizer|RtcpTransceiver|PacingController|CongestionControl|SrtpSession/);
  });

  it('opens no peer when there is no media sender to bind', async () => {
    // A peer without a media path is not a view-only degrade, it is a failure.
    expect(backend).toContain('if (media_binder_ == nullptr)');
  });

  it('keeps the binder free of libwebrtc so its fail-closed rules stay testable', async () => {
    expect(binder).not.toMatch(/#include\s*"(api|pc|rtc_base|media|p2p)\//);
    expect(binder).not.toMatch(/webrtc::/);
  });

  it('declares the binder as a build target the worker depends on', async () => {
    expect(build).toContain('source_set("macos_media_sender_binder")');
    const body = build.slice(build.indexOf('rtc_executable("imcodes_remote_desktop_worker")'));
    const start = body.indexOf('deps = [');
    expect(body.slice(start, body.indexOf(']', start))).toContain(':macos_media_sender_binder');
  });

  it('derives encoder and clipboard readiness from real probes, not compilation', async () => {
    // A build's presence is not encoder readiness: a VideoToolbox session can
    // fail to open on a machine whose binary contains the encoder.
    expect(worker).toContain('macos::VideoToolboxH264Encoder encoder;');
    expect(worker).toContain('encoder.ProbeReadiness() == rd::common::ReadinessState::kReady');
    expect(worker).toContain('macos::NSPasteboardClipboardAdapter clipboard(');
    expect(worker).toContain('clipboard.ProbeReadiness() == rd::common::ReadinessState::kReady');
    expect(worker).not.toMatch(/out->encoder\s*=\s*true/);
    expect(worker).not.toMatch(/out->clipboard\s*=\s*true/);
    // Cleanup claims are tied to the executable seam actually being derivable.
    expect(worker).toContain('macos::BuildControlSocketPath(');
    expect(worker).not.toMatch(/out->release_input\s*=\s*true/);
    expect(worker).not.toMatch(/out->stop_capture\s*=\s*true/);
  });

  it('releases all controllers on cleanup instead of an empty-id no-op', async () => {
    // InputLedger looks the id up in its controller map; "" misses and returns
    // kApplied, so the command would report a generation-stamped success while
    // real controllers still hold keys and buttons down.
    expect(worker).toContain('session->ReleaseAllControllers()');
    expect(worker).not.toContain('session->ReleaseController(std::string_view{})');
    // SetControlActive(false) is the public SessionCore seam that reaches
    // ReleaseAllControllers() and therefore InputLedger::ReleaseAll().
    expect(session).toContain('core_.SetControlActive(false)');
    // Capture and viewing are deliberately preserved by release-all.
    const releaseAt = worker.indexOf('session->ReleaseAllControllers()');
    const stopAt = worker.indexOf('session->Stop();', releaseAt);
    expect(releaseAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(releaseAt);
  });

  it('runs the media and cleanup counterfactuals under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const executable = resolve(directory!, 'media-composition-test');
    const compile = await runNative('xcrun', [
      'clang++',
      '-std=c++20',
      '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer',
      '-pthread',
      '-mmacosx-version-min=12.3',
      '-I', NATIVE,
      '-I', resolve(ROOT, 'native/remote-desktop-common'),
      resolve(ROOT, 'test/spec/macos-remote-desktop-media-composition-test.cc'),
      resolve(NATIVE, 'macos_media_sender_binder.cc'),
      resolve(NATIVE, 'h264_sender_bridge.cc'),
      resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
      resolve(ROOT, 'native/remote-desktop-common/input_ledger.cc'),
      '-o', executable,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

    const run = await runNative(executable, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  }, 120_000);

  it('compiles the binder for both release architectures', async () => {
    if (process.platform !== 'darwin') return;
    for (const architecture of ['arm64', 'x86_64'] as const) {
      const compile = await runNative('xcrun', [
        'clang++',
        '-std=c++20',
        '-Wall', '-Wextra', '-Werror',
        '-pthread',
        '-mmacosx-version-min=12.3',
        '-arch', architecture,
        '-I', NATIVE,
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        '-c', resolve(NATIVE, 'macos_media_sender_binder.cc'),
        '-o', resolve(directory!, `binder-${architecture}.o`),
      ], { cwd: directory! });
      expect(compile.status, `${architecture}: ${compile.stderr}`).toBe(0);
    }
  }, 120_000);
});
