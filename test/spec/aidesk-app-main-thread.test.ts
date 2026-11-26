/**
 * The macOS aiDesk app must never block its main thread on the node, the network, the disk, a subprocess or the person's answer: a
 * blocked main thread is what the Dock calls "Application Not Responding", and the window it should have opened never appears.
 *
 * Two real failures led here (the Dock showed the icon with "Application Not Responding" while the panel could not be opened):
 *  1. A Dock/Finder launch ran the permission prompts and a ten-minute wait for the answer ON the main thread, before the run loop
 *     started. The window was opened after that, i.e. never (the app gave up after ten minutes with no window at all).
 *  2. The launcher role -- the same bundle, started by the node to hold the remote-desktop helpers -- waited for its helper in wait4 ON
 *     the main thread for as long as the helper lived (hours), while registered with LaunchServices as an application. A Dock click,
 *     `open -b <id>` or the node's request for the panel was delivered to THAT process, which has no run loop, so no window could open.
 *
 * These checks read the sources (they are built only on macOS). A blocking primitive in the app sources is allowed only on a line (or
 * the line after a comment line) that says `blocking-ok:` and why; the full list of such places is pinned below, so adding one is a
 * decision that has to be made here, in the open.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AIDESK_UI_LOG } from '../../shared/aidesk-ui-log.js';
import { readSource } from '../helpers/read-source.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string): string => readSource(resolve(root, path));

/** The sources of the app process that has a main thread the person is waiting on. (aidesk_fs_delegate.cc is a separate headless one-shot process.) */
const APP_SOURCES = [
  'native/macos-remote-desktop/aidesk_agent_main.mm',
  'native/macos-remote-desktop/aidesk_panel_window.mm',
  'native/macos-remote-desktop/aidesk_ui_support.mm',
  'native/macos-remote-desktop/macos_permission_onboarding.mm',
] as const;

/** Each primitive that can wait for something outside the process (or for the person). */
const BLOCKING_PRIMITIVES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'dispatch_semaphore_wait', pattern: /dispatch_semaphore_wait\s*\(/u },
  { name: 'dispatch_sync', pattern: /\bdispatch_sync\s*\(/u },
  { name: 'dispatch_group_wait', pattern: /dispatch_group_wait\s*\(/u },
  { name: 'waitUntilExit', pattern: /waitUntilExit/u },
  { name: 'waitpid', pattern: /\bwaitpid\s*\(|\bwait4\s*\(/u },
  { name: 'NSAppleScript', pattern: /NSAppleScript|NSUserAppleScriptTask/u },
  { name: 'system/popen', pattern: /(?<![\w:.])(?:system|popen)\s*\(/u },
  { name: 'sleep', pattern: /(?<![\w.])(?:sleep|usleep|nanosleep)\s*\(/u },
  { name: 'synchronous URL load', pattern: /dataWithContentsOfURL|stringWithContentsOfURL|sendSynchronousRequest|initWithContentsOfURL/u },
  { name: 'run-loop spin', pattern: /runUntilDate|runMode:/u },
  { name: 'permission prompt/probe', pattern: /CGRequestScreenCaptureAccess|CGPreflightScreenCaptureAccess|AXIsProcessTrusted/u },
  { name: 'blocking socket/file call', pattern: /(?<![\w.:])(?:connect|accept|recv|recvfrom|fread)\s*\(/u },
];

function annotated(lines: readonly string[], index: number): boolean {
  return lines[index]!.includes('blocking-ok:') || (index > 0 && lines[index - 1]!.includes('blocking-ok:'));
}

function scan(path: string): { violations: string[]; allowed: string[] } {
  const violations: string[] = [];
  const allowed: string[] = [];
  const lines = read(path).split('\n');
  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/u, '').replace(/"(?:[^"\\]|\\.)*"/gu, '""');
    for (const primitive of BLOCKING_PRIMITIVES) {
      if (!primitive.pattern.test(code)) continue;
      if (annotated(lines, index)) allowed.push(primitive.name);
      else violations.push(`${path}:${index + 1} ${primitive.name}: ${line.trim()}`);
    }
  });
  return { violations, allowed };
}

describe('aiDesk macOS app: nothing blocks the main thread', () => {
  it('no blocking primitive in the app sources without an explicit, reasoned exception', () => {
    const violations = APP_SOURCES.flatMap((path) => scan(path).violations);
    expect(violations, `A blocking call in the app sources. Move it to a queue/thread of its own, or mark it \`blocking-ok: <why it cannot stall the main thread>\`:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the worker build (which compiles macos_permission_onboarding.mm) never needs the app-only support file', () => {
    const onboarding = read('native/macos-remote-desktop/macos_permission_onboarding.mm');
    expect(onboarding).not.toMatch(/aidesk_ui_support|\bUiPhase\b|\bUiLogEvent\b|InstallLauncherReopenHandler/u);
    const excluded = /EXCLUDED_SOURCES=\(([^)]*)\)/u.exec(read('native/macos-remote-desktop/build-worker-from-sdk.sh'))?.[1] ?? '';
    for (const file of ['aidesk_ui_support.mm', 'aidesk_ui_support_test_main.mm']) expect(excluded).toContain(file);
  });

  it('the exceptions are exactly these (each is on its own queue/thread, in a headless one-shot, or bounded before any window exists)', () => {
    const summary = Object.fromEntries(APP_SOURCES.map((path) => {
      const counts: Record<string, number> = {};
      for (const name of scan(path).allowed) counts[name] = (counts[name] ?? 0) + 1;
      return [path.split('/').pop(), counts];
    }));
    expect(summary).toEqual({
      'aidesk_agent_main.mm': { dispatch_semaphore_wait: 1 },
      'aidesk_panel_window.mm': {},
      'aidesk_ui_support.mm': { dispatch_sync: 1, waitpid: 1, 'run-loop spin': 1 },
      'macos_permission_onboarding.mm': { waitpid: 1, 'permission prompt/probe': 6, 'run-loop spin': 1, sleep: 1 },
    });
  });

  it('a Dock/Finder launch opens the window first and asks for the permissions on a queue of its own (the main thread never waits for the person)', () => {
    const main = read('native/macos-remote-desktop/aidesk_agent_main.mm');
    expect(main).not.toContain('RequestRegistration');
    const dockBranch = main.slice(main.indexOf('// A Dock / Finder launch'));
    const open = dockBranch.indexOf('OpenLocalManagementPanel();');
    const register = dockBranch.indexOf('macos::StartPermissionRegistrationInBackground();');
    const run = dockBranch.indexOf('[NSApp run];');
    expect(open).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(open);
    expect(run).toBeGreaterThan(register);
    const onboarding = read('native/macos-remote-desktop/macos_permission_onboarding.mm');
    const background = onboarding.slice(onboarding.indexOf('void StartPermissionRegistrationInBackground()'));
    expect(background.slice(0, 400)).toContain('dispatch_queue_create');
    expect(background.slice(0, 900)).toContain('dispatch_async(queue');
  });

  it('the launcher role waits for its helper on a thread of its own and keeps an answering event loop (and handles a reopen request by starting the UI)', () => {
    const onboarding = read('native/macos-remote-desktop/macos_permission_onboarding.mm');
    const exec = onboarding.slice(onboarding.indexOf('bool ExecAiDeskProductHelper('), onboarding.indexOf('void StartPermissionRegistrationInBackground()'));
    const waiter = exec.indexOf('dispatch_async(waiter');
    expect(waiter).toBeGreaterThan(-1);
    // every waitpid is inside the waiter block, which comes before the main thread's run loop
    for (const match of exec.matchAll(/waitpid\s*\(/gu)) expect(match.index!).toBeGreaterThan(waiter);
    expect(exec.indexOf('[NSApp run]')).toBeGreaterThan(waiter);
    expect(exec).toContain('g_launcher_run_loop_setup();');
    expect(read('native/macos-remote-desktop/aidesk_agent_main.mm')).toContain('macos::SetAppHooks(&macos::UiLogEvent, &macos::InstallLauncherReopenHandler);');
    const support = read('native/macos-remote-desktop/aidesk_ui_support.mm');
    expect(support).toContain('applicationShouldHandleReopen');
    expect(support).toContain('--aidesk-background');
    expect(support).toContain('--aidesk-open-panel');
  });

  it('the user-facing role takes the UI lock before it registers as an application, and hands a second request to the first instance', () => {
    const main = read('native/macos-remote-desktop/aidesk_agent_main.mm');
    expect(main.indexOf('macos::ClaimUiRole()')).toBeGreaterThan(-1);
    expect(main.indexOf('macos::ClaimUiRole()')).toBeLessThan(main.indexOf('macos::PrepareMacosPermissionResponsibleApplication();'));
    expect(main).toContain('macos::ObserveUiRequests(');
    expect(main).toContain('macos::UiDiagnosticsStart(');
  });

  it('the panel window is shown before the web view exists, the placeholder says what is going on, and a missing node is retried with a growing pause', () => {
    const panel = read('native/macos-remote-desktop/aidesk_panel_window.mm');
    const createWindow = panel.slice(panel.indexOf('- (void)createWindow {'), panel.indexOf('- (void)attachWebView {'));
    expect(createWindow).not.toContain('WKWebView');
    expect(createWindow).toContain('NSVisualEffectView');
    expect(createWindow).toMatch(/performSelector:@selector\(attachWebView\) withObject:nil afterDelay:/u);
    const attach = panel.slice(panel.indexOf('- (void)attachWebView {'), panel.indexOf('- (void)load {'));
    expect(attach).toContain('WKWebView alloc');
    expect(attach).toContain('webView.hidden = YES');
    expect(panel).toContain('didFinishNavigation');
    // a placeholder words in all seven languages, "starting" and "not answering yet"
    for (const key of ['starting', 'waiting']) {
      for (const code of ['en', 'zh-Hans', 'zh-Hant', 'es', 'ru', 'ja', 'ko']) expect(panel).toMatch(new RegExp(`@"${key}": @\\{[^\\n]*@"${code}":`, 'u'));
    }
    expect(panel).toMatch(/MIN\(15\.0, 2\.0 \* \(double\)\(1u << MIN\(self\.failureCount, 3u\)\)\)/u);
  });

  it('the status poll gives up on a node that accepts and never answers', () => {
    expect(read('native/macos-remote-desktop/aidesk_agent_main.mm')).toMatch(/timeoutIntervalForRequest = \d+;/u);
  });

  it('the diagnostics log: the native side and the shared module agree on file and limits, and the support file is compiled into the app', () => {
    const header = read('native/macos-remote-desktop/aidesk_ui_support.h');
    expect(header).toContain(`kAiDeskUiLogDirectory[] = "${AIDESK_UI_LOG.DIRECTORY}"`);
    expect(header).toContain(`kAiDeskUiLogFile[] = "${AIDESK_UI_LOG.FILE}"`);
    expect(header).toContain(`kUiLogMaxBytes = ${AIDESK_UI_LOG.MAX_BYTES / 1024} * 1024`);
    expect(header).toContain(`kUiLogMaxLinesPerRun = ${AIDESK_UI_LOG.MAX_LINES_PER_RUN}`);
    expect(header).toContain(`kAiDeskUiLogArgument[] = "${AIDESK_UI_LOG.APP_ARGUMENT}"`);
    const build = JSON.parse(read('native/macos-remote-desktop/aidesk-agent-build.json')) as { sources: string[] };
    expect(build.sources).toContain('aidesk_ui_support.mm');
    expect(build.sources).not.toContain('aidesk_ui_support_test_main.mm');
  });

  it('the node starts the menu-bar role with -n: LaunchServices would otherwise only activate the launcher role of the same bundle', () => {
    expect(read('src/node/aidesk-desktop-entry.ts')).toMatch(/args: \['-g', '-n', MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH,/u);
    expect(read('src/node/macos-aidesk-app-refresh.ts')).toMatch(/args: \['-g', '-n', path, '--args', '--aidesk-background'\]/u);
  });
});
