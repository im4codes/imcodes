import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSpeechModelAssetUrl,
  CHINA_MIRROR_ORIGINS,
  getSpeechModelManifests,
  GLOBAL_MIRROR_ORIGINS,
  normalizeMirrorOrigin,
  PcAppSpeechModelDownloader,
  PcAppSpeechModelStore,
  resolvedDefaultMirrorOrigins,
  resolvedMirrorOrigins,
  SPEECH_MODEL_MANIFESTS,
  WIN32_GPU_MIN_VRAM_MB,
  WIN32_SPEECH_MODEL_MANIFESTS,
  verifiedMarkerFilename,
  type PcAppSpeechModelManifest,
  type PcAppSpeechVariant,
} from '../src/speech-models.js';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeResponse(bytes: Buffer, status = 200): Response {
  return new Response(new Uint8Array(bytes), {
    status,
    headers: { 'Content-Length': String(bytes.length) },
  });
}

describe('PC App Qwen3-ASR region-aware mirrors, sticky promotion, persistence, and verification', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `imcodes-pc-speech-models-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('orders default mirrors by region (CN prefers hf-mirror.com; global prefers huggingface.co)', () => {
    expect(resolvedDefaultMirrorOrigins({ locale: 'zh-CN', timeZone: 'Asia/Shanghai' })).toEqual([...CHINA_MIRROR_ORIGINS]);
    expect(resolvedDefaultMirrorOrigins({ locale: 'en-US', timeZone: 'Asia/Urumqi' })).toEqual([...CHINA_MIRROR_ORIGINS]);
    expect(resolvedDefaultMirrorOrigins({ locale: 'zh-CN', timeZone: 'America/Los_Angeles' })).toEqual([...CHINA_MIRROR_ORIGINS]);

    expect(resolvedDefaultMirrorOrigins({ locale: 'en-US', timeZone: 'America/Los_Angeles' })).toEqual([...GLOBAL_MIRROR_ORIGINS]);
    expect(resolvedDefaultMirrorOrigins({ locale: 'ja-JP', timeZone: 'Asia/Tokyo' })).toEqual([...GLOBAL_MIRROR_ORIGINS]);
  });

  it('ignores empty/invalid custom mirror entries, prepends valid overrides, and respects explicit mirrorOrigins', () => {
    expect(normalizeMirrorOrigin('')).toBeNull();
    expect(normalizeMirrorOrigin('   ')).toBeNull();
    expect(normalizeMirrorOrigin('ftp://bad.example.com')).toBeNull();
    expect(normalizeMirrorOrigin('not a url')).toBeNull();
    expect(normalizeMirrorOrigin('https://cdn.example.com/')).toBe('https://cdn.example.com');

    const resolved = resolvedMirrorOrigins({
      env: { IMCODES_SPEECH_MODEL_MIRRORS: ' , invalid-url , ftp://skip.test , https://cdn.example.com/path/ ' },
      customMirrors: ['', 'https://hf-mirror.com/', 'https://oss.example.com:8443/'],
      locale: 'en-US',
      timeZone: 'America/New_York',
    });
    expect(resolved).toEqual([
      'https://cdn.example.com',
      'https://hf-mirror.com',
      'https://oss.example.com:8443',
      'https://huggingface.co',
    ]);

    const explicit = resolvedMirrorOrigins({
      explicitOrigins: ['invalid', 'https://unit.example.test/'],
      env: { IMCODES_SPEECH_MODEL_MIRRORS: 'https://ignored.example.com' },
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
    });
    expect(explicit).toEqual(['https://unit.example.test']);
  });

  it('pins verified 0.6B and 1.7B manifests with expected asset sizes and SHA-256 digests', () => {
    expect(SPEECH_MODEL_MANIFESTS['0.6b'].repoId).toBe('aufklarer/Qwen3-ASR-0.6B-MLX-4bit');
    expect(SPEECH_MODEL_MANIFESTS['0.6b'].files).toHaveLength(6);
    expect(SPEECH_MODEL_MANIFESTS['0.6b'].files.find((f) => f.filename === 'model.safetensors')?.expectedSize).toBe(708_236_945);

    expect(SPEECH_MODEL_MANIFESTS['1.7b'].repoId).toBe('aufklarer/Qwen3-ASR-1.7B-MLX-4bit');
    expect(SPEECH_MODEL_MANIFESTS['1.7b'].revision).toBe('d4f9fa3bb45489219f0fcbec671c92d9c1a68fb6');
    expect(SPEECH_MODEL_MANIFESTS['1.7b'].files).toHaveLength(5);
    expect(SPEECH_MODEL_MANIFESTS['1.7b'].files.find((f) => f.filename === 'model.safetensors')?.expectedSize).toBe(2_225_411_512);
  });

  it('persists speech model selection atomically and fails soft on corrupt files', () => {
    const store = new PcAppSpeechModelStore(tempDir);
    expect(store.load()).toBe('system');

    store.save('qwen3-0.6b');
    expect(store.load()).toBe('qwen3-0.6b');

    store.save('qwen3-1.7b');
    expect(store.load()).toBe('qwen3-1.7b');

    writeFileSync(path.join(tempDir, 'speech-model.json'), '{broken-json');
    expect(store.load()).toBe('system');

    writeFileSync(path.join(tempDir, 'speech-model.json'), JSON.stringify({ version: 1, model: 'qwen3-99b' }));
    expect(store.load()).toBe('system');
  });

  it('promotes the working mirror stickily across multi-file downloads and never leaves corrupt/.part files ready', async () => {
    const fileA = Buffer.from('{"model":"a"}');
    const fileB = Buffer.from('weights-payload-b');
    const badB = Buffer.from('corrupt-payload-b');
    expect(badB.length).toBe(fileB.length);

    const testManifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-0.6b',
        revision: 'rev06',
        files: [
          { filename: 'config.json', expectedSize: fileA.length, expectedSha256: sha256Hex(fileA) },
          { filename: 'model.safetensors', expectedSize: fileB.length, expectedSha256: sha256Hex(fileB) },
        ],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-1.7b',
        revision: 'rev17',
        files: [
          { filename: 'config.json', expectedSize: fileA.length, expectedSha256: sha256Hex(fileA) },
        ],
      },
    };

    const requests: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      requests.push(url);
      if (url.startsWith('https://huggingface.co/')) {
        throw new Error('connect ETIMEDOUT huggingface.co');
      }
      if (url.endsWith('/config.json')) return makeResponse(fileA);
      if (url.endsWith('/model.safetensors')) return makeResponse(fileB);
      return makeResponse(Buffer.alloc(0), 404);
    };

    const downloader = new PcAppSpeechModelDownloader({
      modelsBaseDir: tempDir,
      manifests: testManifests,
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
      fetchFn: fetchMock,
    });

    // Global starts with huggingface.co first
    expect(downloader.getMirrorOrder()).toEqual(['https://huggingface.co', 'https://hf-mirror.com']);

    // Pre-seed a stale .part file to verify cleanup and that .part alone never counts as ready
    const dir06 = downloader.getModelDirectory('0.6b');
    mkdirSync(dir06, { recursive: true });
    writeFileSync(path.join(dir06, 'model.safetensors.part.stale'), 'incomplete');
    expect(downloader.isModelReadySync('0.6b')).toBe(false);

    const ok = await downloader.ensureDownloaded('0.6b');
    expect(ok).toBe(true);
    expect(downloader.isModelReadySync('0.6b')).toBe(true);

    // Sticky mirror promotion: huggingface.co failed on config.json -> hf-mirror.com succeeded ->
    // model.safetensors tried hf-mirror.com FIRST without wasting a timeout on huggingface.co!
    expect(requests).toEqual([
      buildSpeechModelAssetUrl('https://huggingface.co', testManifests['0.6b'], 'config.json'),
      buildSpeechModelAssetUrl('https://hf-mirror.com', testManifests['0.6b'], 'config.json'),
      buildSpeechModelAssetUrl('https://hf-mirror.com', testManifests['0.6b'], 'model.safetensors'),
    ]);
    expect(downloader.getMirrorOrder()).toEqual(['https://hf-mirror.com', 'https://huggingface.co']);
    expect(readdirSync(dir06).some((f) => f.includes('.part.'))).toBe(false);
    expect(existsSync(path.join(dir06, verifiedMarkerFilename('rev06')))).toBe(true);

    // Same-size byte corruption on disk must fail verifyModelFilesOnDisk and strip the verified marker.
    writeFileSync(path.join(dir06, 'model.safetensors'), badB);
    expect(await downloader.verifyModelFilesOnDisk('0.6b')).toBe(false);
    expect(downloader.isModelReadySync('0.6b')).toBe(false);
  });

  it('cancels and retargets cleanly when switching from 0.6b to 1.7b mid-download', async () => {
    const file06 = Buffer.from('small-weights');
    const file17 = Buffer.from('large-weights');
    const manifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'aufklarer/test-0.6b',
        revision: 'r06',
        files: [{ filename: 'config.json', expectedSize: file06.length, expectedSha256: sha256Hex(file06) }],
      },
      '1.7b': {
        choice: 'qwen3-1.7b',
        variant: '1.7b',
        repoId: 'aufklarer/test-1.7b',
        revision: 'r17',
        files: [{ filename: 'config.json', expectedSize: file17.length, expectedSha256: sha256Hex(file17) }],
      },
    };

    let release06!: () => void;
    const started06 = new Promise<void>((res) => { release06 = res; });
    let aborted06 = false;

    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('test-0.6b')) {
        release06();
        await new Promise<void>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => {
            aborted06 = true;
            rej(new Error('aborted'));
          });
        });
      }
      return makeResponse(file17);
    };

    const downloader = new PcAppSpeechModelDownloader({
      modelsBaseDir: tempDir,
      manifests,
      explicitMirrors: ['https://hf-mirror.com'],
      fetchFn: fetchMock,
    });

    const p06 = downloader.ensureDownloaded('0.6b');
    await started06;
    const p17 = downloader.ensureDownloaded('1.7b');

    const [res06, res17] = await Promise.all([p06, p17]);
    expect(aborted06).toBe(true);
    expect(res06).toBe(false);
    expect(res17).toBe(true);
    expect(downloader.isModelReadySync('0.6b')).toBe(false);
    expect(downloader.isModelReadySync('1.7b')).toBe(true);
    expect(readFileSync(path.join(downloader.getModelDirectory('1.7b'), 'config.json'))).toEqual(file17);
  });

  it('provides verified win32 ONNX INT8 manifests (0.6B default + 1.7B manual) and downloads nested tokenizer/* files cleanly', async () => {
    expect(WIN32_GPU_MIN_VRAM_MB).toBe(4096);
    expect(getSpeechModelManifests('darwin')).toBe(SPEECH_MODEL_MANIFESTS);
    expect(getSpeechModelManifests('win32')).toBe(WIN32_SPEECH_MODEL_MANIFESTS);
    expect(WIN32_SPEECH_MODEL_MANIFESTS['0.6b'].repoId).toBe('csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25');
    expect(WIN32_SPEECH_MODEL_MANIFESTS['1.7b'].repoId).toBe('ilmina/qwen3-asr-1.7b-sherpa-onnx');
    expect(WIN32_SPEECH_MODEL_MANIFESTS['0.6b'].files.some((f) => f.filename === 'tokenizer/vocab.json')).toBe(true);

    const store = new PcAppSpeechModelStore(tempDir);
    expect(store.load('qwen3-0.6b')).toBe('qwen3-0.6b');
    store.save('system');
    expect(store.load('qwen3-0.6b')).toBe('system');

    const modelPayload = Buffer.from('onnx-bytes');
    const tokPayload = Buffer.from('{"a":1}');
    const nestedManifests: Record<PcAppSpeechVariant, PcAppSpeechModelManifest> = {
      '0.6b': {
        choice: 'qwen3-0.6b',
        variant: '0.6b',
        repoId: 'csukuangfj2/test-win-06b',
        revision: 'rev-win-06',
        files: [
          { filename: 'decoder.int8.onnx', expectedSize: modelPayload.length, expectedSha256: sha256Hex(modelPayload) },
          { filename: 'tokenizer/vocab.json', expectedSize: tokPayload.length, expectedSha256: sha256Hex(tokPayload) },
        ],
      },
      '1.7b': WIN32_SPEECH_MODEL_MANIFESTS['1.7b'],
    };

    const downloader = new PcAppSpeechModelDownloader({
      modelsBaseDir: tempDir,
      platform: 'win32',
      manifests: nestedManifests,
      explicitMirrors: ['https://hf-mirror.com'],
      fetchFn: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        return url.endsWith('/tokenizer/vocab.json') ? makeResponse(tokPayload) : makeResponse(modelPayload);
      },
    });
    const tokDir = path.join(downloader.getModelDirectory('0.6b'), 'tokenizer');
    mkdirSync(tokDir, { recursive: true });
    writeFileSync(path.join(tokDir, 'vocab.json.part.stale'), 'stale');

    expect(await downloader.ensureDownloaded('0.6b')).toBe(true);
    expect(downloader.isModelReadySync('0.6b')).toBe(true);
    expect(readdirSync(tokDir).some((f) => f.includes('.part.'))).toBe(false);
    expect(readFileSync(path.join(tokDir, 'vocab.json'))).toEqual(tokPayload);
  });

  it('routes linux to ONNX manifests and XDG data directory', async () => {
    const {
      ONNX_SPEECH_MODEL_MANIFESTS,
      WIN32_SPEECH_MODEL_MANIFESTS,
      getSpeechModelManifests,
      defaultLinuxSpeechModelsDir,
      defaultSpeechModelsDir,
    } = await import('../src/speech-models.js');
    expect(getSpeechModelManifests('linux')).toBe(ONNX_SPEECH_MODEL_MANIFESTS);
    expect(WIN32_SPEECH_MODEL_MANIFESTS).toBe(ONNX_SPEECH_MODEL_MANIFESTS);
    expect(defaultLinuxSpeechModelsDir('/tmp/xdg-data')).toBe(path.join('/tmp/xdg-data', 'imcodes-pc-app', 'speech-models'));
    expect(defaultSpeechModelsDir('linux')).toContain(path.join('imcodes-pc-app', 'speech-models'));
  });
});
