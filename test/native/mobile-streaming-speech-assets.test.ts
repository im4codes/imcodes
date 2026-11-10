import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { STREAMING_SPEECH_PLUGIN_NAME } from '../../shared/voice-recognition.js';
// Build tooling is intentionally plain ESM so Gradle/CI do not require tsx.
// @ts-ignore plain build script
import { matchesAsset, prepareSpeechAssets, SPEECH_ASSETS } from '../../web/scripts/prepare-streaming-speech.mjs';
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
  });
  it('pins exact INT8 bytes/version and never downloads the 1GB full archive', () => {
    expect(SPEECH_ASSETS).toHaveLength(4);
    expect(SPEECH_ASSETS.every((a: any) => /^[a-f\d]{64}$/.test(a[2]) && a[1].startsWith('https://'))).toBe(true);
    expect(SPEECH_ASSETS.map((a: any) => a[0])).toEqual(['models/encoder.int8.onnx', 'models/decoder.int8.onnx', 'models/tokens.txt', 'android/libs/sherpa-onnx-2.0.1.aar']);
    expect(SPEECH_ASSETS.slice(0, 3).reduce((n: number, a: any) => n + a[3], 0)).toBe(237202501);
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
});
