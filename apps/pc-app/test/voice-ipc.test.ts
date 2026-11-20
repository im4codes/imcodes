import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPcAppVoiceController,
  PC_APP_VOICE_CHANNELS,
  resolvePrivacySettingsUrl,
  type PcAppIpcInvokeEventLike,
  type PcAppIpcMainLike,
  type PcAppVoiceEvent,
} from '../src/voice-ipc.js';

function createFakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  proc.kill = vi.fn(() => {
    queueMicrotask(() => proc.emit('exit', 0));
    return true;
  });
  return proc;
}

describe('PC App voice permissions, Settings deep-link, and Swift helper IPC', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-voice-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupController(opts: {
    platform?: NodeJS.Platform;
    currentTrustedOrigin?: string | null;
    activeOrigin?: string | null;
    senderUrl?: string;
    micStatus?: 'not-determined' | 'granted' | 'denied' | 'restricted';
    askResult?: boolean;
    helperStatusJson?: string;
    helperRequestJson?: string;
    spawnedProc?: ReturnType<typeof createFakeChildProcess>;
  } = {}) {
    const handlers = new Map<string, (ev: PcAppIpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown>();
    const ipcMain: PcAppIpcMainLike = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    };
    const mainWc = { id: 'main-wc' };
    const sentEvents: PcAppVoiceEvent[] = [];
    let micStatus = opts.micStatus ?? 'not-determined';
    const askForMediaAccess = vi.fn(async () => {
      const granted = opts.askResult ?? true;
      micStatus = granted ? 'granted' : 'denied';
      return granted;
    });
    const openSystemUrl = vi.fn(async () => {});
    const runHelperAsync = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'request') {
        return opts.helperRequestJson ?? JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true });
      }
      return opts.helperStatusJson ?? JSON.stringify({ mic: 'not-determined', speech: 'not-determined', speechAvailable: true });
    });
    const spawned = opts.spawnedProc ?? createFakeChildProcess();
    const spawnHelper = vi.fn(() => spawned as unknown as ChildProcess);

    const trustedOrigins = new Set(['https://app.im.codes']);
    let currentTrusted = opts.currentTrustedOrigin === undefined ? 'https://app.im.codes' : opts.currentTrustedOrigin;
    let activeOrigin = opts.activeOrigin === undefined ? 'https://app.im.codes' : opts.activeOrigin;
    let senderUrl = opts.senderUrl ?? 'https://app.im.codes/session/1';

    const voice = createPcAppVoiceController({
      platform: opts.platform ?? 'darwin',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      isMainWebContents: (sender) => sender === mainWc,
      getCurrentTrustedOrigin: () => currentTrusted,
      getActiveOrigin: () => activeOrigin,
      getTrustedOrigins: () => trustedOrigins,
      getSenderUrl: () => senderUrl,
      sendToRenderer: (_ch, payload) => sentEvents.push(payload),
      getMediaAccessStatus: () => micStatus,
      askForMediaAccess,
      openSystemUrl,
      runHelperAsync,
      spawnHelper,
    });
    voice.registerIpc(ipcMain);

    return {
      handlers,
      mainWc,
      sentEvents,
      askForMediaAccess,
      openSystemUrl,
      runHelperAsync,
      spawnHelper,
      spawned,
      voice,
      setNavigationState: (next: { trusted: string | null; active: string | null; url: string }) => {
        currentTrusted = next.trusted;
        activeOrigin = next.active;
        senderUrl = next.url;
      },
    };
  }

  it('rejects privileged voice & settings IPC from untrusted origins, wrong senders, or untrusted frames', async () => {
    const ctx = setupController();
    const untrustedFrameEvent: PcAppIpcInvokeEventLike = {
      sender: ctx.mainWc,
      senderFrame: { url: 'https://evil.example/embed' },
    };
    const wrongSenderEvent: PcAppIpcInvokeEventLike = {
      sender: { id: 'other-wc' },
      senderFrame: { url: 'https://app.im.codes/session/1' },
    };

    for (const ch of [
      PC_APP_VOICE_CHANNELS.getPermissions,
      PC_APP_VOICE_CHANNELS.requestPermissions,
      PC_APP_VOICE_CHANNELS.openPrivacySettings,
      PC_APP_VOICE_CHANNELS.startListening,
      PC_APP_VOICE_CHANNELS.stopListening,
    ]) {
      const fn = ctx.handlers.get(ch)!;
      await expect(fn(untrustedFrameEvent, 'microphone')).rejects.toThrow(/Untrusted origin/);
      await expect(fn(wrongSenderEvent, 'microphone')).rejects.toThrow(/Untrusted origin/);
    }

    ctx.setNavigationState({ trusted: null, active: null, url: 'data:text/html,<h1>welcome</h1>' });
    await expect(
      ctx.handlers.get(PC_APP_VOICE_CHANNELS.requestPermissions)!({
        sender: ctx.mainWc,
        senderFrame: { url: 'data:text/html,<h1>welcome</h1>' },
      }),
    ).rejects.toThrow(/Untrusted origin/);

    expect(ctx.askForMediaAccess).not.toHaveBeenCalled();
    expect(ctx.openSystemUrl).not.toHaveBeenCalled();
    expect(ctx.spawnHelper).not.toHaveBeenCalled();
  });

  it('triggers macOS askForMediaAccess + Swift helper on requestPermissions and returns denied target cleanly', async () => {
    const ctx = setupController({
      micStatus: 'not-determined',
      askResult: true,
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
    });
    const ev: PcAppIpcInvokeEventLike = {
      sender: ctx.mainWc,
      senderFrame: { url: 'https://app.im.codes/session/1' },
    };

    const perms = await ctx.handlers.get(PC_APP_VOICE_CHANNELS.requestPermissions)!(ev);
    expect(ctx.askForMediaAccess).toHaveBeenCalledWith('microphone');
    expect(ctx.runHelperAsync).toHaveBeenCalledWith('/Applications/IM.codes.app/Contents/Resources/imcodes-speech', ['request']);
    expect(perms).toEqual({
      mic: 'granted',
      speech: 'granted',
      platform: 'darwin',
      nativeSpeechAvailable: true,
    });

    // When mic is previously denied in macOS TCC, startListening returns structured permission_denied
    const deniedMicCtx = setupController({
      micStatus: 'denied',
      helperRequestJson: JSON.stringify({ mic: 'denied', speech: 'authorized', speechAvailable: true }),
    });
    const startDeniedMic = await deniedMicCtx.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(
      { sender: deniedMicCtx.mainWc, senderFrame: { url: 'https://app.im.codes/session/1' } },
      { locale: 'zh-Hans' },
    );
    expect(startDeniedMic).toEqual({ ok: false, error: 'permission_denied', target: 'mic' });
    expect(deniedMicCtx.spawnHelper).not.toHaveBeenCalled();

    // When mic is granted but Speech Recognition is denied, returns target: 'speech'
    const deniedSpeechCtx = setupController({
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'denied', speechAvailable: true }),
    });
    const startDeniedSpeech = await deniedSpeechCtx.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(
      { sender: deniedSpeechCtx.mainWc, senderFrame: { url: 'https://app.im.codes/session/1' } },
      {},
    );
    expect(startDeniedSpeech).toEqual({ ok: false, error: 'permission_denied', target: 'speech' });
  });

  it('opens strict allowlisted OS Privacy Settings URLs and streams live speech events from helper', async () => {
    const ctx = setupController({
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
    });
    const ev: PcAppIpcInvokeEventLike = {
      sender: ctx.mainWc,
      senderFrame: { url: 'https://app.im.codes/session/1' },
    };

    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.openPrivacySettings)!(ev, 'microphone')).toBe(true);
    expect(ctx.openSystemUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.openPrivacySettings)!(ev, 'speech')).toBe(true);
    expect(ctx.openSystemUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
    );
    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.openPrivacySettings)!(ev, 'https://evil.example')).toBe(false);

    const startRes = await ctx.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(ev, { locale: 'en-US' });
    expect(startRes).toEqual({ ok: true });
    expect(ctx.spawnHelper).toHaveBeenCalledWith(
      '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      ['listen', '--locale', 'en-US'],
    );

    ctx.spawned.stdout.emit('data', '{"type":"start"}\n{"type":"level","value":0.4}\n{"type":"result","text":"hello world","isFinal":false}\n');
    expect(ctx.sentEvents).toEqual([
      { type: 'start' },
      { type: 'level', value: 0.4 },
      { type: 'result', text: 'hello world', isFinal: false },
    ]);

    const stopPromise = ctx.handlers.get(PC_APP_VOICE_CHANNELS.stopListening)!(ev, { abort: false });
    expect(ctx.spawned.stdin.write).toHaveBeenCalledWith('stop\n');
    ctx.spawned.stdout.emit('data', '{"type":"result","text":"hello world","isFinal":true}\n{"type":"end"}\n');
    ctx.spawned.emit('exit', 0);
    await stopPromise;
  });

  it('handles win32 safely without invoking darwin-only media/Swift APIs', async () => {
    const ctx = setupController({ platform: 'win32' });
    const ev: PcAppIpcInvokeEventLike = {
      sender: ctx.mainWc,
      senderFrame: { url: 'https://app.im.codes/session/1' },
    };

    const perms = await ctx.handlers.get(PC_APP_VOICE_CHANNELS.getPermissions)!(ev);
    expect(perms).toEqual({
      mic: 'unknown',
      speech: 'unavailable',
      platform: 'win32',
      nativeSpeechAvailable: false,
    });
    expect(ctx.askForMediaAccess).not.toHaveBeenCalled();
    expect(ctx.runHelperAsync).not.toHaveBeenCalled();

    expect(resolvePrivacySettingsUrl('win32', 'microphone')).toBe('ms-settings:privacy-microphone');
    expect(resolvePrivacySettingsUrl('win32', 'speech')).toBeNull();
  });

  if (process.platform === 'darwin') {
    it('compiles imcodes-speech.swift and reports valid JSON status on macOS', { timeout: 30_000 }, () => {
      const swiftSrc = path.resolve(import.meta.dirname, '..', 'native', 'imcodes-speech.swift');
      expect(existsSync(swiftSrc)).toBe(true);
      const binPath = path.join(tempDir, 'imcodes-speech');
      const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
      execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macosx12.0`, swiftSrc, '-o', binPath], {
        stdio: 'pipe',
      });
      const out = execFileSync(binPath, ['status'], { encoding: 'utf8', stdio: 'pipe' }).trim();
      const parsed = JSON.parse(out) as { mic: string; speech: string; speechAvailable: boolean };
      expect(['not-determined', 'granted', 'authorized', 'denied', 'restricted']).toContain(parsed.mic);
      expect(['not-determined', 'granted', 'authorized', 'denied', 'restricted']).toContain(parsed.speech);
      expect(typeof parsed.speechAvailable).toBe('boolean');
    });
  }
});
