import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { STREAMING_SPEECH_PLUGIN_NAME } from '../../shared/voice-recognition.js';
// Build tooling is intentionally plain ESM so Gradle/CI do not require tsx.
// @ts-ignore plain build script
import { matchesAsset, prepareSpeechAssets, SPEECH_ASSETS, MODEL_REVISION } from '../../web/scripts/prepare-streaming-speech.mjs';
let root: string;
afterEach(async () => { vi.useRealTimers(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup() { root = await mkdtemp(join(tmpdir(), 'imcodes-test-speech-')); return pathToFileURL(root + '/'); }
const bytes = Buffer.from('offline-model');
const digest = createHash('sha256').update(bytes).digest('hex');
const asset = ['models/test.onnx', 'https://example.invalid/pinned/model', digest, bytes.length];
describe('shared mobile model preparation', () => {
  it('binds both native registrations to the shared Capacitor name', async () => {
    const base = new URL('../../web/plugins/streaming-speech/', import.meta.url);
    const android = await readFile(new URL('android/src/main/java/com/imcodes/speech/StreamingSpeechPlugin.java', base), 'utf8');
    const ios = await readFile(new URL('ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', base), 'utf8');
    expect(android).toContain(`@CapacitorPlugin(name = "${STREAMING_SPEECH_PLUGIN_NAME}"`);
    expect(ios).toContain(`jsName = "${STREAMING_SPEECH_PLUGIN_NAME}"`);
    for (const name of ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt', 'bpe.vocab', 'hotwords.txt']) {
      expect(android).toContain(`"${name}"`);
      expect(ios).toContain(`"${name}"`);
    }
    expect(android).toContain('setDecodingMethod("modified_beam_search")');
    expect(ios).toContain('decodingMethod: "modified_beam_search"');
    expect(android).toContain('setHotwordsScore(2.0f)');
    expect(ios).toContain('hotwordsScore: 2.0');
    expect(android).toContain('new float[SAMPLE_RATE]');
    expect(ios).toContain('count: 16000');
    expect(android).toContain('new float[SAMPLE_RATE / 2]');
    expect(ios).toContain('count: 8000');
    expect(android).toContain('if (text.startsWith(previous)) return text;');
    expect(ios).toContain('if text.hasPrefix(previous) { return text }');
    expect(android).toContain('OnlineStream next = recognizer.createStream("")');
    expect(android).not.toContain('recognizer.reset(stream)');
    expect(ios).toContain('func startNextStream() -> Bool');
    expect(ios).not.toContain('SherpaOnnxOnlineStreamReset(');
    expect(android).not.toContain('getParaformer()');
    expect(ios).not.toContain('sherpaOnnxOnlineParaformerModelConfig(');
  });
  it('pins the mixed-precision transducer bytes and locally maintained hotwords', async () => {
    expect(MODEL_REVISION).toBe('98590b7ed6443e77b714204da2757d75e1a642f4');
    expect(SPEECH_ASSETS).toHaveLength(7);
    expect(SPEECH_ASSETS.every((a: any) => /^[a-f\d]{64}$/.test(a[2]) && (a[1] === null || a[1].startsWith('https://')))).toBe(true);
    expect(SPEECH_ASSETS.map((a: any) => a[0])).toEqual(['models/encoder.int8.onnx', 'models/decoder.onnx', 'models/joiner.int8.onnx', 'models/tokens.txt', 'models/bpe.vocab', 'models/hotwords.txt', 'android/libs/sherpa-onnx-2.0.1.aar']);
    expect(SPEECH_ASSETS.slice(0, 5).reduce((n: number, a: any) => n + a[3], 0)).toBe(199068769);
    const base = new URL('../../web/plugins/streaming-speech/', import.meta.url);
    expect(await matchesAsset(new URL('models/hotwords.txt', base), SPEECH_ASSETS[5][2], SPEECH_ASSETS[5][3])).toBe(true);
    expect(await readFile(new URL('models/hotwords.txt', base), 'utf8')).toBe('COMMIT\nGITHUB\nGITLAB\nREACT\nTYPESCRIPT\nDOCKER\nENGLISH\n');
  });
  it('publishes verified files atomically, reuses them, and repairs a corrupt cached file', async () => {
    const url = await setup(); const fetcher = vi.fn(async () => new Response(bytes));
    await prepareSpeechAssets(url, fetcher, [asset]);
    expect(await readFile(join(root, 'models/test.onnx'))).toEqual(bytes);
    await prepareSpeechAssets(url, fetcher, [asset]); expect(fetcher).toHaveBeenCalledTimes(1);
    await writeFile(join(root, 'models/test.onnx'), Buffer.alloc(bytes.length));
    await prepareSpeechAssets(url, fetcher, [asset]); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await matchesAsset(join(root, 'models/test.onnx'), digest, bytes.length)).toBe(true);
  });
  it('fails closed on corrupt downloads without overwriting the last file or retaining partials', async () => {
    const url = await setup(); await prepareSpeechAssets(url, async () => new Response(bytes), [asset]);
    const mismatch = [...asset]; mismatch[2] = '0'.repeat(64);
    const result = prepareSpeechAssets(url, async () => new Response(bytes), [mismatch]);
    const failure = expect(result).rejects.toThrow('checksum/size mismatch');
    await failure;
    expect(await readFile(join(root, 'models/test.onnx'))).toEqual(bytes);
    expect(await readdir(join(root, 'models'))).toEqual(['test.onnx']);
  });
  it('fails visibly if bundled hotwords are missing', async () => {
    const url = await setup();
    await expect(prepareSpeechAssets(url, vi.fn(), [['models/hotwords.txt', null, digest, bytes.length]])).rejects.toThrow('Bundled speech asset missing/corrupt');
  });
  it('removes only the obsolete cached decoder when preparing the replacement', async () => {
    const url = await setup();
    await (await import('node:fs/promises')).mkdir(join(root, 'models'));
    await writeFile(join(root, 'models/decoder.int8.onnx'), bytes);
    await prepareSpeechAssets(url, async () => new Response(bytes), [['models/decoder.onnx', 'https://example.invalid/model', digest, bytes.length]]);
    expect(await readdir(join(root, 'models'))).toEqual(['decoder.onnx']);
  });
});
