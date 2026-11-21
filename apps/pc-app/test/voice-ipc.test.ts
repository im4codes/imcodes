import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PcAppSpeechModelManifest, PcAppSpeechVariant } from '../src/speech-models.js';
import {
  createPcAppVoiceController,
  PC_APP_VOICE_CHANNELS,
  resolvePrivacySettingsUrl,
  type PcAppIpcInvokeEventLike,
  type PcAppIpcMainLike,
  type PcAppVoiceControllerDeps,
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
    arch?: string;
    currentTrustedOrigin?: string | null;
    activeOrigin?: string | null;
    senderUrl?: string;
    micStatus?: 'not-determined' | 'granted' | 'denied' | 'restricted';
    askResult?: boolean;
    helperStatusJson?: string;
    helperRequestJson?: string;
    spawnedProc?: ReturnType<typeof createFakeChildProcess>;
    mlxHelperPath?: string;
    isMlxSupported?: PcAppVoiceControllerDeps['isMlxSupported'];
    fetchModel?: typeof fetch;
    manifests?: Record<PcAppSpeechVariant, PcAppSpeechModelManifest>;
    mirrorOrigins?: readonly string[] | null;
    onSpeechModelStatusChanged?: PcAppVoiceControllerDeps['onSpeechModelStatusChanged'];
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
      arch: opts.arch ?? 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: opts.mlxHelperPath,
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
      isMlxSupported: opts.isMlxSupported,
      fetchModel: opts.fetchModel,
      manifests: opts.manifests,
      mirrorOrigins: opts.mirrorOrigins,
      onSpeechModelStatusChanged: opts.onSpeechModelStatusChanged,
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
      PC_APP_VOICE_CHANNELS.getSpeechModel,
      PC_APP_VOICE_CHANNELS.setSpeechModel,
      PC_APP_VOICE_CHANNELS.getSpeechModelStatus,
      PC_APP_VOICE_CHANNELS.getInputDevices,
      PC_APP_VOICE_CHANNELS.getInputDevice,
      PC_APP_VOICE_CHANNELS.setInputDevice,
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

  it('surfaces bounded helper stderr on non-zero helper_exited and omits empty message', async () => {
    const ctx = setupController({
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
    });
    const ev: PcAppIpcInvokeEventLike = {
      sender: ctx.mainWc,
      senderFrame: { url: 'https://app.im.codes/session/1' },
    };

    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(ev, {})).toEqual({ ok: true });
    ctx.spawned.stderr.emit('data', `${'prefix-'.repeat(100)}audio tap failed\n`);
    ctx.spawned.emit('exit', 1);

    expect(ctx.sentEvents).toHaveLength(2);
    const errEvent = ctx.sentEvents[0]!;
    expect(errEvent.type).toBe('error');
    if (errEvent.type === 'error') {
      expect(errEvent.code).toBe('helper_exited');
      expect(errEvent.message).toBeDefined();
      expect(errEvent.message!.length).toBeLessThanOrEqual(512);
      expect(errEvent.message).toContain('audio tap failed');
    }
    expect(ctx.sentEvents[1]).toEqual({ type: 'end' });

    const ctxEmpty = setupController({
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
    });
    const evEmpty: PcAppIpcInvokeEventLike = {
      sender: ctxEmpty.mainWc,
      senderFrame: { url: 'https://app.im.codes/session/1' },
    };
    expect(await ctxEmpty.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(evEmpty, {})).toEqual({ ok: true });
    ctxEmpty.spawned.stderr.emit('data', '   \n  ');
    ctxEmpty.spawned.emit('exit', 2);
    expect(ctxEmpty.sentEvents).toEqual([
      { type: 'error', code: 'helper_exited' },
      { type: 'end' },
    ]);
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

  it('persists speech model selection, downloads in background, falls back to system until ready, and routes to Qwen3-ASR 0.6b/1.7b once verified', async () => {
    const smallBuf = Buffer.from('06b-weights');
    const largeBuf = Buffer.from('17b-weights');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-0.6b',
        revision: 'rev06',
        files: [{ filename: 'config.json', expectedSize: smallBuf.length, expectedSha256: sha(smallBuf) }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-1.7b',
        revision: 'rev17',
        files: [{ filename: 'config.json', expectedSize: largeBuf.length, expectedSha256: sha(largeBuf) }],
      },
    };

    let release06!: () => void;
    const download06Gate = new Promise<void>((res) => { release06 = res; });
    const mlxBin = '/Applications/IM.codes.app/Contents/Resources/imcodes-speech-mlx';

    const ctx = setupController({
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      mlxHelperPath: mlxBin,
      isMlxSupported: () => true,
      manifests,
      mirrorOrigins: ['https://hf-mirror.com'],
      fetchModel: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('test-0.6b')) {
          await download06Gate;
          return new Response(new Uint8Array(smallBuf), { status: 200 });
        }
        return new Response(new Uint8Array(largeBuf), { status: 200 });
      },
    });

    const ev: PcAppIpcInvokeEventLike = {
      sender: ctx.mainWc,
      senderFrame: { url: 'https://app.im.codes/session/1' },
    };

    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.getSpeechModel)!(ev)).toBe('system');
    await expect(ctx.handlers.get(PC_APP_VOICE_CHANNELS.setSpeechModel)!(ev, 'invalid-model')).rejects.toThrow(/Invalid speech model/);

    // Switch to qwen3-0.6b while download is gated -> starts downloading, activeBackend stays 'system'
    const initialStatus = await ctx.handlers.get(PC_APP_VOICE_CHANNELS.setSpeechModel)!(ev, 'qwen3-0.6b') as {
      selectedModel: string;
      activeBackend: string;
      state: string;
    };
    expect(initialStatus.selectedModel).toBe('qwen3-0.6b');
    expect(initialStatus.activeBackend).toBe('system');

    // Starting voice before weights finish falls back cleanly to system SFSpeechRecognizer
    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(ev, { locale: 'zh-CN' })).toEqual({ ok: true });
    expect(ctx.spawnHelper).toHaveBeenLastCalledWith(
      '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      ['listen', '--locale', 'zh-CN'],
    );

    // Finish background download -> next startListening uses imcodes-speech-mlx with --variant 0.6b
    release06();
    await new Promise((res) => setTimeout(res, 25));
    const ready06 = await ctx.handlers.get(PC_APP_VOICE_CHANNELS.getSpeechModelStatus)!(ev) as {
      activeBackend: string;
      state: string;
      modelDir: string;
    };
    expect(ready06.state).toBe('ready');
    expect(ready06.activeBackend).toBe('qwen3-0.6b');

    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(ev, { locale: 'zh-CN' })).toEqual({ ok: true });
    expect(ctx.spawnHelper).toHaveBeenLastCalledWith(
      mlxBin,
      ['listen', '--model-dir', ready06.modelDir, '--variant', '0.6b', '--locale', 'zh-CN'],
    );

    // Switch to 1.7b, verify persistence across new controller instance, and check x64 unsupported fallback
    await ctx.handlers.get(PC_APP_VOICE_CHANNELS.setSpeechModel)!(ev, 'qwen3-1.7b');
    await new Promise((res) => setTimeout(res, 25));
    const ctx2 = setupController({
      platform: 'darwin',
      arch: 'x64',
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      mlxHelperPath: mlxBin,
      manifests,
    });
    expect(await ctx2.voice.getSpeechModel()).toBe('qwen3-1.7b');
    const x64Status = await ctx2.voice.getSpeechModelStatus();
    expect(x64Status.state).toBe('unsupported');
    expect(x64Status.activeBackend).toBe('system');
    expect(await ctx2.voice.startListening({ locale: 'en-US' })).toEqual({ ok: true });
    expect(ctx2.spawnHelper).toHaveBeenLastCalledWith(
      '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      ['listen', '--locale', 'en-US'],
    );

    await ctx.voice.dispose();
    await ctx2.voice.dispose();
  });

  it('uses packaged resourcesPath imcodes-speech-mlx when mlx.metallib probe passes, and falls back activeBackend to system when metallib is missing', async () => {
    const weights = Buffer.from('verified-06b-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-0.6b',
        revision: 'rev06',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-1.7b',
        revision: 'rev17',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const packagedResDir = path.join(tempDir, 'IM.codes.app', 'Contents', 'Resources');
    mkdirSync(packagedResDir, { recursive: true });
    const packagedSpeechBin = path.join(packagedResDir, 'imcodes-speech');
    const packagedMlxBin = path.join(packagedResDir, 'imcodes-speech-mlx');
    writeFileSync(packagedSpeechBin, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
    writeFileSync(packagedMlxBin, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });

    const createPackagedController = (metallibAvailable: boolean) => {
      const spawned = createFakeChildProcess();
      const spawnHelper = vi.fn(() => spawned as unknown as ChildProcess);
      const runHelperAsync = vi.fn(async (bin: string, args: string[]) => {
        if (bin === packagedMlxBin && args[0] === 'probe') {
          return JSON.stringify({
            arch: 'arm64',
            metalSupported: true,
            metallibAvailable,
            mlxSupported: metallibAvailable,
          });
        }
        return JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true });
      });
      const voice = createPcAppVoiceController({
        platform: 'darwin',
        arch: 'arm64',
        userDataDir: tempDir,
        resourcesPath: packagedResDir,
        isMainWebContents: () => true,
        getCurrentTrustedOrigin: () => 'https://app.im.codes',
        getActiveOrigin: () => 'https://app.im.codes',
        getTrustedOrigins: () => new Set(['https://app.im.codes']),
        getSenderUrl: () => 'https://app.im.codes/session/1',
        sendToRenderer: () => {},
        getMediaAccessStatus: () => 'granted',
        runHelperAsync,
        spawnHelper,
        manifests,
        mirrorOrigins: ['https://hf-mirror.com'],
        fetchModel: async () => new Response(new Uint8Array(weights), { status: 200 }),
      });
      return { voice, spawnHelper, runHelperAsync };
    };

    // Case 1: packaged app without mlx.metallib -> probe reports mlxSupported: false -> activeBackend stays 'system' & falls back to imcodes-speech
    const missingMetallib = createPackagedController(false);
    const statusMissing = await missingMetallib.voice.setSpeechModel('qwen3-0.6b');
    expect(statusMissing.mlxSupported).toBe(false);
    expect(statusMissing.state).toBe('unsupported');
    expect(statusMissing.activeBackend).toBe('system');
    expect(await missingMetallib.voice.startListening({ locale: 'en-US' })).toEqual({ ok: true });
    expect(missingMetallib.spawnHelper).toHaveBeenLastCalledWith(packagedSpeechBin, ['listen', '--locale', 'en-US']);
    await missingMetallib.voice.dispose();

    // Case 2: packaged app with imcodes-speech-mlx + mlx.metallib -> downloads weights & routes to packaged imcodes-speech-mlx
    writeFileSync(path.join(packagedResDir, 'mlx.metallib'), 'METALLIB');
    const withMetallib = createPackagedController(true);
    await withMetallib.voice.setSpeechModel('qwen3-0.6b');
    await new Promise((res) => setTimeout(res, 25));
    const statusReady = await withMetallib.voice.getSpeechModelStatus();
    expect(statusReady.mlxSupported).toBe(true);
    expect(statusReady.state).toBe('ready');
    expect(statusReady.activeBackend).toBe('qwen3-0.6b');
    expect(await withMetallib.voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
    expect(withMetallib.spawnHelper).toHaveBeenLastCalledWith(
      packagedMlxBin,
      ['listen', '--model-dir', statusReady.modelDir, '--variant', '0.6b', '--locale', 'zh-CN'],
    );
    await withMetallib.voice.dispose();
  });

  it('enumerates, persists, and binds selected microphone input device across system and mlx helpers', async () => {
    const weights = Buffer.from('verified-06b-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-0.6b',
        revision: 'rev06',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-1.7b',
        revision: 'rev17',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const packagedResDir = path.join(tempDir, 'IM.codes-mic.app', 'Contents', 'Resources');
    mkdirSync(packagedResDir, { recursive: true });
    const packagedSpeechBin = path.join(packagedResDir, 'imcodes-speech');
    const packagedMlxBin = path.join(packagedResDir, 'imcodes-speech-mlx');
    writeFileSync(packagedSpeechBin, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(packagedMlxBin, '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(path.join(packagedResDir, 'mlx.metallib'), 'METALLIB');

    let deviceProbeReply: string | Error = JSON.stringify([
      { uid: 'BuiltInMic', name: 'MacBook Pro Microphone', transport: 'builtin', isDefault: true, isPhysical: true },
      { uid: 'AirPods-UID', name: 'AirPods Pro', transport: 'bluetooth', isDefault: false, isPhysical: false },
    ]);

    const createMicController = () => {
      const spawned = createFakeChildProcess();
      const spawnHelper = vi.fn(() => spawned as unknown as ChildProcess);
      const onInputDevicesChanged = vi.fn();
      const runHelperAsync = vi.fn(async (bin: string, args: string[]) => {
        if (bin === packagedSpeechBin && args[0] === 'devices') {
          if (deviceProbeReply instanceof Error) throw deviceProbeReply;
          return deviceProbeReply;
        }
        if (bin === packagedMlxBin && args[0] === 'probe') {
          return JSON.stringify({ arch: 'arm64', metalSupported: true, metallibAvailable: true, mlxSupported: true });
        }
        return JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true });
      });
      const handlers = new Map<string, (event: PcAppIpcInvokeEventLike, ...args: unknown[]) => unknown>();
      const mainWc = { id: 'main' };
      const ipcMain: PcAppIpcMainLike = {
        handle: (channel, listener) => { handlers.set(channel, listener); },
        removeHandler: (channel) => { handlers.delete(channel); },
      };
      const voice = createPcAppVoiceController({
        platform: 'darwin',
        arch: 'arm64',
        userDataDir: tempDir,
        resourcesPath: packagedResDir,
        isMainWebContents: (s) => s === mainWc,
        getCurrentTrustedOrigin: () => 'https://app.im.codes',
        getActiveOrigin: () => 'https://app.im.codes',
        getTrustedOrigins: () => new Set(['https://app.im.codes']),
        getSenderUrl: () => 'https://app.im.codes/session/1',
        sendToRenderer: () => {},
        getMediaAccessStatus: () => 'granted',
        runHelperAsync,
        spawnHelper,
        manifests,
        mirrorOrigins: ['https://hf-mirror.com'],
        fetchModel: async () => new Response(new Uint8Array(weights), { status: 200 }),
        onInputDevicesChanged,
      });
      voice.registerIpc(ipcMain);
      return { voice, spawnHelper, runHelperAsync, onInputDevicesChanged, handlers, mainWc };
    };

    const first = createMicController();
    const ev: PcAppIpcInvokeEventLike = { sender: first.mainWc, senderFrame: { url: 'https://app.im.codes/session/1' } };
    expect(await first.handlers.get(PC_APP_VOICE_CHANNELS.getInputDevice)!(ev)).toBe('auto');

    const devices = await first.handlers.get(PC_APP_VOICE_CHANNELS.getInputDevices)!(ev);
    expect(devices).toEqual([
      { uid: 'BuiltInMic', name: 'MacBook Pro Microphone', transport: 'builtin', isDefault: true, isPhysical: true },
      { uid: 'AirPods-UID', name: 'AirPods Pro', transport: 'bluetooth', isDefault: false, isPhysical: false },
    ]);
    expect(first.voice.getInputDevicesSync()).toEqual(devices);

    // Helper error preserves cached devices cleanly
    deviceProbeReply = new Error('helper crashed');
    expect(await first.voice.getInputDevices()).toEqual(devices);

    // Selecting a device persists it and appends --device <uid> to imcodes-speech
    expect(await first.handlers.get(PC_APP_VOICE_CHANNELS.setInputDevice)!(ev, 'AirPods-UID')).toBe('AirPods-UID');
    expect(await first.voice.startListening({ locale: 'en-US' })).toEqual({ ok: true });
    expect(first.spawnHelper).toHaveBeenLastCalledWith(
      packagedSpeechBin,
      ['listen', '--locale', 'en-US', '--device', 'AirPods-UID'],
    );
    await first.voice.dispose();

    // Reloading in a fresh controller preserves the selected device and binds --device <uid> on mlx helper too
    const second = createMicController();
    expect(second.voice.getSelectedInputDevice()).toBe('AirPods-UID');
    await second.voice.setSpeechModel('qwen3-0.6b');
    await new Promise((res) => setTimeout(res, 25));
    const statusReady = await second.voice.getSpeechModelStatus();
    expect(await second.voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
    expect(second.spawnHelper).toHaveBeenLastCalledWith(
      packagedMlxBin,
      ['listen', '--model-dir', statusReady.modelDir, '--variant', '0.6b', '--locale', 'zh-CN', '--device', 'AirPods-UID'],
    );

    // Setting blank / 'auto' clears --device flag
    expect(second.voice.setSelectedInputDevice('   ')).toBe('auto');
    expect(await second.voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
    expect(second.spawnHelper).toHaveBeenLastCalledWith(
      packagedMlxBin,
      ['listen', '--model-dir', statusReady.modelDir, '--variant', '0.6b', '--locale', 'zh-CN'],
    );
    await second.voice.dispose();
  });

  it('forwards startListening({ onEvent }) to local test listener without relaxing untrusted remote IPC checks', async () => {
    const spawned = createFakeChildProcess();
    const sendToRenderer = vi.fn();
    const mainWc = { id: 'main' };
    const handlers = new Map<string, (event: PcAppIpcInvokeEventLike, ...args: unknown[]) => unknown>();
    const ipcMain: PcAppIpcMainLike = {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      removeHandler: (channel) => { handlers.delete(channel); },
    };

    const voice = createPcAppVoiceController({
      platform: 'darwin',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      isMainWebContents: (s) => s === mainWc,
      getCurrentTrustedOrigin: () => null,
      getActiveOrigin: () => null,
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => '',
      sendToRenderer,
      getMediaAccessStatus: () => 'granted',
      runHelperAsync: async () => JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      spawnHelper: () => spawned as unknown as ChildProcess,
    });
    voice.registerIpc(ipcMain);

    // Remote IPC remains strictly blocked when untrusted / unauthenticated
    await expect(
      handlers.get(PC_APP_VOICE_CHANNELS.startListening)!({
        sender: { id: 'evil' },
        senderFrame: { url: 'https://evil.example' },
      }),
    ).rejects.toThrow('Untrusted origin');

    // Internal local test listener receives events even with no connected remote origin, without leaking to renderer
    const events: PcAppVoiceEvent[] = [];
    expect(await voice.startListening({ locale: 'en-US', onEvent: (ev) => events.push(ev) })).toEqual({ ok: true });
    spawned.stdout.emit('data', '{"type":"start"}\n{"type":"level","value":0.55}\n{"type":"result","text":"mic check","isFinal":true}\n{"type":"end"}\n');
    expect(events).toEqual([
      { type: 'start' },
      { type: 'level', value: 0.55 },
      { type: 'result', text: 'mic check', isFinal: true },
      { type: 'end' },
    ]);
    expect(sendToRenderer).not.toHaveBeenCalled();
    await voice.dispose();
  });

  it('writes bounded voice.log diagnostics (<= 64 KB) and degrades cleanly when log path is unwritable', async () => {
    const voiceLogPath = path.join(tempDir, 'voice.log');
    writeFileSync(voiceLogPath, `${'stale-log-line\n'.repeat(4500)}`, 'utf8');
    expect(statSync(voiceLogPath).size).toBeGreaterThan(64 * 1024);

    const spawned = createFakeChildProcess();
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      runHelperAsync: async () => JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      spawnHelper: () => spawned as unknown as ChildProcess,
    });

    expect(await voice.startListening({ locale: 'en-US' })).toEqual({ ok: true });
    spawned.stderr.emit('data', '[imcodes-speech] input deviceID=42 bindStatus=0 sampleRate=48000 channels=1\n');
    spawned.stdout.emit('data', '{"type":"level","value":0.005}\n{"type":"level","value":0.24}\n{"type":"level","value":0.65}\n{"type":"result","text":"   ","isFinal":false}\n{"type":"result","text":"hello world","isFinal":false}\n{"type":"result","text":"hello world final","isFinal":true}\n{"type":"error","code":"no_audio_input"}\n');
    spawned.emit('exit', 1, null);

    expect(statSync(voiceLogPath).size).toBeLessThanOrEqual(64 * 1024);
    const logContent = readFileSync(voiceLogPath, 'utf8');
    expect(logContent).toContain('startListening model=system device=auto');
    expect(logContent).toContain('helper stderr: [imcodes-speech] input deviceID=42 bindStatus=0 sampleRate=48000 channels=1');
    expect(logContent).toContain('first level value=0.2400');
    expect(logContent).not.toContain('first level value=0.6500');
    expect(logContent).toContain('first result isFinal=false len=11 text="hello world"');
    expect(logContent).not.toContain('hello world final');
    expect(logContent).toContain('helper error code=no_audio_input');
    expect(logContent).toContain('helper exit code=1');
    await voice.dispose();

    // Unwritable userDataDir (file blocking directory creation) never throws or blocks startListening
    const blockerFile = path.join(tempDir, 'not-a-dir');
    writeFileSync(blockerFile, 'x');
    const spawned2 = createFakeChildProcess();
    const voiceNoWrite = createPcAppVoiceController({
      platform: 'darwin',
      userDataDir: blockerFile,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      runHelperAsync: async () => JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      spawnHelper: () => spawned2 as unknown as ChildProcess,
    });
    expect(await voiceNoWrite.startListening({ locale: 'en-US' })).toEqual({ ok: true });
    await voiceNoWrite.dispose();
  });
});
