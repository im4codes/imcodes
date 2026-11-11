import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, join as pathJoin } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    expect(android).toContain('worker.execute(() -> capture(call, owner, audio, session));');
    expect(android).toContain('private void stopCapture(boolean discard)');
    expect(android).toMatch(/onAccepted\.run\(\);\s*\n\s*pcmQueue\.addLast\(samples\);/);
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

  it('compiles and executes production StreamingSpeechPlugin.java across cold stop-before-warmup, warm reuse, bounded overflow, and destroy', async () => {
    await setup();
    const srcDir = pathJoin(root, 'src');
    const classesDir = pathJoin(root, 'classes');
    await mkdir(classesDir, { recursive: true });

    const files: Record<string, string> = {
      'android/Manifest.java': `package android; public class Manifest { public static class permission { public static final String RECORD_AUDIO="mic"; } }`,
      'android/media/AudioFormat.java': `package android.media; public class AudioFormat { public static final int CHANNEL_IN_MONO=1, ENCODING_PCM_16BIT=2; }`,
      'android/media/MediaRecorder.java': `package android.media; public class MediaRecorder { public static class AudioSource { public static final int VOICE_RECOGNITION=1; } }`,
      'android/media/AudioRecord.java': `package android.media;
public class AudioRecord {
  public static final int STATE_INITIALIZED=1, RECORDSTATE_RECORDING=3, READ_BLOCKING=0;
  public static volatile AudioRecord latest;
  public static volatile int chunksPerStart=1;
  public static int reads=0;
  private boolean recording;
  private int remaining;
  public AudioRecord(int a,int b,int c,int d,int e){ latest=this; remaining=chunksPerStart; }
  public static int getMinBufferSize(int a,int b,int c){ return 3200; }
  public int getState(){ return STATE_INITIALIZED; }
  public synchronized int getRecordingState(){ return recording ? RECORDSTATE_RECORDING : 0; }
  public synchronized void startRecording(){ recording=true; }
  public synchronized void stop(){ recording=false; notifyAll(); }
  public void release(){}
  public synchronized int read(short[] out,int off,int n,int mode){
    reads++;
    while (remaining <= 0 && recording) {
      try { wait(); } catch (InterruptedException e) { return -1; }
    }
    if (!recording || remaining <= 0) return 0;
    remaining--;
    java.util.Arrays.fill(out, (short) 1000);
    return n;
  }
}`,
      'androidx/lifecycle/Lifecycle.java': `package androidx.lifecycle; public class Lifecycle { public enum State { RESUMED; public boolean isAtLeast(State other){ return true; } } public State getCurrentState(){ return State.RESUMED; } }`,
      'com/getcapacitor/JSArray.java': `package com.getcapacitor; public class JSArray extends java.util.ArrayList<Object>{ public JSArray put(Object x){ add(x); return this; } }`,
      'com/getcapacitor/JSObject.java': `package com.getcapacitor; public class JSObject extends java.util.TreeMap<String,Object>{}`,
      'com/getcapacitor/PermissionState.java': `package com.getcapacitor; public enum PermissionState{ GRANTED }`,
      'com/getcapacitor/PluginCall.java': `package com.getcapacitor; public class PluginCall { public final java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1); public String error; public void resolve(){ done.countDown(); } public void resolve(JSObject o){ resolve(); } public void reject(String e){ error=e; done.countDown(); } public void reject(String e,Exception x){ reject(e); } }`,
      'com/getcapacitor/Plugin.java': `package com.getcapacitor;
public class Plugin {
  public final java.util.List<String> events=java.util.Collections.synchronizedList(new java.util.ArrayList<>());
  public void load(){}
  protected void handleOnPause(){}
  protected void handleOnDestroy(){}
  public void notifyListeners(String key,JSObject value){ events.add(key+":"+value); }
  public PermissionState getPermissionState(String p){ return PermissionState.GRANTED; }
  public void requestPermissionForAlias(String a,PluginCall c,String callback){}
  public Context getContext(){ return new Context(); }
  public Activity getActivity(){ return new Activity(); }
  public static class Context { public Assets getAssets(){ return new Assets(); } }
  public static class Assets { public java.io.InputStream open(String path) throws java.io.IOException { return new java.io.ByteArrayInputStream(new byte[]{1}); } }
  public static class Activity { public androidx.lifecycle.Lifecycle getLifecycle(){ return new androidx.lifecycle.Lifecycle(); } }
}`,
      'com/getcapacitor/PluginMethod.java': `package com.getcapacitor; public @interface PluginMethod{}`,
      'com/getcapacitor/annotation/CapacitorPlugin.java': `package com.getcapacitor.annotation; public @interface CapacitorPlugin{ String name(); Permission[] permissions(); }`,
      'com/getcapacitor/annotation/Permission.java': `package com.getcapacitor.annotation; public @interface Permission{ String alias(); String[] strings(); }`,
      'com/getcapacitor/annotation/PermissionCallback.java': `package com.getcapacitor.annotation; public @interface PermissionCallback{}`,
      'com/k2fsa/sherpa/onnx/OnlineRecognizerConfig.java': `package com.k2fsa.sherpa.onnx;
public class OnlineRecognizerConfig {
  public Model getModelConfig(){ return new Model(); }
  public Endpoint getEndpointConfig(){ return new Endpoint(); }
  public void setDecodingMethod(String x){}
  public void setHotwordsFile(String x){}
  public void setHotwordsScore(float x){}
  public static class Model { public Transducer getTransducer(){ return new Transducer(); } public void setTokens(String x){} public void setModelType(String x){} public void setModelingUnit(String x){} public void setBpeVocab(String x){} public void setNumThreads(int n){} }
  public static class Transducer { public void setEncoder(String x){} public void setDecoder(String x){} public void setJoiner(String x){} }
  public static class Endpoint { public Rule getRule2(){ return new Rule(); } public Rule getRule3(){ return new Rule(); } }
  public static class Rule { public void setMinTrailingSilence(float x){} public void setMinUtteranceLength(float x){} }
}`,
      'com/k2fsa/sherpa/onnx/OnlineStream.java': `package com.k2fsa.sherpa.onnx;
public class OnlineStream {
  public String text="";
  public static volatile int spokenSamples=0;
  public static volatile java.util.concurrent.CountDownLatch speech=new java.util.concurrent.CountDownLatch(1);
  public void acceptWaveform(float[] data,int rate){
    for (float f : data) {
      if (f != 0) {
        spokenSamples += data.length;
        text = "synthetic utterance";
        speech.countDown();
        break;
      }
    }
  }
  public void inputFinished(){}
  public void release(){}
}`,
      'com/k2fsa/sherpa/onnx/OnlineRecognizer.java': `package com.k2fsa.sherpa.onnx;
public class OnlineRecognizer {
  public static volatile java.util.concurrent.CountDownLatch entered=new java.util.concurrent.CountDownLatch(1);
  public static volatile java.util.concurrent.CountDownLatch release=new java.util.concurrent.CountDownLatch(1);
  public static volatile int creations=0;
  public static volatile int releases=0;
  public OnlineRecognizer(Object assets,OnlineRecognizerConfig config){
    creations++;
    entered.countDown();
    try { release.await(); } catch (InterruptedException e) { throw new RuntimeException(e); }
  }
  public OnlineStream createStream(String s){ return new OnlineStream(); }
  public boolean isReady(OnlineStream s){ return false; }
  public void decode(OnlineStream s){}
  public boolean isEndpoint(OnlineStream s){ return false; }
  public void release(){ releases++; }
  public Result getResult(OnlineStream stream){ return new Result(stream.text); }
  public record Result(String text){ public String getText(){ return text; } }
}`,
      'Harness.java': `import com.imcodes.speech.StreamingSpeechPlugin;
import com.getcapacitor.PluginCall;
import com.k2fsa.sherpa.onnx.*;
import android.media.AudioRecord;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class Harness {
  static class Subject extends StreamingSpeechPlugin { void destroy(){ super.handleOnDestroy(); } }
  static void await(CountDownLatch latch){
    try {
      if (!latch.await(2, TimeUnit.SECONDS)) throw new AssertionError("timeout");
    } catch (InterruptedException e) {
      throw new RuntimeException(e);
    }
  }
  public static void main(String[] args) {
    // 1. Cold stop-before-warmup: utterance recorded while warmup is held must be drained and decoded after stop
    Subject p = new Subject();
    try {
      p.load();
      await(OnlineRecognizer.entered);
      PluginCall start = new PluginCall();
      p.start(start);
      await(start.done);
      boolean startedDuringWarmup = AudioRecord.latest.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING;
      PluginCall stop = new PluginCall();
      p.stop(stop);
      boolean micStoppedOnStop = AudioRecord.latest.getRecordingState() == 0;
      OnlineRecognizer.release.countDown();
      await(stop.done);
      if (!startedDuringWarmup || !micStoppedOnStop || OnlineStream.spokenSamples != 1600) {
        throw new AssertionError("COLD_STOP failed: started=" + startedDuringWarmup + " micStopped=" + micStoppedOnStop + " spoken=" + OnlineStream.spokenSamples);
      }
      System.out.println("COLD_STOP:" + OnlineStream.spokenSamples + ":" + p.events);

      // 2. Warm positive control: reuses resident recognizer without recreating
      p.events.clear();
      OnlineStream.speech = new CountDownLatch(1);
      PluginCall warmStart = new PluginCall();
      p.start(warmStart);
      await(warmStart.done);
      await(OnlineStream.speech);
      PluginCall warmStop = new PluginCall();
      p.stop(warmStop);
      await(warmStop.done);
      if (OnlineRecognizer.creations != 1 || OnlineStream.spokenSamples != 3200) {
        throw new AssertionError("WARM_POSITIVE failed: creations=" + OnlineRecognizer.creations + " spoken=" + OnlineStream.spokenSamples);
      }
      System.out.println("WARM_POSITIVE:" + OnlineRecognizer.creations + ":" + OnlineStream.spokenSamples + ":" + p.events);
    } finally {
      p.destroy();
    }
    // Wait briefly for worker shutdown after destroy
    for (int i = 0; i < 20 && OnlineRecognizer.releases == 0; i++) {
      try { Thread.sleep(10); } catch (InterruptedException ignored) {}
    }
    if (OnlineRecognizer.releases != 1) {
      throw new AssertionError("Expected resident recognizer release on destroy, got " + OnlineRecognizer.releases);
    }

    // 3. Bounded overflow during held warmup: >64 chunks stops mic and reports explicit error
    OnlineRecognizer.entered = new CountDownLatch(1);
    OnlineRecognizer.release = new CountDownLatch(1);
    AudioRecord.chunksPerStart = 70;
    Subject p2 = new Subject();
    try {
      p2.load();
      await(OnlineRecognizer.entered);
      PluginCall s2 = new PluginCall();
      p2.start(s2);
      await(s2.done);
      for (int i = 0; i < 100 && AudioRecord.latest.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING; i++) {
        try { Thread.sleep(5); } catch (InterruptedException ignored) {}
      }
      OnlineRecognizer.release.countDown();
      PluginCall stop2 = new PluginCall();
      p2.stop(stop2);
      await(stop2.done);
      System.out.println("OVERFLOW:" + p2.events);
    } finally {
      p2.destroy();
    }
  }
}`,
    };

    const javaSources: string[] = [];
    for (const [rel, content] of Object.entries(files)) {
      const full = pathJoin(srcDir, rel);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
      javaSources.push(full);
    }
    const pluginSource = fileURLToPath(
      new URL('../../web/plugins/streaming-speech/android/src/main/java/com/imcodes/speech/StreamingSpeechPlugin.java', import.meta.url),
    );
    javaSources.push(pluginSource);

    execFileSync('javac', ['-d', classesDir, ...javaSources], { stdio: 'pipe', timeout: 30000 });
    const output = execFileSync('java', ['-cp', classesDir, 'Harness'], { encoding: 'utf8', timeout: 10000 }).trim().split('\n');

    expect(output[0]).toContain('COLD_STOP:1600:[listeningState:{status=started}, audioLevel:{level=0.091552734375}, partialResults:{isFinal=false, matches=[synthetic utterance]}, partialResults:{isFinal=true, matches=[synthetic utterance]}, listeningState:{status=stopped}]');
    expect(output[1]).toContain('WARM_POSITIVE:1:3200:[listeningState:{status=started}, audioLevel:{level=0.091552734375}, partialResults:{isFinal=false, matches=[synthetic utterance]}, partialResults:{isFinal=true, matches=[synthetic utterance]}, listeningState:{status=stopped}]');
    expect(output[2]).toContain('recognitionError:{message=Offline speech processing overloaded}');
    expect(output[2]).toContain('listeningState:{status=stopped}');
  });
});
