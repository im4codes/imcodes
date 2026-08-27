import { runNative } from './support/native-exec.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');
const COMMON = resolve(ROOT, 'native/remote-desktop-common');

function read(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8');
}

/**
 * Runs a long compile WITHOUT blocking the worker thread.
 *
 * `spawnSync` holds the event loop for the whole compile, so vitest's worker
 * cannot answer its own `onTaskUpdate` RPC and the run fails with an internal
 * timeout even though every test passed. Awaiting the child instead keeps the
 * worker responsive.
 */
async function runTool(
  command: string, args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveRun) => {
    const child = spawn(command, [...args], { encoding: 'utf8' } as never);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', (error) => resolveRun({ status: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolveRun({ status: code, stdout, stderr }));
  });
}

describe('macOS SessionCore composition', () => {
  it('owns a concrete adapter composition without inventing transport', async () => {
    const header = read(
      'native/macos-remote-desktop/macos_remote_desktop_session.h',
    );
    const source = read(
      'native/macos-remote-desktop/macos_remote_desktop_session.mm',
    );
    for (const seam of [
      'common::SessionCore core_',
      'common::TransportSessionCore transport_core_',
      'ScreenCaptureKitAdapter capture_',
      'VideoToolboxH264Encoder encoder_',
      'CGEventInputAdapter input_',
      'NSPasteboardClipboardAdapter clipboard_',
      'MacosLocalDisclosureAdapter local_disclosure_',
      'common::DisclosureAdapter& disclosure_',
      'MacosSessionMonitor monitor_',
      'MacosPermissionReadiness permissions_',
      'H264SenderBridge bridge_',
    ]) {
      expect(source).toContain(seam);
    }
    expect(header).toContain('CreateWithPinnedLibwebrtcSender');
    expect(header).toContain('CreatePinnedLibwebrtcH264Sender()');
    expect(header).toContain('common::TransportSessionAdapter* transport');
    expect(header).toContain('common::DisclosureAdapter* disclosure');
    expect(header).toContain('MacosDisclosureBeginGeneration begin_disclosure');
    expect(header).toContain('RenewRouteAuthority');
    expect(header).toContain('RecordRouteActivity');
    expect(header).toContain('TickTransport');
    expect(`${header}\n${source}`).not.toMatch(
      /CreatePeerConnection|RTCPeerConnection|RtpPacket|UdpSocket|TurnClient/,
    );

    const build = read('native/macos-remote-desktop/BUILD.gn');
    const targetStart = build.indexOf('source_set("macos_remote_desktop_session")');
    expect(targetStart).toBeGreaterThanOrEqual(0);
    const target = build.slice(targetStart);
    for (const dependency of [
      ':cg_event_input_adapter',
      ':macos_local_disclosure',
      ':macos_permission_readiness',
      ':macos_session_monitor',
      ':ns_pasteboard_clipboard_adapter',
      ':pinned_libwebrtc_h264_sender_bridge',
      ':screen_capture_kit_adapter',
      ':video_toolbox_h264_encoder',
      ':macos_login_window_capture',
      '../remote-desktop-common:remote_desktop_common',
    ]) {
      expect(target).toContain(`"${dependency}"`);
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'compiles and runs the fake-seam lifecycle matrix on the native Mac',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-session-'));
      const executable = join(directory, 'macos-session-test');
      try {
        const sources = [
          'test/spec/macos-remote-desktop-session-test.mm',
          'native/macos-remote-desktop/macos_remote_desktop_session.mm',
          'native/macos-remote-desktop/screen_capture_kit_adapter.mm',
          'native/macos-remote-desktop/screen_capture_kit_limits.cc',
          'native/macos-remote-desktop/macos_virtual_display_adapter.cc',
          'native/macos-remote-desktop/apple_virtual_display_backend.mm',
          'native/macos-remote-desktop/video_toolbox_h264_encoder.mm',
          'native/macos-remote-desktop/h264_sender_bridge.cc',
          'native/macos-remote-desktop/cg_event_input_adapter.mm',
          'native/macos-remote-desktop/ns_pasteboard_clipboard_adapter.mm',
          'native/macos-remote-desktop/macos_local_disclosure.mm',
          'native/macos-remote-desktop/macos_session_monitor.mm',
          'native/macos-remote-desktop/macos_permission_readiness.mm',
          // The session derives its capability profile from the authenticated
          // session type rather than from an Aqua probe.
          'native/macos-remote-desktop/macos_login_window_capture.cc',
          'native/remote-desktop-common/session_core.cc',
          'native/remote-desktop-common/transport_session_core.cc',
          'native/remote-desktop-common/input_ledger.cc',
          'native/remote-desktop-common/value_types.cc',
        ].map((path) => resolve(ROOT, path));
        const compile = await runTool('xcrun', [
          'clang++',
          '-std=c++20',
          '-fobjc-arc',
          '-fblocks',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Werror=unguarded-availability-new',
          '-fsanitize=address,undefined',
          '-fno-omit-frame-pointer',
          '-mmacosx-version-min=12.3',
          '-I', NATIVE,
          '-I', COMMON,
          ...sources,
          '-framework', 'AppKit',
          '-framework', 'ApplicationServices',
          '-framework', 'CoreGraphics',
          '-framework', 'CoreMedia',
          '-framework', 'CoreVideo',
          '-framework', 'Foundation',
          '-framework', 'ScreenCaptureKit',
          '-framework', 'VideoToolbox',
          '-o', executable,
        ], { cwd: ROOT });
        expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

        const run = await runNative(executable, [], {
          cwd: ROOT,
        });
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toBe('');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    // ~19s alone. The session's compile closure grew with the login-window
    // capture supervisor, and under full-suite parallelism several native
    // compiles contend for the same cores, so 30s was overrun by scheduling
    // rather than by the work itself.
    120_000,
  );
});
