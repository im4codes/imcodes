import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPcAppGlobalVoice,
  GLOBAL_VOICE_LEVEL_MIN_INTERVAL_MS,
  PcAppGlobalVoiceStore,
  resolveGlobalVoiceOverlayIconPath,
} from '../src/global-voice.js';
import { tPcApp } from '../src/i18n.js';
import type { PcAppVoiceEvent } from '../src/voice-ipc.js';

interface FakeHelperProcess {
  proc: ChildProcess;
  stdout: PassThrough;
  stdinLines: string[];
  killCalls: Array<NodeJS.Signals | number | undefined>;
  emitExit: (code?: number | null) => void;
}

function createFakeHelper(): FakeHelperProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinLines: string[] = [];
  let stdinBuffer = '';
  const stdin = {
    write: vi.fn((chunk: string | Buffer) => {
      stdinBuffer += String(chunk);
      let idx = stdinBuffer.indexOf('\n');
      while (idx !== -1) {
        const line = stdinBuffer.slice(0, idx).trim();
        stdinBuffer = stdinBuffer.slice(idx + 1);
        idx = stdinBuffer.indexOf('\n');
        if (line) stdinLines.push(line);
      }
      return true;
    }),
    end: vi.fn(() => {
      if (stdinBuffer.trim()) {
        stdinLines.push(stdinBuffer.trim());
        stdinBuffer = '';
      }
    }),
  };
  const killCalls: Array<NodeJS.Signals | number | undefined> = [];
  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      killCalls.push(signal);
      (proc as { killed: boolean }).killed = true;
      return true;
    }),
  }) as unknown as ChildProcess;

  return {
    proc,
    stdout,
    stdinLines,
    killCalls,
    emitExit: (code = 0) => {
      emitter.emit('exit', code, null);
    },
  };
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveGlobalVoiceOverlayIconPath', () => {
  it('prefers resourcesPath/icon.icns and falls back to resourcesPath/build/icon.png then dev build/icon.png', () => {
    const resourcesDir = makeTempDir('imcodes-gv-res-');
    const devModuleDir = makeTempDir('imcodes-gv-dev-');
    const devBuildDir = join(devModuleDir, 'build');
    mkdirSync(join(resourcesDir, 'build'), { recursive: true });
    mkdirSync(devBuildDir, { recursive: true });

    const devIcon = join(devBuildDir, 'icon.png');
    writeFileSync(devIcon, 'dev-png');
    expect(
      resolveGlobalVoiceOverlayIconPath({
        resourcesPath: resourcesDir,
        moduleDir: join(devModuleDir, 'dist'),
      }),
    ).toBe(devIcon);

    const resPng = join(resourcesDir, 'build', 'icon.png');
    writeFileSync(resPng, 'res-png');
    expect(
      resolveGlobalVoiceOverlayIconPath({
        resourcesPath: resourcesDir,
        moduleDir: join(devModuleDir, 'dist'),
      }),
    ).toBe(resPng);

    const resIcns = join(resourcesDir, 'icon.icns');
    writeFileSync(resIcns, 'res-icns');
    expect(
      resolveGlobalVoiceOverlayIconPath({
        resourcesPath: resourcesDir,
        moduleDir: join(devModuleDir, 'dist'),
      }),
    ).toBe(resIcns);
  });
});

describe('createPcAppGlobalVoice', () => {
  it('ignores single-tap and double-tap Shift when the IM.codes main window is focused, and ignores single-tap when idle', async () => {
    const userDataDir = makeTempDir('imcodes-gv-focus-');
    const hotkey = createFakeHelper();
    const spawnHelper = vi.fn(() => hotkey.proc);
    const startListening = vi.fn();

    let focused = true;
    const controller = createPcAppGlobalVoice({
      platform: 'darwin',
      userDataDir,
      iconPath: '/tmp/robot-icon.png',
      getLocale: () => 'en',
      getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => focused }),
      getSpeechHelperPath: () => '/usr/local/bin/imcodes-speech',
      voice: {
        startListening,
        stopListening: vi.fn(async () => {}),
      },
      spawnHelper,
    });

    controller.start();
    expect(spawnHelper).toHaveBeenCalledWith('/usr/local/bin/imcodes-speech', ['hotkey']);

    hotkey.stdout.write('{"type":"single_tap"}\n');
    hotkey.stdout.write('{"type":"double_tap"}\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(startListening).not.toHaveBeenCalled();

    // Unfocused while idle: single_tap is ignored, double_tap starts dictation
    focused = false;
    hotkey.stdout.write('{"type":"single_tap"}\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(startListening).not.toHaveBeenCalled();

    await controller.dispose();
  });

  it('starts on double_tap, stops and pastes without Enter on single_tap, and pastes with --enter on double_tap when active', async () => {
    const userDataDir = makeTempDir('imcodes-gv-flow-');
    const hotkey = createFakeHelper();
    const overlay = createFakeHelper();
    const spawnedArgs: string[][] = [];
    const spawnHelper = vi.fn((_bin: string, args: string[]) => {
      spawnedArgs.push(args);
      if (args[0] === 'hotkey') return hotkey.proc;
      if (args[0] === 'overlay') return overlay.proc;
      throw new Error(`Unexpected subcommand: ${args.join(' ')}`);
    });
    const runPasteHelper = vi.fn(async () => '{"type":"ok","length":11}\n');

    let capturedOnEvent: ((event: PcAppVoiceEvent) => void) | undefined;
    const startListening = vi.fn(async (opts?: { source?: 'in-app' | 'global'; locale?: string; onEvent?: (e: PcAppVoiceEvent) => void }) => {
      capturedOnEvent = opts?.onEvent;
      return { ok: true };
    });
    const stopListening = vi.fn(async () => {
      capturedOnEvent?.({ type: 'end' });
    });

    let clock = 1_000;
    const controller = createPcAppGlobalVoice({
      platform: 'darwin',
      userDataDir,
      iconPath: '/opt/imcodes/icon.icns',
      getLocale: () => 'zh-CN',
      getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => false }),
      getSpeechHelperPath: () => '/usr/local/bin/imcodes-speech',
      voice: { startListening, stopListening },
      spawnHelper,
      runPasteHelper,
      now: () => clock,
    });

    controller.start();
    hotkey.stdout.write('{"type":"double_tap"}\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(startListening).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'zh-CN',
        source: 'global',
        onEvent: expect.any(Function),
      }),
    );
    expect(spawnedArgs).toContainEqual(['overlay', '--icon', '/opt/imcodes/icon.icns']);

    capturedOnEvent?.({ type: 'start' });
    capturedOnEvent?.({ type: 'level', value: 0.4 });
    clock += GLOBAL_VOICE_LEVEL_MIN_INTERVAL_MS - 10;
    capturedOnEvent?.({ type: 'level', value: 0.8 });
    clock += 20;
    capturedOnEvent?.({ type: 'level', value: 0.9 });
    capturedOnEvent?.({ type: 'result', text: 'hello', isFinal: false });
    capturedOnEvent?.({ type: 'result', text: 'hello world', isFinal: true });

    // Single-tap Shift stops and pastes WITHOUT --enter.
    hotkey.stdout.write('{"type":"single_tap"}\n');
    await new Promise((r) => setTimeout(r, 20));

    expect(stopListening).toHaveBeenCalledTimes(1);
    expect(runPasteHelper).toHaveBeenCalledWith(
      '/usr/local/bin/imcodes-speech',
      ['paste', '--stdin'],
      'hello world',
    );

    const parsedOverlayCmds = overlay.stdinLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsedOverlayCmds[0]).toMatchObject({
      cmd: 'show',
      state: 'loading',
      title: tPcApp('zh-CN', 'voiceHud.loading'),
      iconPath: '/opt/imcodes/icon.icns',
    });
    const levelShowCmds = parsedOverlayCmds.filter(
      (cmd) => cmd.cmd === 'show' && cmd.state === 'listening' && cmd.text === '' && Number(cmd.level) > 0,
    );
    expect(levelShowCmds.map((c) => c.level)).toEqual([0.4, 0.9]);
    expect(parsedOverlayCmds.some((cmd) => cmd.cmd === 'show' && cmd.state === 'draining')).toBe(true);
    expect(parsedOverlayCmds[parsedOverlayCmds.length - 1]).toEqual({ cmd: 'hide' });

    // Second session: double_tap starts, then double_tap while listening stops and pastes WITH --enter.
    hotkey.stdout.write('{"type":"double_tap"}\n');
    await new Promise((r) => setTimeout(r, 10));
    capturedOnEvent?.({ type: 'start' });
    capturedOnEvent?.({ type: 'result', text: 'send now', isFinal: true });
    hotkey.stdout.write('{"type":"double_tap"}\n');
    await new Promise((r) => setTimeout(r, 20));

    expect(stopListening).toHaveBeenCalledTimes(2);
    expect(runPasteHelper).toHaveBeenLastCalledWith(
      '/usr/local/bin/imcodes-speech',
      ['paste', '--stdin', '--enter'],
      'send now',
    );

    await controller.dispose();
  });

  it('hides overlay and reports onError on start failure, voice error event, and accessibility_denied paste error', async () => {
    const userDataDir = makeTempDir('imcodes-gv-err-');
    const hotkey = createFakeHelper();
    const overlay = createFakeHelper();
    const spawnHelper = vi.fn((_bin: string, args: string[]) => (args[0] === 'hotkey' ? hotkey.proc : overlay.proc));
    const onError = vi.fn();

    let mode: 'start-fail' | 'voice-error' | 'paste-denied' = 'start-fail';
    let capturedOnEvent: ((event: PcAppVoiceEvent) => void) | undefined;
    const startListening = vi.fn(async (opts?: { onEvent?: (e: PcAppVoiceEvent) => void }) => {
      capturedOnEvent = opts?.onEvent;
      if (mode === 'start-fail') {
        return { ok: false, error: 'mic_denied' };
      }
      return { ok: true };
    });
    const stopListening = vi.fn(async () => {});
    const runPasteHelper = vi.fn(async () =>
      JSON.stringify({ type: 'error', code: 'accessibility_denied', message: 'Grant Accessibility permission' }),
    );

    const controller = createPcAppGlobalVoice({
      platform: 'darwin',
      userDataDir,
      iconPath: null,
      getLocale: () => 'en',
      getMainWindow: () => null,
      getSpeechHelperPath: () => '/usr/local/bin/imcodes-speech',
      voice: { startListening, stopListening },
      spawnHelper,
      runPasteHelper,
      onError,
    });

    await controller.toggleDictation();
    expect(onError).toHaveBeenCalledWith('mic_denied');

    mode = 'voice-error';
    await controller.toggleDictation();
    capturedOnEvent?.({ type: 'error', code: 'speech_denied', message: 'Speech denied' });
    expect(onError).toHaveBeenCalledWith('speech_denied', 'Speech denied');

    mode = 'paste-denied';
    await controller.toggleDictation();
    capturedOnEvent?.({ type: 'start' });
    capturedOnEvent?.({ type: 'result', text: 'secret text', isFinal: true });
    await controller.toggleDictation();
    expect(onError).toHaveBeenCalledWith('accessibility_denied', 'Grant Accessibility permission');

    const overlayCmds = overlay.stdinLines.map((line) => JSON.parse(line) as { cmd: string });
    expect(overlayCmds.filter((c) => c.cmd === 'hide').length).toBeGreaterThanOrEqual(3);

    await controller.dispose();
  });

  it('persists enabled state via PcAppGlobalVoiceStore, cleans up helpers on disable/dispose, and no-ops off darwin', async () => {
    const userDataDir = makeTempDir('imcodes-gv-store-');
    const hotkey = createFakeHelper();
    const overlay = createFakeHelper();
    const spawnHelper = vi.fn((_bin: string, args: string[]) => (args[0] === 'hotkey' ? hotkey.proc : overlay.proc));
    const onStateChanged = vi.fn();

    const controller = createPcAppGlobalVoice({
      platform: 'darwin',
      userDataDir,
      iconPath: null,
      getLocale: () => 'en',
      getMainWindow: () => null,
      getSpeechHelperPath: () => '/usr/local/bin/imcodes-speech',
      voice: {
        startListening: vi.fn(async () => ({ ok: true })),
        stopListening: vi.fn(async () => {}),
      },
      spawnHelper,
      onStateChanged,
    });

    expect(controller.isEnabled()).toBe(true);
    controller.start();
    await controller.toggleDictation();

    expect(await controller.setEnabled(false)).toBe(false);
    expect(new PcAppGlobalVoiceStore(userDataDir).load()).toBe(false);
    expect(onStateChanged).toHaveBeenCalledWith(false);
    expect(hotkey.killCalls).toEqual(['SIGTERM']);
    expect(overlay.killCalls).toEqual(['SIGTERM']);

    const controllerReloaded = createPcAppGlobalVoice({
      platform: 'darwin',
      userDataDir,
      iconPath: null,
      getLocale: () => 'en',
      getMainWindow: () => null,
      getSpeechHelperPath: () => '/usr/local/bin/imcodes-speech',
      voice: {
        startListening: vi.fn(async () => ({ ok: true })),
        stopListening: vi.fn(async () => {}),
      },
      spawnHelper,
    });
    expect(controllerReloaded.isEnabled()).toBe(false);
    controllerReloaded.start();
    expect(spawnHelper).toHaveBeenCalledTimes(2); // did not respawn when disabled
    await controllerReloaded.dispose();

    const winController = createPcAppGlobalVoice({
      platform: 'win32',
      userDataDir: makeTempDir('imcodes-gv-win-'),
      iconPath: null,
      getLocale: () => 'en',
      getMainWindow: () => null,
      getSpeechHelperPath: () => null,
      voice: {
        startListening: vi.fn(async () => ({ ok: true })),
        stopListening: vi.fn(async () => {}),
      },
      spawnHelper,
    });
    expect(winController.isEnabled()).toBe(false);
    winController.start();
    expect(await winController.setEnabled(true)).toBe(false);
    await winController.dispose();
  });
});
