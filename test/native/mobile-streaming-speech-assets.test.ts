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
    expect(ios).toContain('Qwen3DecodingOptions(maxTokens: 192');
    expect(ios).toContain('transcribeSegmentWithCancellation(');
    expect(ios).toContain('prefixTokens: prefixTokens');
    expect(ios).toContain('safePrefixTokensForRollback(');
    expect(ios).toContain('qos: .userInteractive');
    expect(ios).toContain('didReceiveMemoryWarningNotification');
    expect(ios).toContain('Qwen3ASRModel.clearMetalCache()');
    expect(ios).toContain('appendingPathComponent("ios-models", isDirectory: true)');
    expect(ios).toContain('static let segmentCapacity = sampleRate * 27 / 2');
    expect(ios).toContain('static let splitSearchWindow = sampleRate * 5 / 2');
    expect(ios).toContain('static let unfixedChunkNum = 2');
    expect(ios).toContain('static let unfixedTokenNum = 5');
    for (const obsoleteSymbol of [
      'overlapText',
      'overlapHint',
      'lastGrowth',
      'normalizedOverlap',
      'overlapCount',
      'rollbackCharacters',
      'seamTail',
      'edgeTrimmedOverlap',
    ]) {
      expect(ios).not.toContain(obsoleteSymbol);
    }
    expect(ios).toContain('static let limit = 16000 * 320 / 10');
    expect(ios).toContain('static let warmupSamples = 320');
    expect(ios).toContain('mode: .spokenAudio, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth]');
    expect(ios).not.toContain('mode: .measurement');
    expect(ios).toContain('session.isInputGainSettable');
    expect(ios).toContain('try? session.setInputGain(1.0)');
    expect(ios).toContain('struct SpeechGain');
    expect(ios).toContain('options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth]');
    expect(ios).not.toContain('.duckOthers');
    expect(ios).toContain('if warming && inbox.warmupRemaining == 0');
    expect(ios).toContain('self.settleStartingCall()');
    expect(ios).toContain('startingCall = nil');
    expect(ios).not.toContain('if self.engine?.isRunning == true { call.resolve(); return }');
    expect(ios).toContain('self.endCapture(nil, deactivateSession: false)');
    expect(ios).toContain('.AVAudioEngineConfigurationChange');
    expect(ios).toContain('AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity)');
    expect(ios).not.toContain('AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)');
    expect(ios).toContain('AVAudioFrameCount(max(512, Int(format.sampleRate / 40)))');
    expect(ios).toContain('input.installTap(onBus: 0, bufferSize: tapFrames, format: format)');
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
    expect(qwenAsr).toContain('prefixTokens: [Int32] = []');
    expect(qwenAsr).toContain('suffix.append(contentsOf: prefixTokens)');
  });
  it('compiles and executes the production Android plugin through cold/warm/stop/segmentation/overflow/destroy', async () => {
    await setup(); const srcDir = join(root, 'src'), classesDir = join(root, 'classes'); await mkdir(classesDir, { recursive: true });
    const files: Record<string, string> = {
      'android/Manifest.java': `package android; public class Manifest { public static class permission { public static final String RECORD_AUDIO="mic"; } }`,
      'android/media/AudioFormat.java': `package android.media; public class AudioFormat { public static final int CHANNEL_IN_MONO=1, ENCODING_PCM_16BIT=2; }`,
      'android/media/MediaRecorder.java': `package android.media; public class MediaRecorder { public static class AudioSource { public static final int MIC=1, VOICE_RECOGNITION=6; } }`,
      'android/media/audiofx/AudioEffect.java': `package android.media.audiofx; public class AudioEffect { public static final int SUCCESS=0, ERROR=-1; }`,
      'android/media/audiofx/AutomaticGainControl.java': `package android.media.audiofx;
public class AutomaticGainControl extends AudioEffect {
  public static volatile boolean available=true;
  public static volatile boolean returnNullOnCreate=false;
  public static volatile boolean throwOnCreate=false;
  public static volatile boolean failEnable=false;
  public static volatile boolean throwOnEnable=false;
  public static volatile boolean throwOnRelease=false;
  public static volatile int created=0, enabled=0, disabled=0, released=0, lastSessionId=-1;
  public static void reset(){
    available=true; returnNullOnCreate=false; throwOnCreate=false;
    failEnable=false; throwOnEnable=false; throwOnRelease=false;
    created=0; enabled=0; disabled=0; released=0; lastSessionId=-1;
  }
  public static boolean isAvailable(){ return available; }
  public static AutomaticGainControl create(int sessionId){
    lastSessionId=sessionId;
    if(throwOnCreate) throw new RuntimeException("agc create failed");
    if(returnNullOnCreate) return null;
    created++;
    return new AutomaticGainControl();
  }
  public int setEnabled(boolean enable){
    if(enable){
      if(throwOnEnable) throw new IllegalStateException("agc enable failed");
      if(failEnable) return ERROR;
      enabled++;
      return SUCCESS;
    }
    disabled++;
    return SUCCESS;
  }
  public void release(){
    released++;
    if(throwOnRelease) throw new RuntimeException("agc release failed");
  }
}`,
      'android/media/AudioRecord.java': `package android.media;
public class AudioRecord {
  public static final int STATE_INITIALIZED=1, STATE_UNINITIALIZED=0, RECORDSTATE_RECORDING=3, READ_BLOCKING=0;
  public static volatile AudioRecord latest;
  public static volatile int chunksPerStart=1;
  public static volatile int silentChunksPerStart=0;
  public static volatile boolean labelledWords=false;
  public static volatile boolean failMicSource=false;
  public static volatile int lastSource=-1;
  private static int nextSessionId=42;
  public static int reads=0;
  public static volatile java.util.concurrent.CountDownLatch delivered;
  private final int audioSessionId=nextSessionId++;
  private final int state;
  private boolean recording;
  private int remaining;
  private int silentRemaining;
  private int deliveredVoiced=0;
  public AudioRecord(int source,int b,int c,int d,int e){
    lastSource=source;
    state=(failMicSource && source==MediaRecorder.AudioSource.MIC) ? STATE_UNINITIALIZED : STATE_INITIALIZED;
    if(state==STATE_INITIALIZED){
      latest=this;
      remaining=chunksPerStart;
      silentRemaining=silentChunksPerStart;
      delivered=new java.util.concurrent.CountDownLatch(remaining+silentRemaining);
    }
  }
  public static int getMinBufferSize(int a,int b,int c){ return 3200; }
  public int getState(){ return state; }
  public int getAudioSessionId(){ return audioSessionId; }
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
      if (labelledWords) {
        int halfPeriod = 4 + (deliveredVoiced / 15);
        for (int i = 0; i < out.length; i++) {
          out[i] = ((i / halfPeriod) % 2 == 0) ? (short) 1000 : (short) -1000;
        }
      } else {
        java.util.Arrays.fill(out, (short) 1000);
      }
      deliveredVoiced++;
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
   for (int base = 0; base + 1600 <= stream.samples.length; base += 1600) {
    int limit = base + 1580;
    int i = base + 20;
    while (i < limit && stream.samples[i] >= -1e-4f) i++;
    while (i < limit && stream.samples[i] <= 1e-4f) i++;
    int run = 0;
    while (i < limit && stream.samples[i] > 1e-4f) { run++; i++; }
    if (i >= limit || stream.samples[i] >= -1e-4f || run < 4) continue;
    int id = run - 4;
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
      'Harness.java': `import com.imcodes.speech.StreamingSpeechPlugin; import com.imcodes.speech.SpeechGainTest; import com.getcapacitor.PluginCall; import com.k2fsa.sherpa.onnx.*; import android.media.AudioRecord; import android.media.MediaRecorder; import android.media.audiofx.AutomaticGainControl; import java.util.concurrent.*;
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
   check(AutomaticGainControl.created>=1 && AutomaticGainControl.enabled==AutomaticGainControl.created, "AGC should attach and enable");
   check(AutomaticGainControl.disabled==AutomaticGainControl.created && AutomaticGainControl.released==AutomaticGainControl.created,
    "AGC must disable and release once per session: disabled="+AutomaticGainControl.disabled+" released="+AutomaticGainControl.released+" created="+AutomaticGainControl.created);
   System.out.println("AGC_LIFECYCLE_OK");
   String[] agcModes = {"unavailable", "null", "throwCreate", "failEnable", "throwEnable", "throwRelease"};
   for (String mode : agcModes) {
    AutomaticGainControl.reset();
    if (mode.equals("unavailable")) AutomaticGainControl.available = false;
    if (mode.equals("null")) AutomaticGainControl.returnNullOnCreate = true;
    if (mode.equals("throwCreate")) AutomaticGainControl.throwOnCreate = true;
    if (mode.equals("failEnable")) AutomaticGainControl.failEnable = true;
    if (mode.equals("throwEnable")) AutomaticGainControl.throwOnEnable = true;
    if (mode.equals("throwRelease")) AutomaticGainControl.throwOnRelease = true;
    p.events.clear();AudioRecord.chunksPerStart=1;AudioRecord.silentChunksPerStart=0;OfflineRecognizer.decoded=new CountDownLatch(1);
    PluginCall modeStart=new PluginCall();p.start(modeStart);await(modeStart.done);await(AudioRecord.delivered);
    check(modeStart.error==null, "AGC mode "+mode+" must be non-fatal: "+modeStart.error);
    PluginCall modeStop=new PluginCall();p.stop(modeStop);await(modeStop.done);
    check(finals(p)==1, "AGC mode "+mode+" failed to deliver final result");
    check(AutomaticGainControl.released==AutomaticGainControl.created, "AGC mode "+mode+" leaked AutomaticGainControl");
   }
   AutomaticGainControl.reset();
   AudioRecord.failMicSource = true;
   p.events.clear();AudioRecord.chunksPerStart=1;AudioRecord.silentChunksPerStart=0;OfflineRecognizer.decoded=new CountDownLatch(1);
   PluginCall fbStart=new PluginCall();p.start(fbStart);await(fbStart.done);await(AudioRecord.delivered);
   check(AudioRecord.lastSource==MediaRecorder.AudioSource.VOICE_RECOGNITION, "MIC init failure must fall back to VOICE_RECOGNITION");
   PluginCall fbStop=new PluginCall();p.stop(fbStop);await(fbStop.done);
   check(finals(p)==1, "fallback source failed to deliver final result");
   AudioRecord.failMicSource = false;
   System.out.println("AGC_FALLBACK_OK");
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
  SpeechGainTest.main(new String[0]);
 }
}
`,
    };
    const sources: string[] = [];
    for (const [relative, content] of Object.entries(files)) { const full=join(srcDir, relative); await mkdir(dirname(full),{recursive:true});await writeFile(full,content);sources.push(full); }
    sources.push(fileURLToPath(new URL('../../web/plugins/streaming-speech/android/src/main/java/com/imcodes/speech/SpeechGain.java',import.meta.url)));
    sources.push(fileURLToPath(new URL('../../web/plugins/streaming-speech/android/src/main/java/com/imcodes/speech/StreamingSpeechPlugin.java',import.meta.url)));
    sources.push(fileURLToPath(new URL('../../web/plugins/streaming-speech/android/src/test/java/com/imcodes/speech/SpeechGainTest.java',import.meta.url)));
    execFileSync('javac',['-d',classesDir,...sources],{stdio:'pipe',timeout:30000});
    for (const failure of ['none', 'runtime', 'linkage']) {
      const output=execFileSync('java',['-Djava.io.tmpdir='+root, '-DnnapiFailure='+failure, '-cp',classesDir,'Harness'],{encoding:'utf8',timeout:15000}).trim().split('\n');
      expect(output, `NNAPI ${failure}`).toEqual(['COLD_STOP_OK','WARM_REUSE_OK','SINGLE_TAIL_DRAIN_OK','SILENCE_SEGMENT_OK','WINDOW_AND_RELEASE_OK','AGC_LIFECYCLE_OK','AGC_FALLBACK_OK','OVERFLOW_OK','OWNER_RETIRE_OK','SpeechGainTest: ALL 6 TESTS PASSED']);
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
  const recognizerSlice = plugin.slice(plugin.indexOf('final class SpeechRecognizer {'), plugin.indexOf('// MARK: - Token Prefix Rollback'));
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
var seenPrefixTokens: [[Int32]] = []
var cancelAfterCheck = false
final class Qwen3ASRModel {
    let root: URL
    init(root: URL) { self.root = root }
    static func loadLocal(from root: URL) throws -> Qwen3ASRModel {
        loadedRoots.append(root)
        return Qwen3ASRModel(root: root)
    }
    func transcribeSegmentWithCancellation(
        audio: [Float],
        sampleRate: Int,
        options: Qwen3DecodingOptions,
        prefixTokens: [Int32] = [],
        checkCancellation: () throws -> Void
    ) throws -> (text: String, tokens: [Int32]) {
        seenOptions.append(options)
        seenPrefixTokens.append(prefixTokens)
        precondition(sampleRate == 16000)
        try checkCancellation()
        if cancelAfterCheck { throw CancellationError() }
        return ("  ok:\\(audio.count)  ", prefixTokens + [10, 11])
    }
    func safePrefixTokensForRollback(_ tokens: [Int32], rollbackCount: Int = 5) -> [Int32] {
        guard tokens.count > rollbackCount else { return [] }
        return Array(tokens.dropLast(rollbackCount))
    }
}
${recognizerSlice}
${windowAndInboxSlice}
${coordinatorSlice}

let emptyRoot = URL(fileURLWithPath: CommandLine.arguments[1])
let biasedRoot = URL(fileURLWithPath: CommandLine.arguments[2])

// 1. SpeechRecognizer + SpeechDecoder Metal guard, hotwords bias, prefixTokens & cancellation
stubMetalAvailable = false
require(SpeechRecognizer(root: emptyRoot) == nil, "expected nil SpeechRecognizer when Metal unavailable")
stubMetalAvailable = true
let rEmpty = SpeechRecognizer(root: emptyRoot)
require(rEmpty != nil && rEmpty?.hotwords == nil, "empty hotwords must yield nil bias")
let rBias = SpeechRecognizer(root: biasedRoot)
require(rBias?.hotwords == "Qwen3, IMCodes", "hotwords trimming/joining mismatch: \\(String(describing: rBias?.hotwords))")
let dec = SpeechDecoder(recognizer: rBias!)!
let decOut = dec.decode(samples: [0.1, 0.2], prefixTokens: [1, 2])
require(decOut?.text == "ok:2" && decOut?.tokens == [1, 2, 10, 11], "expected trimmed decoded text + prefix continuation")
require(seenOptions.last?.maxTokens == 192 && seenOptions.last?.context == "Qwen3, IMCodes", "unexpected Qwen3DecodingOptions")
require(seenPrefixTokens.last == [1, 2], "prefixTokens not forwarded to model")
require(dec.rollbackPrefix([1, 2, 3, 4, 5, 6], rollbackCount: 5) == [1], "rollbackPrefix mismatch")
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
    let owner = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("w:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
    let owner = coordB.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("partial_ok:\\(s.count)", [1, 2]) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
        SpeechCoordinator.Decoder { _, _, cont in
            decodeEntered.signal()
            _ = releaseDecode.wait(timeout: .now() + 2)
            return cont() ? ("never", []) : nil
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
    let owner = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("fg:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
        SpeechCoordinator.Decoder { _, _, cont in
            decodeEntered.signal()
            _ = releaseOld.wait(timeout: .now() + 2)
            return cont() ? ("old", []) : nil
        }
    }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner1, now: 0.01) {}
    coord.offerSamples(speech(24000), owner: owner1, now: 0.20) {}
    require(decodeEntered.wait(timeout: .now() + 2) == .success, "E: owner1 decode did not enter")
    coord.setBackgrounded(true)
    coord.endCapture(stopAudio: {})
    coord.setBackgrounded(false)
    let owner2 = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("recovered:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
        let old = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("old:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
            freshOwner = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("fresh:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
    let owner = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("tail:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
    let owner = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("should_not_emit:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
    let owner1 = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("out:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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
    let owner2 = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("owner2:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
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

// 2K. Coordinator forwards prefixTokens and custom rollbackPrefix across chunks 1..4 & finish
do {
    let (coord, _, events) = makeHarness()
    var seenPrefixes: [[Int32]] = []
    let owner = coord.beginStart(makeDecode: {
        SpeechCoordinator.Decoder(
            decode: { s, prefix, cont in
                guard cont() else { return nil }
                seenPrefixes.append(prefix)
                let stepTokens: [Int32] = Array(100..<(100 + Int32(s.count / 8000)))
                let tokens = prefix.isEmpty ? stepTokens : prefix + stepTokens.suffix(3)
                return ("t:\\(tokens.count)", tokens)
            },
            rollbackPrefix: { tokens, n in
                tokens.count > n ? Array(tokens.dropLast(n)) : []
            }
        )
    }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner, now: 0.01) {}
    coord.worker.sync {}
    for step in 1...4 {
        coord.offerSamples(speech(24000), owner: owner, now: TimeInterval(step)) {}
        coord.worker.sync {}
    }
    coord.offerSamples(speech(1600), owner: owner, now: 5.0) {}
    coord.worker.sync {}
    let ack = DispatchSemaphore(value: 0)
    var err: String? = "unset"
    coord.endCapture(stopCompletion: { e in err = e; ack.signal() }, stopAudio: {})
    require(ack.wait(timeout: .now() + 2) == .success && err == nil, "K: coordinator prefix rollback failed")
    require(seenPrefixes.count == 5, "K: expected 4 partials + 1 final decode, got \\(seenPrefixes)")
    require(seenPrefixes[0].isEmpty && seenPrefixes[1].isEmpty, "K: first 2 chunks must not lock prefix: \\(seenPrefixes)")
    require(!seenPrefixes[2].isEmpty && !seenPrefixes[4].isEmpty, "K: chunks >=3 and finish must receive rolled-back prefix: \\(seenPrefixes)")
    let evs = events()
    require(evs.contains(.final("t:\\(seenPrefixes[4].count + 3)")), "K: missing expected final: \\(evs)")
    print("COORDINATOR_PREFIX_ROLLBACK:PASS")
}

// 2L. SpeechGain + SpeechInbox adaptive quiet-speech gain, soft-knee limiting & noise-floor VAD
do {
    func sinePCM(_ count: Int, rms: Float) -> [Float] {
        let peak = rms * sqrt(2.0)
        return (0..<count).map { i in peak * sin(2.0 * .pi * 220.0 * Float(i) / 16000.0) }
    }

    // Quiet speech (RMS 0.0025 < old 0.00333 floor) amplifies without clipping and opens VAD.
    var gain = SpeechGain()
    let quiet = sinePCM(1600, rms: 0.0025)
    let g1 = gain.process(quiet)
    require(g1.boostedRMS >= g1.rawRMS * 4.0, "L: quiet speech chunk1 not boosted: \\(g1.boostedRMS) vs \\(g1.rawRMS)")
    require(g1.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 }, "L: quiet speech chunk1 clipped")
    let g2 = gain.process(quiet)
    require(g2.boostedRMS >= 0.015 && gain.currentGain <= SpeechGain.maxGain, "L: quiet speech chunk2 gain unexpected: rms=\\(g2.boostedRMS) gain=\\(gain.currentGain)")

    // Loud burst immediately after high gain stays strictly inside (-1.0, 1.0) without hard clipping.
    let loud = sinePCM(1600, rms: 0.85)
    let gLoud = gain.process(loud)
    require(gLoud.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 }, "L: loud burst hard clipped")
    require(gain.currentGain <= 1.5, "L: gain failed fast downward attack: \\(gain.currentGain)")

    // Cold-start pure silence and ultra-low noise floor stay unboosted and unvoiced.
    var inbox = SpeechInbox()
    _ = try! inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
    let noise = sinePCM(1600, rms: 0.0003)
    _ = try! inbox.offer(noise)
    require(!inbox.lastVoiced, "L: ultra-low noise triggered voiced")
    let noiseBatch = inbox.take()!
    require(!noiseBatch.speech && noiseBatch.trailingSilence == noise.count, "L: noise marked as speech")
    require(SpeechGain.rms(noiseBatch.samples) <= 0.0004, "L: noise floor was wildly amplified")

    // Quiet speech in inbox opens VAD, emits visible audioLevel, and trailing ambient floor releases VAD.
    _ = try! inbox.offer(quiet)
    require(inbox.lastVoiced, "L: quiet speech failed VAD onset")
    let quietLevel = inbox.pollAudioLevel(now: 0.1)
    require((quietLevel ?? 0) > 0.015, "L: quiet audioLevel too weak for equalizer: \\(String(describing: quietLevel))")
    let quietBatch = inbox.take()!
    require(quietBatch.speech && quietBatch.trailingSilence == 0, "L: quiet speech batch not marked voiced")

    _ = try! inbox.offer(sinePCM(1600, rms: 0.0004))
    require(!inbox.lastVoiced, "L: ambient hum stayed voiced after speech")

    // Coordinator captures quiet speech (RMS 0.0025) cleanly without dropping initial audio.
    let (coord, q, events) = makeHarness()
    let owner = coord.beginStart(makeDecode: { SpeechCoordinator.Decoder { s, _, cont in cont() ? ("q:\\(s.count)", []) : nil } }, onStartReady: {}, onSetupFailureTeardown: {})
    coord.offerSamples(speech(320), owner: owner, now: 0.01) {}
    coord.offerSamples(sinePCM(3200, rms: 0.0025), owner: owner, now: 0.10) {}
    q.sync {}
    let ack = DispatchSemaphore(value: 0)
    var err: String? = "unset"
    coord.endCapture(stopCompletion: { e in err = e; ack.signal() }, stopAudio: {})
    require(ack.wait(timeout: .now() + 2) == .success && err == nil, "L: coordinator quiet capture failed")
    let evs = events()
    require(evs.contains(.final("q:6400")), "L: quiet speech dropped before final: \\(evs)")
    require(evs.contains { if case .audioLevel(let lvl) = $0 { return lvl > 0.015 }; return false }, "L: missing responsive audioLevel event: \\(evs)")
    print("SPEECH_GAIN_AND_INBOX_VAD:PASS")
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
    'COORDINATOR_PREFIX_ROLLBACK',
    'SPEECH_GAIN_AND_INBOX_VAD',
  ]) {
    expect(result).toContain(name + ':PASS');
  }
}, 95000);

it.skipIf(!swiftCompiler)('executes Qwen3Tokenizer U+FFFD rollback boundary guard and buildPromptTokenIds prefix insertion', async () => {
  await setup();
  const tokenizerSrc = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/AudioCommon/Tokenizer.swift', import.meta.url), 'utf8');
  const qwenSrc = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/Qwen3ASR/Qwen3ASR.swift', import.meta.url), 'utf8');
  const tokensSlice = qwenSrc.slice(qwenSrc.indexOf('public struct Qwen3ASRTokens'), qwenSrc.indexOf('/// Main Qwen3-ASR model'));
  const rollbackSlice = qwenSrc.slice(
    qwenSrc.indexOf('    public static func safePrefixTokensForRollback('),
    qwenSrc.indexOf('    /// Shared implementation behind')
  );
  const promptSlice = qwenSrc.slice(
    qwenSrc.indexOf('    static func buildPromptTokenIds('),
    qwenSrc.indexOf('    static func buildInputEmbeds(')
  );
  expect(rollbackSlice).toContain('hasSuffix("\\u{FFFD}")');
  expect(promptSlice).toContain('suffix.append(contentsOf: prefixTokens)');

  const file = join(root, 'TokenizerRollbackTests.swift'), executable = join(root, 'tokenizer-rollback-tests');
  await writeFile(file, `${tokenizerSrc}
${tokensSlice}
struct PrefixRollbackBridge {
${rollbackSlice}
${promptSlice}
}
func assert(_ cond: @autoclosure () -> Bool, _ msg: String) {
    if !cond() { FileHandle.standardError.write(Data(("FAIL: " + msg + "\\n").utf8)); exit(1) }
}
// Construct BPE idToToken where token 202 + 203 form 3-byte UTF-8 "中" ([0xE4, 0xB8, 0xAD])
// so dropping trailing 5 tokens lands between 202 (incomplete [0xE4, 0xB8]) and 203 ([0xAD]).
let testByteToUnicode: [UInt8: Character] = {
    var m: [UInt8: Character] = [:], n = 0
    for r: ClosedRange<UInt8> in [UInt8(ascii: "!")...UInt8(ascii: "~"), 0xA1...0xAC, 0xAE...0xFF] {
        for b in r { m[b] = Character(UnicodeScalar(b)) }
    }
    for b: UInt8 in 0...255 where m[b] == nil {
        m[b] = Character(UnicodeScalar(0x100 + n)!); n += 1
    }
    return m
}()
func bpeStr(_ bytes: [UInt8]) -> String {
    String(bytes.compactMap { testByteToUnicode[$0] })
}
let idToToken: [Int: String] = [
    151704: "<asr_text>",
    151644: "<|im_start|>",
    151645: "<|im_end|>",
    151643: "<|endoftext|>",
    151669: "<|audio_start|>",
    151670: "<|audio_end|>",
    198: "\\n",
    8948: "system",
    872: "user",
    77091: "assistant",
    200: "language",
    201: bpeStr(Array("我".utf8)),
    202: bpeStr([0xE4, 0xB8]),
    203: bpeStr([0xAD]),
    204: bpeStr(Array("们".utf8)),
    205: bpeStr(Array("好".utf8)),
    206: bpeStr(Array("啊".utf8)),
    207: bpeStr(Array("！".utf8)),
]
let tokenizer = Qwen3Tokenizer(idToToken: idToToken)
assert(tokenizer.decode(tokens: [201, 202]).hasSuffix("\\u{FFFD}"), "expected incomplete UTF-8 fragment to decode with U+FFFD")
assert(tokenizer.decode(tokens: [201, 202, 203]) == "我中", "expected complete BPE pair to decode cleanly")

// Sequence: ["我", part1("中"), part2("中"), "们", "好", "啊", "！", EOS]
// Dropping EOS then rollbackCount=5 leaves [201, 202] -> ends in U+FFFD -> must snap back to [201].
let rolled = PrefixRollbackBridge.safePrefixTokensForRollback([201, 202, 203, 204, 205, 206, 207, Int32(Qwen3ASRTokens.eosTokenId)], rollbackCount: 5, tokenizer: tokenizer)
assert(rolled == [201], "U+FFFD boundary guard failed, got \\(rolled)")
print("UTF8_ROLLBACK_GUARD:PASS")

// Preserve <asr_text> header while only counting tokens after it against rollbackCount
let withHeader: [Int32] = [200, Int32(Qwen3ASRTokens.asrTextTokenId), 201, 202, 203, 204, 205, 206, 207]
let rolledHeader = PrefixRollbackBridge.safePrefixTokensForRollback(withHeader, rollbackCount: 5, tokenizer: tokenizer)
assert(rolledHeader == [200, Int32(Qwen3ASRTokens.asrTextTokenId), 201], "header rollback failed, got \\(rolledHeader)")
assert(PrefixRollbackBridge.safePrefixTokensForRollback([201, 202, 203], rollbackCount: 5, tokenizer: tokenizer).isEmpty, "short sequence must return []")
print("HEADER_AND_SHORT_GUARD:PASS")

// buildPromptTokenIds inserts prefixTokens strictly after T.asrTextTokenId
let (_, suffixEmpty) = PrefixRollbackBridge.buildPromptTokenIds(language: nil, context: nil, tokenizer: tokenizer)
assert(suffixEmpty.last == Int32(Qwen3ASRTokens.asrTextTokenId), "empty prefixTokens must end with asrTextTokenId")
let (_, suffixWithPrefix) = PrefixRollbackBridge.buildPromptTokenIds(language: nil, context: nil, tokenizer: tokenizer, prefixTokens: [201, 202, 203])
let asrIdx = suffixWithPrefix.firstIndex(of: Int32(Qwen3ASRTokens.asrTextTokenId))!
assert(Array(suffixWithPrefix[(asrIdx + 1)...]) == [201, 202, 203], "prefixTokens missing after asrTextTokenId: \\(suffixWithPrefix)")
print("PROMPT_PREFIX_INSERTION:PASS")
`);
  execFileSync(swiftCompiler!, ['-swift-version', '5', file, '-o', executable], { encoding: 'utf8', timeout: 60000 });
  const result = execFileSync(executable, [], { encoding: 'utf8', timeout: 20000 });
  for (const name of ['UTF8_ROLLBACK_GUARD', 'HEADER_AND_SHORT_GUARD', 'PROMPT_PREFIX_INSERTION']) {
    expect(result).toContain(name + ':PASS');
  }
}, 95000);

it.skipIf(!swiftCompiler)('executes the actual Swift bounded window through token prefix rollback, repeated phrases, VAD, disjoint low-RMS cut and final tails', async () => {
  await setup();
  const source = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', import.meta.url), 'utf8');
  const state = source.slice(source.indexOf('struct SpeechWindow {'));
  expect(state).toContain('mutating func finish(');
  const file = join(root, 'SpeechWindowTests.swift'), executable = join(root, 'speech-window-tests');
  await writeFile(file, 'import Foundation\n' + state + '\n' + swiftWindowCases);
  execFileSync(swiftCompiler!, ['-swift-version', '5', file, '-o', executable], { encoding: 'utf8', timeout: 60000 });
  const result = execFileSync(executable, [], { encoding: 'utf8', timeout: 30000 });
  for (const name of ['TAIL', 'PREFIX_ROLLBACK_CADENCE', 'REPEATED_PHRASE_PUNCTUATION', 'VAD', 'PUNCTUATION', 'REPEATED_SENTENCE', 'LONG_CONTINUOUS', 'LONG_TRANSCRIPT', 'VARIABLE_TAP', 'BACKLOG_CHUNKING', 'DISJOINT_LOW_RMS_PARTITION', 'FAILURE', 'UNICODE', 'EMPTY', 'IN_FLIGHT_STOP', 'ZERO_LAG', 'WARMUP', 'AUDIO_LEVEL_THROTTLE', 'OVERLOAD', 'TAIL_BATCH', 'MID_DECODE_CANCEL']) {
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
func pcm(_ count: Int, amp: Float = 0.1) -> [Float] { Array(repeating: amp, count: count) }
final class InFlightCapture {
    var window = SpeechWindow()
    var lengths: [Int] = []
    var events: [String] = []
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    func decode(_ samples: [Float], _ prefix: [Int32]) -> SpeechWindow.DecodeResult? {
        lengths.append(samples.count)
        if lengths.count == 1 { entered.signal(); release.wait() }
        return samples.count == 24000 ? ("before tail", [1, 2]) : ("before tail last word", [1, 2, 3, 4])
    }
}
func run() throws {
    var window = SpeechWindow(), calls: [Int] = [], seenPrefixes: [[Int32]] = [], emitted: [String] = [], lastDecodedSamples: [Float] = []
    let decode: SpeechWindow.DecodeFn = { samples, prefix in
        calls.append(samples.count)
        seenPrefixes.append(prefix)
        lastDecodedSamples = samples
        return ("最后的字", [501, 502])
    }
    try window.append(pcm(1599), speech: true, decode: decode) { emitted.append($0) }
    check(calls.isEmpty, "short tail decoded early")
    let tail = try window.finish(decode: decode)
    check(tail == "最后的字" && calls == [1599 + SpeechWindow.finalSilencePadding], "short tail lost or missing 200ms silence flush")
    check(seenPrefixes == [[]], "short tail must use empty prefix")
    check(lastDecodedSamples.prefix(1599).allSatisfy { $0 == 0.1 } && lastDecodedSamples.suffix(SpeechWindow.finalSilencePadding).allSatisfy { $0 == 0 }, "final decode did not append exact 3200 trailing zeros after real PCM")
    _ = try window.finish(decode: decode)
    check(calls == [1599 + SpeechWindow.finalSilencePadding] && window.samples.isEmpty, "final decoded twice")
    print("TAIL:PASS")

    // unfixedChunkNum=2, unfixedTokenNum=5 cadence + rolled-back prefix propagation into finish()
    window = SpeechWindow(); calls = []; seenPrefixes = []; emitted = []
    let rollbackDecode: SpeechWindow.DecodeFn = { samples, prefix in
        calls.append(samples.count)
        seenPrefixes.append(prefix)
        let chunks = calls.count
        switch chunks {
        case 1:
            return ("w1 w2", [101, 102])
        case 2:
            return ("w1 w2 w3 w4 w5 w6 w7", [101, 102, 103, 104, 105, 106, 107])
        case 3:
            check(prefix == [101, 102], "chunk 3 expected rolled-back [101, 102], got \\(prefix)")
            return ("w1 w2 w3 w4 w5 w6 w7 w8", prefix + [103, 104, 105, 106, 107, 108])
        case 4:
            check(prefix == [101, 102, 103], "chunk 4 expected rolled-back [101, 102, 103], got \\(prefix)")
            return ("w1 w2 w3 w4 w5 w6 w7 w8 w9", prefix + [104, 105, 106, 107, 108, 109])
        default:
            check(prefix == [101, 102, 103, 104], "finish expected rolled-back [101, 102, 103, 104], got \\(prefix)")
            return ("w1 w2 w3 w4 w5 w6 w7 w8 w9 end", prefix + [105, 106, 107, 108, 109, 110])
        }
    }
    for _ in 0..<4 {
        try window.append(pcm(24000), speech: true, decode: rollbackDecode) { emitted.append($0) }
    }
    try window.append(pcm(1600), speech: true, decode: rollbackDecode) { emitted.append($0) }
    let rollbackFinal = try window.finish(decode: rollbackDecode)
    check(rollbackFinal == "w1 w2 w3 w4 w5 w6 w7 w8 w9 end", "prefix rollback final mismatch: " + rollbackFinal)
    check(seenPrefixes[0].isEmpty && seenPrefixes[1].isEmpty, "chunks 1-2 must not lock prefixTokens")
    print("PREFIX_ROLLBACK_CADENCE:PASS")

    // Repeated Chinese phrase + punctuation counterfactual + repeated consecutive words preserved verbatim
    window = SpeechWindow(); seenPrefixes = []
    let repeatedPhrase = "我们一起研究广东深圳啊，广东深圳呢"
    let phraseChars = Array(repeatedPhrase)
    let phraseTokenIds: [Int32] = (0..<phraseChars.count).map { Int32(2000 + $0) }
    var phraseStep = 0
    let phraseDecode: SpeechWindow.DecodeFn = { _, prefix in
        phraseStep += 1
        let targetLen = min(phraseChars.count, phraseStep * 6)
        if !prefix.isEmpty {
            check(prefix == Array(phraseTokenIds.prefix(prefix.count)), "prefix diverged from phrase token stream")
        }
        return (String(phraseChars.prefix(targetLen)), Array(phraseTokenIds.prefix(targetLen)))
    }
    for _ in 0..<3 {
        try window.append(pcm(24000), speech: true, decode: phraseDecode) { _ in }
    }
    let phraseOut = try window.finish(decode: phraseDecode)
    check(phraseOut == repeatedPhrase, "repeated phrase corrupted: " + phraseOut)

    // Across segmentCapacity split too: repeated CJK tokens are never dropped
    window = SpeechWindow()
    let repeatTokens: SpeechWindow.DecodeFn = { samples, prefix in
        let count = samples.count / 24000
        let toks = (0..<count).map { Int32(3000 + $0) }
        return (Array(repeating: "哈", count: count).joined(), prefix.isEmpty ? toks : prefix + toks.suffix(min(toks.count, 5)))
    }
    for _ in 0..<10 {
        try window.append(pcm(24000), speech: true, decode: repeatTokens) { _ in }
    }
    let repeatFinal = try window.finish(decode: repeatTokens)
    check(repeatFinal.count == 10 && repeatFinal == String(repeating: "哈", count: 10), "repeated tokens lost: " + repeatFinal)
    print("REPEATED_PHRASE_PUNCTUATION:PASS")

    // VAD pause resets segment tokens & prefixTokens
    window = SpeechWindow(); calls = []; seenPrefixes = []
    try window.append(pcm(8000), speech: true, decode: decode) { _ in }
    try window.append(pcm(11200), speech: false, decode: decode) { _ in }
    check(window.samples.isEmpty && window.committed == "最后的字" && window.partial.isEmpty, "VAD failed to isolate segment")
    var sawSecondSegmentEmptyPrefix = false
    for s in 1...3 {
        try window.append(pcm(24000), speech: true, decode: { _, prefix in
            if s == 1 { sawSecondSegmentEmptyPrefix = prefix.isEmpty }
            return ("第二句", [601, 602, 603, 604, 605, 606])
        }) { _ in }
    }
    check(sawSecondSegmentEmptyPrefix, "new segment after VAD leaked prior prefix")
    print("VAD:PASS")

    window = SpeechWindow()
    let sentence: SpeechWindow.DecodeFn = { _, _ in ("同一句。", [701, 702]) }
    try window.append(pcm(24000), speech: true, decode: sentence) { _ in }
    try window.append(pcm(6400), speech: false, decode: sentence) { _ in }
    check(window.samples.isEmpty && window.committed == "同一句。", "punctuation pause did not commit")
    print("PUNCTUATION:PASS")
    try window.append(pcm(24000), speech: true, decode: sentence) { _ in }
    try window.append(pcm(6400), speech: false, decode: sentence) { _ in }
    check(window.committed == "同一句。同一句。", "valid repeated sentence deduplicated")
    print("REPEATED_SENTENCE:PASS")

    // Continuous 2-minute speech stays strictly bounded at segmentCapacity
    window = SpeechWindow(); calls = []
    let longDecode: SpeechWindow.DecodeFn = { samples, _ in
        calls.append(samples.count)
        return ("连续讲话没有标点也没有停顿可以一直继续", [801, 802])
    }
    for _ in 0..<1200 {
        try window.append(pcm(1600), speech: true, decode: longDecode) { _ in }
        check(window.samples.count <= SpeechWindow.segmentCapacity, "PCM exceeded segmentCapacity")
    }
    _ = try window.finish(decode: longDecode)
    check(calls.count == 80 && calls.max() == SpeechWindow.segmentCapacity, "2 minute decode cadence/bound failed: \\(calls.count) max=\\(calls.max() ?? -1)")
    check(window.samples.isEmpty, "final did not release PCM")
    print("LONG_CONTINUOUS:PASS")

    // Labelled 3-minute transcript across multiple segment splits preserves every word with zero duplication
    window = SpeechWindow()
    func word(_ id: Int) -> String { "word" + String(format: "%03d", id) }
    let labelled: SpeechWindow.DecodeFn = { samples, _ in
        var previous = -1, words: [String] = [], toks: [Int32] = []
        for sample in samples {
            let id = Int(sample.rounded())
            if id <= 0 { continue }
            if id != previous {
                words.append(word(id))
                toks.append(Int32(1000 + id))
                previous = id
            }
        }
        return (words.joined(separator: " "), toks)
    }
    for second in 1...120 {
        // Place a 160ms quiet word boundary after each 1.34s word so sustained-quiet splits land cleanly between words without slicing a word in half.
        var chunk = Array(repeating: Float(second), count: 21_440)
        chunk.append(contentsOf: Array(repeating: Float(0), count: 2_560))
        try window.append(chunk, speech: true, decode: labelled) { _ in }
    }
    let transcript = try window.finish(decode: labelled)
    check(transcript == (1...120).map(word).joined(separator: " "), "continuous segmented transcript corrupted")
    print("LONG_TRANSCRIPT:PASS")

    window = SpeechWindow(); calls = []
    try window.append(pcm(64000 + 137), speech: true, decode: longDecode) { _ in }
    _ = try window.finish(decode: longDecode)
    check(calls == [64137], "large tap overshot boundary or lost tail")
    print("VARIABLE_TAP:PASS")

    window = SpeechWindow(); calls = []
    try window.append(pcm(SpeechWindow.segmentCapacity + 24000), speech: true, decode: longDecode) { _ in }
    check(calls == [SpeechWindow.segmentCapacity, 24000] && window.samples.count == 24000, "live backlog exceeded segmentCapacity: \\(calls)")
    print("BACKLOG_CHUNKING:PASS")

    // Disjoint sustained-quiet-interval partitioning beyond segmentCapacity (13.5s = 216,000 samples)
    do {
        var quietGapSignal = Array(repeating: Float(0.25), count: 195_200) // 12.2s voiced
        quietGapSignal.append(contentsOf: Array(repeating: Float(0.001), count: 3_200)) // 200ms sustained quiet interval
        quietGapSignal.append(contentsOf: Array(repeating: Float(0.25), count: 19_200)) // 1.2s voiced -> 13.6s total (217,600)
        check(quietGapSignal.count == 217_600, "fixture length mismatch")
        let cutIdx = SpeechWindow.lowestEnergySplitIndex(in: Array(quietGapSignal.prefix(SpeechWindow.segmentCapacity)))
        check(cutIdx >= 195_200 && cutIdx <= 198_400, "sustained-quiet cut missed quiet gap: \\(cutIdx)")

        for isBacklog in [false, true] {
            var segWin = SpeechWindow()
            var sliceDecodeLog: [(Int, Int)] = []
            let trackingDecode: SpeechWindow.DecodeFn = { samples, _ in
                sliceDecodeLog.append((samples.count, samples.filter { $0 == 0.001 }.count))
                return ("s\\(sliceDecodeLog.count)", [Int32(sliceDecodeLog.count)])
            }
            if isBacklog {
                try segWin.append(quietGapSignal, speech: true, final: true, decode: trackingDecode) { _ in }
                _ = try segWin.finish(decode: trackingDecode)
                check(sliceDecodeLog.count == 2, "backlog expected 2 disjoint segments, got \\(sliceDecodeLog)")
                let seg1Count = sliceDecodeLog[0].0
                let seg2Count = sliceDecodeLog[1].0 - SpeechWindow.finalSilencePadding
                check(seg1Count == cutIdx && seg1Count + seg2Count == quietGapSignal.count, "disjoint backlog split sum mismatch: \\(seg1Count) + \\(seg2Count) != \\(quietGapSignal.count)")
            } else {
                var offset = 0
                while offset < quietGapSignal.count {
                    let end = min(quietGapSignal.count, offset + 24_000)
                    try segWin.append(Array(quietGapSignal[offset..<end]), speech: true, decode: trackingDecode) { _ in }
                    offset = end
                }
                _ = try segWin.finish(decode: trackingDecode)
                let finalSeg2Count = sliceDecodeLog.last!.0 - SpeechWindow.finalSilencePadding
                let seg1Count = sliceDecodeLog[sliceDecodeLog.count - 2].0
                check(seg1Count == cutIdx && seg1Count + finalSeg2Count == quietGapSignal.count, "disjoint streaming split sum mismatch: \\(seg1Count) + \\(finalSeg2Count) != \\(quietGapSignal.count)")
            }
        }
        print("DISJOINT_LOW_RMS_PARTITION:PASS")
    }

    // F2 class test: isolated 20ms stop-closure trough mid-speech is ignored in favor of true 160ms sustained quiet pause
    do {
        var speechWithDip = Array(repeating: Float(0.30), count: SpeechWindow.segmentCapacity)
        // Isolated 20ms zero dip at 11.80s..11.82s surrounded by loud 0.30 speech
        for idx in 188_800..<189_120 { speechWithDip[idx] = 0.0 }
        // True sustained 160ms quiet interval at 12.29s..12.45s
        for idx in 196_640..<199_200 { speechWithDip[idx] = 0.002 }
        let sustainedCut = SpeechWindow.lowestEnergySplitIndex(in: speechWithDip)
        check(sustainedCut >= 196_960 && sustainedCut <= 198_880, "split picked isolated 20ms dip or edge instead of sustained quiet center: \\(sustainedCut)")
        print("SUSTAINED_QUIET_CUT:PASS")
    }

    // F1 class test: capacity split preserves only carriedAudio's VAD trailing silence (no-cap control, post-cut silence, cut-straddling silence, empty carry, warmup isolation)
    do {
        // 1) Parameterized no-cap control vs post-cut carried silence
        for useCapSplit in [false, true] {
            var vadWin = SpeechWindow()
            var seenPrefixes: [[Int32]] = []
            let vadDecode: SpeechWindow.DecodeFn = { _, prefix in
                seenPrefixes.append(prefix)
                // Always return 7 tokens unpunctuated so vadPause (700ms = 11200) applies and rollback keeps >=2 tokens
                return ("词一词二词三", [201, 202, 203, 204, 205, 206, 207])
            }
            if useCapSplit {
                // Build 12.2s loud -> 200ms 0.0 valley (cut lands around 196_160 = 12.26s) -> loud up to 13.2s -> 300ms trailing silence (4,800) to reach 13.5s
                var chunk = Array(repeating: Float(0.25), count: 195_200)
                chunk.append(contentsOf: Array(repeating: Float(0.0), count: 3_200))
                chunk.append(contentsOf: Array(repeating: Float(0.25), count: 12_800))
                chunk.append(contentsOf: Array(repeating: Float(0.001), count: 4_800))
                check(chunk.count == SpeechWindow.segmentCapacity, "vad cap fixture size mismatch")
                // Feed in 24k strides so chunkCount >= 2 before reaching capacity, ending with final voiced+300ms silence batch hitting capacity+1600
                var pos = 0
                while pos < 192_000 {
                    try vadWin.append(Array(chunk[pos..<(pos + 24_000)]), speech: true, trailingSilence: 0, decode: vadDecode) { _ in }
                    pos += 24_000
                }
                let tailWithSilence = Array(chunk[pos..<216_000]) + Array(repeating: Float(0.0), count: 1_600)
                // Last 4,800 + 1,600 = 6,400 samples (< 11,200 vadPause) trailing silence; carried tail has speech + 6,400 trailing silence
                try vadWin.append(tailWithSilence, speech: true, trailingSilence: 6_400, decode: vadDecode) { _ in }
                check(!vadWin.samples.isEmpty, "carried tail unexpectedly cleared before 700ms pause")
                // Adding 300ms more silence (6,400 + 4,800 = 11,200 == vadPause) MUST commit and clear samples
                try vadWin.append(pcm(4_800), speech: false, decode: vadDecode) { _ in }
                check(vadWin.samples.isEmpty, "F1 regression: carried trailing silence lost across cap split, left \\(vadWin.samples.count) samples")
            } else {
                try vadWin.append(Array(repeating: Float(0.25), count: 24_000), speech: true, trailingSilence: 4_800, decode: vadDecode) { _ in }
                try vadWin.append(pcm(6_400), speech: false, decode: vadDecode) { _ in }
                check(vadWin.samples.isEmpty, "no-cap control did not commit at 700ms pause")
            }
            // Subsequent speech MUST start isolated with two warmup chunks (empty prefixTokens)
            seenPrefixes.removeAll()
            try vadWin.append(Array(repeating: Float(0.25), count: 24_000), speech: true, decode: vadDecode) { _ in }
            try vadWin.append(Array(repeating: Float(0.25), count: 24_000), speech: true, decode: vadDecode) { _ in }
            try vadWin.append(Array(repeating: Float(0.25), count: 24_000), speech: true, decode: vadDecode) { _ in }
            check(seenPrefixes.count == 3 && seenPrefixes[0].isEmpty && seenPrefixes[1].isEmpty && !seenPrefixes[2].isEmpty,
                  "next segment failed warmup prefix isolation after VAD commit: \\(seenPrefixes)")
        }

        // 2) Trailing silence straddling cut with non-empty remaining: exact 640ms stays uncommitted, 700ms commits + isolates warmup prefixes
        var spanWin = SpeechWindow()
        var spanPrefixes: [[Int32]] = []
        let spanDecode: SpeechWindow.DecodeFn = { _, prefix in
            spanPrefixes.append(prefix)
            return ("不断言词", [301, 302, 303, 304, 305, 306])
        }
        var spanPcm = Array(repeating: Float(0.25), count: 205_600) // loud up to 12.85s
        spanPcm.append(contentsOf: Array(repeating: Float(0.0), count: 10_400)) // 650ms silence at 12.85s..13.50s
        try spanWin.append(spanPcm + Array(repeating: Float(0.0), count: 160), speech: true, trailingSilence: 10_560, decode: spanDecode) { _ in }
        let carriedRemaining = spanWin.samples.count
        check(carriedRemaining > 0 && carriedRemaining < 10_560, "expected partial silent carry, got \\(carriedRemaining)")
        // Step just past where leaked trailingSilence (10_560) would cross vadPause (11_200), while post-cut silence is still < 700ms
        let leakThresholdStep = max(640, SpeechWindow.vadPause - 10_560)
        check(carriedRemaining + leakThresholdStep < SpeechWindow.vadPause, "fixture needs headroom between leakThreshold and vadPause")
        try spanWin.append(pcm(leakThresholdStep), speech: false, decode: spanDecode) { _ in }
        check(!spanWin.samples.isEmpty, "F1-R2 regression: pre-cut silence leaked across !remaining.isEmpty causing premature commit at \\(carriedRemaining + leakThresholdStep) samples")
        // Reach 1 sample below actual 700ms in carried segment -> still must NOT commit
        let nearlyFull = SpeechWindow.vadPause - (carriedRemaining + leakThresholdStep) - 1
        if nearlyFull > 0 {
            try spanWin.append(pcm(nearlyFull), speech: false, decode: spanDecode) { _ in }
            check(!spanWin.samples.isEmpty, "carried segment committed 1 sample before 700ms pause")
        }
        // Final sample reaches exact 700ms (vadPause) -> commits cleanly
        try spanWin.append(pcm(1), speech: false, decode: spanDecode) { _ in }
        check(spanWin.samples.isEmpty, "carried segment did not commit at exact 700ms pause")
        // Verify subsequent speech starts isolated with two empty warmup prefixes
        spanPrefixes.removeAll()
        for _ in 0..<3 {
            try spanWin.append(Array(repeating: Float(0.25), count: 24_000), speech: true, decode: spanDecode) { _ in }
        }
        check(spanPrefixes.count == 3 && spanPrefixes[0].isEmpty && spanPrefixes[1].isEmpty && !spanPrefixes[2].isEmpty,
              "post-straddle next segment leaked prefix tokens: \\(spanPrefixes)")

        // 3) Empty carry (constant signal splits cleanly at segmentCapacity) + multi-split straddling silence + final path parity
        var emptyCarryWin = SpeechWindow()
        try emptyCarryWin.append(Array(repeating: Float(0.25), count: SpeechWindow.segmentCapacity + 1), speech: true, decode: { _, _ in ("ok", [1]) }) { _ in }
        check(emptyCarryWin.samples.count == 1, "expected 1 carried sample after constant cap split, got \\(emptyCarryWin.samples.count)")
        try emptyCarryWin.append(pcm(SpeechWindow.vadPause - 160), speech: false, decode: { _, _ in ("ok", [1]) }) { _ in }
        check(!emptyCarryWin.samples.isEmpty, "empty-carry segment committed early before 700ms")
        try emptyCarryWin.append(pcm(160), speech: false, decode: { _, _ in ("ok", [1]) }) { _ in }
        check(emptyCarryWin.samples.isEmpty, "empty-carry segment did not commit at 700ms")

        var multiWin = SpeechWindow()
        var multiPcm = Array(repeating: Float(0.25), count: SpeechWindow.segmentCapacity * 2)
        multiPcm.append(contentsOf: Array(repeating: Float(0.0), count: 160))
        try multiWin.append(multiPcm, speech: true, trailingSilence: 160, decode: { _, _ in ("多段", [401]) }) { _ in }
        check(multiWin.samples.count == 160, "expected 160 post-cut samples after uniform multi-split, got \\(multiWin.samples.count)")
        try multiWin.append(pcm(SpeechWindow.vadPause - 320), speech: false, decode: { _, _ in ("多段", [401]) }) { _ in }
        check(!multiWin.samples.isEmpty, "multi-split segment committed early before 700ms")
        try multiWin.append(pcm(160), speech: false, decode: { _, _ in ("多段", [401]) }) { _ in }
        check(multiWin.samples.isEmpty, "multi-split segment did not commit at 700ms")
        print("CAP_VAD_CLOCK_PRESERVATION:PASS")
    }

    var inbox = SpeechInbox()
    check(!(try inbox.offer(pcm(160))), "warmup scheduled decode")
    check(!(try inbox.offer(pcm(160))), "warmup not exactly 20ms")
    check(try inbox.offer([0.1, 0.2, 0.3]), "first PCM did not schedule")
    check(!(try inbox.offer([0.4, 0.5])), "duplicate drain scheduled")
    let drained = inbox.take()
    check(drained?.samples.count == 5 && drained?.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 } == true && inbox.pending.isEmpty, "drain left backlog")
    check(!(try inbox.offer([0.6])), "in-flight drain scheduled a duplicate")
    check(inbox.take()?.samples.count == 1 && inbox.take() == nil, "in-flight PCM lost")
    check(try inbox.offer([0.7]), "empty drain did not rearm")
    print("ZERO_LAG:PASS")
    print("WARMUP:PASS")

    var levelInbox = SpeechInbox()
    _ = try levelInbox.offer(pcm(160))
    check(levelInbox.pollAudioLevel(now: 0.0) == nil, "audioLevel emitted during first warmup half")
    _ = try levelInbox.offer(pcm(160))
    check(levelInbox.pollAudioLevel(now: 0.01) == nil, "audioLevel emitted on exact warmup completion without post-warmup samples")
    _ = try levelInbox.offer(Array(repeating: 0.0025, count: 320))
    let firstLevel = levelInbox.pollAudioLevel(now: 0.05)
    check(firstLevel != nil && firstLevel! > 0.015 && firstLevel! < 0.2, "first quiet post-warmup audioLevel out of range: \\(String(describing: firstLevel))")
    _ = try levelInbox.offer(Array(repeating: 0.2, count: 320))
    check(levelInbox.pollAudioLevel(now: 0.07) == nil, "audioLevel not throttled at +20ms")
    _ = try levelInbox.offer(Array(repeating: 0.2, count: 320))
    check(levelInbox.pollAudioLevel(now: 0.099) == nil, "audioLevel not throttled at +49ms")
    let secondLevel = levelInbox.pollAudioLevel(now: 0.10)
    check(secondLevel != nil && abs(secondLevel! - 0.8) < 0.05, "throttled audioLevel did not emit at +50ms: \\(String(describing: secondLevel))")
    check(levelInbox.pollAudioLevel(now: 0.20) == nil, "duplicate audioLevel emitted without new samples")
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
    // Remaining 32s accepted backlog on stop: split into 216,000-sample (13.5s) segments + bounded tail
    try window.append(pcm(SpeechInbox.limit), speech: true, final: true, decode: longDecode) { _ in fatalError("stop emitted partial") }
    _ = try window.finish(decode: longDecode)
    let stopCalls = Array(calls.dropFirst(beforeStop))
    check(stopCalls == [216000, 216000, 104000 + SpeechWindow.finalSilencePadding], "unexpected 32s stop split cadence: \\(stopCalls)")
    let afterFirstFinish = calls.count
    _ = try window.finish(decode: longDecode)
    check(calls.count == afterFirstFinish, "stop decoded twice")

    // Verify 19.75s (13 strides + 4000 tail = 316,000 samples) labelled backlog across both live & final stop paths
    for isFinalPath in [false, true] {
        var backlogWindow = SpeechWindow()
        var backlogLengths: [Int] = []
        var backlogLastSamples: [Float] = []
        let labelledBacklogDecode: SpeechWindow.DecodeFn = { samples, _ in
            backlogLengths.append(samples.count)
            backlogLastSamples = samples
            var previous = -1, words: [String] = []
            for sample in samples {
                let raw = Int(sample.rounded())
                if raw <= 0 { continue }
                if raw != previous { words.append(word(raw)); previous = raw }
            }
            return (words.joined(separator: " "), [])
        }
        var fullBacklog: [Float] = []
        for id in 1...13 {
            fullBacklog.append(contentsOf: Array(repeating: Float(id), count: 21_440))
            fullBacklog.append(contentsOf: Array(repeating: Float(0), count: 2_560))
        }
        fullBacklog.append(contentsOf: Array(repeating: Float(14), count: 4000))
        try backlogWindow.append(fullBacklog, speech: true, final: isFinalPath, decode: labelledBacklogDecode) { _ in
            if isFinalPath { fatalError("final backlog emitted partial") }
        }
        let stitched = try backlogWindow.finish(decode: labelledBacklogDecode)
        let expectedStitched = (1...14).map(word).joined(separator: " ")
        check(stitched == expectedStitched, "backlog transcript mismatch (final=\\(isFinalPath)): " + stitched + " != " + expectedStitched)
        let expectedPad = isFinalPath ? SpeechWindow.finalSilencePadding : 0
        check(backlogLengths.count == 2
              && backlogLengths[0] >= SpeechWindow.segmentCapacity - SpeechWindow.splitSearchWindow
              && backlogLengths[0] <= SpeechWindow.segmentCapacity
              && backlogLengths[0] + backlogLengths[1] == fullBacklog.count + expectedPad,
              "unexpected backlog split lengths (final=\\(isFinalPath)): \\(backlogLengths)")
        if isFinalPath {
            check(backlogLastSamples.dropLast(SpeechWindow.finalSilencePadding).suffix(4000).allSatisfy { $0 == 14 }
                  && backlogLastSamples.suffix(SpeechWindow.finalSilencePadding).allSatisfy { $0 == 0 },
                  "final backlog window zero padding corrupted")
        }
    }
    print("TAIL_BATCH:PASS")

    window = SpeechWindow()
    try window.append(pcm(24000), speech: true, decode: sentence) { _ in }
    try window.append(pcm(100), speech: true, decode: sentence) { _ in }
    do { _ = try window.finish(decode: { _, _ in nil }); fatalError("decode failure swallowed") }
    catch SpeechWindow.Failure.decode { check(window.text == "同一句。" && window.samples.count == 24100, "failed flush discarded previous text/PCM") }
    print("FAILURE:PASS")

    window = SpeechWindow()
    let unicode: SpeechWindow.DecodeFn = { _, _ in ("你好👨‍👩‍👧‍👦e\\u{301}世界朋友再见", [1, 2, 3]) }
    try window.append(pcm(SpeechWindow.segmentCapacity), speech: true, decode: unicode) { _ in }
    check(window.text == "你好👨‍👩‍👧‍👦e\\u{301}世界朋友再见" && !window.text.contains("\\u{FFFD}"), "corrupted unicode")
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

    // Mid-decode & pre-append cancellation throws Failure.cancelled instead of Failure.decode or silent return
    window = SpeechWindow()
    do {
        try window.append(pcm(24000), speech: true, shouldContinue: { false }, decode: { _, _ in fatalError("should not decode after shouldContinue=false") }) { _ in }
        fatalError("pre-append cancellation returned silently")
    } catch SpeechWindow.Failure.cancelled { }
    var keepGoing = true
    do {
        try window.append(pcm(24000), speech: true, shouldContinue: { keepGoing }, decode: { _, _ in
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
