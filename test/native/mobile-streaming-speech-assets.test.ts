import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { STREAMING_SPEECH_PLUGIN_NAME } from '../../shared/voice-recognition.js';
// @ts-ignore plain build script
import {
  ANDROID_SPEECH_ASSETS,
  IOS_MODEL_REVISION,
  IOS_SPEECH_ASSETS,
  MODEL_REVISION,
  SPEECH_ASSETS,
  matchesAsset,
  prepareSpeechAssets,
  selectSpeechAssets,
} from '../../web/scripts/prepare-streaming-speech.mjs';
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function setup() { root = await mkdtemp(join(tmpdir(), 'imcodes-test-speech-')); return pathToFileURL(root + '/'); }
const bytes = Buffer.from('offline-model');
const digest = createHash('sha256').update(bytes).digest('hex');
const asset = ['models/test.onnx', 'https://example.invalid/pinned/model', digest, bytes.length];
const modelFiles = ['conv_frontend.onnx', 'encoder.int4.onnx', 'encoder.int4.weights', 'decoder.int4.onnx', 'decoder.int4.weights', 'tokenizer/vocab.json', 'tokenizer/merges.txt', 'tokenizer/tokenizer_config.json', 'hotwords.txt'];
const iosModelFiles = ['config.json', 'model.safetensors', 'vocab.json', 'merges.txt', 'tokenizer_config.json', 'hotwords.txt'];

describe('Qwen3-ASR mobile assets', () => {
  it('pins the Android INT4 ONNX and iOS 0.6B MLX 4-bit assets and platform routing', async () => {
    expect(MODEL_REVISION).toBe('9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e');
    expect(IOS_MODEL_REVISION).toBe('bc441bd1e4295c1f42d9879f056049a925b6e013');
    expect(ANDROID_SPEECH_ASSETS).toHaveLength(10);
    expect(ANDROID_SPEECH_ASSETS.map((a: any) => a[2])).toEqual([
      'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e', '774e997d23a2f06c3f544666625c93a3b824fdd83d04c6acd88ee25f4e3b6e2e',
      'dc66975d9be10fbd31f89c76d33dd0bf4a8059ef14da4abf545bbf9895a5293d', 'c588d2a89460315f51ca8c65dbe85a0619891500fc853e5b673e3c914c25b2d3',
      '126c8e16074cc87250dacbf07602315e3bc5239c93ea414773b6e3a6fd4bf466', 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
      '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5', '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'a8d09d1d32f3eb8520482c6d3d43fae674681c5b050385967c70a3c2c9bf0ee7',
    ]);
    expect(ANDROID_SPEECH_ASSETS.map((a: any) => a[0])).toEqual([...modelFiles.map(x => 'models/' + x), 'android/libs/sherpa-onnx-2.0.1.aar']);
    expect(ANDROID_SPEECH_ASSETS.every((a: any) => /^[a-f\d]{64}$/.test(a[2]) && (a[0] === 'models/hotwords.txt' ? a[3] === 0 : a[3] > 0))).toBe(true);
    expect(ANDROID_SPEECH_ASSETS.slice(0, 8).every((a: any) => a[1].includes('/goodpixelltd/qwen3-asr-0.6b-int4-sherpa-onnx/resolve/' + MODEL_REVISION))).toBe(true);
    expect(ANDROID_SPEECH_ASSETS.map((a: any) => a[3])).toEqual([44148281, 5622024, 110308864, 891837, 469962752, 2776833, 1671853, 12487, 0, 49441341]);
    expect(await matchesAsset(new URL('../../web/plugins/streaming-speech/models/hotwords.txt', import.meta.url), ANDROID_SPEECH_ASSETS[8][2], 0)).toBe(true);

    expect(IOS_SPEECH_ASSETS).toHaveLength(7);
    expect(IOS_SPEECH_ASSETS.map((a: any) => a[2])).toEqual([
      '923618cf5ca452fda0253a6be5c1a17f94a2e4851d3b98beb45848565587bd72', '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5',
      '70c7e67e588062adce4f10796e47ad42ead51c6671eda61a0987eae38ca95ddf', 'e3bb80ef0fd42a5be07b04e90c97d60460bbde8af3531e0bfe9100a61404d81a',
      '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c', 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ]);
    expect(IOS_SPEECH_ASSETS.map((a: any) => a[0])).toEqual([
      'ios-models/config.json',
      'ios-models/merges.txt',
      'ios-models/model.safetensors',
      'ios-models/model.safetensors.index.json',
      'ios-models/tokenizer_config.json',
      'ios-models/vocab.json',
      'ios-models/hotwords.txt',
    ]);
    expect(IOS_SPEECH_ASSETS.every((a: any) => /^[a-f\d]{64}$/.test(a[2]) && (a[0] === 'ios-models/hotwords.txt' ? a[3] === 0 : a[3] > 0))).toBe(true);
    expect(IOS_SPEECH_ASSETS.slice(0, 6).every((a: any) => a[1].includes('/aufklarer/Qwen3-ASR-0.6B-MLX-4bit/resolve/' + IOS_MODEL_REVISION))).toBe(true);
    expect(IOS_SPEECH_ASSETS.map((a: any) => a[3])).toEqual([7187, 1671853, 708236945, 71814, 12487, 2776833, 0]);
    expect(await matchesAsset(new URL('../../web/plugins/streaming-speech/ios-models/hotwords.txt', import.meta.url), IOS_SPEECH_ASSETS[6][2], 0)).toBe(true);

    expect(SPEECH_ASSETS).toHaveLength(17);
    expect(SPEECH_ASSETS).toEqual([...ANDROID_SPEECH_ASSETS, ...IOS_SPEECH_ASSETS]);
    expect(selectSpeechAssets(['--android'])).toEqual(ANDROID_SPEECH_ASSETS);
    expect(selectSpeechAssets(['--ios'])).toEqual(IOS_SPEECH_ASSETS);
    expect(selectSpeechAssets([])).toEqual(SPEECH_ASSETS);
    expect(selectSpeechAssets(['--android', '--ios'])).toEqual(SPEECH_ASSETS);

    const gradle = await readFile(new URL('../../web/plugins/streaming-speech/android/build.gradle', import.meta.url), 'utf8');
    expect(gradle).toContain("'--android'");
    const workflow = await readFile(new URL('../../.github/workflows/mobile-speech.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('--ios');
    expect(workflow).toContain('MetalToolchain');
    expect(workflow).toContain('ios-models');
    const pluginPkg = await readFile(new URL('../../web/plugins/streaming-speech/Package.swift', import.meta.url), 'utf8');
    expect(pluginPkg).toContain('.iOS(.v17)');
    expect(pluginPkg).toContain('mlx-swift.git');
    expect(pluginPkg).toContain('"Cordova"');
    const capAppPkg = await readFile(new URL('../../web/ios/App/CapApp-SPM/Package.swift', import.meta.url), 'utf8');
    expect(capAppPkg).toContain('.iOS(.v17)');
    const pbxproj = await readFile(new URL('../../web/ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
    expect(pbxproj).toContain('IPHONEOS_DEPLOYMENT_TARGET = 17.0;');
  });
  it('reuses the bundled empty bias file without downloads and rejects stale hotwords', async () => {
    const url = await setup(); await mkdir(join(root, 'models'));
    const fetcher = vi.fn();
    await writeFile(join(root, 'models/hotwords.txt'), '');
    await prepareSpeechAssets(url, fetcher, [ANDROID_SPEECH_ASSETS[8]]);
    expect(fetcher).not.toHaveBeenCalled();
    await writeFile(join(root, 'models/hotwords.txt'), 'COMMIT');
    await expect(prepareSpeechAssets(url, fetcher, [ANDROID_SPEECH_ASSETS[8]])).rejects.toThrow('Bundled speech asset');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('publishes verified files atomically, reuses them, and repairs a corrupt cached file', async () => {
    const url = await setup(), fetcher = vi.fn(async () => new Response(bytes));
    await prepareSpeechAssets(url, fetcher, [asset]); await prepareSpeechAssets(url, fetcher, [asset]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await writeFile(join(root, 'models/test.onnx'), Buffer.alloc(bytes.length));
    await prepareSpeechAssets(url, fetcher, [asset]); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await matchesAsset(join(root, 'models/test.onnx'), digest, bytes.length)).toBe(true);
  });
  it('keeps last good files on a failed checksum and removes partial downloads', async () => {
    const url = await setup(); await prepareSpeechAssets(url, async () => new Response(bytes), [asset]);
    const mismatch = [...asset]; mismatch[2] = '0'.repeat(64);
    await expect(prepareSpeechAssets(url, async () => new Response(bytes), [mismatch])).rejects.toThrow('checksum/size mismatch');
    expect(await readFile(join(root, 'models/test.onnx'))).toEqual(bytes);
    expect(await readdir(join(root, 'models'))).toEqual(['test.onnx']);
  });
  it('fails visibly on missing bundled hotwords and HTTP failure', async () => {
    const url = await setup();
    await expect(prepareSpeechAssets(url, vi.fn(), [['models/hotwords.txt', null, digest, bytes.length]])).rejects.toThrow('Bundled speech asset');
    await expect(prepareSpeechAssets(url, async () => new Response('', { status: 503 }), [asset])).rejects.toThrow('HTTP 503');
  });
  it('retires all obsolete transducer/punctuation assets only after the replacement verifies', async () => {
    const url = await setup(); await mkdir(join(root, 'models'));
    const obsolete = ['encoder.int8.onnx', 'decoder.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'punct.int8.onnx', 'tokens.txt', 'bpe.vocab'];
    for (const name of [...obsolete, 'unrelated.keep']) await writeFile(join(root, 'models', name), bytes);
    await prepareSpeechAssets(url, async () => new Response(bytes), [['models/conv_frontend.onnx', 'https://example.invalid/pinned', digest, bytes.length]]);
    expect((await readdir(join(root, 'models'))).sort()).toEqual(['conv_frontend.onnx', 'unrelated.keep']);
  });
  it('keeps native contracts, bounded offline segments, 0.6B MLX config, and stream ownership aligned', async () => {
    const base = new URL('../../web/plugins/streaming-speech/', import.meta.url);
    const android = await readFile(new URL('android/src/main/java/com/imcodes/speech/StreamingSpeechPlugin.java', base), 'utf8');
    const ios = await readFile(new URL('ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', base), 'utf8');
    const qwenAsr = await readFile(new URL('ios/Sources/Qwen3ASR/Qwen3ASR.swift', base), 'utf8');
    expect(android).toContain(`@CapacitorPlugin(name = "${STREAMING_SPEECH_PLUGIN_NAME}"`);
    expect(ios).toContain(`jsName = "${STREAMING_SPEECH_PLUGIN_NAME}"`);
    for (const name of modelFiles) { expect(android).toContain('"' + name + '"'); }
    for (const name of iosModelFiles) { expect(ios).toContain('"' + name + '"'); }
    for (const name of ['listeningState', 'audioLevel', 'partialResults', 'recognitionError']) { expect(android).toContain('"' + name + '"'); expect(ios).toContain('"' + name + '"'); }
    expect(android).toContain('qwen.setMaxTotalLen(768)'); expect(android).toContain('new OfflineRecognizer(null, config)');
    expect(android).toContain('getNoBackupFilesDir()'); expect(android).toContain('finally { stream.release(); }');
    expect(android).toContain('qwen.setMaxNewTokens(24)');
    expect(android).toContain('MAX_BUFFERED_CHUNKS = 320');
    expect(android).toContain('model.setProvider("nnapi")');
    expect(android).toContain('catch (RuntimeException | LinkageError accelerationUnavailable)');
    expect(android).toContain('model.setProvider("cpu")');
    expect(android).toContain('model.setNumThreads(4)');
    expect(android).not.toContain('OfflinePunctuation'); expect(android).not.toContain('OnlineStream');

    expect(ios).toContain('import Qwen3ASR');
    expect(ios).toContain('import Metal');
    expect(ios).not.toContain('SherpaOnnx');
    expect(ios).not.toContain('OfflinePunctuation'); expect(ios).not.toContain('OnlineStream');
    expect(ios).toContain('#if targetEnvironment(simulator)');
    expect(ios).toContain('MTLCreateSystemDefaultDevice() != nil');
    expect(ios).toContain('Qwen3ASRModel.loadLocal(from: root)');
    expect(ios).toContain('Qwen3DecodingOptions(maxTokens: 128');
    expect(ios).toContain('transcribeWithCancellation(audio: samples, sampleRate: 16000');
    expect(ios).toContain('appendingPathComponent("ios-models", isDirectory: true)');
    expect(ios).toContain('static let capacity = 4 * stride');
    expect(ios).toContain('static let limit = 16000 * 320 / 10');
    expect(ios).toContain('static let warmupSamples = 320');
    expect(ios).toContain('options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth]');
    expect(ios).not.toContain('.duckOthers');
    expect(ios).toContain('if warming && inbox.warmupRemaining == 0');
    expect(ios).toContain('self?.startingCall?.resolve()');
    expect(ios).toContain('self?.startingCall = nil');
    expect(ios).toContain('AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity)');
    expect(ios).not.toContain('AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)');
    expect(ios).toContain('input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format)');
    expect(ios).toContain('Offline audio conversion failed:');
    expect(ios).toContain('UIApplication.shared.applicationState != .background');
    expect(ios).toContain('UIApplication.willResignActiveNotification');
    expect(ios).toContain('UIApplication.didEnterBackgroundNotification');
    expect(ios).toContain('UIApplication.didBecomeActiveNotification');
    expect(ios).toContain('static let audioLevelInterval: TimeInterval = 0.05');
    expect(ios).toContain('let level = inbox.pollAudioLevel(now: now)');
    expect(ios).toContain('let active = self.generation == owner && self.eventOwner == owner');
    expect(ios).toContain('case .audioLevel(let level):');
    expect(ios).toContain('self.notifyListeners("audioLevel", data: ["level": level])');
    const drainSection = ios.slice(ios.indexOf('private func drain('), ios.indexOf('/// The same Capacitor'));
    expect(drainSection).not.toContain('audioLevel');

    expect(qwenAsr).toContain('modelId: String = "aufklarer/Qwen3-ASR-0.6B-MLX-4bit"');
    expect(qwenAsr).toContain('case .small: return .small');
  });
  it('compiles and executes the production Android plugin through cold/warm/stop/segmentation/overflow/destroy', async () => {
    await setup(); const srcDir = join(root, 'src'), classesDir = join(root, 'classes'); await mkdir(classesDir, { recursive: true });
    const files: Record<string, string> = {
      'android/Manifest.java': `package android; public class Manifest { public static class permission { public static final String RECORD_AUDIO="mic"; } }`,
      'android/media/AudioFormat.java': `package android.media; public class AudioFormat { public static final int CHANNEL_IN_MONO=1, ENCODING_PCM_16BIT=2; }`,
      'android/media/MediaRecorder.java': `package android.media; public class MediaRecorder { public static class AudioSource { public static final int VOICE_RECOGNITION=1; } }`,
      'android/media/AudioRecord.java': `package android.media;
public class AudioRecord {
  public static final int STATE_INITIALIZED=1, RECORDSTATE_RECORDING=3, READ_BLOCKING=0;
  public static volatile AudioRecord latest;
  public static volatile int chunksPerStart=1;
  public static volatile int silentChunksPerStart=0;
  public static volatile boolean labelledWords=false;
  public static int reads=0;
  public static volatile java.util.concurrent.CountDownLatch delivered;
  private boolean recording;
  private int remaining;
  private int silentRemaining;
  private int deliveredVoiced=0;
  public AudioRecord(int a,int b,int c,int d,int e){ latest=this; remaining=chunksPerStart; silentRemaining=silentChunksPerStart; delivered=new java.util.concurrent.CountDownLatch(remaining+silentRemaining); }
  public static int getMinBufferSize(int a,int b,int c){ return 3200; }
  public int getState(){ return STATE_INITIALIZED; }
  public synchronized int getRecordingState(){ return recording ? RECORDSTATE_RECORDING : 0; }
  public synchronized void startRecording(){ recording=true; }
  public synchronized void stop(){ recording=false; notifyAll(); }
  public void release(){}
  public synchronized int read(short[] out,int off,int n,int mode){
    reads++; try { wait(1); } catch (InterruptedException ignored) {}
    while (remaining <= 0 && silentRemaining <= 0 && recording) {
      try { wait(); } catch (InterruptedException e) { return -1; }
    }
    if (!recording || (remaining <= 0 && silentRemaining <= 0)) return 0;
    if (remaining > 0) {
      remaining--;
      short val = labelledWords ? (short)(1000 + (deliveredVoiced / 15)) : (short) 1000;
      deliveredVoiced++;
      java.util.Arrays.fill(out, val);
    } else {
      silentRemaining--;
      java.util.Arrays.fill(out, (short) 0);
    }
    delivered.countDown(); return n;
  }
}`,
      'androidx/lifecycle/Lifecycle.java': `package androidx.lifecycle; public class Lifecycle { public enum State { RESUMED; public boolean isAtLeast(State other){ return true; } } public State getCurrentState(){ return State.RESUMED; } }`,
      'com/getcapacitor/JSArray.java': `package com.getcapacitor; public class JSArray extends java.util.ArrayList<Object>{ public JSArray put(Object x){ add(x); return this; } }`,
      'com/getcapacitor/JSObject.java': `package com.getcapacitor; public class JSObject extends java.util.TreeMap<String,Object>{}`,
      'com/getcapacitor/PermissionState.java': `package com.getcapacitor; public enum PermissionState{ GRANTED }`,
      'com/getcapacitor/PluginCall.java': `package com.getcapacitor; public class PluginCall { public final java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1); public String error,value; public void resolve(){ done.countDown(); } public void resolve(JSObject o){ value=o.toString(); resolve(); } public void reject(String e){ error=e; done.countDown(); } public void reject(String e,Exception x){ reject(e); } }`,
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
  public static class Context { public Assets getAssets(){ return new Assets(); } public java.io.File getNoBackupFilesDir(){ return new java.io.File(System.getProperty("java.io.tmpdir"),"speech-private"); } }
  public static class Assets { public java.io.InputStream open(String path) throws java.io.IOException { return new java.io.ByteArrayInputStream(path.equals("hotwords.txt") ? new byte[0] : new byte[]{1}); } }
  public static class Activity { public androidx.lifecycle.Lifecycle getLifecycle(){ return new androidx.lifecycle.Lifecycle(); } }
}`,
      'com/getcapacitor/PluginMethod.java': `package com.getcapacitor; public @interface PluginMethod{}`,
      'com/getcapacitor/annotation/CapacitorPlugin.java': `package com.getcapacitor.annotation; public @interface CapacitorPlugin{ String name(); Permission[] permissions(); }`,
      'com/getcapacitor/annotation/Permission.java': `package com.getcapacitor.annotation; public @interface Permission{ String alias(); String[] strings(); }`,
      'com/getcapacitor/annotation/PermissionCallback.java': `package com.getcapacitor.annotation; public @interface PermissionCallback{}`,
      'com/k2fsa/sherpa/onnx/OfflineRecognizerConfig.java': `package com.k2fsa.sherpa.onnx;
public class OfflineRecognizerConfig {
  private final Model model=new Model(); public Model getModelConfig(){return model;}
  public static class Model { public void setNumThreads(int n){if(n!=4)throw new AssertionError();} public String provider; public void setProvider(String p){provider=p;} public Qwen getQwen3Asr(){return new Qwen();} }
  public static class Qwen { public void setConvFrontend(String p){} public void setEncoder(String p){} public void setDecoder(String p){} public void setTokenizer(String p){} public void setMaxTotalLen(int n){if(n!=768)throw new AssertionError();} public void setMaxNewTokens(int n){} public void setTemperature(float n){} public void setTopP(float n){} public void setSeed(int n){} public void setHotwords(String s){if(!s.isEmpty())throw new AssertionError(s);} }
}`,
      'com/k2fsa/sherpa/onnx/OfflineStream.java': `package com.k2fsa/sherpa/onnx;`.replace(/\//g, '.').replace('package com.k2fsa.sherpa.onnx.;', 'package com.k2fsa.sherpa.onnx;') + `
public class OfflineStream {
  public float[] samples;
  public static int created=0,released=0,maxSamples=0;
  public static volatile float[] lastAcceptedSamples;
  public static final java.util.List<Integer> acceptedLengths=java.util.Collections.synchronizedList(new java.util.ArrayList<>());
  public OfflineStream(){created++;}
  public void acceptWaveform(float[] s,int rate){
    if(samples!=null||rate!=16000)throw new AssertionError();
    samples=s;
    lastAcceptedSamples=s;
    acceptedLengths.add(s.length);
    maxSamples=Math.max(maxSamples,s.length);
  }
  public void release(){released++;}
}`,
      'com/k2fsa/sherpa/onnx/OfflineRecognizer.java': `package com.k2fsa.sherpa.onnx;
public class OfflineRecognizer {
 public static java.util.concurrent.CountDownLatch entered=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1),decoded=new java.util.concurrent.CountDownLatch(1);
 public static volatile int attempts=0,creations=0,releases=0; public static volatile int lastSamples=0; public static volatile boolean holdDecode=false; public static java.util.concurrent.CountDownLatch decoding=new java.util.concurrent.CountDownLatch(1),decodeRelease=new java.util.concurrent.CountDownLatch(1);
 public OfflineRecognizer(Object assets,OfflineRecognizerConfig config){if(assets!=null)throw new AssertionError("external weights require files");
 if(config.getModelConfig().provider.equals("nnapi")) {
  attempts++;
  String failure=System.getProperty("nnapiFailure", "none");
  if(failure.equals("runtime"))throw new IllegalArgumentException("EP rejected");
  if(failure.equals("linkage"))throw new UnsatisfiedLinkError("EP unavailable");
 } else if(!config.getModelConfig().provider.equals("cpu"))throw new AssertionError("unexpected provider");
 creations++;entered.countDown();try{release.await();}catch(InterruptedException e){throw new RuntimeException(e);}}
 public OfflineStream createStream(){return new OfflineStream();}
 public void decode(OfflineStream stream){lastSamples=stream.samples.length;decoded.countDown();if(holdDecode){decoding.countDown();try{decodeRelease.await();}catch(InterruptedException e){throw new RuntimeException(e);}}}
 public Result getResult(OfflineStream stream){
  if (android.media.AudioRecord.labelledWords && stream.samples != null) {
   StringBuilder sb = new StringBuilder();
   int prev = -1;
   for (float v : stream.samples) {
    int raw = Math.round(v * 32768.0f);
    if (raw < 1000) continue;
    int id = raw - 1000;
    if (id != prev) {
     if (sb.length() > 0) sb.append(' ');
     sb.append(String.format("word%03d", id));
     prev = id;
    }
   }
   return new Result(sb.toString());
  }
  return new Result("你好 Hello.");
 }
 public static class Result { private final String text; public Result(String t){this.text=t;} public String getText(){return text;}}
 public void release(){releases++;}
}`,
      'Harness.java': `import com.imcodes.speech.StreamingSpeechPlugin; import com.getcapacitor.PluginCall; import com.k2fsa.sherpa.onnx.*; import android.media.AudioRecord; import java.util.concurrent.*;
public class Harness {
 static class Subject extends StreamingSpeechPlugin {void destroy(){handleOnDestroy();}}
 static void await(CountDownLatch l)throws Exception{if(!l.await(4,TimeUnit.SECONDS))throw new AssertionError("timeout");}
 static void check(boolean b,Object message){if(!b)throw new AssertionError(message);}
 static long finals(Subject p){return p.events.stream().filter(x->x.contains("isFinal=true")).count();}
 static boolean hasTrailingZeroFlush(float[] s, int voicedCount) {
  if (s == null || s.length != voicedCount + 3200) return false;
  for (int i = 0; i < voicedCount; i++) if (s[i] == 0.0f) return false;
  for (int i = voicedCount; i < s.length; i++) if (s[i] != 0.0f) return false;
  return true;
 }
 public static void main(String[] args)throws Exception {
  Subject p=new Subject();
  // Empty optional bias is available; stale cached nonempty bias is replaced.
  java.io.File cache=new java.io.File(p.getContext().getNoBackupFilesDir(), "qwen3-asr-9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e/hotwords.txt");
  cache.getParentFile().mkdirs();java.nio.file.Files.writeString(cache.toPath(), "COMMIT");
  PluginCall available=new PluginCall();p.available(available);await(available.done);
  check(available.value.contains("available=true"),available.value);
  try {
   p.load();await(OfflineRecognizer.entered);
   check(cache.length()==0,"stale hotwords cache survived");
   PluginCall start=new PluginCall();p.start(start);await(start.done);await(AudioRecord.delivered);
   PluginCall stop=new PluginCall();p.stop(stop);OfflineRecognizer.release.countDown();await(stop.done);
   check(OfflineRecognizer.lastSamples==1600+3200,"expected 1600+3200 final samples, got "+OfflineRecognizer.lastSamples);
   check(hasTrailingZeroFlush(OfflineStream.lastAcceptedSamples, 1600),"final decode missing exact 3200 zero flush");
   check(finals(p)==1,p.events);check(p.events.get(p.events.size()-1).contains("status=stopped"),p.events);
   System.out.println("COLD_STOP_OK");
   p.events.clear();OfflineStream.acceptedLengths.clear();AudioRecord.chunksPerStart=18;OfflineRecognizer.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(OfflineRecognizer.decoded);await(AudioRecord.delivered);PluginCall stop2=new PluginCall();p.stop(stop2);await(stop2.done);
   check(OfflineRecognizer.creations==1,p.events);check(OfflineRecognizer.attempts==1,"NNAPI attempted again on warm reuse");check(finals(p)==1,p.events);check(p.events.stream().anyMatch(x->x.contains("isFinal=false")),p.events);System.out.println("WARM_REUSE_OK");
   p.events.clear();OfflineStream.acceptedLengths.clear();OfflineStream.maxSamples=0;AudioRecord.chunksPerStart=55;OfflineRecognizer.holdDecode=true;
   OfflineRecognizer.decoding=new CountDownLatch(1);OfflineRecognizer.decodeRelease=new CountDownLatch(1);
   p.start(new PluginCall());await(OfflineRecognizer.decoding);await(AudioRecord.delivered);
   PluginCall drainedStop=new PluginCall();p.stop(drainedStop);
   check(drainedStop.done.getCount()==1,"stop overtook in-flight decode");
   OfflineRecognizer.decodeRelease.countDown();await(drainedStop.done);OfflineRecognizer.holdDecode=false;
   check(OfflineStream.maxSamples<=72000+3200,"stop drain exceeded bounded 4.5s capacity: "+OfflineStream.maxSamples);
   check(hasTrailingZeroFlush(OfflineStream.lastAcceptedSamples, 40000),"final bounded window missing 3200 zero flush");
   check(finals(p)==1,p.events);System.out.println("SINGLE_TAIL_DRAIN_OK");
   p.events.clear();AudioRecord.chunksPerStart=15;AudioRecord.silentChunksPerStart=6;OfflineRecognizer.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(OfflineRecognizer.decoded);await(AudioRecord.delivered);PluginCall stop3=new PluginCall();p.stop(stop3);await(stop3.done);
   check(p.events.stream().filter(x->x.contains("isFinal=true")).anyMatch(x->x.contains("你好 Hello.")&&!x.contains("你好 Hello.你好")),p.events);System.out.println("SILENCE_SEGMENT_OK");
   p.events.clear();OfflineStream.acceptedLengths.clear();OfflineStream.maxSamples=0;
   AudioRecord.labelledWords=true;AudioRecord.chunksPerStart=205;AudioRecord.silentChunksPerStart=0;OfflineRecognizer.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(AudioRecord.delivered);PluginCall stop4=new PluginCall();p.stop(stop4);await(stop4.done);
   AudioRecord.labelledWords=false;
   check(OfflineStream.maxSamples>=48000 && OfflineStream.maxSamples<=72000+3200,"window capacity violated: "+OfflineStream.maxSamples);
   for (int idx=0; idx<OfflineStream.acceptedLengths.size()-1; idx++) {
    check(OfflineStream.acceptedLengths.get(idx)<=72000, "live/intermediate window exceeded 72000: "+OfflineStream.acceptedLengths.get(idx));
   }
   check(finals(p)==1,p.events);
   StringBuilder expectedWords = new StringBuilder();
   for (int w=0; w<=13; w++) { if (w>0) expectedWords.append(' '); expectedWords.append(String.format("word%03d", w)); }
   check(p.events.stream().filter(x->x.contains("isFinal=true")).anyMatch(x->x.contains(expectedWords.toString())),p.events);
   check(OfflineStream.created==OfflineStream.released,p.events);System.out.println("WINDOW_AND_RELEASE_OK");
  } finally {p.destroy();}
  for(int i=0;i<100&&OfflineRecognizer.releases==0;i++)Thread.sleep(5);check(OfflineRecognizer.releases==1,OfflineRecognizer.releases);
  OfflineRecognizer.entered=new CountDownLatch(1);OfflineRecognizer.release=new CountDownLatch(1);AudioRecord.chunksPerStart=330;
  Subject overflow=new Subject();try{overflow.load();await(OfflineRecognizer.entered);overflow.start(new PluginCall());for(int i=0;i<800&&AudioRecord.latest.getRecordingState()==AudioRecord.RECORDSTATE_RECORDING;i++)Thread.sleep(5);check(AudioRecord.latest.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING,"overflow did not stop intake");OfflineRecognizer.release.countDown();PluginCall end=new PluginCall();overflow.stop(end);await(end.done);check(overflow.events.stream().anyMatch(x->x.contains("processing overloaded")),overflow.events);System.out.println("OVERFLOW_OK");}finally{overflow.destroy();}
  for(int i=0;i<100&&OfflineRecognizer.releases<2;i++)Thread.sleep(5);
  OfflineRecognizer.holdDecode=true;OfflineRecognizer.decoding=new CountDownLatch(1);OfflineRecognizer.decodeRelease=new CountDownLatch(1);AudioRecord.chunksPerStart=15;
  Subject retired=new Subject();retired.load();retired.start(new PluginCall());await(OfflineRecognizer.decoding);
  retired.destroy();OfflineRecognizer.decodeRelease.countDown();
  for(int i=0;i<100&&OfflineRecognizer.releases<3;i++)Thread.sleep(5);
  check(retired.events.stream().noneMatch(x->x.contains("partialResults")),retired.events);
  check(OfflineStream.created==OfflineStream.released,retired.events);System.out.println("OWNER_RETIRE_OK");
 }
}`,
    };
    const sources: string[] = [];
    for (const [relative, content] of Object.entries(files)) { const full=join(srcDir, relative); await mkdir(dirname(full),{recursive:true});await writeFile(full,content);sources.push(full); }
    sources.push(fileURLToPath(new URL('../../web/plugins/streaming-speech/android/src/main/java/com/imcodes/speech/StreamingSpeechPlugin.java',import.meta.url)));
    execFileSync('javac',['-d',classesDir,...sources],{stdio:'pipe',timeout:30000});
    for (const failure of ['none', 'runtime', 'linkage']) {
      const output=execFileSync('java',['-Djava.io.tmpdir='+root, '-DnnapiFailure='+failure, '-cp',classesDir,'Harness'],{encoding:'utf8',timeout:15000}).trim().split('\n');
      expect(output, `NNAPI ${failure}`).toEqual(['COLD_STOP_OK','WARM_REUSE_OK','SINGLE_TAIL_DRAIN_OK','SILENCE_SEGMENT_OK','WINDOW_AND_RELEASE_OK','OVERFLOW_OK','OWNER_RETIRE_OK']);
    }
  });
});

// Execute the production Foundation-only recognizer, decoder, coordinator, and bounded window.
// iOS AVAudioEngine/MLX Metal kernel execution runs on physical iOS hardware in Xcode.
const swiftCompiler = process.env.SWIFTC || (existsSync('/usr/bin/swiftc') ? '/usr/bin/swiftc' : undefined);
it.skipIf(!swiftCompiler)('executes the production Swift recognizer, decoder, and background cancellation coordinator', async () => {
  await setup();
  const plugin = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', import.meta.url), 'utf8');
  const coordinatorSlice = plugin.slice(plugin.indexOf('final class SpeechCoordinator {'), plugin.indexOf('/// The same Capacitor'));
  const recognizerSlice = plugin.slice(plugin.indexOf('final class SpeechRecognizer {'), plugin.indexOf('// MARK: - Bounded offline segmentation'));
  const windowAndInboxSlice = plugin.slice(plugin.indexOf('struct SpeechWindow {'));
  expect(coordinatorSlice).toContain('final class SpeechCoordinator');
  expect(recognizerSlice).toContain('final class SpeechRecognizer');
  expect(recognizerSlice).toContain('final class SpeechDecoder');
  expect(windowAndInboxSlice).toContain('struct SpeechInbox');

  const file = join(root, 'coordinator.swift'), executable = join(root, 'coordinator');
  const emptyDir = join(root, 'empty-hw'), biasedDir = join(root, 'biased-hw');
  await mkdir(emptyDir, { recursive: true });
  await mkdir(biasedDir, { recursive: true });
  await writeFile(join(emptyDir, 'hotwords.txt'), '');
  await writeFile(join(biasedDir, 'hotwords.txt'), 'Qwen3\n  IMCodes \n\n');

  await writeFile(file, `import Foundation
func require(_ cond: @autoclosure () -> Bool, _ msg: String) {
    if !cond() { FileHandle.standardError.write(Data(("FAIL: " + msg + "\\n").utf8)); exit(1) }
}
var stubMetalAvailable = true
func MTLCreateSystemDefaultDevice() -> AnyObject? { stubMetalAvailable ? NSObject() : nil }
struct Qwen3DecodingOptions {
    var maxTokens: Int = 448
    var language: String? = nil
    var context: String? = nil
}
var loadedRoots: [URL] = []
var seenOptions: [Qwen3DecodingOptions] = []
var cancelAfterCheck = false
final class Qwen3ASRModel {
    let root: URL
    init(root: URL) { self.root = root }
    static func loadLocal(from root: URL) throws -> Qwen3ASRModel {
        loadedRoots.append(root)
        return Qwen3ASRModel(root: root)
    }
    func transcribeWithCancellation(audio: [Float], sampleRate: Int, options: Qwen3DecodingOptions, cancellationCheck: () throws -> Void) throws -> String {
        seenOptions.append(options)
        precondition(sampleRate == 16000)
        try cancellationCheck()
        if cancelAfterCheck { throw CancellationError() }
        return "  ok:\\(audio.count)  "
    }
}
${recognizerSlice}
${windowAndInboxSlice}
${coordinatorSlice}

let emptyRoot = URL(fileURLWithPath: CommandLine.arguments[1])
let biasedRoot = URL(fileURLWithPath: CommandLine.arguments[2])

// 1. SpeechRecognizer + SpeechDecoder Metal guard, hotwords bias & cancellation
stubMetalAvailable = false
require(SpeechRecognizer(root: emptyRoot) == nil, "expected nil SpeechRecognizer when Metal unavailable")
stubMetalAvailable = true
let rEmpty = SpeechRecognizer(root: emptyRoot)
require(rEmpty != nil && rEmpty?.hotwords == nil, "empty hotwords must yield nil bias")
let rBias = SpeechRecognizer(root: biasedRoot)
require(rBias?.hotwords == "Qwen3, IMCodes", "hotwords trimming/joining mismatch: \\(String(describing: rBias?.hotwords))")
let dec = SpeechDecoder(recognizer: rBias!)!
require(dec.decode(samples: [0.1, 0.2]) == "ok:2", "expected trimmed decoded text")
require(seenOptions.last?.maxTokens == 128 && seenOptions.last?.context == "Qwen3, IMCodes", "unexpected Qwen3DecodingOptions")
require(dec.decode(samples: [0.1], shouldContinue: { false }) == nil, "expected pre-cancelled decode to return nil")
cancelAfterCheck = true
require(dec.decode(samples: [0.1], shouldContinue: { true }) == nil, "expected CancellationError decode to return nil")
cancelAfterCheck = false
print("RECOGNIZER_DECODER:PASS")

func speech(_ count: Int, amp: Float = 0.2) -> [Float] { Array(repeating: amp, count: count) }
func makeHarness() -> (SpeechCoordinator, DispatchQueue, () -> [SpeechCoordinator.Event]) {
    let q = DispatchQueue(label: "test.emit")
    var events: [SpeechCoordinator.Event] = []
    let coord = SpeechCoordinator(emitQueue: q) { event in events.append(event) }
    return (coord, q, { q.sync { events } })
}

// 2A. 0.5s (8000 samples) un-decoded speech backgrounded -> error before stopped, NO false final, ACK rejects
do {
    let (coord, _, events) = makeHarness()
    let owner = coord.beginStart(makeDecode: { { s, cont in cont() ? "w:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner, now: 0.01) {}
    coord.offerSamples(speech(8000), owner: owner, now: 0.10) {}
    coord.setBackgrounded(true)
    let ack1 = DispatchSemaphore(value: 0)
    var err1: String? = nil
    coord.endCapture(stopCompletion: { err in err1 = err; ack1.signal() }, stopAudio: {})
    require(ack1.wait(timeout: .now() + 2) == .success, "A: stop ACK timed out")
    require(err1 != nil, "A: expected rejection on background un-decoded audio, got nil")
    let ack2 = DispatchSemaphore(value: 0)
    var err2: String? = nil
    coord.endCapture(stopCompletion: { err in err2 = err; ack2.signal() }, stopAudio: {})
    require(ack2.wait(timeout: .now() + 2) == .success && err2 == err1, "A: duplicate stop did not replay error")
    let evs = events()
    require(!evs.contains { if case .final = $0 { return true }; return false }, "A: must not emit final on lost tail: \\(evs)")
    let errIdx = evs.firstIndex { if case .error = $0 { return true }; return false }
    let stopIdx = evs.firstIndex(of: .stopped)
    require(errIdx != nil && stopIdx != nil && errIdx! < stopIdx!, "A: error must precede stopped: \\(evs)")
    print("BG_UNDECODED_SHORT:PASS")
}

// 2B. partial already emitted (>=24000) + 8000 tail backgrounded -> NO partial-as-final, error before stopped, ACK rejects
do {
    let (coord, _, events) = makeHarness()
    let partialSeen = DispatchSemaphore(value: 0)
    let q = DispatchQueue(label: "test.emit.b")
    var evList: [SpeechCoordinator.Event] = []
    let coordB = SpeechCoordinator(emitQueue: q) { e in
        evList.append(e)
        if case .partial = e { partialSeen.signal() }
    }
    _ = (coord, events)
    let owner = coordB.beginStart(makeDecode: { { s, cont in cont() ? "partial_ok:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    coordB.offerSamples(speech(320), owner: owner, now: 0.01) {}
    coordB.offerSamples(speech(24000), owner: owner, now: 0.20) {}
    require(partialSeen.wait(timeout: .now() + 2) == .success, "B: initial partial never emitted")
    coordB.offerSamples(speech(8000), owner: owner, now: 0.30) {}
    coordB.setBackgrounded(true)
    let ack = DispatchSemaphore(value: 0)
    var stopErr: String? = nil
    coordB.endCapture(stopCompletion: { err in stopErr = err; ack.signal() }, stopAudio: {})
    require(ack.wait(timeout: .now() + 2) == .success && stopErr != nil, "B: expected stop rejection when tail lost in background")
    let evs = q.sync { evList }
    require(!evs.contains { if case .final = $0 { return true }; return false }, "B: partial must NOT be promoted to final=true on background drop: \\(evs)")
    let errIdx = evs.firstIndex { if case .error = $0 { return true }; return false }
    let stopIdx = evs.firstIndex(of: .stopped)
    require(errIdx != nil && stopIdx != nil && errIdx! < stopIdx!, "B: error must precede stopped: \\(evs)")
    print("BG_PARTIAL_PLUS_TAIL:PASS")
}

// 2C. Mid-decode background cancellation -> cancel active decode, NO final, error before stopped, ACK rejects
do {
    let q = DispatchQueue(label: "test.emit.c")
    var evList: [SpeechCoordinator.Event] = []
    let coord = SpeechCoordinator(emitQueue: q) { e in evList.append(e) }
    let decodeEntered = DispatchSemaphore(value: 0)
    let releaseDecode = DispatchSemaphore(value: 0)
    let owner = coord.beginStart(makeDecode: {
        { _, cont in
            decodeEntered.signal()
            _ = releaseDecode.wait(timeout: .now() + 2)
            return cont() ? "never" : nil
        }
    }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner, now: 0.01) {}
    coord.offerSamples(speech(24000), owner: owner, now: 0.20) {}
    require(decodeEntered.wait(timeout: .now() + 2) == .success, "C: decode did not enter")
    coord.setBackgrounded(true)
    releaseDecode.signal()
    let ack = DispatchSemaphore(value: 0)
    var stopErr: String? = nil
    coord.endCapture(stopCompletion: { err in stopErr = err; ack.signal() }, stopAudio: {})
    require(ack.wait(timeout: .now() + 2) == .success && stopErr != nil, "C: mid-decode cancel must reject stop ACK")
    let evs = q.sync { evList }
    require(!evs.contains { if case .final = $0 { return true }; return false }, "C: mid-decode cancel emitted final: \\(evs)")
    let errIdx = evs.firstIndex { if case .error = $0 { return true }; return false }
    let stopIdx = evs.firstIndex(of: .stopped)
    require(errIdx != nil && stopIdx != nil && errIdx! < stopIdx!, "C: error must precede stopped: \\(evs)")
    print("BG_MID_DECODE_CANCEL:PASS")
}

// 2D. Clean foreground capture & duplicate stop -> single final, zero errors, stopped once, nil ACK
do {
    let (coord, _, events) = makeHarness()
    let owner = coord.beginStart(makeDecode: { { s, cont in cont() ? "fg:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner, now: 0.01) {}
    coord.offerSamples(speech(8000), owner: owner, now: 0.15) {}
    let ack1 = DispatchSemaphore(value: 0), ack2 = DispatchSemaphore(value: 0)
    var err1: String? = "unset", err2: String? = "unset"
    coord.endCapture(stopCompletion: { e in err1 = e; ack1.signal() }, stopAudio: {})
    coord.endCapture(stopCompletion: { e in err2 = e; ack2.signal() }, stopAudio: {})
    require(ack1.wait(timeout: .now() + 2) == .success && ack2.wait(timeout: .now() + 2) == .success, "D: stop timed out")
    require(err1 == nil && err2 == nil, "D: expected nil errors on clean foreground stop")
    let evs = events()
    let finals = evs.filter { if case .final = $0 { return true }; return false }
    let stops = evs.filter { $0 == .stopped }
    let errs = evs.filter { if case .error = $0 { return true }; return false }
    require(finals == [.final("fg:11200")] && stops.count == 1 && errs.isEmpty, "D: unexpected foreground events: \\(evs)")
    print("FG_CLEAN_AND_DUPLICATE_STOP:PASS")
}

// 2E. Owner replacement & foreground recovery -> old backgrounded owner never leaks errors to new foreground owner
do {
    let q = DispatchQueue(label: "test.emit.e")
    var evList: [SpeechCoordinator.Event] = []
    let coord = SpeechCoordinator(emitQueue: q) { e in evList.append(e) }
    let decodeEntered = DispatchSemaphore(value: 0)
    let releaseOld = DispatchSemaphore(value: 0)
    let owner1 = coord.beginStart(makeDecode: {
        { _, cont in
            decodeEntered.signal()
            _ = releaseOld.wait(timeout: .now() + 2)
            return cont() ? "old" : nil
        }
    }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner1, now: 0.01) {}
    coord.offerSamples(speech(24000), owner: owner1, now: 0.20) {}
    require(decodeEntered.wait(timeout: .now() + 2) == .success, "E: owner1 decode did not enter")
    coord.setBackgrounded(true)
    coord.endCapture(stopAudio: {})
    coord.setBackgrounded(false)
    let owner2 = coord.beginStart(makeDecode: { { s, cont in cont() ? "recovered:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    releaseOld.signal()
    coord.offerSamples(speech(320), owner: owner2, now: 0.50) {}
    coord.offerSamples(speech(8000), owner: owner2, now: 0.60) {}
    let ack2 = DispatchSemaphore(value: 0)
    var err2: String? = "unset"
    coord.endCapture(stopCompletion: { e in err2 = e; ack2.signal() }, stopAudio: {})
    require(ack2.wait(timeout: .now() + 2) == .success && err2 == nil, "E: owner2 recovery failed: \\(String(describing: err2))")
    let evs = q.sync { evList }
    require(!evs.contains { if case .error = $0 { return true }; return false }, "E: old owner leaked error into new session: \\(evs)")
    require(evs.contains(.final("recovered:11200")), "E: owner2 final missing: \\(evs)")
    print("OWNER_REPLACEMENT_RECOVERY:PASS")
}

// 2F. Cold setup failure concurrent with endCapture -> single error, stopped, rejected ACK
do {
    let (coord, _, events) = makeHarness()
    let setupEntered = DispatchSemaphore(value: 0), releaseSetup = DispatchSemaphore(value: 0)
    let owner = coord.beginStart(makeDecode: {
        setupEntered.signal()
        _ = releaseSetup.wait(timeout: .now() + 2)
        return nil
    }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner, now: 0.01) {}
    require(setupEntered.wait(timeout: .now() + 2) == .success, "F: setup did not start")
    let ack = DispatchSemaphore(value: 0)
    var err: String? = nil
    coord.endCapture(stopCompletion: { e in err = e; ack.signal() }, stopAudio: {})
    releaseSetup.signal()
    require(ack.wait(timeout: .now() + 2) == .success && err != nil, "F: setup fail should reject stop")
    let evs = events()
    let errIdx = evs.firstIndex { if case .error = $0 { return true }; return false }
    let stopIdx = evs.firstIndex(of: .stopped)
    require(errIdx != nil && stopIdx != nil && errIdx! < stopIdx!, "F: setup error must precede stopped: \\(evs)")
    print("SETUP_FAIL_WITH_STOP:PASS")
}

// 2G. R3-F2a: Late-delivery stopped guard across normal stop, duplicate stop, and owner replacement
do {
    func runOwnerDelivery(replaceBeforeDelivery: Bool, duplicateStop: Bool) {
        let q = DispatchQueue(label: replaceBeforeDelivery ? "test.late.replace" : "test.late.normal")
        var evs: [SpeechCoordinator.Event] = []
        let coord = SpeechCoordinator(emitQueue: q) { evs.append($0) }
        q.suspend()
        let old = coord.beginStart(makeDecode: { { s, cont in cont() ? "old:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
        coord.offerSamples(speech(320), owner: old, now: 0.01) {}
        coord.offerSamples(speech(8000), owner: old, now: 0.10) {}
        coord.worker.sync {}
        var oldAcks: [String?] = []
        coord.endCapture(stopCompletion: { oldAcks.append($0) }, stopAudio: {})
        if duplicateStop {
            coord.endCapture(stopCompletion: { oldAcks.append($0) }, stopAudio: {})
        }
        coord.worker.sync {}
        var freshOwner: UInt64 = 0
        if replaceBeforeDelivery {
            freshOwner = coord.beginStart(makeDecode: { { s, cont in cont() ? "fresh:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
            coord.offerSamples(speech(320), owner: freshOwner, now: 0.20) {}
            coord.worker.sync {}
        }
        q.resume()
        let snapshot = q.sync { evs }
        let stops = snapshot.filter { $0 == .stopped }.count
        let finals = snapshot.filter { if case .final = $0 { return true }; return false }.count
        let expectedAcks = duplicateStop ? 2 : 1
        require(oldAcks.count == expectedAcks && oldAcks.allSatisfy { $0 == nil }, "G: old ACK count/error mismatch: \\(oldAcks)")
        if replaceBeforeDelivery {
            require(stops == 0 && finals == 0 && snapshot == [.started], "G: stale stopped/final leaked into new owner: \\(snapshot)")
            let freshAck = DispatchSemaphore(value: 0)
            var freshErr: String? = "unset"
            coord.offerSamples(speech(1600), owner: freshOwner, now: 0.30) {}
            coord.endCapture(stopCompletion: { freshErr = $0; freshAck.signal() }, stopAudio: {})
            require(freshAck.wait(timeout: .now() + 2) == .success && freshErr == nil, "G: fresh capture failed after stale drop")
            let finalSnapshot = q.sync { evs }
            require(finalSnapshot.contains(.final("fresh:4800")) && finalSnapshot.filter { $0 == .stopped }.count == 1, "G: fresh owner did not finish cleanly: \\(finalSnapshot)")
        } else {
            require(stops == 1 && finals == 1 && snapshot.contains(.final("old:11200")), "G: normal terminal events wrong: \\(snapshot)")
        }
    }
    runOwnerDelivery(replaceBeforeDelivery: false, duplicateStop: false)
    runOwnerDelivery(replaceBeforeDelivery: true, duplicateStop: false)
    runOwnerDelivery(replaceBeforeDelivery: true, duplicateStop: true)
    print("LATE_OWNER_STOP_GUARD:PASS")
}

// 2H. R3-F2b: In-flight conversion barrier vs Stop retains tail once & rejects post-Stop taps
do {
    let (coord, _, events) = makeHarness()
    let owner = coord.beginStart(makeDecode: { { s, cont in cont() ? "tail:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    require(coord.admitAndOffer(owner: owner, now: 0.01, onOverloadTeardown: {}, produce: { .samples(speech(320)) }), "H: warmup admit failed")

    let convertEntered = DispatchSemaphore(value: 0)
    let releaseConvert = DispatchSemaphore(value: 0)
    let tapDone = DispatchSemaphore(value: 0)
    let stopAck = DispatchSemaphore(value: 0)
    var stopErr: String? = "unset"
    var stopAudioCalled = false
    var convertFinishedBeforeStopAudio = false

    DispatchQueue.global(qos: .userInitiated).async {
        let ok = coord.admitAndOffer(owner: owner, now: 0.10, onOverloadTeardown: {}) {
            convertEntered.signal()
            _ = releaseConvert.wait(timeout: .now() + 2)
            convertFinishedBeforeStopAudio = !stopAudioCalled
            return .samples(speech(8000))
        }
        require(ok, "H: in-flight frame should be admitted")
        tapDone.signal()
    }
    require(convertEntered.wait(timeout: .now() + 2) == .success, "H: conversion never entered")

    DispatchQueue.global(qos: .userInitiated).async {
        coord.endCapture(stopCompletion: { e in stopErr = e; stopAck.signal() }, stopAudio: { stopAudioCalled = true })
    }
    let deadline = Date().addingTimeInterval(2)
    while coord.isCurrent(owner) && Date() < deadline { usleep(1000) }
    require(!coord.isCurrent(owner), "H: endCapture did not advance generation")

    var postStopProduced = false
    let postStopAdmitted = coord.admitAndOffer(owner: owner, now: 0.15, onOverloadTeardown: {}) {
        postStopProduced = true
        return .samples(speech(1600))
    }
    require(!postStopAdmitted && !postStopProduced, "H: post-Stop tap must be rejected before converting")
    require(!stopAudioCalled, "H: stopAudio ran before blocked conversion finished")

    releaseConvert.signal()
    require(tapDone.wait(timeout: .now() + 2) == .success, "H: in-flight tap did not finish")
    require(stopAck.wait(timeout: .now() + 2) == .success && stopErr == nil, "H: stop ACK failed: \\(String(describing: stopErr))")
    require(convertFinishedBeforeStopAudio && stopAudioCalled, "H: stopAudio barrier violated")

    let evs = events()
    let finals = evs.filter { if case .final = $0 { return true }; return false }
    let stops = evs.filter { $0 == .stopped }
    require(finals == [.final("tail:11200")] && stops.count == 1, "H: missing or duplicated blocked tail final/stopped: \\(evs)")
    require(evs.firstIndex(of: .final("tail:11200"))! < evs.firstIndex(of: .stopped)!, "H: final must precede stopped")
    print("IN_FLIGHT_CONVERSION_TAIL_BARRIER:PASS")
}

// 2I. R3-F2b: In-flight conversion failure during Stop emits error visibly instead of truncated final
do {
    let (coord, _, events) = makeHarness()
    let owner = coord.beginStart(makeDecode: { { s, cont in cont() ? "should_not_emit:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner, now: 0.01) {}
    coord.offerSamples(speech(3200), owner: owner, now: 0.05) {}

    let convertEntered = DispatchSemaphore(value: 0)
    let releaseConvert = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async {
        _ = coord.admitAndOffer(owner: owner, now: 0.10, onOverloadTeardown: {}) {
            convertEntered.signal()
            _ = releaseConvert.wait(timeout: .now() + 2)
            return .failure("Offline audio conversion failed: simulated")
        }
    }
    require(convertEntered.wait(timeout: .now() + 2) == .success, "I: fail conversion never entered")

    let stopAck = DispatchSemaphore(value: 0)
    var stopErr: String? = nil
    DispatchQueue.global(qos: .userInitiated).async {
        coord.endCapture(stopCompletion: { e in stopErr = e; stopAck.signal() }, stopAudio: {})
    }
    let deadline = Date().addingTimeInterval(2)
    while coord.isCurrent(owner) && Date() < deadline { usleep(1000) }
    releaseConvert.signal()

    require(stopAck.wait(timeout: .now() + 2) == .success && stopErr == "Offline audio conversion failed: simulated", "I: expected conversion failure ACK, got \\(String(describing: stopErr))")
    let evs = events()
    require(!evs.contains { if case .final = $0 { return true }; return false }, "I: failed tail must NOT emit truncated final: \\(evs)")
    let errIdx = evs.firstIndex { if case .error = $0 { return true }; return false }
    let stopIdx = evs.firstIndex(of: .stopped)
    require(errIdx != nil && stopIdx != nil && errIdx! < stopIdx!, "I: error must precede stopped: \\(evs)")
    print("IN_FLIGHT_CONVERSION_FAIL_AT_STOP:PASS")
}

// 2J. R3-F2b: Old owner's delayed in-flight conversion never leaks PCM into replacement owner
do {
    let (coord, _, events) = makeHarness()
    let owner1 = coord.beginStart(makeDecode: { { s, cont in cont() ? "out:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner1, now: 0.01) {}
    let convertEntered = DispatchSemaphore(value: 0)
    let releaseConvert = DispatchSemaphore(value: 0)
    let oldDone = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async {
        _ = coord.admitAndOffer(owner: owner1, now: 0.05, onOverloadTeardown: {}) {
            convertEntered.signal()
            _ = releaseConvert.wait(timeout: .now() + 2)
            return .samples(speech(8000))
        }
        oldDone.signal()
    }
    require(convertEntered.wait(timeout: .now() + 2) == .success, "J: old convert never entered")
    let owner2 = coord.beginStart(makeDecode: { { s, cont in cont() ? "owner2:\\(s.count)" : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    releaseConvert.signal()
    require(oldDone.wait(timeout: .now() + 2) == .success, "J: old convert did not exit")
    coord.offerSamples(speech(320), owner: owner2, now: 0.10) {}
    coord.offerSamples(speech(1600), owner: owner2, now: 0.20) {}
    let ack2 = DispatchSemaphore(value: 0)
    var err2: String? = "unset"
    coord.endCapture(stopCompletion: { e in err2 = e; ack2.signal() }, stopAudio: {})
    require(ack2.wait(timeout: .now() + 2) == .success && err2 == nil, "J: owner2 stop failed")
    let evs = events()
    let finals = evs.filter { if case .final = $0 { return true }; return false }
    require(finals == [.final("owner2:4800")], "J: old owner PCM leaked into owner2: \\(evs)")
    print("OLD_IN_FLIGHT_ISOLATED_FROM_NEW_OWNER:PASS")
}
`);
  execFileSync(swiftCompiler!, ['-swift-version', '5', file, '-o', executable], { encoding: 'utf8', timeout: 60000 });
  const result = execFileSync(executable, [emptyDir, biasedDir], { encoding: 'utf8', timeout: 20000 });
  for (const name of [
    'RECOGNIZER_DECODER',
    'BG_UNDECODED_SHORT',
    'BG_PARTIAL_PLUS_TAIL',
    'BG_MID_DECODE_CANCEL',
    'FG_CLEAN_AND_DUPLICATE_STOP',
    'OWNER_REPLACEMENT_RECOVERY',
    'SETUP_FAIL_WITH_STOP',
    'LATE_OWNER_STOP_GUARD',
    'IN_FLIGHT_CONVERSION_TAIL_BARRIER',
    'IN_FLIGHT_CONVERSION_FAIL_AT_STOP',
    'OLD_IN_FLIGHT_ISOLATED_FROM_NEW_OWNER',
  ]) {
    expect(result).toContain(name + ':PASS');
  }
}, 95000);

it.skipIf(!swiftCompiler)('executes the actual Swift bounded window through rollback, VAD, long speech and final short tails', async () => {
  await setup();
  const source = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', import.meta.url), 'utf8');
  const state = source.slice(source.indexOf('struct SpeechWindow {'));
  expect(state).toContain('mutating func finish(');
  const file = join(root, 'SpeechWindowTests.swift'), executable = join(root, 'speech-window-tests');
  await writeFile(file, 'import Foundation\n' + state + '\n' + swiftWindowCases);
  execFileSync(swiftCompiler!, ['-swift-version', '5', file, '-o', executable], { encoding: 'utf8', timeout: 60000 });
  const result = execFileSync(executable, [], { encoding: 'utf8', timeout: 30000 });
  for (const name of ['TAIL', 'ROLLBACK', 'VAD', 'PUNCTUATION', 'REPEATED_SENTENCE', 'LONG_CONTINUOUS', 'VARIABLE_TAP', 'BACKLOG_CHUNKING', 'FAILURE', 'UNICODE', 'EMPTY', 'IN_FLIGHT_STOP', 'LONG_TRANSCRIPT', 'SHORT_CJK', 'SHORT_ASCII', 'REPEATED_OVERLAP', 'STABLE_HYPOTHESIS', 'NO_PROGRESS_THEN_GROWTH', 'ZERO_LAG', 'WARMUP', 'AUDIO_LEVEL_THROTTLE', 'OVERLOAD', 'TAIL_BATCH', 'NORMALIZED_OVERLAP', 'MID_DECODE_CANCEL']) {
    expect(result).toContain(name + ':PASS');
  }
}, 95000);

it.skipIf(!swiftCompiler)('executes AppDelegate.reconcileCachedOtaBundles to purge stale OTA snapshots, poison rejected version, preserve user prefs, and retain newer valid OTA bundles', async () => {
  await setup();
  const appDelegateSource = await readFile(new URL('../../web/ios/App/App/AppDelegate.swift', import.meta.url), 'utf8');
  const startIdx = appDelegateSource.indexOf('private static let nativeBundledBuildIdKey');
  const endIdx = appDelegateSource.lastIndexOf('}');
  const extracted = appDelegateSource.slice(startIdx, endIdx);
  const harness = `
import Foundation
class AppDelegate {
${extracted}
}
func require(_ cond: Bool, _ msg: String) {
    if !cond { FileHandle.standardError.write(Data((msg + "\\n").utf8)); exit(1) }
}
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let fm = FileManager.default
let builtinPublic = root.appendingPathComponent("builtin/public", isDirectory: true)
let libraryDir = root.appendingPathComponent("Library", isDirectory: true)
let snapshotsDir = libraryDir.appendingPathComponent("NoCloud/ionic_built_snapshots", isDirectory: true)
try fm.createDirectory(at: builtinPublic, withIntermediateDirectories: true)
try fm.createDirectory(at: snapshotsDir, withIntermediateDirectories: true)
try Data(#"{"buildId":"10eb7c82","buildTime":"2026-04-19T06:22:02.634Z"}"#.utf8).write(to: builtinPublic.appendingPathComponent("app-build.json"))

let suiteName = "imcodes.ota.test." + UUID().uuidString
let defaults = UserDefaults(suiteName: suiteName)!
defer { defaults.removePersistentDomain(forName: suiteName) }

// 1. Stale legacy snapshot c84Qsje59L (v6175, missing app-build.json)
let staleDir = snapshotsDir.appendingPathComponent("c84Qsje59L", isDirectory: true)
try fm.createDirectory(at: staleDir, withIntermediateDirectories: true)
try Data("<html>stale</html>".utf8).write(to: staleDir.appendingPathComponent("index.html"))
defaults.set("/var/mobile/Containers/Data/Application/X/Library/NoCloud/ionic_built_snapshots/c84Qsje59L", forKey: "serverBasePath")
defaults.set("c84Qsje59L", forKey: "pastVersion")
defaults.set("c84Qsje59L", forKey: "nextVersion")
defaults.set(try JSONSerialization.data(withJSONObject: ["id": "c84Qsje59L", "version": "6175", "status": "success"]), forKey: "c84Qsje59L_info")
defaults.set("keep-user-pref", forKey: "CapacitorStorage.user_pref")

let didReset = AppDelegate.reconcileCachedOtaBundles(
    defaults: defaults,
    fileManager: fm,
    builtinPublicURL: builtinPublic,
    libraryURL: libraryDir,
    nativeBuildVersion: "1.2"
)
require(didReset, "expected stale OTA snapshot to trigger reset")
require((defaults.string(forKey: "serverBasePath") ?? "") == "", "serverBasePath not cleared")
require(defaults.string(forKey: "pastVersion") == "builtin", "pastVersion not reset to builtin")
require(defaults.string(forKey: "nextVersion") == nil, "nextVersion not removed")
require(defaults.data(forKey: "c84Qsje59L_info") == nil, "stale bundle info not removed")
require(!fm.fileExists(atPath: staleDir.path), "stale snapshot dir not deleted")
require(defaults.string(forKey: "CapacitorStorage.deck_ota_version") == "6175", "rejected version 6175 not recorded")
require(defaults.string(forKey: "CapacitorStorage.user_pref") == "keep-user-pref", "user preference wiped")

// 2. Newer compatible OTA snapshot (v6176, newer app-build.json)
let newerDir = snapshotsDir.appendingPathComponent("validNewer99", isDirectory: true)
try fm.createDirectory(at: newerDir, withIntermediateDirectories: true)
try Data("<html>newer</html>".utf8).write(to: newerDir.appendingPathComponent("index.html"))
try Data(#"{"buildId":"9999aaaa","buildTime":"2026-04-20T00:00:00.000Z"}"#.utf8).write(to: newerDir.appendingPathComponent("app-build.json"))
defaults.set(newerDir.path, forKey: "serverBasePath")
defaults.set("validNewer99", forKey: "pastVersion")
defaults.set(try JSONSerialization.data(withJSONObject: ["id": "validNewer99", "version": "6176", "status": "success"]), forKey: "validNewer99_info")

let didResetNewer = AppDelegate.reconcileCachedOtaBundles(
    defaults: defaults,
    fileManager: fm,
    builtinPublicURL: builtinPublic,
    libraryURL: libraryDir,
    nativeBuildVersion: "1.2"
)
require(!didResetNewer, "valid newer OTA snapshot should not be reset")
require(defaults.string(forKey: "serverBasePath") == newerDir.path, "valid newer serverBasePath altered")
require(fm.fileExists(atPath: newerDir.path), "valid newer snapshot deleted")
print("OTA_RECONCILE:PASS")
`;
  const swiftFile = join(root, 'OtaReconcileTest.swift');
  const binFile = join(root, 'ota-reconcile-test');
  await writeFile(swiftFile, harness);
  execFileSync(swiftCompiler!, ['-swift-version', '5', swiftFile, '-o', binFile], { encoding: 'utf8', timeout: 60000 });
  expect(execFileSync(binFile, [root], { encoding: 'utf8', timeout: 10000 }).trim()).toBe('OTA_RECONCILE:PASS');
}, 65000);

const swiftWindowCases = `
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) {
    if !(try! condition()) { fatalError(message) }
}
func pcm(_ count: Int) -> [Float] { Array(repeating: 0.1, count: count) }
// Exercise the actual production window on the same serial worker/barrier
// ordering as the plugin, with a deliberately blocked recognizer peer.
final class InFlightCapture {
    var window = SpeechWindow()
    var lengths: [Int] = []
    var events: [String] = []
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    func decode(_ samples: [Float]) -> String? {
        lengths.append(samples.count)
        if lengths.count == 1 { entered.signal(); release.wait() }
        return samples.count == 24000 ? "before tail" : "before tail last word"
    }
}
func labelledSeams(_ words: [String], separator: String, holds: [Int] = []) throws {
    var window = SpeechWindow()
    let decode: ([Float]) -> String? = { samples in
        var previous = -1, result: [String] = []
        for sample in samples {
            let id = Int(sample)
            if id != previous { result.append(words[id]); previous = id }
        }
        return result.joined(separator: separator)
    }
    for id in 0..<words.count {
        let expected = words.prefix(id + 1).joined(separator: separator)
        for _ in 0..<(holds.isEmpty ? 1 : holds[id]) {
            try window.append(Array(repeating: Float(id), count: 24000), speech: true, decode: decode) { snapshot in
                check(snapshot == expected, "seam corrupted an intermediate snapshot: " + snapshot + " != " + expected)
            }
            check(window.text == expected, "window lost previously recognised text")
            check(window.samples.count <= SpeechWindow.capacity, "labelled input grew the PCM window")
        }
    }
    let final = try window.finish(decode: decode)
    check(final == words.joined(separator: separator), "seam corrupted final text")
}
func run() throws {
    var window = SpeechWindow(), calls: [Int] = [], emitted: [String] = [], lastDecodedSamples: [Float] = []
    let decode: ([Float]) -> String? = { samples in
        calls.append(samples.count)
        lastDecodedSamples = samples
        return "最后的字"
    }
    try window.append(pcm(1599), speech: true, decode: decode) { emitted.append($0) }
    check(calls.isEmpty, "short tail decoded early")
    let tail = try window.finish(decode: decode)
    check(tail == "最后的字" && calls == [1599 + SpeechWindow.finalSilencePadding], "short tail lost or missing 200ms silence flush")
    check(lastDecodedSamples.prefix(1599).allSatisfy { $0 == 0.1 } && lastDecodedSamples.suffix(SpeechWindow.finalSilencePadding).allSatisfy { $0 == 0 }, "final decode did not append exact 3200 trailing zeros after real PCM")
    _ = try window.finish(decode: decode)
    check(calls == [1599 + SpeechWindow.finalSilencePadding] && window.samples.isEmpty, "final decoded twice")
    print("TAIL:PASS")

    window = SpeechWindow(); calls = []; emitted = []
    var hypotheses = ["alpha", "alpha hello", "alpha hello worlt", "alpha hello world", "hello world again"]
    let rollingDecode: ([Float]) -> String? = { samples in calls.append(samples.count); return hypotheses.removeFirst() }
    for _ in 0..<4 { try window.append(pcm(24000), speech: true, decode: rollingDecode) { emitted.append($0) } }
    check(window.committed == "alpha hello " && window.partial == "world", "five-character rollback")
    check(window.samples.count == 24000 && window.text == "alpha hello world", "roll did not retain exact seam")
    try window.append(pcm(24000), speech: true, decode: rollingDecode) { emitted.append($0) }
    check(window.text == "alpha hello world again", "overlap repeated or split word")
    check(calls == [24000, 48000, 72000, 96000, 48000], "decode input unbounded")
    _ = try window.finish(decode: rollingDecode)
    check(calls.count == 5, "overlap-only stop reran audio")
    print("ROLLBACK:PASS")

    // Full short tails (including <=5 Character windows) can outlive their PCM.
    // Check EVERY cumulative snapshot, not just a convenient long-word final.
    for count in [3, 5, 8] {
        try labelledSeams(Array(["你", "好", "吗", "我", "们", "来", "了", "啊"].prefix(count)), separator: "")
    }
    try labelledSeams((0..<120).map { String(UnicodeScalar(0x4e00 + $0)!) }, separator: "")
    print("SHORT_CJK:PASS")
    try labelledSeams(["a", "be", "see", "dog", "eel", "fox", "go", "hi"], separator: " ")
    try labelledSeams((0..<120).map { ["a", "be", "see", "dog", "eel", "fox", "go", "hi"][$0 % 8] }, separator: " ")
    print("SHORT_ASCII:PASS")
    // Longest text overlap alone over-matches legitimate consecutive repeats.
    try labelledSeams(Array(repeating: "a", count: 12), separator: " ")
    try labelledSeams(Array(repeating: "哈", count: 12), separator: "")
    try labelledSeams(["go", "go", "now", "go", "now", "go", "go", "now"], separator: " ")
    print("REPEATED_OVERLAP:PASS")
    // One acoustic word can span several stride ticks: unchanged text must not
    // manufacture an empty "known overlap" candidate and duplicate that word.
    try labelledSeams(["hello", "world", "again"], separator: " ", holds: [3, 3, 3])
    try labelledSeams(["你", "好", "吗"], separator: "", holds: [3, 3, 3])
    print("STABLE_HYPOTHESIS:PASS")
    try labelledSeams(["hello", "world", "again", "last", "word"], separator: " ", holds: [4, 1, 3, 2, 4])
    try labelledSeams(["你", "好", "吗", "我", "们"], separator: "", holds: [4, 1, 3, 2, 4])
    // Zero-progress intervals and genuinely distinct repeated words coexist.
    try labelledSeams(["a", "a", "a", "be", "be"], separator: " ", holds: [3, 1, 3, 1, 3])
    try labelledSeams(["哈", "哈", "哈", "好", "好"], separator: "", holds: [3, 1, 3, 1, 3])
    try labelledSeams(["a", "a", "a"], separator: " ", holds: [1, 2, 1])
    try labelledSeams(["哈", "哈", "哈"], separator: "", holds: [1, 2, 1])
    try labelledSeams(["aaaa", "bbbb", "aaaa"], separator: " ", holds: [3, 3, 3])
    try labelledSeams(["哈哈", "你好", "哈哈"], separator: "", holds: [3, 3, 3])
    print("NO_PROGRESS_THEN_GROWTH:PASS")

    window = SpeechWindow(); calls = []
    try window.append(pcm(8000), speech: true, decode: decode) { _ in }
    try window.append(pcm(11200), speech: false, decode: decode) { _ in }
    check(window.samples.isEmpty && window.committed == "最后的字", "VAD failed to unload PCM")
    print("VAD:PASS")

    window = SpeechWindow()
    let sentence: ([Float]) -> String? = { _ in "同一句。" }
    try window.append(pcm(24000), speech: true, decode: sentence) { _ in }
    try window.append(pcm(6400), speech: false, decode: sentence) { _ in }
    check(window.samples.isEmpty && window.committed == "同一句。", "punctuation pause did not commit")
    print("PUNCTUATION:PASS")
    try window.append(pcm(24000), speech: true, decode: sentence) { _ in }
    try window.append(pcm(6400), speech: false, decode: sentence) { _ in }
    check(window.committed == "同一句。同一句。", "valid repeated sentence deduplicated")
    print("REPEATED_SENTENCE:PASS")

    window = SpeechWindow(); calls = []
    let longDecode: ([Float]) -> String? = { samples in
        calls.append(samples.count)
        return "连续讲话没有标点也没有停顿可以一直继续"
    }
    for _ in 0..<1200 {
        try window.append(pcm(1600), speech: true, decode: longDecode) { _ in }
        check(window.samples.count <= SpeechWindow.capacity, "PCM grew with duration")
        check(window.partial.count <= 32, "mock hypothesis leaked historical partial")
    }
    _ = try window.finish(decode: longDecode)
    check(calls.count == 80 && calls.max() == SpeechWindow.capacity, "2 minute decode cadence/bound failed")
    check(window.samples.isEmpty, "final did not release PCM")
    print("LONG_CONTINUOUS:PASS")

    // An ideal deterministic acoustic peer labels one word per second. This
    // checks text seams too, not only the size of repeated constant hypotheses.
    window = SpeechWindow()
    func word(_ id: Int) -> String { "word" + String(format: "%03d", id) }
    let labelled: ([Float]) -> String? = { samples in
        var previous = -1, words: [String] = []
        for sample in samples {
            let id = Int(sample)
            if id != previous { words.append(word(id)); previous = id }
        }
        return words.joined(separator: " ")
    }
    for second in 0..<120 {
        try window.append(Array(repeating: Float(second), count: 24000), speech: true, decode: labelled) { _ in }
    }
    let transcript = try window.finish(decode: labelled)
    check(transcript == (0..<120).map(word).joined(separator: " "), "continuous overlapped words repeated or lost")
    print("LONG_TRANSCRIPT:PASS")

    window = SpeechWindow(); calls = []
    try window.append(pcm(64000 + 137), speech: true, decode: longDecode) { _ in }
    _ = try window.finish(decode: longDecode)
    check(calls == [64137], "large tap overshot boundary or lost tail")
    print("VARIABLE_TAP:PASS")

    window = SpeechWindow(); calls = []
    try window.append(pcm(168000), speech: true, decode: longDecode) { _ in }
    check(calls == [96000, 96000] && window.samples.count == 24000, "live backlog exceeded capacity without rolling")
    print("BACKLOG_CHUNKING:PASS")

    var inbox = SpeechInbox()
    check(!(try inbox.offer(pcm(160))), "warmup scheduled decode")
    check(!(try inbox.offer(pcm(160))), "warmup not exactly 20ms")
    check(try inbox.offer([1, 2, 3]), "first PCM did not schedule")
    check(!(try inbox.offer([4, 5])), "duplicate drain scheduled")
    check(inbox.take()?.samples == [1, 2, 3, 4, 5] && inbox.pending.isEmpty, "drain left backlog")
    check(!(try inbox.offer([6])), "in-flight drain scheduled a duplicate")
    check(inbox.take()?.samples == [6] && inbox.take() == nil, "in-flight PCM lost")
    check(try inbox.offer([7]), "empty drain did not rearm")
    print("ZERO_LAG:PASS")
    print("WARMUP:PASS")

    var levelInbox = SpeechInbox()
    // Warmup taps (first 320 samples = 20ms) must never emit audioLevel
    _ = try levelInbox.offer(pcm(160))
    check(levelInbox.pollAudioLevel(now: 0.0) == nil, "audioLevel emitted during first warmup half")
    _ = try levelInbox.offer(pcm(160))
    check(levelInbox.pollAudioLevel(now: 0.01) == nil, "audioLevel emitted on exact warmup completion without post-warmup samples")
    // First post-warmup tap at t=0.05 emits RMS * 3 (0.1 * 3 = 0.3), independent of inbox.take() / worker drain
    _ = try levelInbox.offer(pcm(320))
    let firstLevel = levelInbox.pollAudioLevel(now: 0.05)
    check(firstLevel != nil && abs(firstLevel! - 0.3) < 0.001, "first post-warmup audioLevel inaccurate: \\(String(describing: firstLevel))")
    // Subsequent taps within <50ms (t=0.07, t=0.099) are throttled even as new samples accumulate while drain is busy
    _ = try levelInbox.offer(Array(repeating: 0.2, count: 320))
    check(levelInbox.pollAudioLevel(now: 0.07) == nil, "audioLevel not throttled at +20ms")
    _ = try levelInbox.offer(Array(repeating: 0.2, count: 320))
    check(levelInbox.pollAudioLevel(now: 0.099) == nil, "audioLevel not throttled at +49ms")
    // At +50ms (t=0.10), throttled window opens and emits latest level (0.2 * 3 = 0.6) while inbox is still un-drained!
    let secondLevel = levelInbox.pollAudioLevel(now: 0.10)
    check(secondLevel != nil && abs(secondLevel! - 0.6) < 0.001, "throttled audioLevel did not emit at +50ms: \\(String(describing: secondLevel))")
    // Without new audio offered, polling again at t=0.20 returns nil
    check(levelInbox.pollAudioLevel(now: 0.20) == nil, "duplicate audioLevel emitted without new samples")
    // Loud audio clamps to 1.0
    _ = try levelInbox.offer(Array(repeating: 0.8, count: 320))
    let clampedLevel = levelInbox.pollAudioLevel(now: 0.20)
    check(clampedLevel == 1.0, "loud audioLevel did not clamp to 1.0: \\(String(describing: clampedLevel))")
    print("AUDIO_LEVEL_THROTTLE:PASS")

    inbox = SpeechInbox()
    _ = try inbox.offer(pcm(SpeechInbox.warmupSamples))
    _ = try inbox.offer(pcm(SpeechInbox.limit))
    do { _ = try inbox.offer([1]); fatalError("overflow unbounded") }
    catch SpeechInbox.Failure.overload { check(inbox.pending.count == SpeechInbox.limit, "overflow lost admitted PCM") }
    print("OVERLOAD:PASS")

    window = SpeechWindow(); calls = []
    try window.append(pcm(24000), speech: true, decode: longDecode) { _ in }
    let beforeStop = calls.count
    // Remaining 32s accepted backlog on stop: chunked into bounded 96,000-sample
    // windows without emitting intermediate partials, then flushed once in finish()
    // with 3,200 trailing zero samples.
    try window.append(pcm(SpeechInbox.limit), speech: true, final: true, decode: longDecode) { _ in fatalError("stop emitted partial") }
    _ = try window.finish(decode: longDecode)
    let stopCalls = Array(calls.dropFirst(beforeStop))
    check(stopCalls.count == 8, "expected 7 full 96k windows + 1 final tail window, got \\(stopCalls)")
    check(stopCalls.dropLast().allSatisfy { $0 == SpeechWindow.capacity }, "intermediate stop window exceeded or missed 96k capacity: \\(stopCalls)")
    check(stopCalls.last! == 32000 + SpeechWindow.finalSilencePadding, "final stop window missing bounded tail + 3200 silence flush: \\(stopCalls)")
    let afterFirstFinish = calls.count
    _ = try window.finish(decode: longDecode)
    check(calls.count == afterFirstFinish, "stop decoded twice")

    // Verify 19.75s (13 strides + 4000 tail = 316,000 samples) labelled backlog across both live and final stop paths:
    // every decode stays <= capacity (+ final padding on finish), all words stitch without seam duplication or tail loss.
    for isFinalPath in [false, true] {
        var backlogWindow = SpeechWindow()
        var backlogLengths: [Int] = []
        var backlogLastSamples: [Float] = []
        let labelledBacklogDecode: ([Float]) -> String? = { samples in
            backlogLengths.append(samples.count)
            backlogLastSamples = samples
            var previous = -1, words: [String] = []
            for sample in samples {
                let raw = Int(sample.rounded())
                if raw <= 0 { continue } // ignore 0.0 final silence padding
                if raw != previous { words.append(word(raw)); previous = raw }
            }
            return words.joined(separator: " ")
        }
        var fullBacklog: [Float] = []
        for id in 1...13 {
            fullBacklog.append(contentsOf: Array(repeating: Float(id), count: 24000))
        }
        // Append 4000 extra samples (< 24000 stride) on word 14 so finish() flushes the sub-stride tail on both live and final paths
        fullBacklog.append(contentsOf: Array(repeating: Float(14), count: 4000))
        try backlogWindow.append(fullBacklog, speech: true, final: isFinalPath, decode: labelledBacklogDecode) { _ in
            if isFinalPath { fatalError("final backlog emitted partial") }
        }
        let stitched = try backlogWindow.finish(decode: labelledBacklogDecode)
        let expectedStitched = (1...14).map(word).joined(separator: " ")
        check(stitched == expectedStitched, "backlog stitched transcript mismatch (final=\\(isFinalPath)): " + stitched + " != " + expectedStitched)
        check(backlogLengths.dropLast().allSatisfy { $0 <= SpeechWindow.capacity }, "live/intermediate backlog decode exceeded 96k: \\(backlogLengths)")
        check(backlogLengths.last! == 28000 + SpeechWindow.finalSilencePadding, "final backlog window did not flush exact tail + 3200 zeros: \\(backlogLengths)")
        check(backlogLastSamples.prefix(28000).allSatisfy { $0 > 0 } && backlogLastSamples.suffix(SpeechWindow.finalSilencePadding).allSatisfy { $0 == 0 }, "final backlog window zero padding corrupted")
    }
    print("TAIL_BATCH:PASS")

    window = SpeechWindow()
    try window.append(pcm(24000), speech: true, decode: sentence) { _ in }
    try window.append(pcm(100), speech: true, decode: sentence) { _ in }
    do { _ = try window.finish(decode: { _ in nil }); fatalError("decode failure swallowed") }
    catch SpeechWindow.Failure.decode { check(window.text == "同一句。" && window.samples.count == 24100, "failed flush discarded previous text/PCM") }
    print("FAILURE:PASS")

    window = SpeechWindow()
    let unicode: ([Float]) -> String? = { _ in "你好👨‍👩‍👧‍👦e\\u{301}世界朋友再见" }
    try window.append(pcm(96000), speech: true, decode: unicode) { _ in }
    check(window.partial.count == 5 && !window.text.contains("�"), "split grapheme cluster")
    print("UNICODE:PASS")

    window = SpeechWindow(); calls = []
    try window.append(pcm(240000), speech: false, decode: decode) { _ in }
    let empty = try window.finish(decode: decode)
    check(empty.isEmpty && calls.isEmpty, "silence hallucinated an empty session")
    print("EMPTY:PASS")

    let capture = InFlightCapture(), worker = DispatchQueue(label: "speech-window-test")
    let done = DispatchSemaphore(value: 0)
    worker.async {
        try! capture.window.append(pcm(24000), speech: true, decode: capture.decode) { _ in capture.events.append("partial") }
    }
    check(capture.entered.wait(timeout: .now() + 2) == .success, "decode did not start")
    worker.async {
        try! capture.window.append(pcm(137), speech: true, decode: capture.decode) { _ in capture.events.append("partial") }
    }
    worker.async {
        let final = try! capture.window.finish(decode: capture.decode)
        capture.events.append(final)
        capture.events.append("stopped/ACK")
        done.signal()
    }
    check(done.wait(timeout: .now() + 0.02) == .timedOut, "stop overtook in-flight decode")
    capture.release.signal()
    check(done.wait(timeout: .now() + 2) == .success, "stop barrier hung")
    check(capture.lengths == [24000, 24137 + SpeechWindow.finalSilencePadding], "accepted tail lost or decoded twice")
    check(capture.events == ["partial", "before tail last word", "stopped/ACK"], "final did not precede stopped/ACK")
    print("IN_FLIGHT_STOP:PASS")

    // Normalized overlap reconciles punctuation/casing drift across rolling seams without duplication
    window = SpeechWindow()
    var normHypotheses = ["Hello", "Hello, world", "Hello, world", "Hello, world", "WORLD! Again"]
    for _ in 0..<4 {
        try window.append(pcm(24000), speech: true, decode: { _ in normHypotheses.removeFirst() }) { _ in }
    }
    try window.append(pcm(24000), speech: true, decode: { _ in normHypotheses.removeFirst() }) { _ in }
    let normFinal = try window.finish(decode: { _ in nil })
    check(normFinal == "Hello, WORLD! Again", "normalized overlap failed: \\(normFinal)")
    print("NORMALIZED_OVERLAP:PASS")

    // Mid-decode & pre-append cancellation throws Failure.cancelled instead of Failure.decode or silent return
    window = SpeechWindow()
    do {
        try window.append(pcm(24000), speech: true, shouldContinue: { false }, decode: { _ in fatalError("should not decode after shouldContinue=false") }) { _ in }
        fatalError("pre-append cancellation returned silently")
    } catch SpeechWindow.Failure.cancelled { }
    var keepGoing = true
    do {
        try window.append(pcm(24000), speech: true, shouldContinue: { keepGoing }, decode: { _ in
            keepGoing = false
            return nil
        }) { _ in }
        fatalError("mid-decode cancellation did not throw Failure.cancelled")
    } catch SpeechWindow.Failure.cancelled {
        check(window.newSamples == 24000, "cancelled decode lost un-flushed sample count")
    }
    print("MID_DECODE_CANCEL:PASS")
}
try run()
`;
