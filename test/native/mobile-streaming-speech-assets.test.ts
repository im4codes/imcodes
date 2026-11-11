import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { STREAMING_SPEECH_PLUGIN_NAME } from '../../shared/voice-recognition.js';
// @ts-ignore plain build script
import { matchesAsset, prepareSpeechAssets, SPEECH_ASSETS, MODEL_REVISION } from '../../web/scripts/prepare-streaming-speech.mjs';
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function setup() { root = await mkdtemp(join(tmpdir(), 'imcodes-test-speech-')); return pathToFileURL(root + '/'); }
const bytes = Buffer.from('offline-model');
const digest = createHash('sha256').update(bytes).digest('hex');
const asset = ['models/test.onnx', 'https://example.invalid/pinned/model', digest, bytes.length];
const modelFiles = ['conv_frontend.onnx', 'encoder.int4.onnx', 'encoder.int4.weights', 'decoder.int4.onnx', 'decoder.int4.weights', 'tokenizer/vocab.json', 'tokenizer/merges.txt', 'tokenizer/tokenizer_config.json', 'hotwords.txt'];

describe('Qwen3-ASR mobile assets', () => {
  it('pins the complete INT4 model/external weights/tokenizer/hotwords and AAR without a punctuator', async () => {
    expect(MODEL_REVISION).toBe('9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e');
    expect(SPEECH_ASSETS).toHaveLength(10);
    expect(SPEECH_ASSETS.map((a: any) => a[2])).toEqual([
      'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e', '774e997d23a2f06c3f544666625c93a3b824fdd83d04c6acd88ee25f4e3b6e2e',
      'dc66975d9be10fbd31f89c76d33dd0bf4a8059ef14da4abf545bbf9895a5293d', 'c588d2a89460315f51ca8c65dbe85a0619891500fc853e5b673e3c914c25b2d3',
      '126c8e16074cc87250dacbf07602315e3bc5239c93ea414773b6e3a6fd4bf466', 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
      '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5', '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c',
      '26feefe92ea440b2cd286ace1b4d386db86990bd6f6a95e921cdbe0c1af79b49', 'a8d09d1d32f3eb8520482c6d3d43fae674681c5b050385967c70a3c2c9bf0ee7',
    ]);
    expect(SPEECH_ASSETS.map((a: any) => a[0])).toEqual([...modelFiles.map(x => 'models/' + x), 'android/libs/sherpa-onnx-2.0.1.aar']);
    expect(SPEECH_ASSETS.every((a: any) => /^[a-f\d]{64}$/.test(a[2]) && a[3] > 0)).toBe(true);
    expect(SPEECH_ASSETS.slice(0, 8).every((a: any) => a[1].includes('/goodpixelltd/qwen3-asr-0.6b-int4-sherpa-onnx/resolve/' + MODEL_REVISION))).toBe(true);
    expect(SPEECH_ASSETS.map((a: any) => a[3])).toEqual([44148281, 5622024, 110308864, 891837, 469962752, 2776833, 1671853, 12487, 53, 49441341]);
    expect(await matchesAsset(new URL('../../web/plugins/streaming-speech/models/hotwords.txt', import.meta.url), SPEECH_ASSETS[8][2], 53)).toBe(true);
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
  it('keeps both native contracts, bounded 20s segments, and offline API ownership aligned', async () => {
    const base = new URL('../../web/plugins/streaming-speech/', import.meta.url);
    const android = await readFile(new URL('android/src/main/java/com/imcodes/speech/StreamingSpeechPlugin.java', base), 'utf8');
    const ios = await readFile(new URL('ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', base), 'utf8');
    expect(android).toContain(`@CapacitorPlugin(name = "${STREAMING_SPEECH_PLUGIN_NAME}"`);
    expect(ios).toContain(`jsName = "${STREAMING_SPEECH_PLUGIN_NAME}"`);
    for (const name of modelFiles) { expect(android).toContain('"' + name + '"'); expect(ios).toContain('"' + name + '"'); }
    for (const name of ['listeningState', 'audioLevel', 'partialResults', 'recognitionError']) { expect(android).toContain('"' + name + '"'); expect(ios).toContain('"' + name + '"'); }
    expect(ios).toContain('sherpaOnnxOfflineQwen3ASRModelConfig(maxTotalLen: 768');
    expect(ios).toContain('SherpaOnnxDestroyOfflineStream(stream)'); expect(ios).toContain('SherpaOnnxDestroyOfflineRecognizerResult(result)');
    expect(android).toContain('qwen.setMaxTotalLen(768)'); expect(android).toContain('new OfflineRecognizer(null, config)');
    expect(android).toContain('getNoBackupFilesDir()'); expect(android).toContain('finally { stream.release(); }');
    expect(ios).toContain('20 * 16000'); expect(android).toContain('20 * SAMPLE_RATE');
    expect(ios).toContain('DispatchSemaphore(value: 64)'); expect(android).toContain('MAX_BUFFERED_CHUNKS = 64');
    expect(ios).not.toContain('OfflinePunctuation'); expect(android).not.toContain('OfflinePunctuation');
    expect(ios).not.toContain('OnlineStream'); expect(android).not.toContain('OnlineStream');
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
  public static int reads=0;
  public static volatile java.util.concurrent.CountDownLatch delivered;
  private boolean recording;
  private int remaining;
  private int silentRemaining;
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
      java.util.Arrays.fill(out, (short) 1000);
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
  public static class Context { public Assets getAssets(){ return new Assets(); } public java.io.File getNoBackupFilesDir(){ return new java.io.File(System.getProperty("java.io.tmpdir"),"speech-private"); } }
  public static class Assets { public java.io.InputStream open(String path) throws java.io.IOException { return new java.io.ByteArrayInputStream(path.equals("hotwords.txt") ? "COMMIT\\nGITHUB\\nENGLISH\\n".getBytes(java.nio.charset.StandardCharsets.UTF_8) : new byte[]{1}); } }
  public static class Activity { public androidx.lifecycle.Lifecycle getLifecycle(){ return new androidx.lifecycle.Lifecycle(); } }
}`,
      'com/getcapacitor/PluginMethod.java': `package com.getcapacitor; public @interface PluginMethod{}`,
      'com/getcapacitor/annotation/CapacitorPlugin.java': `package com.getcapacitor.annotation; public @interface CapacitorPlugin{ String name(); Permission[] permissions(); }`,
      'com/getcapacitor/annotation/Permission.java': `package com.getcapacitor.annotation; public @interface Permission{ String alias(); String[] strings(); }`,
      'com/getcapacitor/annotation/PermissionCallback.java': `package com.getcapacitor.annotation; public @interface PermissionCallback{}`,
      'com/k2fsa/sherpa/onnx/OfflineRecognizerConfig.java': `package com.k2fsa.sherpa.onnx;
public class OfflineRecognizerConfig {
  private final Model model=new Model(); public Model getModelConfig(){return model;}
  public static class Model { public void setNumThreads(int n){if(n!=2)throw new AssertionError();} public void setProvider(String p){} public Qwen getQwen3Asr(){return new Qwen();} }
  public static class Qwen { public void setConvFrontend(String p){} public void setEncoder(String p){} public void setDecoder(String p){} public void setTokenizer(String p){} public void setMaxTotalLen(int n){if(n!=768)throw new AssertionError();} public void setMaxNewTokens(int n){} public void setTemperature(float n){} public void setTopP(float n){} public void setSeed(int n){} public void setHotwords(String s){if(!s.equals("COMMIT,GITHUB,ENGLISH"))throw new AssertionError(s);} }
}`,
      'com/k2fsa/sherpa/onnx/OfflineStream.java': `package com.k2fsa.sherpa.onnx;
public class OfflineStream { public float[] samples; public static int created=0,released=0,maxSamples=0; public OfflineStream(){created++;} public void acceptWaveform(float[] s,int rate){if(samples!=null||rate!=16000)throw new AssertionError(); samples=s;maxSamples=Math.max(maxSamples,s.length);} public void release(){released++;} }`,
      'com/k2fsa/sherpa/onnx/OfflineRecognizer.java': `package com.k2fsa.sherpa.onnx;
public class OfflineRecognizer {
 public static java.util.concurrent.CountDownLatch entered=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1),decoded=new java.util.concurrent.CountDownLatch(1);
 public static volatile int creations=0,releases=0; public static volatile int lastSamples=0; public static volatile boolean holdDecode=false; public static java.util.concurrent.CountDownLatch decoding=new java.util.concurrent.CountDownLatch(1),decodeRelease=new java.util.concurrent.CountDownLatch(1);
 public OfflineRecognizer(Object assets,OfflineRecognizerConfig config){if(assets!=null)throw new AssertionError("external weights require files");creations++;entered.countDown();try{release.await();}catch(InterruptedException e){throw new RuntimeException(e);}}
 public OfflineStream createStream(){return new OfflineStream();}
 public void decode(OfflineStream stream){lastSamples=stream.samples.length;decoded.countDown();if(holdDecode){decoding.countDown();try{decodeRelease.await();}catch(InterruptedException e){throw new RuntimeException(e);}}}
 public Result getResult(OfflineStream stream){return new Result();}
 public static class Result {public String getText(){return "你好 Hello.";}}
 public void release(){releases++;}
}`,
      'Harness.java': `import com.imcodes.speech.StreamingSpeechPlugin; import com.getcapacitor.PluginCall; import com.k2fsa.sherpa.onnx.*; import android.media.AudioRecord; import java.util.concurrent.*;
public class Harness {
 static class Subject extends StreamingSpeechPlugin {void destroy(){handleOnDestroy();}}
 static void await(CountDownLatch l)throws Exception{if(!l.await(4,TimeUnit.SECONDS))throw new AssertionError("timeout");}
 static void check(boolean b,Object message){if(!b)throw new AssertionError(message);}
 static long finals(Subject p){return p.events.stream().filter(x->x.contains("isFinal=true")).count();}
 public static void main(String[] args)throws Exception {
  Subject p=new Subject();
  try {
   p.load();await(OfflineRecognizer.entered);
   PluginCall start=new PluginCall();p.start(start);await(start.done);await(AudioRecord.delivered);
   PluginCall stop=new PluginCall();p.stop(stop);OfflineRecognizer.release.countDown();await(stop.done);
   check(OfflineRecognizer.lastSamples==1600,p.events); check(finals(p)==1,p.events);check(p.events.get(p.events.size()-1).contains("status=stopped"),p.events);
   System.out.println("COLD_STOP_OK");
   p.events.clear();AudioRecord.chunksPerStart=12;OfflineRecognizer.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(OfflineRecognizer.decoded);await(AudioRecord.delivered);PluginCall stop2=new PluginCall();p.stop(stop2);await(stop2.done);
   check(OfflineRecognizer.creations==1,p.events);check(finals(p)==1,p.events);check(p.events.stream().anyMatch(x->x.contains("isFinal=false")),p.events);System.out.println("WARM_REUSE_OK");
   p.events.clear();AudioRecord.chunksPerStart=6;AudioRecord.silentChunksPerStart=6;OfflineRecognizer.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(OfflineRecognizer.decoded);await(AudioRecord.delivered);PluginCall stop3=new PluginCall();p.stop(stop3);await(stop3.done);
   check(p.events.stream().filter(x->x.contains("isFinal=true")).anyMatch(x->x.contains("你好 Hello.")&&!x.contains("你好 Hello.你好")),p.events);System.out.println("SILENCE_SEGMENT_OK");
   p.events.clear();AudioRecord.chunksPerStart=205;AudioRecord.silentChunksPerStart=0;OfflineRecognizer.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(AudioRecord.delivered);PluginCall stop4=new PluginCall();p.stop(stop4);await(stop4.done);
   check(OfflineStream.maxSamples==320000,OfflineStream.maxSamples);check(finals(p)==1,p.events);check(p.events.stream().anyMatch(x->x.contains("你好 Hello.你好 Hello.")),p.events);check(OfflineStream.created==OfflineStream.released,p.events);System.out.println("WINDOW_AND_RELEASE_OK");
  } finally {p.destroy();}
  for(int i=0;i<100&&OfflineRecognizer.releases==0;i++)Thread.sleep(5);check(OfflineRecognizer.releases==1,OfflineRecognizer.releases);
  OfflineRecognizer.entered=new CountDownLatch(1);OfflineRecognizer.release=new CountDownLatch(1);AudioRecord.chunksPerStart=70;
  Subject overflow=new Subject();try{overflow.load();await(OfflineRecognizer.entered);overflow.start(new PluginCall());for(int i=0;i<800&&AudioRecord.latest.getRecordingState()==AudioRecord.RECORDSTATE_RECORDING;i++)Thread.sleep(5);check(AudioRecord.latest.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING,"overflow did not stop intake");OfflineRecognizer.release.countDown();PluginCall end=new PluginCall();overflow.stop(end);await(end.done);check(overflow.events.stream().anyMatch(x->x.contains("processing overloaded")),overflow.events);System.out.println("OVERFLOW_OK");}finally{overflow.destroy();}
  for(int i=0;i<100&&OfflineRecognizer.releases<2;i++)Thread.sleep(5);
  OfflineRecognizer.holdDecode=true;AudioRecord.chunksPerStart=6;
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
    const output=execFileSync('java',['-Djava.io.tmpdir='+root,'-cp',classesDir,'Harness'],{encoding:'utf8',timeout:15000}).trim().split('\n');
    expect(output).toEqual(['COLD_STOP_OK','WARM_REUSE_OK','SILENCE_SEGMENT_OK','WINDOW_AND_RELEASE_OK','OVERFLOW_OK','OWNER_RETIRE_OK']);
  });
});
