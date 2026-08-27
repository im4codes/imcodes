import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS remote-desktop transport session adapter', () => {
  const header = read('native/macos-remote-desktop/macos_transport_session_adapter.h');
  const adapter = read('native/macos-remote-desktop/macos_transport_session_adapter.cc');
  const backend = read('native/macos-remote-desktop/pinned_libwebrtc_transport_backend.cc');
  const dataConstants = read('native/remote-desktop-common/data_channel_constants.h');
  const build = read('native/macos-remote-desktop/BUILD.gn');
  const directory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'imcodes-macos-rd-transport-'))
    : null;

  afterAll(async () => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });

  it('declares exactly the three required data channels with distinct labels', async () => {
    expect(header).toContain('kRequiredDataChannels');
    expect(header).toContain('common::DataChannelKind::kControl');
    expect(header).toContain('common::DataChannelKind::kKeyboard');
    expect(header).toContain('common::DataChannelKind::kPointer');
    const labels = [...dataConstants.matchAll(/"(imcodes-rd-[a-z]+)"/g)].map((m) => m[1]);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(3);
  });

  it('keeps the adapter half free of libwebrtc so it stays checkout-independent', async () => {
    // The whole point of the split is that fail-closed logic can be compiled
    // and tested without a pinned checkout. A libwebrtc include here would
    // silently make that impossible again.
    expect(header).not.toMatch(/#include\s*"(api|pc|rtc_base|media|p2p)\//);
    expect(adapter).not.toMatch(/#include\s*"(api|pc|rtc_base|media|p2p)\//);
    expect(adapter).not.toMatch(/webrtc::/);
  });

  it('routes the real peer through pinned upstream libwebrtc only', async () => {
    expect(backend).toContain('#include "api/peer_connection_interface.h"');
    expect(backend).toContain('#include "api/data_channel_interface.h"');
    expect(backend).toContain('CreateModularPeerConnectionFactory');
    expect(backend).toContain('CreatePeerConnectionOrError');
    expect(backend).toContain('void OnDataChannel(');
    expect(backend).not.toContain('CreateDataChannelOrError');
    expect(backend).toContain('ReportDataChannelMessage');
    expect(build).toContain('source_set("pinned_libwebrtc_transport_backend")');
    // These are the exact public targets in the locked WebRTC revision. The
    // former libjingle_* labels do not exist there; a real GN generation
    // caught that stale assumption before this contract was corrected.
    expect(build).toContain('"//api:create_modular_peer_connection_factory"');
    expect(build).toContain('"//api:data_channel_interface"');
    expect(build).toContain('"//api:jsep"');
    expect(build).toContain('"//api:peer_connection_interface"');
    expect(build).not.toContain('"//pc:libjingle_peerconnection"');
    expect(build).not.toContain('"//api:libjingle_peerconnection_api"');
  });

  it('adds no second media stack, custom RTP, ICE or socket implementation', async () => {
    const production = `${adapter}\n${backend}`;
    expect(production).not.toMatch(
      /RtpPacketizer|RtcpTransceiver|PacingController|CongestionControl|BasicPortAllocator|TurnServer|UdpSocket|TcpSocket|SrtpSession/,
    );
    expect(production).not.toMatch(
      /#include\s*[<"][^>"]*(libdatachannel|pion|mediasoup|aiortc|openssl\/srtp)[^>"]*[>"]/i,
    );
    // Exactly one translation unit may reach upstream WebRTC headers.
    expect(adapter).not.toContain('peer_connection_interface.h');
  });

  it('tears the peer down before reporting a terminal reason', async () => {
    const terminal = adapter.slice(adapter.indexOf('void MacosTransportSessionAdapter::OnTerminal'));
    const closeAt = terminal.indexOf('CloseTransport();');
    const notifyAt = terminal.indexOf('sink_.OnTerminal(reason);');
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(notifyAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeLessThan(notifyAt);
  });

  it('runs the fail-closed counterfactual under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const executable = resolve(directory!, 'transport-test');
    const compile = await runNative('xcrun', [
      'clang++',
      '-std=c++20',
      '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer',
      '-pthread',
      '-mmacosx-version-min=12.3',
      '-I', resolve(ROOT, 'native/macos-remote-desktop'),
      '-I', resolve(ROOT, 'native/remote-desktop-common'),
      resolve(ROOT, 'test/spec/macos-remote-desktop-transport-test.cc'),
      resolve(ROOT, 'native/macos-remote-desktop/macos_transport_session_adapter.cc'),
      resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
      resolve(ROOT, 'native/remote-desktop-common/transport_session_core.cc'),
      '-o', executable,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

    const run = await runNative(executable, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  }, 120_000);

  it('compiles the checkout-independent adapter for both release architectures', async () => {
    if (process.platform !== 'darwin') return;
    for (const architecture of ['arm64', 'x86_64'] as const) {
      const compile = await runNative('xcrun', [
        'clang++',
        '-std=c++20',
        '-Wall', '-Wextra', '-Werror',
        '-pthread',
        '-mmacosx-version-min=12.3',
        '-arch', architecture,
        '-I', resolve(ROOT, 'native/macos-remote-desktop'),
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        '-c', resolve(ROOT, 'native/macos-remote-desktop/macos_transport_session_adapter.cc'),
        '-o', resolve(directory!, `adapter-${architecture}.o`),
      ], { cwd: directory! });
      expect(compile.status, `${architecture}: ${compile.stdout}\n${compile.stderr}`).toBe(0);
    }
  }, 120_000);
});
