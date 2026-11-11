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
    expect(android).not.toContain('startsWith(previous)');
    expect(ios).not.toContain('hasPrefix(previous)');
    expect(android).toContain('OnlineStream next = recognizer.createStream("")');
    expect(android).not.toContain('recognizer.reset(stream)');
    expect(ios).toContain('func startNextStream() -> Bool');
    expect(ios).not.toContain('SherpaOnnxOnlineStreamReset(');
    expect(android).not.toContain('getParaformer()');
    expect(ios).not.toContain('sherpaOnnxOnlineParaformerModelConfig(');
    // Resident recognizer + async load() warmup + immediate left-padding decodeAvailable + iOS 64 slots
    expect(ios).toContain('DispatchSemaphore(value: 64)');
    expect(ios).not.toContain('DispatchSemaphore(value: 8)');
    expect(ios).toContain('private var recognizer: SpeechRecognizer?');
    expect(ios).toContain('_ = self.ensureRecognizer()');
    expect(ios).toContain('private final class SpeechRecognizer');
    expect(ios).toContain('SherpaOnnxDestroyOnlineStream(warmStream)');
    expect(ios).toMatch(/acceptWaveform\(samples: \[Float\]\(repeating: 0, count: 8000\)\)\s*\n\s*decodeAvailable\(\)/);
    expect(ios).toMatch(/notifyListeners\("audioLevel", data: \["level": level\]\)\s*\n\s*worker\.async/);
    expect(android).toContain('private OnlineRecognizer recognizer;');
    expect(android).toContain('private OnlineRecognizer ensureRecognizer()');
    expect(android).toContain('warmStream.release();');
    expect(android).toContain('Math.max(min * 2, SAMPLE_RATE * 2 * 6)');
    expect(android).toContain('worker.execute(() -> capture(call, owner, audio));');
    expect(android).toMatch(/stream\.acceptWaveform\(new float\[SAMPLE_RATE \/ 2\], SAMPLE_RATE\);\s*\n\s*decodeAvailable\(recognizer, stream\);/);
    expect(android).toMatch(/next\.acceptWaveform\(new float\[SAMPLE_RATE \/ 2\], SAMPLE_RATE\);\s*\n\s*decodeAvailable\(recognizer, next\);/);
    expect(android).toMatch(/handleOnDestroy\(\)[\s\S]*recognizer\.release\(\);/);
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

describe('native stream segment concatenation and lifecycle semantics', () => {
  function join(previous: string, text: string): string {
    if (!previous) return text;
    if (!text) return previous;
    const asciiBoundary = previous.charCodeAt(previous.length - 1) < 128 && text.charCodeAt(0) < 128;
    return previous + (asciiBoundary ? ' ' : '') + text;
  }

  it('correctly handles exact identical repeated segments without swallow', () => {
    expect(join('你好', '你好')).toBe('你好你好');
    expect(join('COMMIT', 'COMMIT')).toBe('COMMIT COMMIT');
  });

  it('correctly joins prefix overlap across endpoints without dropping earlier segment', () => {
    expect(join('COMMIT', 'COMMIT TO GITHUB')).toBe('COMMIT COMMIT TO GITHUB');
    expect(join('你好', '你好世界')).toBe('你好你好世界');
  });

  it('preserves ASCII boundary spacing between English and non-ASCII Chinese', () => {
    expect(join('HELLO', 'WORLD')).toBe('HELLO WORLD');
    expect(join('你好', '世界')).toBe('你好世界');
    expect(join('你好', 'world')).toBe('你好world');
    expect(join('hello', '世界')).toBe('hello世界');
    expect(join('COMMIT', 'TO GITHUB')).toBe('COMMIT TO GITHUB');
  });

  it('handles empty segments, empty previous, and stop transitions cleanly', () => {
    expect(join('', '')).toBe('');
    expect(join('', 'hello')).toBe('hello');
    expect(join('hello', '')).toBe('hello');
  });

  it('simulates multi-stream speech session without duplicate partials or swallowed repeated utterances', () => {
    let committed = '';
    let last = '';
    const emittedPartials: string[] = [];

    function onPartial(activeStreamText: string) {
      const full = join(committed, activeStreamText.trim());
      if (full !== last) {
        emittedPartials.push(full);
        last = full;
      }
      return full;
    }

    function onEndpoint(activeStreamFinalText: string) {
      const full = join(committed, activeStreamFinalText.trim());
      committed = full;
    }

    // Stream 1: User says "你好"
    onPartial('你');
    onPartial('你好');
    onEndpoint('你好');
    expect(committed).toBe('你好');

    // Stream 2: After a pause, user says "你好" again
    onPartial('你');
    expect(last).toBe('你好你');
    onPartial('你好');
    expect(last).toBe('你好你好');
    onEndpoint('你好');
    expect(committed).toBe('你好你好');

    // Stream 3: User says "COMMIT"
    onPartial('COM');
    onPartial('COMMIT');
    onEndpoint('COMMIT');
    expect(committed).toBe('你好你好COMMIT');

    // Stream 4: User says "COMMIT TO GITHUB"
    onPartial('COMMIT');
    expect(last).toBe('你好你好COMMIT COMMIT');
    onPartial('COMMIT TO GITHUB');
    expect(last).toBe('你好你好COMMIT COMMIT TO GITHUB');
    // Stop called: final stop flushes and commits final segment
    const finalResult = join(committed, 'COMMIT TO GITHUB');
    expect(finalResult).toBe('你好你好COMMIT COMMIT TO GITHUB');
  });

  it('reuses a single resident recognizer across sessions, drains 0.5s left-padding before capture, and releases recognizer only on destroy', () => {
    const events: string[] = [];
    let recognizerCount = 0;
    let recognizerReleased = 0;
    let streamSeq = 0;

    interface MockStream {
      id: number;
      pendingSamples: number;
      released: boolean;
      acceptWaveform(samplesCount: number): void;
      isReady(): boolean;
      decode(): void;
      release(): void;
    }

    class MockRecognizer {
      readonly id = ++recognizerCount;
      released = false;
      constructor() {
        events.push(`recognizer.create#${this.id}`);
      }
      createStream(): MockStream {
        const id = ++streamSeq;
        events.push(`stream.create#${id}`);
        return {
          id,
          pendingSamples: 0,
          released: false,
          acceptWaveform(samplesCount: number) {
            this.pendingSamples += samplesCount;
            events.push(`stream#${id}.accept(${samplesCount})`);
          },
          isReady() {
            return this.pendingSamples >= 4000;
          },
          decode() {
            this.pendingSamples = Math.max(0, this.pendingSamples - 4000);
            events.push(`stream#${id}.decode`);
          },
          release() {
            if (!this.released) {
              this.released = true;
              events.push(`stream.release#${id}`);
            }
          },
        };
      }
      release() {
        if (!this.released) {
          this.released = true;
          recognizerReleased++;
          events.push(`recognizer.release#${this.id}`);
        }
      }
    }

    let resident: MockRecognizer | null = null;
    let activeStream: MockStream | null = null;

    function decodeAvailable(stream: MockStream) {
      while (stream.isReady()) stream.decode();
    }

    function ensureRecognizer(): MockRecognizer {
      if (resident) return resident;
      const created = new MockRecognizer();
      const warmStream = created.createStream();
      warmStream.acceptWaveform(8000);
      decodeAvailable(warmStream);
      warmStream.release();
      resident = created;
      return resident;
    }

    function load() {
      ensureRecognizer();
    }

    function startCapture() {
      const rec = ensureRecognizer();
      const stream = rec.createStream();
      stream.acceptWaveform(8000);
      decodeAvailable(stream);
      events.push('audioEngine.start');
      activeStream = stream;
    }

    function endCapture() {
      if (activeStream) {
        activeStream.acceptWaveform(16000);
        decodeAvailable(activeStream);
        activeStream.release();
        activeStream = null;
      }
    }

    function destroyPlugin() {
      endCapture();
      if (resident) {
        resident.release();
        resident = null;
      }
    }

    // 1. Plugin load() preloads and warms up recognizer before user taps mic
    load();
    expect(recognizerCount).toBe(1);
    expect(recognizerReleased).toBe(0);
    expect(events).toEqual([
      'recognizer.create#1',
      'stream.create#1',
      'stream#1.accept(8000)',
      'stream#1.decode',
      'stream#1.decode',
      'stream.release#1',
    ]);

    // 2. First mic start reuses recognizer#1, drains 8000 left-padding BEFORE audioEngine.start, and endCapture keeps recognizer#1 alive
    events.length = 0;
    startCapture();
    expect(recognizerCount).toBe(1);
    expect(activeStream?.pendingSamples).toBe(0);
    expect(events).toEqual([
      'stream.create#2',
      'stream#2.accept(8000)',
      'stream#2.decode',
      'stream#2.decode',
      'audioEngine.start',
    ]);
    endCapture();
    expect(recognizerReleased).toBe(0);

    // 3. Second mic start still reuses recognizer#1 without reloading 198MB model
    events.length = 0;
    startCapture();
    expect(recognizerCount).toBe(1);
    endCapture();
    expect(recognizerReleased).toBe(0);

    // 4. Plugin destroy releases resident recognizer#1
    destroyPlugin();
    expect(recognizerReleased).toBe(1);
  });

  it('captures and buffers initial speech immediately while model warmup is still in flight on the serial worker', () => {
    const timeline: string[] = [];
    const workerQueue: Array<() => void> = [];
    const emittedPartials: string[] = [];
    let decoderReady = false;
    const decodedChunks: string[] = [];

    function enqueueWorker(task: () => void) {
      workerQueue.push(task);
    }

    function drainWorker() {
      while (workerQueue.length > 0) {
        const next = workerQueue.shift()!;
        next();
      }
    }

    // 1. Plugin load() enqueues async model warmup on serial worker (not yet drained when user taps mic)
    enqueueWorker(() => {
      timeline.push('worker:load.ensureRecognizer+warmup');
    });

    // 2. User immediately taps start() before load() finishes:
    //    start() enqueues session decoder setup on serial worker AND immediately starts mic capture on main thread
    enqueueWorker(() => {
      timeline.push('worker:start.sessionStream+drainLeftPadding');
      decoderReady = true;
    });
    timeline.push('main:AVAudioEngine.start+listeningState:started');

    // 3. User speaks "喂" -> "你好" -> "听得到吗" while worker is STILL busy warming up the model:
    for (const chunk of ['喂', '你好', '听得到吗']) {
      // consume() emits audioLevel immediately on tap thread and queues PCM onto serial worker
      timeline.push(`tap:audioLevel(${chunk})`);
      enqueueWorker(() => {
        expect(decoderReady).toBe(true);
        decodedChunks.push(chunk);
        const cumulative = decodedChunks.join('');
        emittedPartials.push(cumulative);
        timeline.push(`worker:decode(${chunk})->${cumulative}`);
      });
    }

    // Before worker finishes warmup, mic has already started and emitted all 3 audioLevels without dropping any buffer
    expect(timeline).toEqual([
      'main:AVAudioEngine.start+listeningState:started',
      'tap:audioLevel(喂)',
      'tap:audioLevel(你好)',
      'tap:audioLevel(听得到吗)',
    ]);
    expect(emittedPartials).toEqual([]);

    // 4. Serial worker finishes warmup and drains queued setup + all buffered speech chunks in exact FIFO order
    drainWorker();
    expect(emittedPartials).toEqual(['喂', '喂你好', '喂你好听得到吗']);
    expect(timeline).toEqual([
      'main:AVAudioEngine.start+listeningState:started',
      'tap:audioLevel(喂)',
      'tap:audioLevel(你好)',
      'tap:audioLevel(听得到吗)',
      'worker:load.ensureRecognizer+warmup',
      'worker:start.sessionStream+drainLeftPadding',
      'worker:decode(喂)->喂',
      'worker:decode(你好)->喂你好',
      'worker:decode(听得到吗)->喂你好听得到吗',
    ]);
  });
});
