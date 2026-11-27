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
  normalizePcAppVoiceHotwordsContext,
  PC_APP_VOICE_CHANNELS,
  resolvePrivacySettingsUrl,
  type PcAppIpcInvokeEventLike,
  type PcAppIpcMainLike,
  type PcAppRemoteVoiceEvent,
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

    ctx.spawned.stdout.emit('data', '{"type":"loading","variant":"0.6b"}\n{"type":"start"}\n{"type":"level","value":0.4}\n{"type":"result","text":"hello world","isFinal":false}\n');
    expect(ctx.sentEvents).toEqual([
      { type: 'loading', variant: '0.6b' },
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

    // Switch to qwen3-0.6b while download is gated -> starts downloading, selectedModel & activeBackend stay 'system'
    const initialStatus = await ctx.handlers.get(PC_APP_VOICE_CHANNELS.setSpeechModel)!(ev, 'qwen3-0.6b') as {
      selectedModel: string;
      activeBackend: string;
      state: string;
      downloadingModel: string | null;
      models: Record<string, { state: string; progress: number }>;
    };
    expect(initialStatus.selectedModel).toBe('system');
    expect(initialStatus.activeBackend).toBe('system');
    expect(initialStatus.state).toBe('downloading');
    expect(initialStatus.downloadingModel).toBe('qwen3-0.6b');
    expect(initialStatus.models['qwen3-0.6b'].state).toBe('downloading');
    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.getSpeechModel)!(ev)).toBe('system');

    // Starting voice before weights finish falls back cleanly to system SFSpeechRecognizer
    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(ev, { locale: 'zh-CN' })).toEqual({ ok: true });
    expect(ctx.spawnHelper).toHaveBeenLastCalledWith(
      '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      ['listen', '--locale', 'zh-CN'],
    );

    // Finish background download -> automatically promotes selectedModel & activeBackend to 'qwen3-0.6b'
    release06();
    await new Promise((res) => setTimeout(res, 25));
    const ready06 = await ctx.handlers.get(PC_APP_VOICE_CHANNELS.getSpeechModelStatus)!(ev) as {
      selectedModel: string;
      activeBackend: string;
      state: string;
      downloadingModel: string | null;
      modelDir: string;
      models: Record<string, { state: string; progress: number }>;
    };
    expect(ready06.state).toBe('ready');
    expect(ready06.selectedModel).toBe('qwen3-0.6b');
    expect(ready06.activeBackend).toBe('qwen3-0.6b');
    expect(ready06.downloadingModel).toBeNull();
    expect(ready06.models['qwen3-0.6b'].state).toBe('ready');

    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(ev, { locale: 'zh-CN' })).toEqual({ ok: true });
    expect(ctx.spawnHelper).toHaveBeenLastCalledWith(
      mlxBin,
      ['listen', '--model-dir', ready06.modelDir, '--variant', '0.6b', '--locale', 'zh-CN'],
    );

    // Switch to 1.7b, verify persistence across new arm64 controller instance, and check x64 unsupported keeps 'system' active
    await ctx.handlers.get(PC_APP_VOICE_CHANNELS.setSpeechModel)!(ev, 'qwen3-1.7b');
    await new Promise((res) => setTimeout(res, 25));
    expect(await ctx.handlers.get(PC_APP_VOICE_CHANNELS.getSpeechModel)!(ev)).toBe('qwen3-1.7b');

    const ctxArm2 = setupController({
      platform: 'darwin',
      arch: 'arm64',
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      mlxHelperPath: mlxBin,
      manifests,
    });
    expect(await ctxArm2.voice.getSpeechModel()).toBe('qwen3-1.7b');
    await ctxArm2.voice.dispose();

    const ctx2 = setupController({
      platform: 'darwin',
      arch: 'x64',
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      mlxHelperPath: mlxBin,
      manifests,
    });
    expect(await ctx2.voice.getSpeechModel()).toBe('system');
    const x64Status = await ctx2.voice.getSpeechModelStatus();
    expect(x64Status.state).toBe('unsupported');
    expect(x64Status.selectedModel).toBe('system');
    expect(x64Status.activeBackend).toBe('system');
    expect(x64Status.models?.['qwen3-0.6b'].state).toBe('unsupported');
    expect(x64Status.models?.['qwen3-1.7b'].state).toBe('unsupported');
    expect(await ctx2.voice.startListening({ locale: 'en-US' })).toEqual({ ok: true });
    expect(ctx2.spawnHelper).toHaveBeenLastCalledWith(
      '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      ['listen', '--locale', 'en-US'],
    );

    await ctx.voice.dispose();
    await ctx2.voice.dispose();
  });

  it('cancels active model download cleanly when switching back to system', async () => {
    const weights = Buffer.from('cancel-test-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-0.6b',
        revision: 'rev06-cancel',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-1.7b',
        revision: 'rev17-cancel',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
    };
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((res) => { releaseDownload = res; });
    const ctx = setupController({
      platform: 'darwin',
      arch: 'arm64',
      micStatus: 'granted',
      helperRequestJson: JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      mlxHelperPath: '/tmp/fake-mlx-bin',
      isMlxSupported: true,
      manifests,
      fetchModel: async (_url, init) => {
        await new Promise<void>((resolveWait, rejectWait) => {
          if (init?.signal?.aborted) {
            rejectWait(new Error('aborted'));
            return;
          }
          init?.signal?.addEventListener('abort', () => rejectWait(new Error('aborted')), { once: true });
          void downloadGate.then(resolveWait);
        });
        return new Response(new Uint8Array(weights), { status: 200 });
      },
    });

    const downloadingStatus = await ctx.voice.setSpeechModel('qwen3-0.6b');
    expect(downloadingStatus.selectedModel).toBe('system');
    expect(downloadingStatus.state).toBe('downloading');
    expect(downloadingStatus.downloadingModel).toBe('qwen3-0.6b');

    const cancelledStatus = await ctx.voice.setSpeechModel('system');
    expect(cancelledStatus.selectedModel).toBe('system');
    expect(cancelledStatus.state).toBe('idle');
    expect(cancelledStatus.downloadingModel).toBeNull();
    expect(cancelledStatus.models?.['qwen3-0.6b'].state).toBe('idle');

    releaseDownload();
    await new Promise((res) => setTimeout(res, 20));
    expect(ctx.voice.getSpeechModel()).toBe('system');
    await ctx.voice.dispose();
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
    expect(logContent).toContain('final result len=17 text="hello world final"');
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

  it('notifies speech model download status at 3-decimal increments with 200ms rate limit while keeping selectedModel=system', async () => {
    const payload = Buffer.alloc(100000, 65);
    const sha = createHash('sha256').update(payload).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-pct-0.6b',
        revision: 'rev06',
        files: [{ filename: 'weights.bin', expectedSize: payload.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-pct-1.7b',
        revision: 'rev17',
        files: [{ filename: 'weights.bin', expectedSize: payload.length, expectedSha256: sha }],
      },
    };

    let fakeNow = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      const statuses: Array<{ state: string; progress: number; selectedModel: string; downloadingModel?: string | null }> = [];
      const ctx = setupController({
        micStatus: 'granted',
        mlxHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech-mlx',
        isMlxSupported: () => true,
        manifests,
        mirrorOrigins: ['https://hf-mirror.com'],
        onSpeechModelStatusChanged: (st) => {
          statuses.push({
            state: st.state,
            progress: st.progress,
            selectedModel: st.selectedModel,
            downloadingModel: st.downloadingModel,
          });
        },
        fetchModel: async () => {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              // 1.234% (1234 bytes) at t=+250ms -> notifies
              fakeNow += 250;
              controller.enqueue(payload.subarray(0, 1234));
              await new Promise((r) => setTimeout(r, 2));
              // 1.235% (1235 bytes) at t=+50ms (< 200ms) -> throttled
              fakeNow += 50;
              controller.enqueue(payload.subarray(1234, 1235));
              await new Promise((r) => setTimeout(r, 2));
              // 1.236% (1236 bytes) at t=+210ms (>= 200ms) -> notifies 0.001% precision update
              fakeNow += 210;
              controller.enqueue(payload.subarray(1235, 1236));
              await new Promise((r) => setTimeout(r, 2));
              // Remaining bytes -> ready notifies immediately (force=true even if < 200ms)
              fakeNow += 10;
              controller.enqueue(payload.subarray(1236));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-length': String(payload.length) },
          });
        },
      });

      await ctx.voice.setSpeechModel('qwen3-0.6b');
      await vi.waitFor(async () => {
        const st = await ctx.voice.getSpeechModelStatus();
        expect(st.state).toBe('ready');
      });

      const dlBuckets = statuses
        .filter((s) => s.state === 'downloading')
        .map((s) => Math.floor(s.progress * 100000));
      expect(dlBuckets).toEqual([0, 1234, 1236]);
      expect(statuses.some((s) => s.state === 'ready')).toBe(true);
      const midDownload = statuses.find((s) => s.state === 'downloading' && Math.floor(s.progress * 100000) === 1236);
      expect(midDownload?.selectedModel).toBe('system');
      expect(midDownload?.downloadingModel).toBe('qwen3-0.6b');
      await ctx.voice.dispose();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses 45_000ms stop drain timeout for Qwen helpers (including slow >12s final re-decode), 2_200ms for system helpers, and immediate SIGTERM on abort=true', async () => {
    const weights = Buffer.from('mlx-drain-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-drain-0.6b',
        revision: 'rev06',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-drain-1.7b',
        revision: 'rev17',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const children: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech-mlx',
      isMlxSupported: () => true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      manifests,
      mirrorOrigins: ['https://hf-mirror.com'],
      fetchModel: async () => new Response(new Uint8Array(weights), { status: 200 }),
      runHelperAsync: async () => JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      spawnHelper: () => {
        const child = createFakeChildProcess();
        // Prevent default auto-exit on kill unless we inspect or trigger exit explicitly
        child.kill = vi.fn(() => {
          queueMicrotask(() => child.emit('exit', 0));
          return true;
        }) as unknown as typeof child.kill;
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });

    // 1. System helper drains with 2_200ms timeout
    vi.useFakeTimers();
    try {
      expect(await voice.startListening({ locale: 'en-US' })).toEqual({ ok: true });
      const sysStop = voice.stopListening({ abort: false });
      expect(children[0].stdin.write).toHaveBeenCalledWith('stop\n');
      await vi.advanceTimersByTimeAsync(2_100);
      expect(children[0].kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      await sysStop;
      expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');

      // 2. Ready Qwen MLX helper drains past 12_000ms (receives slow 25_000ms final exit cleanly without SIGTERM)
      vi.useRealTimers();
      await voice.setSpeechModel('qwen3-0.6b');
      await vi.waitFor(async () => {
        expect((await voice.getSpeechModelStatus()).state).toBe('ready');
      });

      vi.useFakeTimers();
      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      const mlxStop = voice.stopListening({ abort: false });
      expect(children[1].stdin.write).toHaveBeenCalledWith('stop\n');
      await vi.advanceTimersByTimeAsync(25_000);
      expect(children[1].kill).not.toHaveBeenCalled();
      // Emitting natural final exit at 25.0s resolves without SIGTERM
      children[1].emit('exit', 0);
      await mlxStop;
      expect(children[1].kill).not.toHaveBeenCalled();

      // 3. Hung Qwen MLX helper is still bounded and SIGTERM-killed at 45_000ms
      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      const mlxHungStop = voice.stopListening({ abort: false });
      await vi.advanceTimersByTimeAsync(44_900);
      expect(children[2].kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      await mlxHungStop;
      expect(children[2].kill).toHaveBeenCalledWith('SIGTERM');

      // 4. abort=true SIGTERMs MLX helper immediately without waiting
      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      await voice.stopListening({ abort: true });
      expect(children[3].kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
    await voice.dispose();
  });

  it('keeps resident MLX serve worker alive across utterances, suppresses prewarm HUD events, shuts down on switch/dispose, and respawns after crash', async () => {
    const weights = Buffer.from('mlx-serve-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-serve-0.6b',
        revision: 'rev06',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-serve-1.7b',
        revision: 'rev17',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const spawnedWorkers: Array<{ bin: string; args: string[]; proc: ReturnType<typeof createFakeChildProcess> }> = [];
    const rendererEvents: PcAppVoiceEvent[] = [];
    const hudEvents: PcAppVoiceEvent[] = [];

    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech-mlx',
      isMlxSupported: () => true,
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/session/1',
      sendToRenderer: (_ch, payload) => rendererEvents.push(payload),
      onVoiceEvent: (ev) => hudEvents.push(ev),
      getMediaAccessStatus: () => 'granted',
      manifests,
      mirrorOrigins: ['https://hf-mirror.com'],
      fetchModel: async () => new Response(new Uint8Array(weights), { status: 200 }),
      runHelperAsync: async () => JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      spawnHelper: (bin, args) => {
        const proc = createFakeChildProcess();
        spawnedWorkers.push({ bin, args, proc });
        return proc as unknown as ChildProcess;
      },
    });

    // 1. Selecting & downloading qwen3-0.6b prewarms `serve` in background without popping HUD
    await voice.setSpeechModel('qwen3-0.6b');
    await vi.waitFor(() => {
      expect(spawnedWorkers).toHaveLength(1);
    });
    expect(spawnedWorkers[0]!.bin).toBe('/Applications/IM.codes.app/Contents/Resources/imcodes-speech-mlx');
    expect(spawnedWorkers[0]!.args).toEqual([
      'serve',
      '--model-dir',
      (await voice.getSpeechModelStatus()).modelDir!,
      '--variant',
      '0.6b',
    ]);

    const w0 = spawnedWorkers[0]!.proc;
    w0.stdout.emit('data', '{"type":"loading","variant":"0.6b"}\n{"type":"ready","variant":"0.6b"}\n');
    expect(rendererEvents).toEqual([]);
    expect(hudEvents).toEqual([]);

    // 2. First utterance reuses prewarmed worker (no second spawn, instant start JSON)
    expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
    expect(spawnedWorkers).toHaveLength(1);
    expect(w0.stdin.write).toHaveBeenLastCalledWith('{"cmd":"start","locale":"zh-CN"}\n');

    w0.stdout.emit('data', '{"type":"start"}\n{"type":"level","value":0.5}\n{"type":"result","text":"你好","isFinal":false}\n');
    const stop1 = voice.stopListening({ abort: false });
    expect(w0.stdin.write).toHaveBeenLastCalledWith('{"cmd":"stop"}\n');
    expect(w0.stdin.end).not.toHaveBeenCalled();
    w0.stdout.emit('data', '{"type":"result","text":"你好世界","isFinal":true}\n{"type":"end"}\n');
    await stop1;

    expect(rendererEvents).toEqual([
      { type: 'start' },
      { type: 'level', value: 0.5 },
      { type: 'result', text: '你好', isFinal: false },
      { type: 'result', text: '你好世界', isFinal: true },
      { type: 'end' },
    ]);
    expect(hudEvents).toEqual(rendererEvents);

    // 3. Second utterance & abort=true still reuse the same worker without killing/ending stdin
    rendererEvents.length = 0;
    hudEvents.length = 0;
    expect(await voice.startListening({ locale: 'en-US' })).toEqual({ ok: true });
    expect(spawnedWorkers).toHaveLength(1);
    expect(w0.stdin.write).toHaveBeenLastCalledWith('{"cmd":"start","locale":"en-US"}\n');
    await voice.stopListening({ abort: true });
    expect(w0.stdin.write).toHaveBeenLastCalledWith('{"cmd":"abort"}\n');
    expect(w0.kill).not.toHaveBeenCalled();

    // 4. Switching to qwen3-1.7b shuts down 0.6b worker and spawns 1.7b serve worker
    await voice.setSpeechModel('qwen3-1.7b');
    await vi.waitFor(() => {
      expect(spawnedWorkers).toHaveLength(2);
    });
    expect(w0.stdin.write).toHaveBeenCalledWith('{"cmd":"shutdown"}\n');
    expect(w0.stdin.end).toHaveBeenCalledTimes(1);
    expect(spawnedWorkers[1]!.args[3]).toBe('--variant');
    expect(spawnedWorkers[1]!.args[4]).toBe('1.7b');

    const w1 = spawnedWorkers[1]!.proc;
    w1.stdout.emit('data', '{"type":"loading","variant":"1.7b"}\n{"type":"ready","variant":"1.7b"}\n');

    // 5. Unexpected crash clears worker so next startListening respawns cleanly
    w1.emit('exit', 1);
    expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
    expect(spawnedWorkers).toHaveLength(3);
    const w2 = spawnedWorkers[2]!.proc;

    // 6. Switching to system shuts down active worker; dispose also shuts down cleanly
    await voice.setSpeechModel('system');
    expect(w2.stdin.write).toHaveBeenCalledWith('{"cmd":"shutdown"}\n');
    await voice.dispose();
  });

  it('aligns imcodes-speech.swift Unicode paste and dev helper ad-hoc signing with codes.im.pc', () => {
    const swiftSrc = readFileSync(path.resolve(__dirname, '../native/imcodes-speech.swift'), 'utf8');
    const pasteStart = swiftSrc.indexOf('func runPasteCommand(args: [String])');
    const pasteBody = swiftSrc.slice(pasteStart, swiftSrc.indexOf('private extension Int32', pasteStart));
    expect(pasteBody).toContain('let trusted = AXIsProcessTrustedWithOptions(options)');
    expect(pasteBody).toContain('var postTrusted = CGPreflightPostEventAccess()');
    expect(pasteBody).toContain('CGRequestPostEventAccess()');
    expect(pasteBody).not.toContain('CGEventSource(stateID: .hidSystemState)');
    expect(pasteBody).toContain('CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)');
    expect(pasteBody).toContain('down.flags = []');
    expect(pasteBody).toContain('up.flags = []');
    expect(pasteBody).toContain('CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true)');
    expect(pasteBody).toContain('retDown.flags = []');
    expect(pasteBody).toContain('retUp.flags = []');
    expect(pasteBody).toContain('waitForModifierRelease()');
    expect(pasteBody).toContain('if !trusted {');
    expect(pasteBody).toContain('if !postTrusted {');
    expect(pasteBody).toContain('emitJson(["type": "error", "code": "accessibility_denied"])');
    expect(pasteBody).toContain('let pastePostEventSettleMicroseconds: useconds_t = 150_000');
    expect(pasteBody).toContain('if postedEvent {\n    usleep(pastePostEventSettleMicroseconds)\n  }');
    const emptyGuardIdx = pasteBody.indexOf('if utf16.isEmpty && !sendEnter {');
    const emptyReturnIdx = pasteBody.indexOf('return 0', emptyGuardIdx);
    const modifierWaitIdx = pasteBody.indexOf('waitForModifierRelease()');
    const unicodeLoopIdx = pasteBody.indexOf('while offset < utf16.count {');
    const unicodeUpPostIdx = pasteBody.indexOf('up.post(tap: .cghidEventTap)');
    const unicodePostedIdx = pasteBody.indexOf('postedEvent = true', unicodeUpPostIdx);
    const sendEnterIdx = pasteBody.indexOf('if sendEnter {');
    const retUpPostIdx = pasteBody.indexOf('retUp.post(tap: .cghidEventTap)');
    const retPostedIdx = pasteBody.indexOf('postedEvent = true', retUpPostIdx);
    const postSettleIdx = pasteBody.indexOf('if postedEvent {');
    const finalOkIdx = pasteBody.indexOf('emitJson(["type": "ok", "length": utf16.count, "trusted": true])');
    expect(emptyGuardIdx).toBeGreaterThan(-1);
    expect(emptyReturnIdx).toBeGreaterThan(emptyGuardIdx);
    expect(modifierWaitIdx).toBeGreaterThan(emptyReturnIdx);
    expect(unicodeLoopIdx).toBeGreaterThan(modifierWaitIdx);
    expect(unicodeUpPostIdx).toBeGreaterThan(unicodeLoopIdx);
    expect(unicodePostedIdx).toBeGreaterThan(unicodeUpPostIdx);
    expect(sendEnterIdx).toBeGreaterThan(unicodePostedIdx);
    expect(retUpPostIdx).toBeGreaterThan(sendEnterIdx);
    expect(retPostedIdx).toBeGreaterThan(retUpPostIdx);
    expect(postSettleIdx).toBeGreaterThan(retPostedIdx);
    expect(finalOkIdx).toBeGreaterThan(postSettleIdx);
    expect(pasteBody).not.toContain('"trusted": trusted');

    const detectorStart = swiftSrc.indexOf('final class ShiftDoubleTapDetector');
    const detectorBody = swiftSrc.slice(detectorStart, swiftSrc.indexOf('final class ModifierMonitor', detectorStart));
    expect(detectorBody).toContain('private let tapWindowSeconds: TimeInterval = 0.28');
    expect(detectorBody).toContain('private let maxHoldSeconds: TimeInterval = 0.60');
    expect(detectorBody).toContain('DispatchQueue.main.asyncAfter(deadline: .now() + tapWindowSeconds, execute: work)');

    const voiceIpcSrc = readFileSync(path.resolve(__dirname, '../src/voice-ipc.ts'), 'utf8');
    expect(voiceIpcSrc).toContain("'codesign'");
    expect(voiceIpcSrc).toContain("'-i', 'codes.im.pc'");
  });

  it('captures macOS mic audio via input-only AVCaptureSession without AVAudioEngine output coupling in both speech helpers', () => {
    const mlxSrc = readFileSync(
      path.resolve(__dirname, '../native/qwen3-asr/Sources/ImcodesSpeechMlx/main.swift'),
      'utf8',
    );
    const appleSpeechSrc = readFileSync(
      path.resolve(__dirname, '../native/imcodes-speech.swift'),
      'utf8',
    );

    for (const [label, src] of [['ImcodesSpeechMlx', mlxSrc], ['imcodes-speech', appleSpeechSrc]] as const) {
      expect(src, `${label} must not couple via AVAudioEngine`).not.toContain('AVAudioEngine');
      expect(src, `${label} must not bind AUHAL inputNode`).not.toContain('bindAudioInputDevice');
      expect(src, `${label} must not use inputNode`).not.toContain('inputNode');
      expect(src, `${label} must use AVCaptureSession`).toContain('AVCaptureSession');
      expect(src, `${label} must use AVCaptureDeviceInput`).toContain('AVCaptureDeviceInput');
      expect(src, `${label} must use AVCaptureAudioDataOutput`).toContain('AVCaptureAudioDataOutput');
      expect(src, `${label} must resolve AVCaptureDevice by uniqueID`).toContain('AVCaptureDevice(uniqueID:');
      expect(src, `${label} must handle runtime errors`).toContain('AVCaptureSession.runtimeErrorNotification');
      expect(src, `${label} must preserve physical input selection`).toContain('selectPreferredPhysicalInputDeviceID');
      expect(src, `${label} must detect MacBook clamshell state via IOKit`).toContain('import IOKit');
      expect(src, `${label} must query IOPMrootDomain AppleClamshellState`).toContain('AppleClamshellState');
      expect(src, `${label} must release IOPMrootDomain service handle`).toContain('IOObjectRelease(service)');
      expect(src, `${label} must exclude built-in mic when clamshell is closed`).toContain('excludeBuiltIn && transport == kAudioDeviceTransportTypeBuiltIn');
      expect(src, `${label} must fall back to non-built-in alive default when no external wired mic exists`).toContain('audioDeviceTransportType(defaultID) != kAudioDeviceTransportTypeBuiltIn');
      expect(src, `${label} must log clamshellClosed on capture start`).toContain('clamshellClosed=\\(clamshellClosed)');
      expect(src, `${label} must use weak self in capture callbacks`).toContain('[weak self]');
    }
    expect(mlxSrc).toContain('func startPcm(');
    expect(mlxSrc).toContain('func pushPcm(');
  });

  it('supports win32 DXGI probe (< 4 GB VRAM -> cpu, >= 4 GB -> directml), default 0.6B, and serve worker', async () => {
    const weights = Buffer.from('win-onnx-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'csukuangfj2/test-win-0.6b',
        revision: 'win06',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'ilmina/test-win-1.7b',
        revision: 'win17',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const gt1030Dir = path.join(tempDir, 'gt1030');
    mkdirSync(gt1030Dir, { recursive: true });
    const spawnedGt1030: Array<{ bin: string; args: string[]; proc: ReturnType<typeof createFakeChildProcess> }> = [];
    const voiceGt1030 = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: gt1030Dir,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/session/1',
      sendToRenderer: () => {},
      manifests,
      mirrorOrigins: ['https://hf-mirror.com'],
      fetchModel: async () => new Response(new Uint8Array(weights), { status: 200 }),
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          return JSON.stringify({
            ok: true,
            gpuName: 'NVIDIA GeForce GT 1030',
            vramMb: 2048,
            provider: 'directml', // even if helper reports directml, TS policy enforces < 4096 MB -> cpu
            localAsrSupported: true,
          });
        }
        if (args[0] === 'devices') {
          return JSON.stringify([
            { uid: 'wasapi-1', name: 'USB Condenser Mic', transport: 'usb', isDefault: true, isPhysical: true },
          ]);
        }
        return '{}';
      },
      spawnHelper: (bin, args) => {
        const proc = createFakeChildProcess();
        spawnedGt1030.push({ bin, args, proc });
        return proc as unknown as ChildProcess;
      },
    });

    await voiceGt1030.warmSelectedSpeechModel();
    await vi.waitFor(() => {
      expect(spawnedGt1030).toHaveLength(1);
    });
    const gtStatus = await voiceGt1030.getSpeechModelStatus();
    expect(gtStatus.selectedModel).toBe('qwen3-0.6b');
    expect(gtStatus.activeBackend).toBe('qwen3-0.6b');
    expect(gtStatus.localAsrSupported).toBe(true);
    expect(gtStatus.mlxSupported).toBe(false);
    expect(gtStatus.executionProvider).toBe('cpu');
    expect(gtStatus.gpuName).toBe('NVIDIA GeForce GT 1030');
    expect(gtStatus.vramMb).toBe(2048);
    expect(spawnedGt1030[0]!.args).toEqual([
      'serve',
      '--model-dir',
      gtStatus.modelDir!,
      '--variant',
      '0.6b',
      '--provider',
      'cpu',
    ]);

    const winDevices = await voiceGt1030.getInputDevices();
    expect(winDevices.map((d) => d.uid)).toEqual(['wasapi-1']);
    expect((await voiceGt1030.getPermissions()).nativeSpeechAvailable).toBe(true);
    await voiceGt1030.dispose();

    // RTX 4060 8 GB -> enables DirectML
    const rtxDir = path.join(tempDir, 'rtx4060');
    mkdirSync(rtxDir, { recursive: true });
    const spawnedRtx: Array<{ bin: string; args: string[] }> = [];
    const voiceRtx = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: rtxDir,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/session/1',
      sendToRenderer: () => {},
      manifests,
      mirrorOrigins: ['https://hf-mirror.com'],
      fetchModel: async () => new Response(new Uint8Array(weights), { status: 200 }),
      runHelperAsync: async () =>
        JSON.stringify({
          ok: true,
          gpuName: 'NVIDIA GeForce RTX 4060',
          vramMb: 8192,
          provider: 'directml',
          localAsrSupported: true,
        }),
      spawnHelper: (bin, args) => {
        spawnedRtx.push({ bin, args });
        return createFakeChildProcess() as unknown as ChildProcess;
      },
    });
    await voiceRtx.warmSelectedSpeechModel();
    await vi.waitFor(() => {
      expect(spawnedRtx).toHaveLength(1);
    });
    expect(voiceRtx.getSpeechModelStatusSync().executionProvider).toBe('directml');
    expect(spawnedRtx[0]!.args).toContain('directml');
    await voiceRtx.dispose();
  });

  it('persists voice deviceId, isolates remote PCM ASR sessions from HUD/local events/logs, and enforces local dictation priority', async () => {
    const modelDir = path.join(tempDir, 'speech-models', '1.7b');
    mkdirSync(modelDir, { recursive: true });
    const weights = Buffer.from('remote-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    writeFileSync(path.join(modelDir, 'weights.safetensors'), weights);
    writeFileSync(path.join(modelDir, '.verified-main'), '');
    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-1.7b' }));

    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': { choice: 'qwen3-0.6b', variant: '0.6b', repoId: 'mock/0.6b', revision: 'main', files: [] },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'mock/1.7b',
        revision: 'main',
        files: [{ filename: 'weights.safetensors', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const mlxBin = path.join(tempDir, 'imcodes-speech-mlx');
    writeFileSync(mlxBin, '#!/bin/sh\necho ready\n', { mode: 0o755 });

    const spawnedProcs: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const localVoiceEvents: PcAppVoiceEvent[] = [];
    const sentRendererChannels: Array<{ channel: string; payload: unknown }> = [];
    const handlers = new Map<string, (ev: PcAppIpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown>();
    const mainWc = { id: 'main-wc' };
    const trustedOrigins = new Set(['https://app.im.codes']);

    // Pre-model system state & unready 0.6B state MUST return null (never register as remote provider)
    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'system' }));
    const sysVoice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: (s) => s === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trustedOrigins,
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'denied',
      manifests,
    });
    expect(await sysVoice.getRemoteProviderInfo()).toBeNull();
    await sysVoice.dispose();

    const unreadyDir06 = path.join(tempDir, 'speech-models', '0.6b');
    mkdirSync(unreadyDir06, { recursive: true });
    writeFileSync(path.join(unreadyDir06, 'weights.safetensors'), Buffer.from('unverified'));
    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-0.6b' }));
    const unreadyVoice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: (s) => s === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trustedOrigins,
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'denied',
      manifests,
    });
    expect(await unreadyVoice.getRemoteProviderInfo()).toBeNull();
    await unreadyVoice.dispose();

    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-1.7b' }));
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: (s) => s === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trustedOrigins,
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: (channel, payload) => sentRendererChannels.push({ channel, payload }),
      getMediaAccessStatus: () => 'denied',
      askForMediaAccess: async () => false,
      runHelperAsync: async () => JSON.stringify({ mic: 'denied', speech: 'denied', speechAvailable: false }),
      spawnHelper: () => {
        const p = createFakeChildProcess();
        spawnedProcs.push(p);
        return p as unknown as ChildProcess;
      },
      manifests,
      onVoiceEvent: (ev) => localVoiceEvents.push(ev),
      resolveDeviceName: () => null,
    });
    voice.registerIpc({
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    });

    const trustedEv: PcAppIpcInvokeEventLike = { sender: mainWc, senderFrame: { url: 'https://app.im.codes/' } };
    const info1 = await handlers.get(PC_APP_VOICE_CHANNELS.getRemoteProviderInfo)!(trustedEv) as Record<string, unknown>;
    expect(info1).not.toBeNull();
    expect(String(info1.deviceId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(info1.model).toBe('qwen3-1.7b');
    expect(info1.modelLabel).toBe('Qwen3-ASR 1.7B');
    expect(info1.ready).toBe(true);
    expect(info1.busy).toBe(false);
    expect(info1).not.toHaveProperty('deviceName');
    expect(info1).not.toHaveProperty('platform');

    const deviceIdFile = path.join(tempDir, 'voice-device-id.json');
    expect(existsSync(deviceIdFile)).toBe(true);
    expect(statSync(deviceIdFile).mode & 0o777).toBe(0o600);

    // Remote events arrive ONLY on subscribeRemoteEvents / remoteEvent channel, even when local mic permission is denied!
    const remoteEvents: unknown[] = [];
    const unsubRemote = voice.subscribeRemoteEvents((ev) => remoteEvents.push(ev));

    const startRes = await handlers.get(PC_APP_VOICE_CHANNELS.startRemoteSession)!(trustedEv, {
      sessionId: 'rem-1',
      locale: 'zh-Hans',
    });
    expect(startRes).toEqual({ ok: true });
    expect(spawnedProcs).toHaveLength(1);
    const proc = spawnedProcs[0]!;
    proc.stdout.emit('data', '{"type":"ready","variant":"1.7b"}\n');
    expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"cmd":"start_pcm"'));

    // Concurrent second remote session rejected as busy
    expect(await voice.startRemoteSession({ sessionId: 'rem-2' })).toEqual({ ok: false, error: 'busy' });

    // Oversized or malformed PCM chunk rejected safely without crashing
    expect(voice.pushRemotePcm({ sessionId: 'rem-1', pcmBase64: '!!!bad' })).toEqual({ ok: false, error: 'invalid_pcm' });
    expect(voice.pushRemotePcm({ sessionId: 'unknown', pcmBase64: Buffer.alloc(16).toString('base64') })).toEqual({
      ok: false,
      error: 'session_not_found',
    });

    const pcmB64 = Buffer.alloc(320, 2).toString('base64');
    expect(await handlers.get(PC_APP_VOICE_CHANNELS.pushRemotePcm)!(trustedEv, {
      sessionId: 'rem-1',
      pcmBase64: pcmB64,
    })).toEqual({ ok: true });
    expect(proc.stdin.write).toHaveBeenCalledWith(JSON.stringify({ cmd: 'pcm', data: pcmB64 }) + '\n');

    proc.stdout.emit('data', '{"type":"start"}\n');
    proc.stdout.emit('data', '{"type":"result","text":"远程语音","isFinal":false}\n');

    const stopPromise = handlers.get(PC_APP_VOICE_CHANNELS.stopRemoteSession)!(trustedEv, { sessionId: 'rem-1' });
    expect(proc.stdin.write).toHaveBeenCalledWith(JSON.stringify({ cmd: 'stop' }) + '\n');
    proc.stdout.emit('data', '{"type":"result","text":"远程语音测试","isFinal":true}\n');
    proc.stdout.emit('data', '{"type":"end"}\n');
    expect(await stopPromise).toEqual({ ok: true });

    // Local HUD, local composer channel, and voice.log NEVER saw a single remote event or remote transcript
    expect(localVoiceEvents).toEqual([]);
    expect(sentRendererChannels.filter((e) => e.channel === PC_APP_VOICE_CHANNELS.event)).toEqual([]);
    const voiceLogPath = path.join(tempDir, 'voice.log');
    if (existsSync(voiceLogPath)) {
      const logContent = readFileSync(voiceLogPath, 'utf8');
      expect(logContent).not.toContain('远程语音');
      expect(logContent).not.toContain('远程语音测试');
    }
    expect(remoteEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'voice.session.ready', sessionId: 'rem-1' }),
        expect.objectContaining({ type: 'voice.session.result', sessionId: 'rem-1', text: '远程语音', isFinal: false }),
        expect.objectContaining({ type: 'voice.session.result', sessionId: 'rem-1', text: '远程语音测试', isFinal: true }),
        expect.objectContaining({ type: 'voice.session.end', sessionId: 'rem-1' }),
      ]),
    );

    // Native worker error with sensitive path/hostname strips message and maps unknown code to helper_error
    expect(await voice.startRemoteSession({ sessionId: 'rem-err' })).toEqual({ ok: true });
    proc.stdout.emit('data', JSON.stringify({
      type: 'error',
      code: 'mlx_internal_host_crash',
      message: '/Users/k/secret/path on Mac-Studio.local RTX4090 failed',
    }) + '\n');
    expect(remoteEvents).toEqual(
      expect.arrayContaining([
        { type: 'voice.session.error', sessionId: 'rem-err', code: 'helper_error' },
      ]),
    );
    const leaked = remoteEvents.find((e) => (e as { sessionId?: string }).sessionId === 'rem-err') as Record<string, unknown>;
    expect(leaked).not.toHaveProperty('message');
    await voice.stopRemoteSession({ sessionId: 'rem-err', abort: true });

    // Local priority preemption test: start rem-3, then local user starts dictating -> rem-3 is aborted with provider_busy!
    unsubRemote();
    const preemptedEvents: unknown[] = [];
    const unsub2 = voice.subscribeRemoteEvents((ev) => preemptedEvents.push(ev));
    const voice2 = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: (s) => s === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trustedOrigins,
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
      runHelperAsync: async () => JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      spawnHelper: () => createFakeChildProcess() as unknown as ChildProcess,
      manifests,
    });
    // Persistent deviceId reused across controller instances!
    expect((await voice2.getRemoteProviderInfo())?.deviceId).toBe(info1.deviceId);
    const v2Events: unknown[] = [];
    voice2.subscribeRemoteEvents((ev) => v2Events.push(ev));
    expect(await voice2.startRemoteSession({ sessionId: 'rem-preempt' })).toEqual({ ok: true });
    expect(await voice2.startListening({ source: 'global', onEvent: () => {} })).toEqual({ ok: true });
    expect(v2Events).toEqual(
      expect.arrayContaining([
        { type: 'voice.session.error', sessionId: 'rem-preempt', code: 'provider_busy' },
      ]),
    );
    const preemptErr = v2Events.find((e) => (e as { sessionId?: string }).sessionId === 'rem-preempt') as Record<string, unknown>;
    expect(preemptErr).not.toHaveProperty('message');
    // While local listening is active, remote session refuses with busy
    expect(await voice2.startRemoteSession({ sessionId: 'rem-blocked' })).toEqual({ ok: false, error: 'busy' });

    unsub2();
    expect(preemptedEvents).toEqual([]);
    await voice2.dispose();

    // Switching selectedModel back to system emits provider.info = null
    const afterSwitchEvents: unknown[] = [];
    const unsubSwitch = voice.subscribeRemoteEvents((ev) => afterSwitchEvents.push(ev));
    await voice.setSpeechModel('system');
    expect(await voice.getRemoteProviderInfo()).toBeNull();
    expect(afterSwitchEvents).toEqual(expect.arrayContaining([{ type: 'provider.info', info: null }]));
    unsubSwitch();

    await voice.dispose();
  });

  it('auto-aborts orphaned remote sessions after idle timeout, keeps long active PCM alive, prevents double-end on graceful stop, and handles wildcard orphan cleanup', async () => {
    const modelDir = path.join(tempDir, 'speech-models', '1.7b');
    mkdirSync(modelDir, { recursive: true });
    const weights = Buffer.from('remote-weights-idle');
    const sha = createHash('sha256').update(weights).digest('hex');
    writeFileSync(path.join(modelDir, 'weights.safetensors'), weights);
    writeFileSync(path.join(modelDir, '.verified-main'), '');
    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-1.7b' }));

    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': { choice: 'qwen3-0.6b', variant: '0.6b', repoId: 'mock/0.6b', revision: 'main', files: [] },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'mock/1.7b',
        revision: 'main',
        files: [{ filename: 'weights.safetensors', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const mlxBin = path.join(tempDir, 'imcodes-speech-mlx');
    writeFileSync(mlxBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const mainWc = { id: 91 };
    const spawned: ReturnType<typeof createFakeChildProcess>[] = [];
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      remoteSessionIdleTimeoutMs: 60,
      isMainWebContents: (s) => s === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
      runHelperAsync: async () => JSON.stringify({ mic: 'granted', speech: 'granted', speechAvailable: true }),
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        const origWrite = proc.stdin.write;
        proc.stdin.write = vi.fn((chunk: unknown) => {
          const text = typeof chunk === 'string' ? chunk : String(chunk);
          if (text.includes('"cmd":"abort"')) {
            queueMicrotask(() => {
              proc.stdout.emit('data', '{"type":"end"}\n');
            });
          }
          return origWrite(chunk);
        }) as unknown as typeof proc.stdin.write;
        spawned.push(proc);
        return proc as unknown as ChildProcess;
      },
      manifests,
    });

    const events: PcAppRemoteVoiceEvent[] = [];
    const unsub = voice.subscribeRemoteEvents((ev) => events.push(ev));

    // 1. Orphaned ready session with no pushRemotePcm / stopRemoteSession auto-aborts after idle timeout
    expect(await voice.startRemoteSession({ sessionId: 'orphan-ready' })).toEqual({ ok: true });
    const proc1 = spawned[0]!;
    proc1.stdout.emit('data', '{"type":"ready","variant":"1.7b"}\n');
    proc1.stdout.emit('data', '{"type":"start"}\n');
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(true);

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'voice.session.end' && e.sessionId === 'orphan-ready')).toBe(true);
    }, { timeout: 1_500 });
    expect(proc1.stdin.write).toHaveBeenCalledWith(JSON.stringify({ cmd: 'abort' }) + '\n');
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'provider.info', info: expect.objectContaining({ busy: false }) }),
    ]));

    // 2. Active pushRemotePcm chunks keep refreshing the idle timer past the 60ms timeout without aborting
    events.length = 0;
    expect(await voice.startRemoteSession({ sessionId: 'long-utterance' })).toEqual({ ok: true });
    const pcmChunk = Buffer.alloc(320, 3).toString('base64');
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      expect(voice.pushRemotePcm({ sessionId: 'long-utterance', pcmBase64: pcmChunk })).toEqual({ ok: true });
    }
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(true);
    expect(events.some((e) => e.type === 'voice.session.end' && e.sessionId === 'long-utterance')).toBe(false);

    // 3. Graceful stopRemoteSession drains without idle timer double-emitting voice.session.end
    const stopPromise = voice.stopRemoteSession({ sessionId: 'long-utterance', abort: false });
    await new Promise((r) => setTimeout(r, 90));
    expect(events.filter((e) => e.type === 'voice.session.end' && e.sessionId === 'long-utterance')).toHaveLength(0);
    proc1.stdout.emit('data', '{"type":"result","text":"长语音完成","isFinal":true}\n');
    proc1.stdout.emit('data', '{"type":"end"}\n');
    expect(await stopPromise).toEqual({ ok: true });
    expect(events.filter((e) => e.type === 'voice.session.end' && e.sessionId === 'long-utterance')).toHaveLength(1);
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(false);

    // 4. Wildcard abort cleans up active remote session (e.g. renderer reload), but leaves local dictation untouched
    events.length = 0;
    expect(await voice.startRemoteSession({ sessionId: 'orphan-wildcard' })).toEqual({ ok: true });
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(true);
    expect(await voice.stopRemoteSession({ sessionId: '*', abort: true })).toEqual({ ok: true });
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(false);
    expect(events.filter((e) => e.type === 'voice.session.end' && e.sessionId === 'orphan-wildcard')).toHaveLength(1);

    // Wildcard abort during local dictation must NOT stop local listening
    expect(await voice.startListening({ source: 'global', onEvent: () => {} })).toEqual({ ok: true });
    proc1.stdin.write.mockClear();
    expect(await voice.stopRemoteSession({ sessionId: '*', abort: true })).toEqual({ ok: true });
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(true);

    // Scoped in-app stopListening (e.g. mic-test cleanup on window close) must NOT abort active global dictation
    await voice.stopListening({ abort: true, source: 'in-app' });
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(true);
    expect(proc1.stdin.write).not.toHaveBeenCalledWith(JSON.stringify({ cmd: 'abort' }) + '\n');

    // Scoped in-app stopListening DOES abort active in-app listening
    expect(await voice.startListening({ source: 'in-app', onEvent: () => {} })).toEqual({ ok: true });
    proc1.stdin.write.mockClear();
    await voice.stopListening({ abort: true, source: 'in-app' });
    expect((await voice.getRemoteProviderInfo())?.busy).toBe(false);
    expect(proc1.stdin.write).toHaveBeenCalledWith(JSON.stringify({ cmd: 'abort' }) + '\n');

    unsub();
    await voice.dispose();
  });

  it('forwards chunked prefill PCM on live fallback start and decodes finalizeOnly without opening mic', async () => {
    const modelDir = path.join(tempDir, 'speech-models', '0.6b');
    mkdirSync(modelDir, { recursive: true });
    const weights = Buffer.from('weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    writeFileSync(path.join(modelDir, 'weights.safetensors'), weights);
    writeFileSync(path.join(modelDir, '.verified-main'), '');
    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-0.6b' }));
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'mock/0.6b',
        revision: 'main',
        files: [{ filename: 'weights.safetensors', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': { choice: 'qwen3-1.7b', variant: '1.7b', repoId: 'mock/1.7b', revision: 'main', files: [] },
    };
    const mlxHelperPath = path.join(tempDir, 'imcodes-speech-mlx');
    writeFileSync(mlxHelperPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const mainWc = { id: 99 };
    const spawned: ReturnType<typeof createFakeChildProcess>[] = [];
    const handlers = new Map<string, (ev: PcAppIpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown>();
    const ipcMain: PcAppIpcMainLike = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    };
    const sentEvents: PcAppVoiceEvent[] = [];
    const askForMediaAccess = vi.fn(async () => true);
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: (s) => s === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: (_ch, payload) => sentEvents.push(payload),
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess,
      runHelperAsync: async () => JSON.stringify({ mic: 'granted', speech: 'granted', speechAvailable: true }),
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        const origWrite = proc.stdin.write;
        proc.stdin.write = vi.fn((chunk: unknown) => {
          const text = typeof chunk === 'string' ? chunk : String(chunk);
          if (text.includes('"cmd":"abort"')) {
            queueMicrotask(() => {
              proc.stdout.emit('data', '{"type":"end"}\n');
            });
          }
          return origWrite(chunk);
        }) as unknown as typeof proc.stdin.write;
        spawned.push(proc);
        return proc as unknown as ChildProcess;
      },
      manifests,
    });
    voice.registerIpc(ipcMain);

    const startHandler = handlers.get(PC_APP_VOICE_CHANNELS.startListening)!;
    const trustedEv: PcAppIpcInvokeEventLike = {
      sender: mainWc,
      senderFrame: { url: 'https://app.im.codes/s/1' },
    };

    // 1. Live fallback with >64KB PCM (~96KB = 48,000 samples) chunks into <=64KB prefill_pcm lines before start
    const pcmSamples = new Int16Array(48_000);
    for (let i = 0; i < pcmSamples.length; i += 1) {
      pcmSamples[i] = (i % 200) - 100;
    }
    const prefillBuf = Buffer.from(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength);
    const prefillB64 = prefillBuf.toString('base64');

    const startP = startHandler(trustedEv, { locale: 'zh-CN', initialPcmBase64: prefillB64 });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const proc = spawned[0]!;
    proc.stdout.emit('data', '{"type":"ready","variant":"0.6b"}\n');
    expect(await startP).toEqual({ ok: true });
    const cmds = proc.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
    expect(cmds[0]).toEqual({ cmd: 'prefill_reset' });
    expect(cmds[1].cmd).toBe('prefill_pcm');
    expect(cmds[2].cmd).toBe('prefill_pcm');
    expect(cmds[3]).toEqual({ cmd: 'start', locale: 'zh-CN' });
    const reassembled = Buffer.concat([
      Buffer.from(cmds[1].data, 'base64'),
      Buffer.from(cmds[2].data, 'base64'),
    ]);
    expect(Buffer.from(cmds[1].data, 'base64').length).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.from(cmds[2].data, 'base64').length).toBeLessThanOrEqual(64 * 1024);
    expect(reassembled.equals(prefillBuf)).toBe(true);

    proc.stdout.emit('data', '{"type":"end"}\n');

    // 2. finalizeOnly sends start_pcm -> pcm chunks -> stop without calling mic requestPermissions or cmd=start
    proc.stdin.write.mockClear();
    askForMediaAccess.mockClear();
    sentEvents.length = 0;
    expect(await startHandler(trustedEv, { locale: 'en-US', initialPcmBase64: prefillB64, finalizeOnly: true })).toEqual({ ok: true });
    expect(askForMediaAccess).not.toHaveBeenCalled();
    const finCmds = proc.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
    expect(finCmds[0]).toEqual({ cmd: 'start_pcm', locale: 'en-US' });
    expect(finCmds[1].cmd).toBe('pcm');
    expect(finCmds[2].cmd).toBe('pcm');
    expect(finCmds[3]).toEqual({ cmd: 'stop' });

    proc.stdout.emit('data', '{"type":"start"}\n');
    proc.stdout.emit('data', '{"type":"result","text":"offline prefill done","isFinal":true}\n');
    proc.stdout.emit('data', '{"type":"end"}\n');
    expect(sentEvents).toEqual(expect.arrayContaining([
      { type: 'start' },
      { type: 'result', text: 'offline prefill done', isFinal: true },
      { type: 'end' },
    ]));

    // 3. Invalid/empty PCM rejects cleanly without starting capture
    expect(await startHandler(trustedEv, { initialPcmBase64: '!!!invalid!!!' })).toEqual({ ok: false, error: 'invalid_pcm' });
    expect(await startHandler(trustedEv, { initialPcmBase64: '', finalizeOnly: true })).toEqual({ ok: false, error: 'empty_pcm' });

    await voice.dispose();
  });

  it('cancels pending start/finalize requests when stopListening({ abort: true }) arrives while awaiting resident worker startup', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-voice-cancel-race-'));
    const modelDir = path.join(tempDir, 'speech-models', '0.6b');
    mkdirSync(modelDir, { recursive: true });
    const weights = Buffer.from('weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    writeFileSync(path.join(modelDir, 'weights.safetensors'), weights);
    writeFileSync(path.join(modelDir, '.verified-main'), '');
    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-0.6b' }));
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'mock/0.6b',
        revision: 'main',
        files: [{ filename: 'weights.safetensors', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': { choice: 'qwen3-1.7b', variant: '1.7b', repoId: 'mock/1.7b', revision: 'main', files: [] },
    };

    const mlxHelperPath = path.join(tempDir, 'imcodes-speech-mlx');
    writeFileSync(mlxHelperPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const mainWc = { id: 101 };
    const spawned: ReturnType<typeof createFakeChildProcess>[] = [];
    const handlers = new Map<string, (ev: PcAppIpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown>();
    const ipcMain: PcAppIpcMainLike = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
    };
    let releaseMlxSupport!: (supported: boolean) => void;
    let mlxSupportGate = new Promise<boolean>((res) => {
      releaseMlxSupport = res;
    });
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath,
      useResidentMlxWorker: true,
      isMlxSupported: () => mlxSupportGate,
      isMainWebContents: (s) => s === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
      runHelperAsync: async () => JSON.stringify({ mic: 'granted', speech: 'granted', speechAvailable: true }),
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        const origWrite = proc.stdin.write;
        proc.stdin.write = vi.fn((chunk: unknown) => {
          const text = typeof chunk === 'string' ? chunk : String(chunk);
          if (text.includes('"cmd":"abort"')) {
            queueMicrotask(() => {
              proc.stdout.emit('data', '{"type":"end"}\n');
            });
          }
          return origWrite(chunk);
        }) as unknown as typeof proc.stdin.write;
        spawned.push(proc);
        return proc as unknown as ChildProcess;
      },
      manifests,
    });
    voice.registerIpc(ipcMain);

    const startHandler = handlers.get(PC_APP_VOICE_CHANNELS.startListening)!;
    const finalizeHandler = handlers.get(PC_APP_VOICE_CHANNELS.finalizePcmListening)!;
    const stopHandler = handlers.get(PC_APP_VOICE_CHANNELS.stopListening)!;
    const trustedEv: PcAppIpcInvokeEventLike = {
      sender: mainWc,
      senderFrame: { url: 'https://app.im.codes/s/1' },
    };

    const pcmBuf = Buffer.from(new Int16Array([3000, -3000, 4000, -4000]).buffer);
    const pcmB64 = pcmBuf.toString('base64');

    // A. finalizePcmListening is awaiting checkMlxSupported/worker readiness; stopListening({ abort: true }) arrives BEFORE it resolves.
    const abortedFinP = finalizeHandler(trustedEv, { locale: 'zh-CN', pcmBase64: pcmB64 });
    await Promise.resolve();
    await stopHandler(trustedEv, { abort: true });
    releaseMlxSupport(true);
    expect(await abortedFinP).toEqual({ ok: false, error: 'cancelled' });
    expect(spawned).toHaveLength(0);

    // B. Normal stopListening({ abort: false }) while finalizePcmListening is awaiting must NOT cancel finalizePcmListening;
    // subsequent stopListening({ abort: true }) during active startListening cancels it without touching worker stdin.
    const slowFinalizeP = finalizeHandler(trustedEv, { locale: 'zh-CN', pcmBase64: pcmB64 });
    await stopHandler(trustedEv, { abort: false });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const proc = spawned[0]!;
    proc.stdout.emit('data', '{"type":"ready","variant":"0.6b"}\n');
    expect(await slowFinalizeP).toEqual({ ok: true });
    const cmdsA = proc.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
    expect(cmdsA[0]).toEqual({ cmd: 'start_pcm', locale: 'zh-CN' });
    expect(cmdsA[1].cmd).toBe('pcm');
    expect(cmdsA[2]).toEqual({ cmd: 'stop' });
    proc.stdout.emit('data', '{"type":"start"}\n{"type":"end"}\n');

    // C. Subsequent finalizePcmListening after prior aborted startup runs normally on the ready worker.
    proc.stdin.write.mockClear();
    expect(await finalizeHandler(trustedEv, { locale: 'en-US', pcmBase64: pcmB64 })).toEqual({ ok: true });
    const cmds = proc.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line).trim()));
    expect(cmds[0]).toEqual({ cmd: 'start_pcm', locale: 'en-US' });
    expect(cmds[1].cmd).toBe('pcm');
    expect(cmds[2]).toEqual({ cmd: 'stop' });

    await voice.dispose();
  });

  it('logs concise non-sensitive rejection reasons to voice.log on every non-ok startRemoteSession path', async () => {
    const modelDir = path.join(tempDir, 'speech-models', '1.7b');
    mkdirSync(modelDir, { recursive: true });
    const weights = Buffer.from('remote-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    writeFileSync(path.join(modelDir, 'weights.safetensors'), weights);
    writeFileSync(path.join(modelDir, '.verified-main'), '');
    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-1.7b' }));

    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': { choice: 'qwen3-0.6b', variant: '0.6b', repoId: 'mock/0.6b', revision: 'main', files: [] },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'mock/1.7b',
        revision: 'main',
        files: [{ filename: 'weights.safetensors', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const mlxBin = path.join(tempDir, 'imcodes-speech-mlx');
    writeFileSync(mlxBin, '#!/bin/sh\necho ready\n', { mode: 0o755 });

    const spawned: Array<ReturnType<typeof createFakeChildProcess>> = [];
    let throwOnWrite = false;
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        const origWrite = proc.stdin.write;
        proc.stdin.write = vi.fn((chunk: string) => {
          if (throwOnWrite && chunk.includes('"start_pcm"')) {
            throw Object.assign(new Error('broken_pipe https://example.invalid/?ticket=SECRET_WRITE_TOKEN'), {
              code: 'EPIPE',
            });
          }
          return origWrite(chunk);
        }) as typeof proc.stdin.write;
        spawned.push(proc);
        return proc as unknown as ChildProcess;
      },
      manifests,
    });

    // 1. invalid_session (must never persist raw untrusted sessionId payload)
    expect(await voice.startRemoteSession({ sessionId: 'bad id SECRET_INVALID_SESSION_TICKET' })).toEqual({
      ok: false,
      error: 'invalid_session',
    });

    // 2. worker_write_failed
    throwOnWrite = true;
    const writeFailP = voice.startRemoteSession({ sessionId: 'rem-write-fail' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    spawned[0]!.stdout.emit('data', '{"type":"ready","variant":"1.7b"}\n');
    expect(await writeFailP).toEqual({ ok: false, error: 'worker_write_failed' });

    // 3. busy (concurrent remote session)
    throwOnWrite = false;
    const activeP = voice.startRemoteSession({ sessionId: 'rem-active' });
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    spawned[1]!.stdout.emit('data', '{"type":"ready","variant":"1.7b"}\n');
    expect(await activeP).toEqual({ ok: true });
    expect(await voice.startRemoteSession({ sessionId: 'rem-busy-2' })).toEqual({ ok: false, error: 'busy' });

    // 4. not_ready after dispose (controller_disposed)
    await voice.dispose();
    expect(await voice.startRemoteSession({ sessionId: 'rem-after-dispose' })).toEqual({
      ok: false,
      error: 'not_ready',
    });

    // 5. not_ready when mlx unsupported
    const noMlxVoice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: false,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      manifests,
    });
    expect(await noMlxVoice.startRemoteSession({ sessionId: 'rem-no-mlx' })).toEqual({
      ok: false,
      error: 'not_ready',
    });
    await noMlxVoice.dispose();

    const voiceLog = readFileSync(path.join(tempDir, 'voice.log'), 'utf8');
    expect(voiceLog).toContain('startRemoteSession rejected reason=invalid_session');
    expect(voiceLog).not.toContain('SECRET_INVALID_SESSION_TICKET');
    expect(voiceLog).toContain('startRemoteSession rejected reason=worker_write_failed sessionId=rem-write-fail code=EPIPE');
    expect(voiceLog).not.toContain('SECRET_WRITE_TOKEN');
    expect(voiceLog).not.toContain('example.invalid');
    expect(voiceLog).toContain('startRemoteSession rejected reason=busy detail=already_active localActive=false remoteActive=true sessionId=rem-busy-2');
    expect(voiceLog).toContain('startRemoteSession rejected reason=not_ready detail=controller_disposed sessionId=rem-after-dispose');
    expect(voiceLog).toContain('startRemoteSession rejected reason=not_ready detail=mlx_unsupported sessionId=rem-no-mlx');
  });

  it('resolves, sanitizes, and asynchronously broadcasts non-localhost machine deviceName on getRemoteProviderInfo()', async () => {
    const modelDir = path.join(tempDir, 'speech-models', '1.7b');
    mkdirSync(modelDir, { recursive: true });
    const weights = Buffer.from('remote-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    writeFileSync(path.join(modelDir, 'weights.safetensors'), weights);
    writeFileSync(path.join(modelDir, '.verified-main'), '');
    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-1.7b' }));
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': { choice: 'qwen3-0.6b', variant: '0.6b', repoId: 'mock/0.6b', revision: 'main', files: [] },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'mock/1.7b',
        revision: 'main',
        files: [{ filename: 'weights.safetensors', expectedSize: weights.length, expectedSha256: sha }],
      },
    };
    const mlxBin = path.join(tempDir, 'imcodes-speech-mlx');
    writeFileSync(mlxBin, '#!/bin/sh\necho ready\n', { mode: 0o755 });

    const { normalizePcAppDeviceName } = await import('../src/voice-ipc.js');
    expect(normalizePcAppDeviceName('  KOCA’s MacBook Pro (1118)\n ')).toBe('KOCA’s MacBook Pro (1118)');
    expect(normalizePcAppDeviceName('DESKTOP-TVO1KU1.local')).toBe('DESKTOP-TVO1KU1');
    expect(normalizePcAppDeviceName('mac-studio.lan')).toBe('mac-studio');
    expect(normalizePcAppDeviceName('localhost')).toBeUndefined();
    expect(normalizePcAppDeviceName('localhost.local')).toBeUndefined();
    expect(normalizePcAppDeviceName('127.0.0.1')).toBeUndefined();
    expect(normalizePcAppDeviceName('x'.repeat(90))?.length).toBe(64);

    // 1. Async resolution triggers updated provider.info with sanitized deviceName, hostname, and localServerId
    let resolveName!: (v: string | null) => void;
    const remoteEvents: PcAppRemoteVoiceEvent[] = [];
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      manifests,
      resolveDeviceName: () => new Promise<string | null>((res) => { resolveName = res; }),
      resolveHostname: () => 'm3-workstation.local',
      getLocalBoundServerId: () => 'srv-bound-1',
    });
    const unsub = voice.subscribeRemoteEvents((ev) => remoteEvents.push(ev));
    const infoP = voice.getRemoteProviderInfo();
    resolveName('  KOCA’s MacBook Pro (1118).local\t');
    const info = await infoP;
    expect(info).toMatchObject({
      model: 'qwen3-1.7b',
      deviceName: 'KOCA’s MacBook Pro (1118)',
      hostname: 'm3-workstation',
      localServerId: 'srv-bound-1',
      ready: true,
    });
    expect(remoteEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'provider.info',
          info: expect.objectContaining({
            deviceName: 'KOCA’s MacBook Pro (1118)',
            hostname: 'm3-workstation',
            localServerId: 'srv-bound-1',
          }),
        }),
      ]),
    );
    unsub();
    await voice.dispose();

    // 2. Generic localhost or invalid localServerId degrades gracefully and omits them
    const localhostVoice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      manifests,
      resolveDeviceName: () => 'localhost.localdomain',
      resolveHostname: () => 'localhost',
      getLocalBoundServerId: () => 'invalid id with spaces',
    });
    const localhostInfo = await localhostVoice.getRemoteProviderInfo();
    expect(localhostInfo).not.toBeNull();
    expect(localhostInfo).not.toHaveProperty('deviceName');
    expect(localhostInfo).not.toHaveProperty('hostname');
    expect(localhostInfo).not.toHaveProperty('localServerId');
    await localhostVoice.dispose();

    // 3. macOS fallback chain normalizes each candidate before ??: ComputerName='localhost' advances to LocalHostName
    const scutilKeysCalled: string[] = [];
    const darwinFallbackVoice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: mlxBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      manifests,
      readDarwinSysctlValue: async (key) => {
        scutilKeysCalled.push(key);
        return key === 'ComputerName' ? 'localhost' : 'm3-studio.local';
      },
      getOsHostname: () => 'localhost.localdomain',
    });
    const darwinFallbackInfo = await darwinFallbackVoice.getRemoteProviderInfo();
    expect(scutilKeysCalled).toEqual(['ComputerName', 'LocalHostName']);
    expect(darwinFallbackInfo).toMatchObject({ deviceName: 'm3-studio' });
    expect(darwinFallbackInfo).not.toHaveProperty('hostname');
    await darwinFallbackVoice.dispose();

    // 4. Windows fallback chain normalizes COMPUTERNAME before ??: invalid COMPUTERNAME falls through to os.hostname()
    const winBin = path.join(tempDir, 'imcodes-speech-win.exe');
    writeFileSync(winBin, 'stub');
    const winFallbackVoice = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: tempDir,
      winSpeechHelperPath: winBin,
      useResidentMlxWorker: true,
      isMlxSupported: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      getMediaAccessStatus: () => 'granted',
      manifests,
      runHelperAsync: async (_bin, args) => (
        args[0] === 'probe'
          ? JSON.stringify({ ok: true, provider: 'cpu', directmlEligible: false, localAsrSupported: true })
          : ''
      ),
      getEnvComputerName: () => 'localhost',
      getOsHostname: () => 'DESKTOP-WIN-99.lan',
    });
    const winFallbackInfo = await winFallbackVoice.getRemoteProviderInfo();
    expect(winFallbackInfo).toMatchObject({
      deviceName: 'DESKTOP-WIN-99',
      hostname: 'DESKTOP-WIN-99',
    });
    await winFallbackVoice.dispose();
  });

  it('win32 rejects stub/crashing probe (localAsrSupported: false / error) and immediately disables online readiness on sherpa_onnx_unavailable', async () => {
    const weights = Buffer.from('win-sherpa-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'csukuangfj2/test-win-0.6b',
        revision: 'win06',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'ilmina/test-win-1.7b',
        revision: 'win17',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    // 1. Stub probe reporting localAsrSupported: false -> never advertises online or ready
    const stubDir = path.join(tempDir, 'win-stub-probe');
    mkdirSync(stubDir, { recursive: true });
    const stubVoice = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: stubDir,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          return JSON.stringify({
            ok: true,
            gpuName: 'NVIDIA GeForce GT 1030',
            vramMb: 1967,
            provider: 'cpu',
            directmlEligible: false,
            localAsrSupported: false,
          });
        }
        return '[]';
      },
    });
    expect(await stubVoice.getRemoteProviderInfo()).toBeNull();
    const stubStatus = await stubVoice.getSpeechModelStatus();
    expect(stubStatus.localAsrSupported).toBe(false);
    expect(stubStatus.activeBackend).toBe('system');
    expect(stubStatus.models['qwen3-0.6b'].state).toBe('unsupported');
    expect(stubStatus.models['qwen3-1.7b'].state).toBe('unsupported');
    expect(await stubVoice.startRemoteSession({ sessionId: 'rem-win-stub' })).toEqual({
      ok: false,
      error: 'not_ready',
    });
    await stubVoice.dispose();

    // 2. Crashing probe (e.g. missing DLL) -> fails closed (false), never true
    const crashDir = path.join(tempDir, 'win-crash-probe');
    mkdirSync(crashDir, { recursive: true });
    const crashVoice = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: crashDir,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async () => {
        throw new Error('STATUS_DLL_NOT_FOUND');
      },
    });
    expect(await crashVoice.getRemoteProviderInfo()).toBeNull();
    expect((await crashVoice.getSpeechModelStatus()).localAsrSupported).toBe(false);
    await crashVoice.dispose();

    // 3. Background prewarm emitting sherpa_onnx_unavailable -> emits provider.info: null + status unsupported
    const bgDir = path.join(tempDir, 'win-bg-unavail');
    mkdirSync(path.join(bgDir, 'speech-models', '0.6b'), { recursive: true });
    writeFileSync(path.join(bgDir, 'speech-models', '0.6b', 'encoder.int8.onnx'), weights);
    const bgSpawned: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const bgRemoteEvents: Array<Record<string, unknown>> = [];
    const bgStatusUpdates: Array<PcAppSpeechModelStatus> = [];
    const bgVoice = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: bgDir,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      onSpeechModelStatusChanged: (st) => bgStatusUpdates.push(st),
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          return JSON.stringify({
            ok: true,
            gpuName: 'NVIDIA GeForce GT 1030',
            vramMb: 2048,
            provider: 'cpu',
            localAsrSupported: true,
          });
        }
        return '[]';
      },
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        bgSpawned.push(proc);
        return proc as unknown as ChildProcess;
      },
    });
    bgVoice.subscribeRemoteEvents((ev) => bgRemoteEvents.push(ev as unknown as Record<string, unknown>));
    await bgVoice.warmSelectedSpeechModel();
    await vi.waitFor(() => expect(bgSpawned).toHaveLength(1));
    expect((await bgVoice.getRemoteProviderInfo())?.ready).toBe(true);

    bgSpawned[0]!.stdout.emit(
      'data',
      '{"type":"error","code":"sherpa_onnx_unavailable","message":"Built without sherpa-onnx C API support"}\n',
    );
    bgSpawned[0]!.emit('exit', 1, null);

    expect(bgVoice.getSpeechModelStatusSync().localAsrSupported).toBe(false);
    expect(bgVoice.getSpeechModelStatusSync().state).toBe('unsupported');
    expect(bgRemoteEvents.some((ev) => ev.type === 'provider.info' && ev.info === null)).toBe(true);
    expect(bgStatusUpdates.at(-1)?.localAsrSupported).toBe(false);
    expect(await bgVoice.getRemoteProviderInfo()).toBeNull();
    expect(await bgVoice.startRemoteSession({ sessionId: 'rem-bg-after' })).toEqual({
      ok: false,
      error: 'not_ready',
    });
    expect(bgSpawned).toHaveLength(1);
    await bgVoice.dispose();

    // 4. Active remote session hitting sherpa_onnx_unavailable -> terminates session & drops provider offline
    const remDir = path.join(tempDir, 'win-rem-unavail');
    mkdirSync(path.join(remDir, 'speech-models', '0.6b'), { recursive: true });
    writeFileSync(path.join(remDir, 'speech-models', '0.6b', 'encoder.int8.onnx'), weights);
    writeFileSync(path.join(remDir, 'speech-models', '0.6b', '.verified-win06'), '');
    const remSpawned: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const remEvents: Array<Record<string, unknown>> = [];
    const remVoice = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: remDir,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          return JSON.stringify({
            ok: true,
            gpuName: 'NVIDIA GeForce GT 1030',
            vramMb: 2048,
            provider: 'cpu',
            localAsrSupported: true,
          });
        }
        return '[]';
      },
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        remSpawned.push(proc);
        return proc as unknown as ChildProcess;
      },
    });
    remVoice.subscribeRemoteEvents((ev) => remEvents.push(ev as unknown as Record<string, unknown>));
    const startP = remVoice.startRemoteSession({ sessionId: 'rem-win-fail' });
    await vi.waitFor(() => expect(remSpawned).toHaveLength(1));
    remSpawned[0]!.stdout.emit('data', '{"type":"ready","variant":"0.6b"}\n');
    expect(await startP).toEqual({ ok: true });

    remSpawned[0]!.stdout.emit(
      'data',
      '{"type":"error","code":"sherpa_onnx_unavailable","message":"Built without sherpa-onnx C API support"}\n',
    );
    remSpawned[0]!.emit('exit', 1, null);

    expect(remEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'provider.info', info: null }),
        expect.objectContaining({ type: 'voice.session.end', sessionId: 'rem-win-fail' }),
      ]),
    );
    expect(await remVoice.getRemoteProviderInfo()).toBeNull();
    await remVoice.dispose();
  });

  it('prevents delayed concurrent probe success or error from reverting sherpa_onnx_unavailable degradation', async () => {
    const weights = Buffer.from('win-deferred-probe-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'csukuangfj2/test-win-0.6b',
        revision: 'win06',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'ilmina/test-win-1.7b',
        revision: 'win17',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const makeCaseDir = (suffix: string) => {
      const dir = path.join(tempDir, suffix);
      mkdirSync(path.join(dir, 'speech-models', '0.6b'), { recursive: true });
      writeFileSync(path.join(dir, 'speech-models', '0.6b', 'encoder.int8.onnx'), weights);
      writeFileSync(path.join(dir, 'speech-models', '0.6b', '.verified-win06'), '');
      return dir;
    };

    // Case 1: deferred probe #1 resolves with localAsrSupported: true AFTER sherpa_onnx_unavailable
    const dir1 = makeCaseDir('win-deferred-ok');
    let resolveDeferredProbe!: (val: string) => void;
    let probeCall = 0;
    const spawned1: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const events1: Array<Record<string, unknown>> = [];
    const voice1 = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: dir1,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          probeCall += 1;
          if (probeCall === 1) {
            return new Promise<string>((resolve) => {
              resolveDeferredProbe = resolve;
            });
          }
          return JSON.stringify({
            ok: true,
            gpuName: 'NVIDIA GeForce GT 1030',
            vramMb: 2048,
            provider: 'cpu',
            localAsrSupported: true,
          });
        }
        return '[]';
      },
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        spawned1.push(proc);
        return proc as unknown as ChildProcess;
      },
    });
    voice1.subscribeRemoteEvents((ev) => events1.push(ev as unknown as Record<string, unknown>));

    const deferredInfoP = voice1.getRemoteProviderInfo();
    await voice1.warmSelectedSpeechModel();
    await vi.waitFor(() => expect(spawned1).toHaveLength(1));

    spawned1[0]!.stdout.emit(
      'data',
      '{"type":"error","code":"sherpa_onnx_unavailable","message":"Built without sherpa-onnx C API support"}\n',
    );
    spawned1[0]!.emit('exit', 1, null);
    expect(voice1.getSpeechModelStatusSync().localAsrSupported).toBe(false);
    expect(voice1.getSpeechModelStatusSync().state).toBe('unsupported');

    // Now resolve the delayed probe #1 with localAsrSupported: true
    resolveDeferredProbe(
      JSON.stringify({
        ok: true,
        gpuName: 'NVIDIA GeForce GT 1030',
        vramMb: 2048,
        provider: 'cpu',
        localAsrSupported: true,
      }),
    );
    expect(await deferredInfoP).toBeNull();
    expect(voice1.getSpeechModelStatusSync().localAsrSupported).toBe(false);
    expect(voice1.getSpeechModelStatusSync().state).toBe('unsupported');
    expect(await voice1.getRemoteProviderInfo()).toBeNull();
    expect(events1.filter((e) => e.type === 'provider.info').at(-1)).toEqual({ type: 'provider.info', info: null });

    // Subsequent remote and local dictation calls must NOT retry the unavailable backend
    expect(await voice1.startRemoteSession({ sessionId: 'rem-after-deferred' })).toEqual({
      ok: false,
      error: 'not_ready',
    });
    expect(await voice1.startListening()).toEqual({ ok: false, error: 'speech_model_downloading' });
    expect(spawned1).toHaveLength(1);
    await voice1.dispose();

    // Case 2: deferred probe #1 rejects AFTER sherpa_onnx_unavailable -> remains unsupported/null
    const dir2 = makeCaseDir('win-deferred-err');
    let rejectDeferredProbe!: (err: Error) => void;
    let probeCall2 = 0;
    const spawned2: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const voice2 = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: dir2,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          probeCall2 += 1;
          if (probeCall2 === 1) {
            return new Promise<string>((_resolve, reject) => {
              rejectDeferredProbe = reject;
            });
          }
          return JSON.stringify({
            ok: true,
            gpuName: 'NVIDIA GeForce GT 1030',
            vramMb: 2048,
            provider: 'cpu',
            localAsrSupported: true,
          });
        }
        return '[]';
      },
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        spawned2.push(proc);
        return proc as unknown as ChildProcess;
      },
    });
    const deferredInfoP2 = voice2.getRemoteProviderInfo();
    await voice2.warmSelectedSpeechModel();
    await vi.waitFor(() => expect(spawned2).toHaveLength(1));
    spawned2[0]!.stdout.emit(
      'data',
      '{"type":"error","code":"sherpa_onnx_unavailable","message":"Built without sherpa-onnx C API support"}\n',
    );
    rejectDeferredProbe(new Error('late probe timeout'));
    expect(await deferredInfoP2).toBeNull();
    expect(voice2.getSpeechModelStatusSync().localAsrSupported).toBe(false);
    expect(voice2.getSpeechModelStatusSync().state).toBe('unsupported');
    expect(spawned2).toHaveLength(1);
    await voice2.dispose();

    // Case 3: Darwin/arm64 preserves concurrent probe recovery (prior failure does not block late valid probe)
    const darwinDir = makeCaseDir('darwin-concurrent-probe-recovery');
    writeFileSync(path.join(darwinDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-0.6b' }));
    const darwinMlxBin = path.join(darwinDir, 'imcodes-speech-mlx');
    writeFileSync(darwinMlxBin, '#!/bin/sh\necho ready\n', { mode: 0o755 });
    let resolveDarwinDeferred!: (val: string) => void;
    let darwinProbeCall = 0;
    const darwinVoice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: darwinDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: darwinMlxBin,
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          darwinProbeCall += 1;
          if (darwinProbeCall === 1) {
            return new Promise<string>((resolve) => {
              resolveDarwinDeferred = resolve;
            });
          }
          throw new Error('transient darwin probe failure');
        }
        return '[]';
      },
    });
    const darwinFirstProbeP = darwinVoice.getRemoteProviderInfo();
    const darwinFailedStatus = await darwinVoice.getSpeechModelStatus();
    expect(darwinFailedStatus.mlxSupported).toBe(false);
    resolveDarwinDeferred(JSON.stringify({ mlxSupported: true }));
    await darwinFirstProbeP;
    expect(darwinVoice.getSpeechModelStatusSync().mlxSupported).toBe(true);
    expect(await darwinVoice.getRemoteProviderInfo()).not.toBeNull();
    await darwinVoice.dispose();
  });

  it('forwards per-utterance hotwords to local and remote MLX commands without modifying hotwords.txt or leaking across sessions', async () => {
    expect(normalizePcAppVoiceHotwordsContext(['  IM.codes\u0000 ', 'im.codes', 'worktree', ''])).toBe('IM.codes, worktree');
    const longTerms = Array.from({ length: 80 }, (_, i) => `Term_${i}_${'a'.repeat(30)}`);
    const boundedCtx = normalizePcAppVoiceHotwordsContext(longTerms)!;
    expect(boundedCtx.length).toBeLessThanOrEqual(1000);
    expect(boundedCtx.split(', ').length).toBeLessThanOrEqual(60);

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-voice-hotwords-'));
    let voice: ReturnType<typeof createPcAppVoiceController> | null = null;
    try {
      const weights = Buffer.alloc(10, 1);
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
      const modelDir = path.join(tempDir, 'speech-models', '1.7b');
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(path.join(modelDir, 'config.json'), weights);
      const hotwordsFilePath = path.join(modelDir, 'hotwords.txt');
      writeFileSync(hotwordsFilePath, 'StaticOne\nStaticTwo\n', 'utf8');
      writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-1.7b' }));

      const mlxBin = path.join(tempDir, 'imcodes-speech-mlx');
      writeFileSync(mlxBin, '#!/bin/sh\necho ready\n', { mode: 0o755 });

      const spawnedProcs: Array<ReturnType<typeof createFakeChildProcess>> = [];
      const handlers = new Map<string, (ev: PcAppIpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown>();
      const mainWc = { id: 'main-wc' };
      const trustedEv: PcAppIpcInvokeEventLike = { sender: mainWc, senderFrame: { url: 'https://app.im.codes/' } };

      voice = createPcAppVoiceController({
        platform: 'darwin',
        arch: 'arm64',
        userDataDir: tempDir,
        speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
        mlxHelperPath: mlxBin,
        useResidentMlxWorker: true,
        isMlxSupported: () => true,
        isMainWebContents: (s) => s === mainWc,
        getCurrentTrustedOrigin: () => 'https://app.im.codes',
        getActiveOrigin: () => 'https://app.im.codes',
        getTrustedOrigins: () => new Set(['https://app.im.codes']),
        getSenderUrl: () => 'https://app.im.codes/',
        sendToRenderer: () => {},
        getMediaAccessStatus: () => 'granted',
        askForMediaAccess: async () => true,
        runHelperAsync: async () => JSON.stringify({ mic: 'granted', speech: 'granted', speechAvailable: true }),
        spawnHelper: () => {
          const p = createFakeChildProcess();
          spawnedProcs.push(p);
          return p as unknown as ChildProcess;
        },
        manifests,
        resolveDeviceName: () => null,
      });
      voice.registerIpc({
        handle: (ch, fn) => handlers.set(ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      });

      // Wait for resident worker spawn & emit ready
      await voice.warmSelectedSpeechModel();
      await vi.waitFor(() => {
        expect(spawnedProcs).toHaveLength(1);
      });
      const proc = spawnedProcs[0]!;
      proc.stdout.emit('data', '{"type":"ready","variant":"1.7b"}\n');

      // 1) Local startListening passes structured hotwords array cleanly (keeping commas inside single term intact) and leaves hotwords.txt untouched
      const localStart1 = await handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(trustedEv, {
        locale: 'zh-Hans',
        hotwords: ['IM.codes', 'worktree', 'Codex, Claude'],
      });
      expect(localStart1).toEqual({ ok: true });
      const start1Cmd = JSON.parse(String(proc.stdin.write.mock.calls.at(-1)?.[0]).trim());
      expect(start1Cmd).toEqual({ cmd: 'start', locale: 'zh-Hans', hotwords: ['IM.codes', 'worktree', 'Codex, Claude'] });
      proc.stdout.emit('data', '{"type":"end"}\n');
      await voice.stopListening({ abort: true });

      // 2) Next local startListening without hotwords does NOT inherit prior hotwords
      const localStart2 = await handlers.get(PC_APP_VOICE_CHANNELS.startListening)!(trustedEv, { locale: 'en-US' });
      expect(localStart2).toEqual({ ok: true });
      const start2Cmd = JSON.parse(String(proc.stdin.write.mock.calls.at(-1)?.[0]).trim());
      expect(start2Cmd).toEqual({ cmd: 'start', locale: 'en-US' });
      proc.stdout.emit('data', '{"type":"end"}\n');
      await voice.stopListening({ abort: true });

      // 3) Remote session A with hotwords -> start_pcm carries structured hotwords array (preserving commas within a term)
      const rem1 = await handlers.get(PC_APP_VOICE_CHANNELS.startRemoteSession)!(trustedEv, {
        sessionId: 'rem-hw-1',
        locale: 'zh-Hans',
        hotwords: ['IM.codes', 'codex-sdk', 'Codex, Claude'],
      });
      expect(rem1).toEqual({ ok: true });
      const rem1Cmd = JSON.parse(String(proc.stdin.write.mock.calls.at(-1)?.[0]).trim());
      expect(rem1Cmd).toEqual({ cmd: 'start_pcm', locale: 'zh-Hans', hotwords: ['IM.codes', 'codex-sdk', 'Codex, Claude'] });
      proc.stdout.emit('data', '{"type":"end"}\n');

      // 4) Remote session B without hotwords -> zero leakage
      const rem2 = await handlers.get(PC_APP_VOICE_CHANNELS.startRemoteSession)!(trustedEv, {
        sessionId: 'rem-hw-2',
        locale: 'en-US',
      });
      expect(rem2).toEqual({ ok: true });
      const rem2Cmd = JSON.parse(String(proc.stdin.write.mock.calls.at(-1)?.[0]).trim());
      expect(rem2Cmd).toEqual({ cmd: 'start_pcm', locale: 'en-US' });
      proc.stdout.emit('data', '{"type":"end"}\n');

      // 5) Remote session C with different hotwords Y -> sends Y without inheriting A or touching hotwords.txt
      const rem3 = await handlers.get(PC_APP_VOICE_CHANNELS.startRemoteSession)!(trustedEv, {
        sessionId: 'rem-hw-3',
        locale: 'ja-JP',
        hotwords: ['ProjectY'],
      });
      expect(rem3).toEqual({ ok: true });
      const rem3Cmd = JSON.parse(String(proc.stdin.write.mock.calls.at(-1)?.[0]).trim());
      expect(rem3Cmd).toEqual({ cmd: 'start_pcm', locale: 'ja-JP', hotwords: ['ProjectY'] });
      proc.stdout.emit('data', '{"type":"end"}\n');

      expect(readFileSync(hotwordsFilePath, 'utf8')).toBe('StaticOne\nStaticTwo\n');
    } finally {
      if (voice) await voice.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('delivers slow >12s resident Qwen final results for local and remote stop, emits a single end, and isolates win32 worker on abort during stop', async () => {
    const weights = Buffer.from('slow-finalize-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-slow-0.6b',
        revision: 'slow06',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-slow-1.7b',
        revision: 'slow17',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const procs: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const sentEvents: PcAppVoiceEvent[] = [];
    const remoteEvents: PcAppRemoteVoiceEvent[] = [];
    const voice = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: tempDir,
      winSpeechHelperPath: 'C:\\IM.codes\\resources\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/session/1',
      sendToRenderer: (_ch, payload) => sentEvents.push(payload as PcAppVoiceEvent),
      manifests,
      mirrorOrigins: ['https://hf-mirror.com'],
      fetchModel: async () => new Response(new Uint8Array(weights), { status: 200 }),
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          return JSON.stringify({ ok: true, gpuName: 'CPU', vramMb: 0, provider: 'cpu', localAsrSupported: true });
        }
        return JSON.stringify([{ uid: 'mic-1', name: 'Mic', transport: 'usb', isDefault: true, isPhysical: true }]);
      },
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        proc.kill = vi.fn(() => {
          queueMicrotask(() => proc.emit('exit', 0));
          return true;
        }) as unknown as typeof proc.kill;
        procs.push(proc);
        queueMicrotask(() => {
          proc.stdout.emit('data', '{"type":"ready","variant":"0.6b","provider":"cpu"}\n');
        });
        return proc as unknown as ChildProcess;
      },
    });
    const unsubRemote = voice.subscribeRemoteEvents((ev) => remoteEvents.push(ev));

    await voice.setSpeechModel('qwen3-0.6b');
    await vi.waitFor(() => {
      expect(procs).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      const status = await voice.getSpeechModelStatus();
      expect(status.state).toBe('ready');
    });

    vi.useFakeTimers();
    try {
      expect(procs).toHaveLength(1);

      // 1. Local resident stop delivers >12s final result (at 25_000ms) with exactly ONE end event
      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      const localStopP = voice.stopListening({ abort: false });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(sentEvents.filter((e) => e.type === 'end')).toHaveLength(0);
      procs[0]!.stdout.emit('data', '{"type":"result","text":"慢速整句重解","isFinal":true}\n');
      procs[0]!.stdout.emit('data', '{"type":"end"}\n');
      await localStopP;
      expect(sentEvents).toEqual([
        { type: 'result', text: '慢速整句重解', isFinal: true },
        { type: 'end' },
      ]);

      // 2. Remote provider stopRemoteSession also waits past 12_000ms and delivers 25_000ms final + single end
      sentEvents.length = 0;
      remoteEvents.length = 0;
      expect(await voice.startRemoteSession({ sessionId: 'rem-slow-1', locale: 'zh-CN' })).toEqual({ ok: true });
      const remStopP = voice.stopRemoteSession({ sessionId: 'rem-slow-1', abort: false });
      await vi.advanceTimersByTimeAsync(25_000);
      procs[0]!.stdout.emit('data', '{"type":"result","text":"远程慢速整句","isFinal":true}\n');
      procs[0]!.stdout.emit('data', '{"type":"end"}\n');
      await remStopP;
      expect(remoteEvents.filter((e) => e.type === 'voice.session.result')).toEqual([
        { type: 'voice.session.result', sessionId: 'rem-slow-1', text: '远程慢速整句', isFinal: true },
      ]);
      expect(remoteEvents.filter((e) => e.type === 'voice.session.end')).toHaveLength(1);

      // 3. Abort DURING win32 in-flight stop immediately isolates & kills the worker, drops late result, and respawns clean worker
      sentEvents.length = 0;
      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      const inflightStopP = voice.stopListening({ abort: false });
      await vi.advanceTimersByTimeAsync(500);
      await voice.stopListening({ abort: true });
      await inflightStopP;
      expect(procs[0]!.kill).toHaveBeenCalledWith('SIGTERM');
      expect(sentEvents).toEqual([{ type: 'end' }]);

      // Late stdout from terminated worker MUST NOT reach current or next utterance
      procs[0]!.stdout.emit('data', '{"type":"result","text":"迟到旧结果","isFinal":true}\n');
      expect(sentEvents).toEqual([{ type: 'end' }]);

      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(procs).toHaveLength(2);
      procs[1]!.stdout.emit('data', '{"type":"end"}\n');
      await voice.stopListening({ abort: true });
    } finally {
      unsubRemote();
      vi.useRealTimers();
      await voice.dispose();
    }
  });

  it('isolates darwin resident worker across stop->abort->start and swallows delayed aborted end on immediate reuse', async () => {
    const weights = Buffer.from('darwin-abort-reuse-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-mac-0.6b',
        revision: 'mac06',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-mac-1.7b',
        revision: 'mac17',
        files: [{ filename: 'config.json', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const procs: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const sentEvents: PcAppVoiceEvent[] = [];
    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      mlxHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech-mlx',
      isMlxSupported: () => true,
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/session/1',
      sendToRenderer: (_ch, payload) => sentEvents.push(payload as PcAppVoiceEvent),
      getMediaAccessStatus: () => 'granted',
      manifests,
      mirrorOrigins: ['https://hf-mirror.com'],
      fetchModel: async () => new Response(new Uint8Array(weights), { status: 200 }),
      runHelperAsync: async () => JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      spawnHelper: () => {
        const proc = createFakeChildProcess();
        procs.push(proc);
        queueMicrotask(() => {
          proc.stdout.emit('data', '{"type":"ready","variant":"0.6b"}\n');
        });
        return proc as unknown as ChildProcess;
      },
    });

    await voice.setSpeechModel('qwen3-0.6b');
    await vi.waitFor(() => {
      expect(procs).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      expect((await voice.getSpeechModelStatus()).state).toBe('ready');
    });

    // A: start -> abort before stop (waits for old `end` BEFORE dispatching new start) -> old partial + end arrive -> reuses clean w0!
    expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
    await voice.stopListening({ abort: true });
    expect(procs[0]!.kill).not.toHaveBeenCalled();

    sentEvents.length = 0;
    procs[0]!.stdin.write.mockClear();
    const restartP = voice.startListening({ locale: 'zh-CN' });
    await Promise.resolve();
    await Promise.resolve();
    // New start MUST wait for old `end` before writing `cmd:start`!
    expect(procs[0]!.stdin.write).not.toHaveBeenCalledWith(expect.stringContaining('"cmd":"start"'));
    // Queued pre-abort partial AND terminating old `end` arrive together in one stdout chunk:
    procs[0]!.stdout.emit('data', '{"type":"result","text":"旧取消残留","isFinal":false}\n{"type":"end"}\n');
    expect(await restartP).toEqual({ ok: true });
    expect(procs).toHaveLength(1);
    expect(procs[0]!.stdin.write).toHaveBeenCalledWith('{"cmd":"start","locale":"zh-CN"}\n');
    // New session starts, decodes final, and ends:
    procs[0]!.stdout.emit('data', '{"type":"start"}\n{"type":"result","text":"新会话终解","isFinal":true}\n{"type":"end"}\n');
    expect(sentEvents).toEqual([
      { type: 'start' },
      { type: 'result', text: '新会话终解', isFinal: true },
      { type: 'end' },
    ]);

    // B: rapid double abort while waiting on unconfirmed aborted `end` -> cancels immediately without sending start!
    // C: no old `end` recovery -> bounded timeout isolates unresponsive w0 & spawns fresh w1!
    vi.useFakeTimers();
    try {
      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      await voice.stopListening({ abort: true });
      sentEvents.length = 0;
      procs[0]!.stdin.write.mockClear();
      const pendingRestartP = voice.startListening({ locale: 'zh-CN' });
      await vi.advanceTimersByTimeAsync(10);
      await voice.stopListening({ abort: true });
      expect(await pendingRestartP).toEqual({ ok: false, error: 'cancelled' });
      expect(procs[0]!.stdin.write).not.toHaveBeenCalledWith(expect.stringContaining('"cmd":"start"'));

      sentEvents.length = 0;
      const recoverP = voice.startListening({ locale: 'zh-CN' });
      await vi.advanceTimersByTimeAsync(300);
      expect(await recoverP).toEqual({ ok: true });
      expect(procs).toHaveLength(2);
      expect(procs[0]!.stdin.write).toHaveBeenCalledWith('{"cmd":"shutdown"}\n');
      procs[0]!.stdout.emit('data', '{"type":"result","text":"超时旧worker残留","isFinal":true}\n{"type":"end"}\n');
      procs[1]!.stdout.emit('data', '{"type":"start"}\n{"type":"result","text":"隔离恢复终解","isFinal":true}\n{"type":"end"}\n');
      expect(sentEvents.filter((e) => e.type !== 'loading')).toEqual([
        { type: 'start' },
        { type: 'result', text: '隔离恢复终解', isFinal: true },
        { type: 'end' },
      ]);

      // C2 (post-timeout reopen): abort without `end` -> timeout ALREADY fires BEFORE user calls startListening later -> MUST NOT bind old w1!
      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      await voice.stopListening({ abort: true });
      await vi.advanceTimersByTimeAsync(300);
      expect(procs[1]!.stdin.write).toHaveBeenCalledWith('{"cmd":"shutdown"}\n');
      sentEvents.length = 0;
      expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
      expect(procs).toHaveLength(3);
      procs[1]!.stdout.emit('data', '{"type":"result","text":"过期旧w1残留","isFinal":true}\n{"type":"end"}\n');
      procs[2]!.stdout.emit('data', '{"type":"start"}\n{"type":"result","text":"超时后重开新final","isFinal":true}\n{"type":"end"}\n');
      expect(sentEvents.filter((e) => e.type !== 'loading')).toEqual([
        { type: 'start' },
        { type: 'result', text: '超时后重开新final', isFinal: true },
        { type: 'end' },
      ]);
    } finally {
      vi.useRealTimers();
    }

    // D: start -> normal stop (in-flight final) -> abort -> immediate start -> spawns fresh worker w3 & ignores late w2 events
    sentEvents.length = 0;
    expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
    const pendingStopP = voice.stopListening({ abort: false });
    await voice.stopListening({ abort: true });
    await pendingStopP;
    expect(procs[2]!.stdin.write).toHaveBeenCalledWith('{"cmd":"shutdown"}\n');

    sentEvents.length = 0;
    expect(await voice.startListening({ locale: 'zh-CN' })).toEqual({ ok: true });
    expect(procs).toHaveLength(4);
    procs[2]!.stdout.emit('data', '{"type":"result","text":"老worker延迟终解","isFinal":true}\n{"type":"end"}\n');
    procs[3]!.stdout.emit('data', '{"type":"start"}\n{"type":"result","text":"全新worker终解","isFinal":true}\n{"type":"end"}\n');
    expect(sentEvents).toEqual([
      { type: 'start' },
      { type: 'result', text: '全新worker终解', isFinal: true },
      { type: 'end' },
    ]);

    await voice.dispose();
  });

  it('supports linux ONNX helper with CUDA/CPU probe, resident serve, hotwords, and onnxruntime_unavailable degradation', async () => {
    const weights = Buffer.from('linux-onnx-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'csukuangfj2/test-linux-0.6b',
        revision: 'linux06',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'ilmina/test-linux-1.7b',
        revision: 'linux17',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    const cudaDir = path.join(tempDir, 'linux-cuda');
    mkdirSync(path.join(cudaDir, 'speech-models', '0.6b'), { recursive: true });
    writeFileSync(path.join(cudaDir, 'speech-models', '0.6b', 'encoder.int8.onnx'), weights);
    writeFileSync(path.join(cudaDir, 'speech-models', '0.6b', '.verified-linux06'), '');

    const spawnCalls: Array<{ bin: string; args: string[] }> = [];
    const spawned: Array<ReturnType<typeof createFakeChildProcess>> = [];
    const voice = createPcAppVoiceController({
      platform: 'linux',
      arch: 'x64',
      userDataDir: cudaDir,
      linuxSpeechHelperPath: '/opt/imcodes/imcodes-speech-linux',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          return JSON.stringify({
            ok: true,
            gpuName: 'NVIDIA A100-SXM4-80GB',
            vramMb: 81920,
            provider: 'cuda',
            cudaEligible: true,
            localAsrSupported: true,
          });
        }
        if (args[0] === 'devices') {
          return JSON.stringify([{ uid: 'default', name: 'Pulse Default', transport: 'pulseaudio', isDefault: true, isPhysical: true }]);
        }
        return '[]';
      },
      spawnHelper: (bin, args) => {
        spawnCalls.push({ bin, args });
        const proc = createFakeChildProcess();
        spawned.push(proc);
        return proc as unknown as ChildProcess;
      },
    });

    const status = await voice.getSpeechModelStatus();
    expect(status.localAsrSupported).toBe(true);
    expect(status.executionProvider).toBe('cuda');
    expect(status.gpuName).toBe('NVIDIA A100-SXM4-80GB');
    expect(status.vramMb).toBe(81920);
    expect(await voice.getInputDevices()).toHaveLength(1);

    const startRes = await voice.startRemoteSession({
      sessionId: 'rem-linux-1',
      locale: 'zh-CN',
      hotwords: ['OpenClaw', 'Qwen3'],
    });
    expect(startRes).toEqual({ ok: true });
    expect(spawnCalls[0]).toEqual({
      bin: '/opt/imcodes/imcodes-speech-linux',
      args: [
        'serve',
        '--model-dir',
        path.join(cudaDir, 'speech-models', '0.6b'),
        '--variant',
        '0.6b',
        '--provider',
        'cuda',
      ],
    });
    spawned[0]!.stdout.emit('data', '{"type":"ready","variant":"0.6b","provider":"cpu"}\n');
    expect(voice.getSpeechModelStatusSync().executionProvider).toBe('cpu');
    expect(spawned[0]!.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('"hotwords":["OpenClaw","Qwen3"]'),
    );

    spawned[0]!.stdout.emit(
      'data',
      '{"type":"error","code":"onnxruntime_unavailable","message":"Built without ONNX Runtime support"}\n',
    );
    spawned[0]!.emit('exit', 1, null);
    expect(voice.getSpeechModelStatusSync().localAsrSupported).toBe(false);
    expect(voice.getSpeechModelStatusSync().state).toBe('unsupported');
    expect(await voice.getRemoteProviderInfo()).toBeNull();
    await voice.dispose();
  });

  it('forwards probe adapterIndex >= 1 to serve/listen while enforcing explicit CPU & <4GB policies, and passes dynamic hotwords only when present in single-shot ONNX listen', async () => {
    const weights = Buffer.from('onnx-idx1-weights');
    const sha = createHash('sha256').update(weights).digest('hex');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'csukuangfj2/test-0.6b',
        revision: 'r1',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'ilmina/test-1.7b',
        revision: 'r1',
        files: [{ filename: 'encoder.int8.onnx', expectedSize: weights.length, expectedSha256: sha }],
      },
    };

    // 1. Linux non-resident listen with GPU adapterIndex: 1 and back-to-back two utterances (only first has bilingual hotwords)
    const linuxIdx1Dir = path.join(tempDir, 'linux-idx1');
    mkdirSync(path.join(linuxIdx1Dir, 'speech-models', '0.6b'), { recursive: true });
    writeFileSync(path.join(linuxIdx1Dir, 'speech-models', '0.6b', 'encoder.int8.onnx'), weights);
    writeFileSync(path.join(linuxIdx1Dir, 'speech-models', '0.6b', '.verified-r1'), '');

    const linuxSpawns: Array<{ args: string[]; proc: ReturnType<typeof createFakeChildProcess> }> = [];
    const linuxSingleShot = createPcAppVoiceController({
      platform: 'linux',
      arch: 'x64',
      userDataDir: linuxIdx1Dir,
      linuxSpeechHelperPath: '/opt/imcodes/imcodes-speech-linux',
      useResidentMlxWorker: false,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async (_bin, args) => {
        if (args[0] === 'probe') {
          return JSON.stringify({
            ok: true,
            gpuName: 'NVIDIA A100-SXM4-80GB',
            vramMb: 81920,
            adapterIndex: 1,
            provider: 'cuda',
            cudaEligible: true,
            localAsrSupported: true,
          });
        }
        return '[]';
      },
      spawnHelper: (_bin, args) => {
        const proc = createFakeChildProcess();
        linuxSpawns.push({ args, proc });
        return proc as unknown as ChildProcess;
      },
    });

    const start1 = await linuxSingleShot.startListening({
      locale: 'zh-CN',
      hotwords: ['IM.codes', '陈伟', 'Claude, Code'],
    });
    expect(start1).toEqual({ ok: true });
    expect(linuxSpawns).toHaveLength(1);
    expect(linuxSpawns[0]!.args).toEqual([
      'listen',
      '--model-dir',
      path.join(linuxIdx1Dir, 'speech-models', '0.6b'),
      '--variant',
      '0.6b',
      '--provider',
      'cuda',
      '--device-id',
      '1',
      '--locale',
      'zh-CN',
      '--hotwords',
      JSON.stringify(['IM.codes', '陈伟', 'Claude, Code']),
    ]);
    // Finish first utterance cleanly
    const stop1 = linuxSingleShot.stopListening();
    linuxSpawns[0]!.proc.emit('exit', 0, null);
    await stop1;

    // Second utterance with NO hotwords must NOT carry stale --hotwords, while still preserving --device-id 1
    const start2 = await linuxSingleShot.startListening({ locale: 'en-US' });
    expect(start2).toEqual({ ok: true });
    expect(linuxSpawns).toHaveLength(2);
    expect(linuxSpawns[1]!.args).toEqual([
      'listen',
      '--model-dir',
      path.join(linuxIdx1Dir, 'speech-models', '0.6b'),
      '--variant',
      '0.6b',
      '--provider',
      'cuda',
      '--device-id',
      '1',
      '--locale',
      'en-US',
    ]);
    expect(linuxSpawns[1]!.args).not.toContain('--hotwords');
    await linuxSingleShot.stopListening({ abort: true });
    await linuxSingleShot.dispose();

    // 2. Windows resident worker with adapterIndex: 1 & >=4GB -> passes --provider directml --device-id 1
    const winIdx1Dir = path.join(tempDir, 'win-idx1');
    mkdirSync(path.join(winIdx1Dir, 'speech-models', '0.6b'), { recursive: true });
    writeFileSync(path.join(winIdx1Dir, 'speech-models', '0.6b', 'encoder.int8.onnx'), weights);
    writeFileSync(path.join(winIdx1Dir, 'speech-models', '0.6b', '.verified-r1'), '');

    const winIdx1Spawns: string[][] = [];
    const winIdx1Voice = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: winIdx1Dir,
      winSpeechHelperPath: 'C:\\IM.codes\\imcodes-speech-win.exe',
      useResidentMlxWorker: true,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async () =>
        JSON.stringify({
          ok: true,
          gpuName: 'AMD Radeon RX 7800 XT',
          vramMb: 16384,
          adapterIndex: 1,
          provider: 'directml',
          directmlEligible: true,
          localAsrSupported: true,
        }),
      spawnHelper: (_bin, args) => {
        winIdx1Spawns.push(args);
        return createFakeChildProcess() as unknown as ChildProcess;
      },
    });
    await winIdx1Voice.warmSelectedSpeechModel();
    await vi.waitFor(() => {
      expect(winIdx1Spawns).toHaveLength(1);
    });
    expect(winIdx1Spawns[0]).toEqual([
      'serve',
      '--model-dir',
      path.join(winIdx1Dir, 'speech-models', '0.6b'),
      '--variant',
      '0.6b',
      '--provider',
      'directml',
      '--device-id',
      '1',
    ]);
    await winIdx1Voice.dispose();

    // 3. Explicit cpu override on A100 adapterIndex: 1 and <4GB winProvider: 'directml' keep --provider cpu (no --device-id)
    const winLowDir = path.join(tempDir, 'win-low-explicit');
    mkdirSync(path.join(winLowDir, 'speech-models', '0.6b'), { recursive: true });
    writeFileSync(path.join(winLowDir, 'speech-models', '0.6b', 'encoder.int8.onnx'), weights);
    writeFileSync(path.join(winLowDir, 'speech-models', '0.6b', '.verified-r1'), '');
    const winLowSpawns: string[][] = [];
    const winLowVoice = createPcAppVoiceController({
      platform: 'win32',
      arch: 'x64',
      userDataDir: winLowDir,
      winSpeechHelperPath: 'C:\\IM.codes\\imcodes-speech-win.exe',
      winProvider: 'directml',
      useResidentMlxWorker: false,
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes/',
      sendToRenderer: () => {},
      manifests,
      runHelperAsync: async () =>
        JSON.stringify({
          ok: true,
          gpuName: 'NVIDIA GeForce GT 1030',
          vramMb: 2048,
          adapterIndex: 1,
          provider: 'directml',
          directmlEligible: false,
          localAsrSupported: true,
        }),
      spawnHelper: (_bin, args) => {
        winLowSpawns.push(args);
        return createFakeChildProcess() as unknown as ChildProcess;
      },
    });
    await winLowVoice.startListening({ hotwords: ['IM.codes', '陈伟'] });
    expect(winLowSpawns[0]).toEqual([
      'listen',
      '--model-dir',
      path.join(winLowDir, 'speech-models', '0.6b'),
      '--variant',
      '0.6b',
      '--provider',
      'cpu',
      '--hotwords',
      'IM.codes, 陈伟',
    ]);
    await winLowVoice.stopListening({ abort: true });
    await winLowVoice.dispose();
  });
});
