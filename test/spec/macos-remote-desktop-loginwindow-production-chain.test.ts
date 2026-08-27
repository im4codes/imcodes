import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MACOS_REMOTE_DESKTOP_SESSION_TYPE } from '../../src/node/macos-remote-desktop-session-type.js';
import { MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT } from '../../src/node/macos-remote-desktop-launch-agent.js';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');
const COMMON = resolve(ROOT, 'native/remote-desktop-common');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS LoginWindow production chain', () => {
  const worker = read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm');
  const session = read('native/macos-remote-desktop/macos_remote_desktop_session.mm');
  const sessionHeader = read('native/macos-remote-desktop/macos_remote_desktop_session.h');
  const agent = read('native/macos-remote-desktop/macos_launch_agent_main.mm');

  it('carries the launch-agent environment keys the native parser reads', async () => {
    const client = read('native/macos-remote-desktop/macos_worker_ipc_client.h');
    // One name for one wire value. A second spelling on either side is a
    // worker that silently never learns its session type.
    expect(client).toContain(
      `"${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.sessionType}"`,
    );
    expect(client).toContain(
      `"${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.auditSessionId}"`,
    );
  });

  it('has the launch agent declare the session it was actually loaded into', async () => {
    // The plist cannot: one LimitLoadToSessionType array serves both, so the
    // installed artifact is identical for Aqua and LoginWindow.
    expect(agent).toContain('ObserveMacosSessionIdentity');
    expect(agent).toContain('ClassifyMacosSessionType');
    expect(agent).toContain('kEnvSessionType');
    expect(agent).toContain('kEnvAuditSessionId');
    // An unclassifiable session must not exec a worker that would have to guess.
    expect(agent).toMatch(/session_type\.empty\(\)[\s\S]{0,400}return false/u);
    expect(agent).toContain('macos_launch_agent_session_type_unclassified');

    // Declaring it is not enough; it has to gate the exec. An agent that
    // computed the session type and exec'd the worker anyway would leave the
    // worker with no session type at all, and the worker refuses that -- which
    // reads as "login window support is broken" rather than "the agent skipped
    // a step".
    const main = agent.slice(agent.indexOf('int main('));
    expect(main).toMatch(/if \(!DeclareSessionIdentity\(\)\)[\s\S]{0,240}return EX_/u);
    expect(main.indexOf('DeclareSessionIdentity')).toBeGreaterThanOrEqual(0);
    expect(main.indexOf('DeclareSessionIdentity'))
      .toBeLessThan(main.indexOf('ExecVerifiedSiblingWorker'));
  });

  it('re-derives the session identity in the worker instead of trusting the environment', async () => {
    // The declaration arrives through the environment, which whoever launched
    // the process could have written.
    expect(worker).toContain('MacosSessionIdentityMatches');
    expect(worker).toContain('ObserveMacosSessionIdentity');
    expect(worker).toContain('macos_remote_desktop_worker_session_identity_mismatch');
    // And the uid is the kernel's, never the environment's.
    const client = read('native/macos-remote-desktop/macos_worker_ipc_client.cc');
    expect(client).toMatch(/uid\s*=\s*static_cast<std::uint32_t>\(::getuid\(\)\)/u);
  });

  it('hands the composed session the backend it selected, not a probe stream', async () => {
    // The session's own capture adapter must own the selected backend. A
    // separate supervisor stream would deliver frames to no encoder, which is
    // not evidence that the session can capture.
    expect(worker).toContain('ComposeSessionCapture');
    expect(worker).toContain('configuration.capture_backend = std::move(capture_backend)');
    expect(worker).toContain(`configuration.session_type = session_binding.session_type`);
    expect(worker).toContain('CreateCgDisplayStreamBackend');
    expect(worker).toContain('CreateAppleScreenCaptureKitBackend');
    // No second live stream on the same display.
    expect(worker).not.toContain('StartLoginWindowCapture');
    expect(worker).not.toContain('login_window_stream');
  });

  it('refuses to compose a LoginWindow session that never chose a backend', async () => {
    // This is the anti-Aqua-fallback invariant. Without it, a worker that
    // forgot to select would silently construct the ordinary ScreenCaptureKit
    // backend, which below 14.4 cannot see the login window at all.
    expect(sessionHeader).toContain('std::unique_ptr<ScreenCaptureKitBackend> capture_backend');
    expect(session).toMatch(
      new RegExp(
        `session_type\\s*==\\s*kSessionTypeLoginWindow\\s*&&[\\s\\S]{0,120}capture_backend\\s*==\\s*nullptr[\\s\\S]{0,80}return nullptr`,
        'u',
      ),
    );
  });

  it('derives readiness from the authenticated profile rather than an Aqua probe', async () => {
    // At the login window NSPasteboard still answers, so the clipboard adapter
    // reports Ready even though there is no user whose clipboard it is.
    // Reported readiness is what PasteText/CopySelection consult.
    expect(session).toContain('CapabilityProfileFor(configuration.session_type)');
    expect(session).toMatch(
      /!profile_\.clipboard[\s\S]{0,120}constrained\.clipboard\s*=\s*ReadinessState::kUnavailable/u,
    );
    expect(session).toMatch(
      /!profile_\.capture[\s\S]{0,80}constrained\.capture\s*=\s*ReadinessState::kUnavailable/u,
    );
    // Pointer/keyboard stay: login-safe input through the existing CGEvent and
    // InputLedger path is the entire point of reaching a login window.
    expect(session).toMatch(
      /!profile_\.pointer\s*&&\s*!profile_\.keyboard[\s\S]{0,120}constrained\.input\s*=\s*ReadinessState::kUnavailable/u,
    );
  });

  it('refuses clipboard through the seam the session actually consults', async () => {
    // Returning false from the copy/paste callbacks is the enforcement, not a
    // hint: the clipboard adapter asks them for every operation.
    expect(worker).toMatch(
      /!session_profile\.clipboard[\s\S]{0,400}configuration\.request_copy[\s\S]{0,120}configuration\.request_paste/u,
    );
  });

  it('supervises both session types from one installed plist', async () => {
    const launchAgent = read('src/node/macos-remote-desktop-launch-agent.ts');
    expect(launchAgent).toContain('MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_SESSION_TYPES');
    const sessionType = read('src/node/macos-remote-desktop-session-type.ts');
    for (const value of Object.values(MACOS_REMOTE_DESKTOP_SESSION_TYPE)) {
      expect(sessionType, value).toContain(`'${value}'`);
    }
  });

  it('runs the production-chain counterfactual under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-chain-'));
    try {
      const output = resolve(directory, 'production-chain');
      const compile = await runNative('xcrun', [
        'clang++', '-std=c++20', '-fobjc-arc',
        '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror',
        '-I', NATIVE, '-I', COMMON,
        resolve(NATIVE, 'macos_login_window_capture.cc'),
        resolve(NATIVE, 'screen_capture_kit_limits.cc'),
        resolve(NATIVE, 'macos_worker_ipc_client.cc'),
        resolve(NATIVE, 'macos_session_identity.mm'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-loginwindow-production-chain-test.cc'),
        '-framework', 'CoreGraphics', '-framework', 'Foundation', '-lbsm',
        '-o', output,
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      const run = await runNative(output, [], {
        env: {
          ...process.env,
          ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1',
          UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
        },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('macos loginwindow production chain counterfactual ok');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
