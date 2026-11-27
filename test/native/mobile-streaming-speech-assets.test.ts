import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runNativeOrThrow } from '../spec/support/native-exec.js';
import {
  STREAMING_SPEECH_PLUGIN_NAME,
  STREAMING_SPEECH_TTS_STATE_EVENT,
  STREAMING_SPEECH_TTS_STATUS,
} from '../../shared/voice-recognition.js';
// @ts-ignore plain build script
import {
  IOS_SPEECH_ASSET_PACK_ID,
  IOS_SPEECH_ASSET_PACK_REQUIRED_FILES,
  buildIosSpeechAssetPackManifest,
  isBaPackageAvailable,
  packageIosSpeechAssetPack,
} from '../../web/scripts/package-ios-speech-asset-pack.mjs';
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
    expect(ANDROID_SPEECH_ASSETS).toHaveLength(9);
    expect(ANDROID_SPEECH_ASSETS.map((a: any) => a[2])).toEqual([
      'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e', '774e997d23a2f06c3f544666625c93a3b824fdd83d04c6acd88ee25f4e3b6e2e',
      'dc66975d9be10fbd31f89c76d33dd0bf4a8059ef14da4abf545bbf9895a5293d', 'c588d2a89460315f51ca8c65dbe85a0619891500fc853e5b673e3c914c25b2d3',
      '126c8e16074cc87250dacbf07602315e3bc5239c93ea414773b6e3a6fd4bf466', 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
      '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5', '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ]);
    expect(ANDROID_SPEECH_ASSETS.map((a: any) => a[0])).toEqual(modelFiles.map(x => 'models/' + x));
    expect(ANDROID_SPEECH_ASSETS.every((a: any) => /^[a-f\d]{64}$/.test(a[2]) && (a[0] === 'models/hotwords.txt' ? a[3] === 0 : a[3] > 0))).toBe(true);
    expect(ANDROID_SPEECH_ASSETS.slice(0, 8).every((a: any) => a[1].includes('/goodpixelltd/qwen3-asr-0.6b-int4-sherpa-onnx/resolve/' + MODEL_REVISION))).toBe(true);
    expect(ANDROID_SPEECH_ASSETS.map((a: any) => a[3])).toEqual([44148281, 5622024, 110308864, 891837, 469962752, 2776833, 1671853, 12487, 0]);
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

    expect(SPEECH_ASSETS).toHaveLength(16);
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
    const androidBuildGradle = await readFile(new URL('android/build.gradle', base), 'utf8');
    const appBuildGradle = await readFile(new URL('../../web/android/app/build.gradle', import.meta.url), 'utf8');
    const mainActivity = await readFile(new URL('../../web/android/app/src/main/java/com/im/codes/MainActivity.java', import.meta.url), 'utf8');
    const withFcmApp = await readFile(new URL('../../web/android/app/src/withFcm/java/com/im/codes/AppApplication.java', import.meta.url), 'utf8');
    const withoutFcmApp = await readFile(new URL('../../web/android/app/src/withoutFcm/java/com/im/codes/AppApplication.java', import.meta.url), 'utf8');
    const capacitorPluginsUrl = new URL('../../web/android/app/src/main/assets/capacitor.plugins.json', import.meta.url);
    const consumerRules = await readFile(new URL('android/consumer-rules.pro', base), 'utf8');
    const android = await readFile(new URL('android/src/main/java/com/imcodes/speech/StreamingSpeechPlugin.java', base), 'utf8');
    const extractor = await readFile(new URL('android/src/main/java/com/imcodes/speech/SpeechModelExtractor.java', base), 'utf8');
    const androidDecoder = await readFile(new URL('android/src/main/java/com/imcodes/speech/Qwen3OnnxDecoder.java', base), 'utf8');
    const androidTokenizer = await readFile(new URL('android/src/main/java/com/imcodes/speech/Qwen3Tokenizer.java', base), 'utf8');
    const androidMel = await readFile(new URL('android/src/main/java/com/imcodes/speech/WhisperMelExtractor.java', base), 'utf8');
    const androidWindow = await readFile(new URL('android/src/main/java/com/imcodes/speech/Qwen3SpeechWindow.java', base), 'utf8');
    const ios = await readFile(new URL('ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', base), 'utf8');
    const qwenAsr = await readFile(new URL('ios/Sources/Qwen3ASR/Qwen3ASR.swift', base), 'utf8');
    expect(androidBuildGradle).toContain("com.microsoft.onnxruntime:onnxruntime-android:1.28.0");
    expect(androidBuildGradle).not.toContain('noCompress');
    expect(appBuildGradle).not.toContain('noCompress');
    expect(appBuildGradle).toContain("abiFilters(*resolvedAbiFilters)");
    expect(appBuildGradle).toContain("['arm64-v8a']");
    expect(appBuildGradle).toContain("useLegacyPackaging = true");
    expect(androidBuildGradle).not.toContain('sherpa-onnx');
    expect(appBuildGradle).not.toContain('sherpa-onnx');
    expect(mainActivity).toContain('import com.imcodes.speech.StreamingSpeechPlugin;');
    expect(mainActivity).toContain('import com.imcodes.speech.SpeechModelExtractor;');
    expect(mainActivity).toContain('SpeechModelExtractor.warmUpAsync(this);');
    expect(withFcmApp).toContain('SpeechModelExtractor.warmUpAsync(this);');
    expect(withoutFcmApp).toContain('SpeechModelExtractor.warmUpAsync(this);');
    expect(mainActivity).toContain('registerPlugin(StreamingSpeechPlugin.class);');
    expect(mainActivity).toContain('isPluginListedInCapacitorPlugins("com.imcodes.speech.StreamingSpeechPlugin")');
    expect(mainActivity).toContain('settings.setTextZoom(100);');
    const pluginsJson = JSON.parse(await readFile(capacitorPluginsUrl, 'utf8')) as Array<{ pkg: string; classpath: string }>;
    expect(pluginsJson).toContainEqual({
      pkg: '@imcodes/streaming-speech',
      classpath: 'com.imcodes.speech.StreamingSpeechPlugin',
    });
    expect(consumerRules).toContain('ai.onnxruntime.**');
    expect(consumerRules).not.toContain('sherpa');
    expect(android).toContain(`@CapacitorPlugin(name = "${STREAMING_SPEECH_PLUGIN_NAME}"`);
    expect(ios).toContain(`jsName = "${STREAMING_SPEECH_PLUGIN_NAME}"`);
    for (const name of modelFiles) { expect(extractor).toContain('"' + name + '"'); }
    for (const name of iosModelFiles) { expect(ios).toContain('"' + name + '"'); }
    for (const name of ['listeningState', 'audioLevel', 'partialResults', 'recognitionError']) { expect(android).toContain('"' + name + '"'); expect(ios).toContain('"' + name + '"'); }
    const androidPluginAndExtractor = `${android}\n${extractor}`;
    expect(androidPluginAndExtractor).toContain('getNoBackupFilesDir()');
    expect(androidPluginAndExtractor).toContain('.cache-complete');
    expect(androidPluginAndExtractor).not.toContain('input.available()');
    expect(android).toContain('READ_CHUNK_SAMPLES = 800');
    expect(android).toContain('new Qwen3OnnxDecoder(');
    expect(android).toContain('new Qwen3SpeechWindow()');
    expect(android).toContain('new Qwen3SpeechWindow.SpeechInbox(new SpeechGain())');
    expect(android).toContain('decoder.close()');
    expect(android).toContain('MediaRecorder.AudioSource.VOICE_RECOGNITION');
    expect(android).not.toContain('AutomaticGainControl');
    expect(androidWindow).toContain('MIN_DECODE_NOISE_MULTIPLIER');
    expect(androidWindow).toContain('SILENCE_RESET_MIN_VOICED_SAMPLES');
    expect(androidDecoder).not.toContain('nextId == tokenizer.eosTokenId && activePrefix.length == 0');
    expect(android).not.toContain('OfflineRecognizer');
    expect(android).not.toContain('OfflinePunctuation');
    expect(android).not.toContain('OnlineStream');
    expect(android).not.toContain('ROLLBACK_CHARS');
    expect(android).not.toContain('sherpa');
    expect(androidDecoder).toContain('DEFAULT_MAX_TOTAL_LEN = 768');
    expect(androidDecoder).toContain('DEFAULT_MAX_NEW_TOKENS = 192');
    expect(androidDecoder).toContain('safePrefixTokensForRollback(');
    expect(androidDecoder).toContain('applyKvDeltaInplace(');
    expect(androidDecoder).toContain('isDegenerateRepetition(');
    expect(androidWindow).toContain('SEGMENT_CAPACITY = SAMPLE_RATE * 27 / 2');
    expect(androidWindow).toContain('SPLIT_SEARCH_WINDOW = SAMPLE_RATE * 5 / 2');
    expect(androidWindow).toContain('UNFIXED_CHUNK_NUM = 2');
    expect(androidWindow).toContain('UNFIXED_TOKEN_NUM = 5');
    expect(androidWindow).toContain('PUNCTUATION_PAUSE = SAMPLE_RATE * 4 / 10');
    expect(androidWindow).toContain('VAD_PAUSE = SAMPLE_RATE * 7 / 10');
    expect(androidWindow).toContain('WARMUP_SAMPLES = 320');
    expect(androidWindow).toContain('AUDIO_LEVEL_INTERVAL_NS = 50_000_000L');
    // API 24 compatibility guard: no java.nio.file (API 26+) or InputStream.readAllBytes/Files.readString (API 33+/Java 11) in production sources without coreLibraryDesugaring
    expect(androidTokenizer).toContain('readUtf8File(');
    expect(androidTokenizer).toContain('FileInputStream');
    for (const javaSrc of [mainActivity, withFcmApp, withoutFcmApp, android, extractor, androidDecoder, androidTokenizer, androidMel, androidWindow]) {
      expect(javaSrc).not.toMatch(/\bjava\.nio\.file\b|\bFiles\b|\.toPath\s*\(|\breadAllBytes\s*\(|\bFiles\s*\.\s*(?:readString|writeString)\s*\(|\bByteArrayOutputStream[^;]*toString\s*\(\s*StandardCharsets/);
    }
    // Android ICU Pattern & minSdk 24 (Java 8 / no coreLibraryDesugaring) compatibility guard:
    // reject Pattern flags unsupported on Android ART and Java 9+ collection/String/Optional APIs (API 30+/33+)
    const androidJavaDir = fileURLToPath(new URL('../../web/plugins/streaming-speech/android/src/main/java', import.meta.url));
    const androidJavaFiles = (await readdir(androidJavaDir, { recursive: true }))
      .filter((entry) => entry.endsWith('.java'))
      .map((entry) => join(androidJavaDir, entry));
    expect(androidJavaFiles.length).toBeGreaterThanOrEqual(6);
    for (const javaFile of androidJavaFiles) {
      const javaSrc = await readFile(javaFile, 'utf8');
      expect(javaSrc, javaFile).not.toMatch(/\bUNICODE_CHARACTER_CLASS\b|\bCANON_EQ\b/);
      expect(javaSrc, javaFile).not.toMatch(/\b(?:Map|List|Set)\s*\.\s*(?:of|ofEntries|entry|copyOf)\b|\.(?:isBlank|strip|stripLeading|stripTrailing|repeat)\s*\(|\bOptional\b[^;]*\.isEmpty\s*\(/);
    }

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
    expect(ios).toContain('CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise)');
    expect(ios).toContain('func checkPermissions(_ call: CAPPluginCall)');
    expect(ios).toContain('mapRecordPermissionStatus(');
    expect(ios).toContain('static let warmHoldIdleTimeout: TimeInterval = 60.0');
    expect(ios).toContain('mode: .spokenAudio, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP]');
    expect(ios).not.toContain('mode: .measurement');
    expect(ios).toContain('session.isInputGainSettable');
    expect(ios).toContain('try? session.setInputGain(1.0)');
    expect(ios).toContain('struct SpeechGain');
    expect(ios).toContain('options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP]');
    expect(ios).toContain('options: [.defaultToSpeaker, .allowBluetoothA2DP]');
    expect(ios).toContain('!session.categoryOptions.contains(.allowBluetooth)');
    expect(ios).not.toMatch(/options:\s*\[[^\]]*\.allowBluetooth\b(?!A2DP)/);
    expect(ios).toContain('guard let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) else {');
    expect(ios).toContain('if session.preferredInput?.uid != builtInMic.uid {');
    expect(ios).toContain('try? session.setPreferredInput(builtInMic)');
    const configureBody = ios.slice(
      ios.indexOf('private func configureAudioSessionCategoryIfNeeded('),
      ios.indexOf('private func cancelWarmHoldDeactivationOnAudioQueue('),
    );
    expect(configureBody).not.toContain('preferBuiltInMicIfAvailable');
    const prewarmBody = ios.slice(
      ios.indexOf('private func prewarmAudioOnAudioQueue('),
      ios.indexOf('private func installTapAndStartOnAudioQueue('),
    );
    expect(prewarmBody).not.toContain('setActive(true)');
    expect(prewarmBody).toMatch(/if audioSessionActive \{\s*preferBuiltInMicIfAvailable\(session: session\)\s*\}/);
    const startAudioBody = ios.slice(
      ios.indexOf('try self.configureAudioSessionCategoryIfNeeded(session: session)'),
      ios.indexOf('self.coordinator.markStarted(owner: owner)'),
    );
    const cfgIdx = startAudioBody.indexOf('try self.configureAudioSessionCategoryIfNeeded(session: session)');
    const micBeforeIdx = startAudioBody.indexOf('self.preferBuiltInMicIfAvailable(session: session)');
    const activeIdx = startAudioBody.indexOf('try session.setActive(true)');
    const micAfterIdx = startAudioBody.indexOf('self.preferBuiltInMicIfAvailable(session: session)', activeIdx);
    const activeCloseIdx = startAudioBody.indexOf('\n                    }', activeIdx);
    const gainIdx = startAudioBody.indexOf('session.isInputGainSettable');
    const tapIdx = startAudioBody.indexOf('try self.installTapAndStartOnAudioQueue(owner: owner)');
    expect(cfgIdx).toBeGreaterThanOrEqual(0);
    expect(micBeforeIdx).toBeGreaterThan(cfgIdx);
    expect(activeIdx).toBeGreaterThan(micBeforeIdx);
    expect(micAfterIdx).toBeGreaterThan(activeIdx);
    expect(activeCloseIdx).toBeGreaterThan(micAfterIdx);
    expect(gainIdx).toBeGreaterThan(activeCloseIdx);
    expect(tapIdx).toBeGreaterThan(gainIdx);
    expect(ios).not.toContain('.duckOthers');
    expect(ios).toContain('self.coordinator.markStarted(owner: owner)');
    expect(ios).toContain('guard warmupRemaining == 0');
    expect(ios).toContain('self.settleStartingCall()');
    expect(ios).toContain('startingCall = nil');
    // ARC safety & start/stop race guards for raw PCM capture: never capture CAPPluginCall weakly
    expect(ios).not.toMatch(/\[\s*weak\s+call\b|,\s*weak\s+call\b/);
    expect(ios).toContain('final class RawPcmStartController<Call: AnyObject>');
    expect(ios).toContain('enum RawPcmCaptureLifecyclePolicy');
    expect(ios).toContain('private var activeRawPcmTapOwner: UInt64?');
    expect(ios).toContain('startController.isExpected(token: startToken)');
    expect(ios).toContain('startController.takePendingIfCurrent(token: startToken)');
    expect(ios).toContain('rawPcmStartController.invalidateAndTakePending()');
    expect(ios).toContain('self.finishRawPcmStartErrorOnMain(');
    const startRawPcmBody = ios.slice(
      ios.indexOf('func startRawPcmCapture('),
      ios.indexOf('func stopRawPcmCapture('),
    );
    const mainResolveStartIdx = startRawPcmBody.indexOf('if let settled = startController.takePendingIfCurrent(token: startToken)');
    expect(mainResolveStartIdx).toBeGreaterThan(-1);
    const mainResolveBlock = startRawPcmBody.slice(mainResolveStartIdx, mainResolveStartIdx + 240);
    expect(mainResolveBlock).not.toContain('self.audioQueue.async');
    expect(mainResolveBlock).not.toContain('self.stopCaptureAudioOnAudioQueue');
    const cancelWatchdogBody = ios.slice(
      ios.indexOf('private func cancelWarmupWatchdog()'),
      ios.indexOf('private func settleStartingCall('),
    );
    expect(cancelWatchdogBody).not.toContain('rawPcm');
    expect(ios).not.toContain('if self.engine?.isRunning == true { call.resolve(); return }');
    expect(ios).toContain('self.endCapture(nil, deactivateSession: false)');
    expect(ios).toContain('.AVAudioEngineConfigurationChange');
    expect(ios).toContain('AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity)');
    expect(ios).not.toContain('AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)');
    expect(ios).toContain('AVAudioFrameCount(max(512, Int(fmt.sampleRate / 40)))');
    expect(ios).toContain('eng.inputNode.installTap(onBus: 0, bufferSize: tapFrames, format: fmt)');
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

    // System TTS plugin contract checks (iOS AVSpeechSynthesizer + Android TextToSpeech)
    for (const methodName of ['speak', 'stopSpeaking', 'isSpeaking', 'openTtsSettings']) {
      expect(ios).toContain(`CAPPluginMethod(name: "${methodName}", returnType: CAPPluginReturnPromise)`);
      expect(android).toContain(`public void ${methodName}(PluginCall call)`);
    }
    expect(ios).toContain('CAPPluginMethod(name: "getTtsVoiceQuality", returnType: CAPPluginReturnPromise)');
    expect(ios).toContain('enum TtsVoiceSelector');
    expect(ios).toContain('"voiceName": voice.name');
    expect(ios).toContain('"voiceIdentifier": voice.identifier');
    expect(ios).toContain('UIApplication.openSettingsURLString');
    expect(ios).not.toContain('App-Prefs:');
    expect(ios).not.toContain('prefs:root');
    expect(android).toContain('"com.android.settings.TTS_SETTINGS"');
    expect(android).toContain('TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA');
    expect(android).toContain('Settings.ACTION_SETTINGS');
    expect(ios).toContain('AVSpeechSynthesizerDelegate');
    expect(ios).toContain('AVSpeechUtteranceDefaultSpeechRate');
    expect(ios).toContain('utterance.postUtteranceDelay = 0.12');
    expect(ios).toContain('session.setCategory(.playback, mode: .default, options: [])');
    expect(ios).not.toContain('.duckOthers');
    expect(ios).toContain(`notifyListeners("${STREAMING_SPEECH_TTS_STATE_EVENT}"`);
    expect(ios).toContain(`"${STREAMING_SPEECH_TTS_STATUS.STARTED}"`);
    expect(ios).toContain(`"${STREAMING_SPEECH_TTS_STATUS.STOPPED}"`);
    expect(ios).toContain(`"${STREAMING_SPEECH_TTS_STATUS.ERROR}"`);
    expect(android).toContain('TextToSpeech.getMaxSpeechInputLength()');
    expect(android).toContain('Voice.QUALITY_VERY_HIGH');
    expect(android).toContain('engine.setVoice(');
    expect(android).toContain('AudioFocusRequest.Builder');
    expect(android).toContain(`notifyListeners("${STREAMING_SPEECH_TTS_STATE_EVENT}"`);
    const iosInfoPlist = await readFile(new URL('../../web/ios/App/App/Info.plist', import.meta.url), 'utf8');
    expect(iosInfoPlist).toContain('<string>remote-notification</string>');
    expect(iosInfoPlist).toContain('<string>audio</string>');
    expect(ios).toContain('enum TtsBackgroundLifecyclePolicy');
    expect(ios).toContain('allowWarmHold && audioSessionActive');
    const didEnterBackgroundBody = ios.slice(ios.indexOf('func didEnterBackground('), ios.indexOf('func engineConfigurationChanged('));
    expect(didEnterBackgroundBody).not.toContain('stopTtsPlaybackOnMain');
    const androidOnPauseBody = android.slice(android.indexOf('protected void handleOnPause()'), android.indexOf('protected void handleOnDestroy()'));
    expect(androidOnPauseBody).toContain('stopCapture(false);');
    expect(androidOnPauseBody).not.toContain('stopTtsInternal');

    expect(qwenAsr).toContain('modelId: String = "aufklarer/Qwen3-ASR-0.6B-MLX-4bit"');
    expect(qwenAsr).toContain('case .small: return .small');
    expect(qwenAsr).toContain('prefixTokens: [Int32] = []');
    expect(qwenAsr).toContain('suffix.append(contentsOf: prefixTokens)');

    // iOS offline model download policy: manual consent + Wi-Fi only default (cellular requires confirmation)
    const iosDownloader = await readFile(new URL('ios/Sources/StreamingSpeechPlugin/IosSpeechModelDownloader.swift', base), 'utf8');
    expect(iosDownloader).toContain('allowsCellularAccess = allowCellular');
    expect(iosDownloader).toContain('allowsExpensiveNetworkAccess = allowCellular');
    expect(iosDownloader).toContain('allowsConstrainedNetworkAccess = allowCellular');
    expect(iosDownloader).toContain('com.im.codes.qwen3asr-model-download.cellular');
    for (const methodName of ['getOfflineModelStatus', 'downloadOfflineModel', 'cancelOfflineModelDownload', 'deleteOfflineModel']) {
      expect(ios).toContain(`CAPPluginMethod(name: "${methodName}", returnType: CAPPluginReturnPromise)`);
    }
    expect(ios).toContain('notifyListeners("offlineModelStatus"');
    const loadBody = ios.slice(ios.indexOf('public override func load()'), ios.indexOf('private func warmUpRecognizerOnWorkerIfIdle('));
    expect(loadBody).toContain('verifyLocalModelsIfPresent');
    expect(loadBody).not.toContain('ensureBackgroundModelDownloadIfNeeded');
    const activeBody = ios.slice(ios.indexOf('private func didBecomeActive('), ios.indexOf('@objc public func stop('));
    expect(activeBody).toContain('verifyLocalModelsIfPresent');
    expect(activeBody).not.toContain('ensureBackgroundModelDownloadIfNeeded');
    const sharedStoreSrc = ios.slice(ios.indexOf('final class SharedSpeechRecognizerStore'));
    const storeEnsureBody = sharedStoreSrc.slice(sharedStoreSrc.indexOf('func ensureRecognizer() -> SpeechRecognizer?'), sharedStoreSrc.indexOf('func clearInferenceCaches()'));
    expect(storeEnsureBody).not.toContain('ensureDownloadedIfNeeded');

    // Apple-Hosted Background Assets integration (iOS 26+) + App Store Extension configuration
    expect(iosDownloader).toContain('@available(iOS 26');
    expect(iosDownloader).toContain('AssetPackManager');
    expect(iosDownloader).toContain('com.im.codes.speech.qwen3-asr-0.6b-mlx-4bit');
    expect(iosDownloader).toContain('collectVerifiedFingerprints');
    expect(sharedStoreSrc).toContain('downloader.verifiedModelRoot');
    expect(sharedStoreSrc).toContain('downloader.verifyAssetsOnDisk(at: root)');

    const appPlist = await readFile(new URL('../../web/ios/App/App/Info.plist', import.meta.url), 'utf8');
    expect(appPlist).toContain('<key>BAUsesAppleHosting</key>');
    expect(appPlist).toContain('<key>BAHasManagedAssetPacks</key>');
    expect(appPlist).toContain('<key>BAAppGroupID</key>');
    expect(appPlist).toContain('<string>group.com.im.codes</string>');

    const baExtSwift = await readFile(new URL('../../web/ios/App/BackgroundAssetsExtension/BackgroundAssetsDownloader.swift', import.meta.url), 'utf8');
    expect(baExtSwift).toContain('StoreDownloaderExtension');
    expect(baExtSwift).toContain('shouldDownload(_ assetPack: AssetPack)');
    expect(baExtSwift).toContain('return false');

    const baExtPlist = await readFile(new URL('../../web/ios/App/BackgroundAssetsExtension/Info.plist', import.meta.url), 'utf8');
    expect(baExtPlist).toContain('com.apple.background-asset-downloader-extension');

    const baExtEnt = await readFile(new URL('../../web/ios/App/BackgroundAssetsExtension/BackgroundAssetsExtension.entitlements', import.meta.url), 'utf8');
    expect(baExtEnt).toContain('group.com.im.codes');

    const pbxproj = await readFile(new URL('../../web/ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
    expect(pbxproj).toContain('BackgroundAssetsExtension.appex');
    expect(pbxproj).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.im.codes.BackgroundAssets;');
    expect(pbxproj).toContain('IPHONEOS_DEPLOYMENT_TARGET = 26.0;');
  });

  it('builds valid on-demand Apple-Hosted asset pack manifests, validates inputs, and invokes ba-package with expected args', async () => {
    const manifest = buildIosSpeechAssetPackManifest();
    expect(manifest).toEqual({
      assetPackID: IOS_SPEECH_ASSET_PACK_ID,
      downloadPolicy: { onDemand: {} },
      fileSelectors: [{ directory: 'ios-models' }],
      platforms: ['iOS'],
    });
    expect('userInfo' in manifest).toBe(false);

    const linuxExecRunner = vi.fn();
    expect(isBaPackageAvailable({ platform: 'linux', execRunner: linuxExecRunner })).toBe(false);
    expect(linuxExecRunner).not.toHaveBeenCalled();

    const oldXcodeRunner = vi.fn(() => {
      throw Object.assign(new Error('unable to find utility "ba-package"'), { status: 72 });
    });
    expect(isBaPackageAvailable({ platform: 'darwin', execRunner: oldXcodeRunner })).toBe(false);
    expect(oldXcodeRunner).toHaveBeenCalledWith('xcrun', ['--find', 'ba-package'], { stdio: 'ignore' });

    const xcode26Runner = vi.fn(() => '/Applications/Xcode.app/Contents/Developer/usr/bin/ba-package');
    expect(isBaPackageAvailable({ platform: 'darwin', execRunner: xcode26Runner })).toBe(true);

    await setup();
    const sourceDir = join(root, 'ios-models');
    await mkdir(sourceDir, { recursive: true });
    const outputPath = join(root, 'out', `${IOS_SPEECH_ASSET_PACK_ID}.aar`);
    const manifestPath = join(root, 'out', 'manifest.json');
    const mockExecRunner = vi.fn();

    expect(() =>
      packageIosSpeechAssetPack({ sourceDir, outputPath: join(root, 'out', 'invalid.zip'), execRunner: mockExecRunner }),
    ).toThrow(/\.aar/);
    expect(() =>
      packageIosSpeechAssetPack({ sourceDir: join(root, 'missing-models'), outputPath, execRunner: mockExecRunner }),
    ).toThrow(/not found/);
    expect(() =>
      packageIosSpeechAssetPack({ sourceDir, outputPath, execRunner: mockExecRunner }),
    ).toThrow(/Missing required iOS speech asset file/);
    expect(mockExecRunner).not.toHaveBeenCalled();

    for (const filename of IOS_SPEECH_ASSET_PACK_REQUIRED_FILES) {
      await writeFile(join(sourceDir, filename), filename === 'hotwords.txt' ? '' : `fixture:${filename}`);
    }

    const result = packageIosSpeechAssetPack({
      sourceDir,
      outputPath,
      manifestPath,
      quiet: true,
      execRunner: mockExecRunner,
    });
    expect(result.assetPackID).toBe(IOS_SPEECH_ASSET_PACK_ID);
    expect(result.manifest).toEqual(manifest);
    expect(result.manifestPath).toBe(manifestPath);
    expect(result.outputPath).toBe(outputPath);
    expect(result.sourceDir).toBe(sourceDir);
    expect(existsSync(manifestPath)).toBe(true);
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest);
    expect(mockExecRunner).toHaveBeenCalledTimes(1);
    expect(mockExecRunner).toHaveBeenCalledWith(
      'xcrun',
      ['ba-package', 'package', manifestPath, '--output-path', outputPath, '--quiet'],
      { cwd: dirname(sourceDir), stdio: 'pipe' },
    );

    // Omitted manifestPath uses a temp directory that is cleaned up even when execRunner fails.
    let capturedTempManifest = '';
    const failingRunner = vi.fn((_cmd: string, args: string[]) => {
      capturedTempManifest = args[2];
      expect(existsSync(capturedTempManifest)).toBe(true);
      throw new Error('simulated xcrun failure');
    });
    expect(() =>
      packageIosSpeechAssetPack({ sourceDir, outputPath, execRunner: failingRunner }),
    ).toThrow('simulated xcrun failure');
    expect(capturedTempManifest).not.toBe('');
    expect(existsSync(dirname(capturedTempManifest))).toBe(false);
  });

  it.runIf(isBaPackageAvailable())('packages .aar archives via real xcrun ba-package on Xcode 26+', async () => {
    await setup();
    const sourceDir = join(root, 'ios-models');
    await mkdir(sourceDir, { recursive: true });
    for (const filename of IOS_SPEECH_ASSET_PACK_REQUIRED_FILES) {
      await writeFile(join(sourceDir, filename), filename === 'hotwords.txt' ? '' : `fixture:${filename}`);
    }
    const outputPath = join(root, 'out', `${IOS_SPEECH_ASSET_PACK_ID}.aar`);
    const manifestPath = join(root, 'out', 'manifest.json');
    const result = packageIosSpeechAssetPack({ sourceDir, outputPath, manifestPath, quiet: true });
    expect(result.outputPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
  });
  it('compiles and executes the production Android plugin through cold/warm/stop/segmentation/overflow/destroy', async () => {
    await setup(); const srcDir = join(root, 'src'), classesDir = join(root, 'classes'); await mkdir(classesDir, { recursive: true });
    const minimalVocabJson = JSON.stringify({
      '<|endoftext|>': 0, '<|im_start|>': 1, '<|im_end|>': 2, '<|audio_start|>': 3, '<|audio_end|>': 4, '<|audio_pad|>': 5, '<asr_text>': 6,
      'language': 7, '\u0120English': 8, 'Hello': 9, '.': 10, '\u0120': 11, '\u010a': 12,
      ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`word${String(i).padStart(3, '0')}`, 13 + i])),
      ...Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((ch, idx) => [ch, 29 + idx])),
    });
    const minimalConfigJson = JSON.stringify({
      eos_token: '<|im_end|>',
      pad_token: '<|endoftext|>',
      added_tokens_decoder: {
        '0': { content: '<|endoftext|>', special: true },
        '1': { content: '<|im_start|>', special: true },
        '2': { content: '<|im_end|>', special: true },
        '3': { content: '<|audio_start|>', special: true },
        '4': { content: '<|audio_end|>', special: true },
        '5': { content: '<|audio_pad|>', special: true },
        '6': { content: '<asr_text>', special: true },
      },
    });
    const files: Record<string, string> = {
      'android/Manifest.java': `package android; public class Manifest { public static class permission { public static final String RECORD_AUDIO="mic"; } }`,
      'android/view/HapticFeedbackConstants.java': `package android.view; public class HapticFeedbackConstants { public static final int LONG_PRESS=0, VIRTUAL_KEY=1, FLAG_IGNORE_VIEW_SETTING=1, CLOCK_TICK=4, CONFIRM=16; }`,
      'android/view/View.java': `package android.view;
public class View {
  public static volatile int hapticCalls=0, lastFeedback=-1, lastFlags=-1;
  public static void reset(){ hapticCalls=0; lastFeedback=-1; lastFlags=-1; }
  public boolean post(Runnable action){ if(action!=null) action.run(); return true; }
  public boolean performHapticFeedback(int feedbackConstant, int flags){
    hapticCalls++; lastFeedback=feedbackConstant; lastFlags=flags; return true;
  }
}`,
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
      'android/media/AudioDeviceInfo.java': `package android.media;
public class AudioDeviceInfo {
  public static final int TYPE_BUILTIN_MIC = 15, TYPE_BLUETOOTH_SCO = 7, TYPE_WIRED_HEADSET = 3, TYPE_BLE_HEADSET = 26;
  private final int type;
  private final String productName;
  public AudioDeviceInfo(int type, String productName){ this.type=type; this.productName=productName; }
  public int getType(){ return type; }
  public CharSequence getProductName(){ return productName; }
}`,
      'android/util/Base64.java': `package android.util;
public class Base64 {
  public static final int DEFAULT = 0;
  public static final int NO_WRAP = 2;
  public static String encodeToString(byte[] input, int flags){
    return java.util.Base64.getEncoder().encodeToString(input);
  }
  public static byte[] decode(String input, int flags){
    return java.util.Base64.getMimeDecoder().decode(input);
  }
}`,
      'android/media/AudioRecord.java': `package android.media;
public class AudioRecord {
  public static final int STATE_INITIALIZED=1, STATE_UNINITIALIZED=0, RECORDSTATE_RECORDING=3, READ_BLOCKING=0;
  public static volatile AudioRecord latest;
  public static volatile AudioDeviceInfo lastPreferredDevice = null;
  public static volatile int chunksPerStart=1;
  public static volatile int silentChunksPerStart=0;
  public static volatile boolean labelledWords=false;
  public static volatile boolean failVoiceRecognitionSource=false;
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
    state=(failVoiceRecognitionSource && source==MediaRecorder.AudioSource.VOICE_RECOGNITION) ? STATE_UNINITIALIZED : STATE_INITIALIZED;
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
  public boolean setPreferredDevice(AudioDeviceInfo device){ lastPreferredDevice = device; return true; }
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
        int id = deliveredVoiced / 30;
        int chunkInWord = deliveredVoiced % 30;
        if (chunkInWord >= 27) {
          java.util.Arrays.fill(out, off, off + n, (short) 0);
        } else {
          double freq = 400.0 + id * 400.0;
          long baseSample = (long) deliveredVoiced * n;
          for (int i = 0; i < n; i++) {
            out[off + i] = (short) Math.round(8000.0 * Math.sin(2.0 * Math.PI * freq * (baseSample + i) / 16000.0));
          }
        }
      } else {
        long baseSample = (long) deliveredVoiced * n;
        for (int i = 0; i < n; i++) {
          out[off + i] = (short) Math.round(4000.0 * Math.sin(2.0 * Math.PI * 440.0 * (baseSample + i) / 16000.0));
        }
      }
      deliveredVoiced++;
    } else {
      silentRemaining--;
      java.util.Arrays.fill(out, off, off + n, (short) 0);
    }
    delivered.countDown(); return n;
  }
}`,
      'androidx/lifecycle/Lifecycle.java': `package androidx.lifecycle; public class Lifecycle { public enum State { DESTROYED, INITIALIZED, CREATED, STARTED, RESUMED; public boolean isAtLeast(State other){ return this.compareTo(other) >= 0; } } public static volatile State currentState = State.RESUMED; public State getCurrentState(){ return currentState; } }`,
      'android/net/Uri.java': `package android.net;
public class Uri {
  private final String value;
  private Uri(String value){ this.value = value; }
  public static Uri fromParts(String scheme, String ssp, String fragment){
    return new Uri((scheme != null ? scheme : "") + ":" + (ssp != null ? ssp : "") + (fragment != null ? "#" + fragment : ""));
  }
  @Override public String toString(){ return value; }
}`,
      'com/getcapacitor/JSArray.java': `package com.getcapacitor; public class JSArray extends java.util.ArrayList<Object>{ public JSArray put(Object x){ add(x); return this; } }`,
      'com/getcapacitor/JSObject.java': `package com.getcapacitor; public class JSObject extends java.util.TreeMap<String,Object>{}`,
      'com/getcapacitor/PermissionState.java': `package com.getcapacitor; public enum PermissionState{ GRANTED }`,
      'com/getcapacitor/PluginCall.java': `package com.getcapacitor; public class PluginCall { public final java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1); public String error,value; private final java.util.Map<String,Object> args=new java.util.HashMap<>(); public PluginCall setArg(String k,Object v){ args.put(k,v); return this; } public String getString(String key){ Object v=args.get(key); return v instanceof String ? (String)v : null; } public Double getDouble(String key){ Object v=args.get(key); return v instanceof Number ? ((Number)v).doubleValue() : null; } public void resolve(){ done.countDown(); } public void resolve(JSObject o){ value=o.toString(); resolve(); } public void reject(String e){ error=e; done.countDown(); } public void reject(String e,Exception x){ reject(e); } }`,
      'com/getcapacitor/Bridge.java': `package com.getcapacitor;
public class Bridge {
  private final android.view.View webView;
  public Bridge(android.view.View webView){ this.webView=webView; }
  public android.view.View getWebView(){ return webView; }
}`,
      'android/content/res/AssetManager.java': `package android.content.res;
public class AssetManager {
  public java.io.InputStream open(String path) throws java.io.IOException { throw new java.io.IOException("unimplemented"); }
}`,
      'android/os/Build.java': `package android.os; public class Build { public static class VERSION { public static int SDK_INT = 28; } public static class VERSION_CODES { public static final int LOLLIPOP = 21; public static final int M = 23; public static final int O = 26; public static final int R = 30; } }`,
      'android/os/Bundle.java': `package android.os; public class Bundle {}`,
      'android/os/Looper.java': `package android.os; public class Looper { private static final Looper MAIN = new Looper(); public static Looper getMainLooper(){ return MAIN; } }`,
      'android/os/Handler.java': `package android.os; public class Handler { public Handler(Looper l){} public boolean postDelayed(Runnable r, long delay){ return true; } public void removeCallbacks(Runnable r){} public void removeCallbacksAndMessages(Object token){} }`,
      'android/media/AudioAttributes.java': `package android.media;
public class AudioAttributes {
  public static final int USAGE_MEDIA = 1, CONTENT_TYPE_SPEECH = 1;
  public static class Builder {
    public Builder setUsage(int u){ return this; }
    public Builder setContentType(int c){ return this; }
    public AudioAttributes build(){ return new AudioAttributes(); }
  }
}`,
      'android/media/AudioFocusRequest.java': `package android.media;
public class AudioFocusRequest {
  public static class Builder {
    public Builder(int gain){}
    public Builder setAudioAttributes(AudioAttributes attrs){ return this; }
    public Builder setOnAudioFocusChangeListener(AudioManager.OnAudioFocusChangeListener l){ AudioManager.lastFocusListener = l; return this; }
    public AudioFocusRequest build(){ return new AudioFocusRequest(); }
  }
}`,
      'android/media/AudioManager.java': `package android.media;
public class AudioManager {
  public static final int AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK = 3, AUDIOFOCUS_REQUEST_GRANTED = 1, STREAM_MUSIC = 3, AUDIOFOCUS_LOSS = -1, AUDIOFOCUS_LOSS_TRANENT_UNUSED = 0, AUDIOFOCUS_LOSS_TRANSIENT = -2, GET_DEVICES_INPUTS = 1;
  public static volatile int focusRequests = 0, focusAbandons = 0;
  public static volatile OnAudioFocusChangeListener lastFocusListener = null;
  public static volatile AudioDeviceInfo[] inputDevices = new AudioDeviceInfo[]{
    new AudioDeviceInfo(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, "AirPods Pro"),
    new AudioDeviceInfo(AudioDeviceInfo.TYPE_BUILTIN_MIC, "Phone Mic"),
    new AudioDeviceInfo(AudioDeviceInfo.TYPE_WIRED_HEADSET, "USB Headset")
  };
  public static void reset(){ focusRequests = 0; focusAbandons = 0; lastFocusListener = null; }
  public interface OnAudioFocusChangeListener { void onAudioFocusChange(int focusChange); }
  public AudioDeviceInfo[] getDevices(int flags){ return (flags & GET_DEVICES_INPUTS) != 0 ? inputDevices : new AudioDeviceInfo[0]; }
  public int requestAudioFocus(AudioFocusRequest req){ focusRequests++; return AUDIOFOCUS_REQUEST_GRANTED; }
  public int requestAudioFocus(OnAudioFocusChangeListener l, int stream, int hint){ lastFocusListener = l; focusRequests++; return AUDIOFOCUS_REQUEST_GRANTED; }
  public int abandonAudioFocusRequest(AudioFocusRequest req){ focusAbandons++; return AUDIOFOCUS_REQUEST_GRANTED; }
  public int abandonAudioFocus(OnAudioFocusChangeListener l){ focusAbandons++; return AUDIOFOCUS_REQUEST_GRANTED; }
}`,
      'android/speech/tts/UtteranceProgressListener.java': `package android.speech.tts;
public abstract class UtteranceProgressListener {
  public abstract void onStart(String utteranceId);
  public abstract void onDone(String utteranceId);
  public abstract void onError(String utteranceId);
  public void onError(String utteranceId, int errorCode){ onError(utteranceId); }
  public void onStop(String utteranceId, boolean interrupted){}
}`,
      'android/speech/tts/Voice.java': `package android.speech.tts;
import java.util.*;
public class Voice {
  public static final int QUALITY_VERY_LOW = 100, QUALITY_LOW = 200, QUALITY_NORMAL = 300, QUALITY_HIGH = 400, QUALITY_VERY_HIGH = 500;
  private final String name;
  private final Locale locale;
  private final int quality;
  private final boolean networkRequired;
  public Voice(String name, Locale locale, int quality, boolean networkRequired){
    this.name = name; this.locale = locale; this.quality = quality; this.networkRequired = networkRequired;
  }
  public String getName(){ return name; }
  public Locale getLocale(){ return locale; }
  public int getQuality(){ return quality; }
  public boolean isNetworkConnectionRequired(){ return networkRequired; }
}`,
      'android/speech/tts/TextToSpeech.java': `package android.speech.tts;
import java.util.*;
public class TextToSpeech {
  public static class Engine {
    public static final String ACTION_INSTALL_TTS_DATA = "android.speech.tts.engine.INSTALL_TTS_DATA";
  }
  public static final int SUCCESS = 0, ERROR = -1, QUEUE_FLUSH = 0, QUEUE_ADD = 1, LANG_AVAILABLE = 0;
  public static volatile int nextInitStatus = SUCCESS;
  public static volatile int maxInputLen = 4000;
  public static volatile boolean failSpeakCall = false;
  public static volatile boolean returnNullVoices = false, throwOnGetVoices = false;
  public static final Set<Voice> nextVoices = Collections.synchronizedSet(new LinkedHashSet<>());
  public static final List<String> spokenTexts = Collections.synchronizedList(new ArrayList<>());
  public static final List<Integer> queueModes = Collections.synchronizedList(new ArrayList<>());
  public static final List<String> utteranceIds = Collections.synchronizedList(new ArrayList<>());
  public static volatile float lastRate = 1.0f;
  public static volatile Locale lastLocale = null;
  public static volatile Voice lastVoice = null;
  public static volatile int stopCalls = 0, shutdownCalls = 0;
  public static volatile TextToSpeech latest;
  private UtteranceProgressListener listener;
  private volatile boolean speaking = false;
  public static void reset(){
    nextInitStatus = SUCCESS; maxInputLen = 4000; failSpeakCall = false;
    returnNullVoices = false; throwOnGetVoices = false; nextVoices.clear();
    spokenTexts.clear(); queueModes.clear(); utteranceIds.clear();
    lastRate = 1.0f; lastLocale = null; lastVoice = null; stopCalls = 0; shutdownCalls = 0; latest = null;
  }
  public interface OnInitListener { void onInit(int status); }
  public TextToSpeech(android.content.Context ctx, OnInitListener l){
    latest = this;
    if (l != null) l.onInit(nextInitStatus);
  }
  public static int getMaxSpeechInputLength(){ return maxInputLen; }
  public void setAudioAttributes(android.media.AudioAttributes a){}
  public void setOnUtteranceProgressListener(UtteranceProgressListener l){ this.listener = l; }
  public int isLanguageAvailable(Locale loc){ return LANG_AVAILABLE; }
  public int setLanguage(Locale loc){ lastLocale = loc; return LANG_AVAILABLE; }
  public Set<Voice> getVoices(){ if (throwOnGetVoices) throw new RuntimeException("getVoices unavailable"); return returnNullVoices ? null : nextVoices; }
  public int setVoice(Voice voice){ lastVoice = voice; return SUCCESS; }
  public int setSpeechRate(float r){ lastRate = r; return SUCCESS; }
  public int speak(CharSequence text, int queueMode, android.os.Bundle params, String utteranceId){
    if (failSpeakCall) return ERROR;
    spokenTexts.add(text.toString());
    queueModes.add(queueMode);
    utteranceIds.add(utteranceId);
    speaking = true;
    return SUCCESS;
  }
  public void emitStart(String id){ if (listener != null) listener.onStart(id); }
  public void emitDone(String id){ speaking = false; if (listener != null) listener.onDone(id); }
  public void emitStop(String id, boolean interrupted){ speaking = false; if (listener != null) listener.onStop(id, interrupted); }
  public boolean isSpeaking(){ return speaking; }
  public int stop(){ stopCalls++; speaking = false; return SUCCESS; }
  public void shutdown(){ shutdownCalls++; speaking = false; }
}`,
      'android/content/ActivityNotFoundException.java': `package android.content;
public class ActivityNotFoundException extends RuntimeException {
  public ActivityNotFoundException(String message){ super(message); }
}`,
      'android/content/Intent.java': `package android.content;
public class Intent {
  public static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000;
  private final String action;
  private final android.net.Uri data;
  private int flags = 0;
  public Intent(String action){ this(action, null); }
  public Intent(String action, android.net.Uri data){ this.action = action; this.data = data; }
  public String getAction(){ return action; }
  public android.net.Uri getData(){ return data; }
  public Intent addFlags(int flag){ this.flags |= flag; return this; }
  public int getFlags(){ return flags; }
}`,
      'android/provider/Settings.java': `package android.provider;
public class Settings {
  public static final String ACTION_SETTINGS = "android.settings.SETTINGS";
  public static final String ACTION_APPLICATION_DETAILS_SETTINGS = "android.settings.APPLICATION_DETAILS_SETTINGS";
}`,
      'android/content/Context.java': `package android.content;
public class Context {
  public static final String AUDIO_SERVICE = "audio";
  private static final android.media.AudioManager AUDIO_MANAGER = new android.media.AudioManager();
  public static final java.util.List<String> startedActions = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
  public static final java.util.List<Integer> startedFlags = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
  public static final java.util.Set<String> failingActions = java.util.Collections.synchronizedSet(new java.util.HashSet<>());
  public static volatile boolean throwSecurityOnInstallTts = false;
  public static void resetIntents(){ startedActions.clear(); startedFlags.clear(); failingActions.clear(); throwSecurityOnInstallTts = false; }
  public Context getApplicationContext(){ return this; }
  public String getPackageName(){ return "com.imcodes.test"; }
  public Object getSystemService(String name){ return AUDIO_SERVICE.equals(name) ? AUDIO_MANAGER : null; }
  public android.content.res.AssetManager getAssets(){ return new android.content.res.AssetManager(); }
  public java.io.File getNoBackupFilesDir(){ return new java.io.File(System.getProperty("java.io.tmpdir"),"speech-private"); }
  public void startActivity(Intent intent){
    String action = intent.getAction();
    startedActions.add(action);
    startedFlags.add(intent.getFlags());
    if (throwSecurityOnInstallTts && "android.speech.tts.engine.INSTALL_TTS_DATA".equals(action)) {
      throw new SecurityException("blocked install tts intent");
    }
    if (failingActions.contains(action)) {
      throw new ActivityNotFoundException("missing activity for " + action);
    }
  }
}`,
      'com/getcapacitor/Plugin.java': `package com.getcapacitor;
public class Plugin {
  public final java.util.List<String> events=java.util.Collections.synchronizedList(new java.util.ArrayList<>());
  private Bridge bridge=new Bridge(new android.view.View());
  public void load(){}
  protected void handleOnPause(){}
  protected void handleOnDestroy(){}
  public Bridge getBridge(){ return bridge; }
  public void setBridge(Bridge bridge){ this.bridge=bridge; }
  public void notifyListeners(String key,JSObject value){ events.add(key+":"+value); }
  public PermissionState getPermissionState(String p){ return PermissionState.GRANTED; }
  public void requestPermissionForAlias(String a,PluginCall c,String callback){}
  public Context getContext(){ return new Context(); }
  public Activity getActivity(){ return new Activity(); }
  public static class Context extends android.content.Context { @Override public Assets getAssets(){ return new Assets(); } }
  public static class Assets extends android.content.res.AssetManager {
    private static final String VOCAB_JSON = ${JSON.stringify(minimalVocabJson)};
    private static final String CONFIG_JSON = ${JSON.stringify(minimalConfigJson)};
    @Override
    public java.io.InputStream open(String path) throws java.io.IOException {
      byte[] bytes;
      if (path.equals("hotwords.txt")) bytes = new byte[0];
      else if (path.equals("tokenizer/vocab.json")) bytes = VOCAB_JSON.getBytes(java.nio.charset.StandardCharsets.UTF_8);
      else if (path.equals("tokenizer/merges.txt")) bytes = "#version: 0.2\\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
      else if (path.equals("tokenizer/tokenizer_config.json")) bytes = CONFIG_JSON.getBytes(java.nio.charset.StandardCharsets.UTF_8);
      else bytes = new byte[]{1};
      return new java.io.ByteArrayInputStream(bytes);
    }
  }
  public static class Activity { public androidx.lifecycle.Lifecycle getLifecycle(){ return new androidx.lifecycle.Lifecycle(); } }
}`,
      'com/getcapacitor/PluginMethod.java': `package com.getcapacitor; public @interface PluginMethod{}`,
      'com/getcapacitor/annotation/CapacitorPlugin.java': `package com.getcapacitor.annotation; public @interface CapacitorPlugin{ String name(); Permission[] permissions(); }`,
      'com/getcapacitor/annotation/Permission.java': `package com.getcapacitor.annotation; public @interface Permission{ String alias(); String[] strings(); }`,
      'com/getcapacitor/annotation/PermissionCallback.java': `package com.getcapacitor.annotation; public @interface PermissionCallback{}`,
      'ai/onnxruntime/OrtException.java': `package ai.onnxruntime; public class OrtException extends Exception { public OrtException(String msg){ super(msg); } }`,
      'ai/onnxruntime/OrtLoggingLevel.java': `package ai.onnxruntime; public enum OrtLoggingLevel { ORT_LOGGING_LEVEL_ERROR }`,
      'ai/onnxruntime/OnnxJavaType.java': `package ai.onnxruntime; public enum OnnxJavaType { FLOAT, FLOAT16, INT16, INT64, BOOL, UINT8 }`,
      'ai/onnxruntime/OnnxValue.java': `package ai.onnxruntime; public interface OnnxValue extends AutoCloseable { @Override default void close() {} }`,
      'ai/onnxruntime/TensorInfo.java': `package ai.onnxruntime;
public class TensorInfo {
  public final OnnxJavaType type;
  public final long[] shape;
  public TensorInfo(OnnxJavaType type, long[] shape){ this.type=type; this.shape=shape; }
  public long[] getShape(){ return shape; }
  public long getNumElements(){ long p=1; for(long s:shape) p*=s; return p; }
}`,
      'ai/onnxruntime/NodeInfo.java': `package ai.onnxruntime;
public class NodeInfo {
  private final TensorInfo info;
  public NodeInfo(TensorInfo info){ this.info=info; }
  public TensorInfo getInfo(){ return info; }
}`,
      'ai/onnxruntime/OnnxTensor.java': `package ai.onnxruntime;
import java.nio.*;
import java.util.concurrent.atomic.AtomicInteger;
public class OnnxTensor implements OnnxValue {
  public static final AtomicInteger created = new AtomicInteger(0);
  public static final AtomicInteger released = new AtomicInteger(0);
  private final TensorInfo info;
  private final ByteBuffer raw;
  private boolean closed = false;
  private OnnxTensor(TensorInfo info, ByteBuffer raw){ this.info=info; this.raw=raw; created.incrementAndGet(); }
  public static OnnxTensor createTensor(OrtEnvironment env, FloatBuffer data, long[] shape) throws OrtException {
    FloatBuffer dup = data.duplicate();
    ByteBuffer bb = ByteBuffer.allocateDirect(dup.remaining()*4).order(ByteOrder.nativeOrder());
    bb.asFloatBuffer().put(dup);
    return new OnnxTensor(new TensorInfo(OnnxJavaType.FLOAT, shape), bb);
  }
  public static OnnxTensor createTensor(OrtEnvironment env, LongBuffer data, long[] shape) throws OrtException {
    LongBuffer dup = data.duplicate();
    ByteBuffer bb = ByteBuffer.allocateDirect(dup.remaining()*8).order(ByteOrder.nativeOrder());
    bb.asLongBuffer().put(dup);
    return new OnnxTensor(new TensorInfo(OnnxJavaType.INT64, shape), bb);
  }
  public static OnnxTensor createTensor(OrtEnvironment env, ByteBuffer data, long[] shape, OnnxJavaType type) throws OrtException {
    ByteBuffer dup = data.duplicate().order(ByteOrder.nativeOrder());
    return new OnnxTensor(new TensorInfo(type, shape), dup);
  }
  public static OnnxTensor createTensor(OrtEnvironment env, boolean[][] data) throws OrtException {
    int rows = data.length, cols = rows > 0 ? data[0].length : 0;
    ByteBuffer bb = ByteBuffer.allocateDirect(rows * cols).order(ByteOrder.nativeOrder());
    for (boolean[] row : data) for (boolean v : row) bb.put((byte)(v ? 1 : 0));
    bb.clear();
    return new OnnxTensor(new TensorInfo(OnnxJavaType.BOOL, new long[]{rows, cols}), bb);
  }
  public TensorInfo getInfo(){ return info; }
  public ByteBuffer getByteBuffer(){ ByteBuffer dup = raw.duplicate().order(ByteOrder.nativeOrder()); dup.rewind(); return dup; }
  public FloatBuffer getFloatBuffer(){ return getByteBuffer().asFloatBuffer(); }
  public ShortBuffer getShortBuffer(){ return getByteBuffer().asShortBuffer(); }
  public LongBuffer getLongBuffer(){ return getByteBuffer().asLongBuffer(); }
  @Override public synchronized void close(){ if(!closed){ closed=true; released.incrementAndGet(); } }
}`,
      'ai/onnxruntime/OrtSession.java': `package ai.onnxruntime;
import java.nio.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
public class OrtSession implements AutoCloseable {
  public enum Role { CONV, ENCODER, DECODER }
  public static volatile CountDownLatch initEntered = null;
  public static volatile CountDownLatch initRelease = null;
  public static volatile CountDownLatch decoded = new CountDownLatch(1);
  public static volatile boolean holdDecode = false;
  public static volatile CountDownLatch decoding = new CountDownLatch(1);
  public static volatile CountDownLatch decodeRelease = new CountDownLatch(1);
  public static volatile int lastConvMelFrames = 0;
  public static volatile int maxConvMelFrames = 0;
  public static volatile int maxDecoderAudioTokens = 0;
  public static final List<Integer> convMelFrames = Collections.synchronizedList(new ArrayList<>());
  public static final AtomicInteger closes = new AtomicInteger(0);
  public static final AtomicInteger observedNonEmptyPrefixes = new AtomicInteger(0);

  public static class SessionOptions implements AutoCloseable {
    public enum OptLevel { ALL_OPT }
    public OptLevel optLevel;
    public int intraThreads;
    public final Map<String, String> configEntries = new LinkedHashMap<>();
    public void setOptimizationLevel(OptLevel lvl){ this.optLevel = lvl; }
    public void setIntraOpNumThreads(int n){ int expected = Math.min(4, Math.max(2, Runtime.getRuntime().availableProcessors() / 2)); if (n != expected) throw new AssertionError("expected " + expected + " threads, got "+n); this.intraThreads = n; }
    public void addConfigEntry(String key, String value){ configEntries.put(key, value); }
    @Override public void close(){}
  }

  public static class Result implements AutoCloseable {
    public static final AtomicInteger created = new AtomicInteger(0);
    public static final AtomicInteger released = new AtomicInteger(0);
    private final Map<String, OnnxValue> map;
    private boolean closed = false;
    public Result(Map<String, OnnxValue> map){ this.map = map; created.incrementAndGet(); }
    public Optional<OnnxValue> get(String name){ return Optional.ofNullable(map.get(name)); }
    @Override public synchronized void close(){
      if (!closed) {
        closed = true;
        released.incrementAndGet();
        for (OnnxValue v : map.values()) { try { v.close(); } catch (Exception ignored) {} }
      }
    }
  }

  private final Role role;
  private final OnnxJavaType dtype;
  private int[] plannedTokens = new int[0];
  private int cursor = 0;
  private boolean closed = false;

  public OrtSession(Role role, OnnxJavaType dtype){ this.role = role; this.dtype = dtype; }

  public Set<String> getInputNames(){
    return role == Role.CONV ? Collections.singleton("input_features") : Collections.emptySet();
  }
  public Set<String> getOutputNames(){
    if (role == Role.CONV) return Collections.singleton("conv_output");
    if (role == Role.ENCODER) return Collections.singleton("audio_features");
    Set<String> outs = new LinkedHashSet<>();
    outs.add("logits");
    for (int i = 0; i < 2; i++) { outs.add("key_delta_" + i); outs.add("value_delta_" + i); }
    return outs;
  }
  public Map<String, NodeInfo> getInputInfo(){
    Map<String, NodeInfo> info = new LinkedHashMap<>();
    if (role == Role.ENCODER) {
      info.put("conv_output", new NodeInfo(new TensorInfo(OnnxJavaType.FLOAT, new long[]{1, -1, 8})));
      info.put("feature_attention_mask", new NodeInfo(new TensorInfo(OnnxJavaType.BOOL, new long[]{1, -1})));
    } else if (role == Role.DECODER) {
      info.put("audio_features", new NodeInfo(new TensorInfo(dtype, new long[]{1, -1, 8})));
      for (int i = 0; i < 2; i++) {
        info.put("cache_key_" + i, new NodeInfo(new TensorInfo(dtype, new long[]{1, 768, 2, 4})));
        info.put("cache_value_" + i, new NodeInfo(new TensorInfo(dtype, new long[]{1, 768, 2, 4})));
      }
    }
    return info;
  }

  private static double hzToMel(double hz){ return hz < 1000.0 ? 3.0*hz/200.0 : 15.0 + Math.log(hz/1000.0)*(27.0/Math.log(6.4)); }
  private static final double[] EXPECTED_WORD_BINS = new double[14];
  static {
    double melMax = hzToMel(8000.0);
    for (int id = 0; id < 14; id++) EXPECTED_WORD_BINS[id] = (hzToMel(400.0 + id * 400.0) / melMax) * 129.0 - 1.0;
  }
  private static float extractChunkTokenTag(float[] mel, int fStart, int fEnd){
    int[] votes = new int[14];
    int activeFrames = 0;
    for (int f = fStart; f < fEnd; f++) {
      int off = f * 128;
      int bestBin = 0;
      float bestVal = Float.NEGATIVE_INFINITY, minVal = Float.POSITIVE_INFINITY;
      for (int m = 0; m < 128; m++) {
        float v = mel[off + m];
        if (v > bestVal) { bestVal = v; bestBin = m; }
        if (v < minVal) minVal = v;
      }
      if (bestVal - minVal < 0.25f) continue;
      int bestId = -1; double bestDist = Double.POSITIVE_INFINITY;
      for (int id = 0; id < 14; id++) {
        double d = Math.abs(bestBin - EXPECTED_WORD_BINS[id]);
        if (d < bestDist) { bestDist = d; bestId = id; }
      }
      if (bestDist <= 3.0) { votes[bestId]++; activeFrames++; }
    }
    if (activeFrames == 0) return 0.0f;
    int bestId = -1, bestVotes = 0;
    for (int id = 0; id < 14; id++) {
      if (votes[id] > bestVotes) { bestVotes = votes[id]; bestId = id; }
    }
    return bestId >= 0 ? (100.0f + bestId) : 0.0f;
  }

  private static short f2h(float val){
    int bits = Float.floatToRawIntBits(val);
    int sign = (bits >>> 16) & 0x8000;
    int exp = ((bits >>> 23) & 0xFF) - 127 + 15;
    int mant = bits & 0x007FFFFF;
    if (exp <= 0) return (short) sign;
    if (exp >= 31) return (short) (sign | 0x7C00);
    return (short) (sign | (exp << 10) | (mant >>> 13));
  }
  private static float h2f(short halfBits){
    int h = halfBits & 0xFFFF;
    int sign = (h & 0x8000) << 16;
    int exp = (h & 0x7C00) >>> 10;
    int mant = h & 0x03FF;
    if (exp == 0) return mant == 0 ? Float.intBitsToFloat(sign) : 0.0f;
    return Float.intBitsToFloat(sign | ((exp + 112) << 23) | (mant << 13));
  }

  public Result run(Map<String, OnnxTensor> inputs) throws OrtException {
    if (role == Role.CONV) {
      OnnxTensor in = inputs.get("input_features");
      long[] shape = in.getInfo().getShape();
      int frames = (int) shape[1];
      lastConvMelFrames = frames;
      maxConvMelFrames = Math.max(maxConvMelFrames, frames);
      convMelFrames.add(frames);
      FloatBuffer fb = in.getFloatBuffer();
      float[] mel = new float[fb.remaining()];
      fb.get(mel);
      int outFrames = Math.max(1, (frames / 100) * 13 + ((frames % 100) == 0 ? 0 : (((frames % 100) - 1) / 8 + 1)));
      float[] convOut = new float[outFrames * 8];
      if (android.media.AudioRecord.labelledWords) {
        for (int t = 0; t < outFrames; t++) {
          int c = t / 13;
          int tInChunk = t % 13;
          int chunkStart = c * 100;
          int chunkMelLen = Math.min(100, Math.max(1, frames - chunkStart));
          int chunkTokLen = Math.min(13, Math.max(1, outFrames - c * 13));
          int f0 = Math.min(frames - 1, chunkStart + (tInChunk * chunkMelLen) / chunkTokLen);
          int f1 = Math.max(f0 + 1, Math.min(frames, chunkStart + ((tInChunk + 1) * chunkMelLen + chunkTokLen - 1) / chunkTokLen));
          convOut[t * 8] = extractChunkTokenTag(mel, f0, f1);
        }
      } else {
        for (int t = 0; t < outFrames; t++) convOut[t * 8] = -1.0f;
      }
      OnnxTensor outT = OnnxTensor.createTensor(OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR, ""), FloatBuffer.wrap(convOut), new long[]{1, outFrames, 8});
      return new Result(Collections.singletonMap("conv_output", outT));
    }
    if (role == Role.ENCODER) {
      OnnxTensor conv = inputs.get("conv_output");
      long[] cShape = conv.getInfo().getShape();
      int frames = (int) cShape[1];
      FloatBuffer fb = conv.getFloatBuffer();
      float[] enc = new float[frames * 8];
      fb.get(enc);
      for (int f = 0; f < frames; f++) {
        // Ensure every frame passes countNonSilentFrames energy threshold without overwriting channel 0 metadata.
        enc[f * 8 + 7] = 1.0f;
      }
      OnnxTensor encT = OnnxTensor.createTensor(OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR, ""), FloatBuffer.wrap(enc), new long[]{1, frames, 8});
      return new Result(Collections.singletonMap("audio_features", encT));
    }
    // DECODER
    OnnxTensor idsTensor = inputs.get("input_ids");
    long[] idShape = idsTensor.getInfo().getShape();
    int seqLen = (int) idShape[1];
    float[] tokenTagsForDelta = new float[seqLen];
    Arrays.fill(tokenTagsForDelta, -2.0f);
    if (seqLen > 1) {
      // Prefill pass: reconstruct complete audio tags from cached KV prefix + current tail audio_features.
      decoded.countDown();
      if (holdDecode) {
        decoding.countDown();
        try { decodeRelease.await(); } catch (InterruptedException e) { throw new RuntimeException(e); }
      }
      List<Float> allAudioTags = new ArrayList<>();
      OnnxTensor posT = inputs.get("cache_position");
      int pos0 = (posT != null && posT.getInfo().getNumElements() > 0) ? (int) posT.getLongBuffer().get(0) : 0;
      OnnxTensor ck0 = inputs.get("cache_key_0");
      if (ck0 != null && pos0 > 0) {
        if (ck0.getInfo().type == OnnxJavaType.FLOAT16) {
          ShortBuffer sb = ck0.getShortBuffer();
          for (int p = 0; p < pos0 && p * 8 < sb.limit(); p++) {
            float tag = h2f(sb.get(p * 8));
            if (tag >= -1.5f) allAudioTags.add(tag);
          }
        } else {
          FloatBuffer fb = ck0.getFloatBuffer();
          for (int p = 0; p < pos0 && p * 8 < fb.limit(); p++) {
            float tag = fb.get(p * 8);
            if (tag >= -1.5f) allAudioTags.add(tag);
          }
        }
      }
      OnnxTensor af = inputs.get("audio_features");
      int nElems = (int) af.getInfo().getNumElements();
      float[] afVals = new float[nElems];
      if (af.getInfo().type == OnnxJavaType.FLOAT16) {
        ShortBuffer sb = af.getShortBuffer();
        for (int i = 0; i < nElems; i++) afVals[i] = h2f(sb.get(i));
      } else {
        af.getFloatBuffer().get(afVals);
      }
      LongBuffer lb = idsTensor.getLongBuffer();
      int audioIdx = 0;
      for (int i = 0; i < seqLen; i++) {
        if (lb.get(i) == 5L && audioIdx * 8 < afVals.length) {
          float tag = afVals[audioIdx * 8];
          tokenTagsForDelta[i] = tag;
          allAudioTags.add(tag);
          audioIdx++;
        }
      }
      maxDecoderAudioTokens = Math.max(maxDecoderAudioTokens, allAudioTags.size());
      boolean unlabelled = allAudioTags.isEmpty();
      for (float tag : allAudioTags) {
        if (tag < -0.5f) { unlabelled = true; break; }
      }
      if (!unlabelled) {
        List<Integer> rawWords = new ArrayList<>();
        for (float tag : allAudioTags) {
          if (tag >= 99.5f) rawWords.add(Math.round(tag) - 100);
        }
        List<Integer> words = new ArrayList<>();
        for (int i = 0; i < rawWords.size(); ) {
          int wId = rawWords.get(i), j = i;
          while (j < rawWords.size() && rawWords.get(j) == wId) j++;
          if ((j - i) >= 2 && (words.isEmpty() || words.get(words.size() - 1) != wId)) words.add(wId);
          i = j;
        }
        List<Integer> seq = new ArrayList<>();
        seq.add(7); seq.add(8); seq.add(6); // language English <asr_text>
        for (int i = 0; i < words.size(); i++) {
          if (i > 0) seq.add(11); // space
          seq.add(13 + words.get(i));
        }
        seq.add(2); // EOS
        plannedTokens = new int[seq.size()];
        for (int i = 0; i < plannedTokens.length; i++) plannedTokens[i] = seq.get(i);
      } else {
        plannedTokens = new int[] { 7, 8, 6, 9, 10, 2 }; // language English <asr_text> Hello . <eos>
      }
      int prefixCount = 0;
      for (int i = 0; i < seqLen; i++) {
        if (lb.get(i) == 6L) {
          // Prefix after <asr_text> (which itself is index 2 in plannedTokens)
          prefixCount = 3 + (seqLen - 1 - i);
          if (seqLen - 1 - i > 0) observedNonEmptyPrefixes.incrementAndGet();
          break;
        }
      }
      cursor = prefixCount;
    }
    int nextTok = (cursor < plannedTokens.length) ? plannedTokens[cursor++] : 2;
    int vocab = 64;
    int lastStep = seqLen - 1;
    OrtEnvironment env = OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR, "");
    OnnxTensor logitsT;
    if (dtype == OnnxJavaType.FLOAT16) {
      ByteBuffer bb = ByteBuffer.allocateDirect(seqLen * vocab * 2).order(ByteOrder.nativeOrder());
      ShortBuffer sb = bb.asShortBuffer();
      for (int s = 0; s < seqLen; s++) {
        for (int v = 0; v < vocab; v++) {
          sb.put((s == lastStep && v == nextTok) ? f2h(10.0f) : f2h(-10.0f));
        }
      }
      logitsT = OnnxTensor.createTensor(env, bb, new long[]{1, seqLen, vocab}, OnnxJavaType.FLOAT16);
    } else {
      float[] logits = new float[seqLen * vocab];
      Arrays.fill(logits, -10.0f);
      logits[lastStep * vocab + nextTok] = 10.0f;
      logitsT = OnnxTensor.createTensor(env, FloatBuffer.wrap(logits), new long[]{1, seqLen, vocab});
    }
    Map<String, OnnxValue> resMap = new LinkedHashMap<>();
    resMap.put("logits", logitsT);
    int elemBytes = (dtype == OnnxJavaType.FLOAT16) ? 2 : 4;
    for (int l = 0; l < 2; l++) {
      ByteBuffer dk = ByteBuffer.allocateDirect(seqLen * 2 * 4 * elemBytes).order(ByteOrder.nativeOrder());
      if (l == 0) {
        if (dtype == OnnxJavaType.FLOAT16) {
          ShortBuffer sb = dk.asShortBuffer();
          for (int s = 0; s < seqLen; s++) sb.put(s * 8, f2h(tokenTagsForDelta[s]));
        } else {
          FloatBuffer fb = dk.asFloatBuffer();
          for (int s = 0; s < seqLen; s++) fb.put(s * 8, tokenTagsForDelta[s]);
        }
      }
      ByteBuffer dv = ByteBuffer.allocateDirect(seqLen * 2 * 4 * elemBytes).order(ByteOrder.nativeOrder());
      resMap.put("key_delta_" + l, OnnxTensor.createTensor(env, dk, new long[]{1, seqLen, 2, 4}, dtype));
      resMap.put("value_delta_" + l, OnnxTensor.createTensor(env, dv, new long[]{1, seqLen, 2, 4}, dtype));
    }
    return new Result(resMap);
  }

  @Override public synchronized void close(){ if (!closed){ closed=true; closes.incrementAndGet(); } }
}`,
      'ai/onnxruntime/OrtEnvironment.java': `package ai.onnxruntime;
import java.util.concurrent.atomic.AtomicInteger;
public class OrtEnvironment {
  private static final OrtEnvironment INSTANCE = new OrtEnvironment();
  public static final AtomicInteger sessionCreations = new AtomicInteger(0);
  public static OrtEnvironment getEnvironment(OrtLoggingLevel lvl, String name){ return INSTANCE; }
  public OrtSession createSession(String path, OrtSession.SessionOptions opts) throws OrtException {
    int expectedThreads = Math.min(4, Math.max(2, Runtime.getRuntime().availableProcessors() / 2));
    if (opts == null || opts.optLevel != OrtSession.SessionOptions.OptLevel.ALL_OPT || opts.intraThreads != expectedThreads) {
      throw new AssertionError("SessionOptions must set ALL_OPT and " + expectedThreads + " threads");
    }
    if (!"0".equals(opts.configEntries.get("session.intra_op.allow_spinning")) || !"1".equals(opts.configEntries.get("session.set_denormal_as_zero"))) {
      throw new AssertionError("SessionOptions missing expected ORT config entries: " + opts.configEntries);
    }
    if (path.endsWith("conv_frontend.onnx")) {
      if (OrtSession.initEntered != null) OrtSession.initEntered.countDown();
      if (OrtSession.initRelease != null) {
        try { OrtSession.initRelease.await(); } catch (InterruptedException e) { throw new RuntimeException(e); }
      }
      sessionCreations.incrementAndGet();
      return new OrtSession(OrtSession.Role.CONV, OnnxJavaType.valueOf(System.getProperty("ortDtype", "FLOAT")));
    }
    if (path.endsWith("encoder.int4.onnx")) {
      sessionCreations.incrementAndGet();
      return new OrtSession(OrtSession.Role.ENCODER, OnnxJavaType.valueOf(System.getProperty("ortDtype", "FLOAT")));
    }
    sessionCreations.incrementAndGet();
    return new OrtSession(OrtSession.Role.DECODER, OnnxJavaType.valueOf(System.getProperty("ortDtype", "FLOAT")));
  }
}`,
      'Harness.java': `import com.imcodes.speech.StreamingSpeechPlugin; import com.imcodes.speech.SpeechGainTest; import com.getcapacitor.PluginCall; import ai.onnxruntime.*; import android.media.AudioRecord; import android.media.MediaRecorder; import android.media.audiofx.AutomaticGainControl; import java.util.concurrent.*;
public class Harness {
 static class Subject extends StreamingSpeechPlugin {void pause(){handleOnPause();} void destroy(){handleOnDestroy();}}
 static void await(CountDownLatch l)throws Exception{if(!l.await(4,TimeUnit.SECONDS))throw new AssertionError("timeout");}
 static void check(boolean b,Object message){if(!b)throw new AssertionError(message);}
 static long finals(Subject p){return p.events.stream().filter(x->x.contains("isFinal=true")).count();}
 public static void main(String[] args)throws Exception {
  Subject p=new Subject();
  // Empty optional bias is available; stale cached nonempty bias is replaced.
  java.io.File cache=new java.io.File(p.getContext().getNoBackupFilesDir(), "qwen3-asr-9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e/hotwords.txt");
  cache.getParentFile().mkdirs();java.nio.file.Files.writeString(cache.toPath(), "COMMIT");
  PluginCall available=new PluginCall();p.available(available);await(available.done);
  check(available.value.contains("available=true"),available.value);
  try {
   p.load();
   PluginCall start=new PluginCall();p.start(start);await(start.done);await(AudioRecord.delivered);
   PluginCall stop=new PluginCall();p.stop(stop);await(stop.done);
   check(cache.length()==0,"stale hotwords cache survived");
   // 1 chunk (800) - 320 warmup + 3200 tail silence = 3680 samples -> floor(3680/160) = 23 mel frames
   check(OrtSession.lastConvMelFrames==23,"expected 23 mel frames (3680 samples), got "+OrtSession.lastConvMelFrames);
   check(finals(p)==1,p.events);check(p.events.get(p.events.size()-1).contains("status=stopped"),p.events);
   System.out.println("COLD_STOP_OK");
   p.events.clear();OrtSession.convMelFrames.clear();AudioRecord.chunksPerStart=45;OrtSession.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(OrtSession.decoded);await(AudioRecord.delivered);PluginCall stop2=new PluginCall();p.stop(stop2);await(stop2.done);
   check(OrtEnvironment.sessionCreations.get()==3,"expected warm decoder reuse (3 sessions total), got "+OrtEnvironment.sessionCreations.get());
   check(finals(p)==1,p.events);check(p.events.stream().anyMatch(x->x.contains("isFinal=false")),p.events);System.out.println("WARM_REUSE_OK");
   p.events.clear();OrtSession.convMelFrames.clear();OrtSession.maxConvMelFrames=0;AudioRecord.chunksPerStart=100;OrtSession.holdDecode=true;
   OrtSession.decoding=new CountDownLatch(1);OrtSession.decodeRelease=new CountDownLatch(1);
   p.start(new PluginCall());await(OrtSession.decoding);await(AudioRecord.delivered);
   PluginCall drainedStop=new PluginCall();p.stop(drainedStop);
   check(drainedStop.done.getCount()==1,"stop overtook in-flight decode");
   OrtSession.decodeRelease.countDown();await(drainedStop.done);OrtSession.holdDecode=false;
   check(OrtSession.maxConvMelFrames<=(216000+3200)/160,"stop drain exceeded bounded capacity frames: "+OrtSession.maxConvMelFrames);
   check(finals(p)==1,p.events);System.out.println("SINGLE_TAIL_DRAIN_OK");
   p.events.clear();AudioRecord.chunksPerStart=32;AudioRecord.silentChunksPerStart=15;OrtSession.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(OrtSession.decoded);await(AudioRecord.delivered);PluginCall stop3=new PluginCall();p.stop(stop3);await(stop3.done);
   check(p.events.stream().filter(x->x.contains("isFinal=true")).anyMatch(x->x.contains("Hello.")&&!x.contains("Hello.Hello")),p.events);System.out.println("SILENCE_SEGMENT_OK");
   p.events.clear();OrtSession.convMelFrames.clear();OrtSession.maxConvMelFrames=0;OrtSession.maxDecoderAudioTokens=0;OrtSession.observedNonEmptyPrefixes.set(0);
   AudioRecord.labelledWords=true;AudioRecord.chunksPerStart=420;AudioRecord.silentChunksPerStart=0;OrtSession.decoded=new CountDownLatch(1);
   p.start(new PluginCall());await(AudioRecord.delivered);PluginCall stop4=new PluginCall();p.stop(stop4);await(stop4.done);
   AudioRecord.labelledWords=false;
   check(OrtSession.maxConvMelFrames>=200 && OrtSession.maxConvMelFrames<=(216000+3200)/160,"conv incremental capacity frames violated: "+OrtSession.maxConvMelFrames);
   check(OrtSession.maxDecoderAudioTokens>=120 && OrtSession.maxDecoderAudioTokens<=176,"decoder window audio tokens violated: "+OrtSession.maxDecoderAudioTokens);
   for (int idx=0; idx<OrtSession.convMelFrames.size()-1; idx++) {
    check(OrtSession.convMelFrames.get(idx)<=(216000+3200)/160, "intermediate window exceeded 13.5s+pad frames: "+OrtSession.convMelFrames.get(idx));
   }
   check(OrtSession.observedNonEmptyPrefixes.get()>0,"expected non-empty rollback prefixTokens to reach decoder");
   check(finals(p)==1,p.events);
   StringBuilder expectedWords = new StringBuilder();
   for (int w=0; w<=13; w++) { if (w>0) expectedWords.append(' '); expectedWords.append(String.format("word%03d", w)); }
   check(p.events.stream().filter(x->x.contains("isFinal=true")).anyMatch(x->x.contains(expectedWords.toString())),p.events);
   check(OnnxTensor.created.get()-OnnxTensor.released.get()==4,"per-inference tensor leak while decoder alive (expected 4 persistent KV tensors): "+OnnxTensor.created.get()+" vs "+OnnxTensor.released.get());
   check(OrtSession.Result.created.get()==OrtSession.Result.released.get(),"result leak: "+OrtSession.Result.created.get()+" vs "+OrtSession.Result.released.get());
   System.out.println("WINDOW_AND_RELEASE_OK");
   check(AutomaticGainControl.created==0 && AutomaticGainControl.enabled==0,
    "AGC must never be created or enabled: created="+AutomaticGainControl.created+" enabled="+AutomaticGainControl.enabled);
   check(AudioRecord.lastSource==MediaRecorder.AudioSource.VOICE_RECOGNITION,
    "Primary AudioRecord source must prefer VOICE_RECOGNITION, got "+AudioRecord.lastSource);
   System.out.println("NO_AGC_OK");
   AudioRecord.failVoiceRecognitionSource = true;
   p.events.clear();AudioRecord.chunksPerStart=1;AudioRecord.silentChunksPerStart=0;OrtSession.decoded=new CountDownLatch(1);
   PluginCall fbStart=new PluginCall();p.start(fbStart);await(fbStart.done);await(AudioRecord.delivered);
   check(AudioRecord.lastSource==MediaRecorder.AudioSource.MIC, "VOICE_RECOGNITION init failure must fall back to MIC");
   PluginCall fbStop=new PluginCall();p.stop(fbStop);await(fbStop.done);
   check(finals(p)==1, "fallback source failed to deliver final result");
   AudioRecord.failVoiceRecognitionSource = false;
   System.out.println("SOURCE_FALLBACK_OK");
  } finally {p.destroy();}
  for(int i=0;i<100&&OrtSession.closes.get()<3;i++)Thread.sleep(5);check(OrtSession.closes.get()==3,"expected 3 closed sessions, got "+OrtSession.closes.get());
  check(OnnxTensor.created.get()==OnnxTensor.released.get(),"tensor leak after destroy: "+OnnxTensor.created.get()+" vs "+OnnxTensor.released.get());
  OrtSession.initEntered=new CountDownLatch(1);OrtSession.initRelease=new CountDownLatch(1);AudioRecord.chunksPerStart=650;
  Subject overflow=new Subject();try{overflow.load();await(OrtSession.initEntered);overflow.start(new PluginCall());for(int i=0;i<800&&AudioRecord.latest.getRecordingState()==AudioRecord.RECORDSTATE_RECORDING;i++)Thread.sleep(5);check(AudioRecord.latest.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING,"overflow did not stop intake");OrtSession.initRelease.countDown();PluginCall end=new PluginCall();overflow.stop(end);await(end.done);check(overflow.events.stream().anyMatch(x->x.contains("processing overloaded")),overflow.events);System.out.println("OVERFLOW_OK");}finally{overflow.destroy();}
  for(int i=0;i<100&&OrtSession.closes.get()<6;i++)Thread.sleep(5);
  OrtSession.initEntered=null;OrtSession.initRelease=null;
  OrtSession.holdDecode=true;OrtSession.decoding=new CountDownLatch(1);OrtSession.decodeRelease=new CountDownLatch(1);AudioRecord.chunksPerStart=45;
  Subject retired=new Subject();retired.load();retired.start(new PluginCall());await(OrtSession.decoding);
  retired.destroy();OrtSession.decodeRelease.countDown();
  for(int i=0;i<100&&OrtSession.closes.get()<9;i++)Thread.sleep(5);
  check(retired.events.stream().noneMatch(x->x.contains("partialResults")),retired.events);
  check(OnnxTensor.created.get()==OnnxTensor.released.get(),"retired tensor leak");
  check(OrtSession.Result.created.get()==OrtSession.Result.released.get(),"retired result leak");
  System.out.println("OWNER_RETIRE_OK");
  android.view.View.reset();
  PluginCall hapticOk=new PluginCall();p.performHaptic(hapticOk);await(hapticOk.done);
  check(android.view.View.hapticCalls==1 && android.view.View.lastFeedback==android.view.HapticFeedbackConstants.LONG_PRESS && android.view.View.lastFlags==android.view.HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING, "performHaptic did not dispatch expected feedback");
  com.getcapacitor.Bridge origBridge=p.getBridge();
  p.setBridge(new com.getcapacitor.Bridge(null));
  PluginCall hapticNullView=new PluginCall();p.performHaptic(hapticNullView);await(hapticNullView.done);
  p.setBridge(null);
  PluginCall hapticNullBridge=new PluginCall();p.performHaptic(hapticNullBridge);await(hapticNullBridge.done);
  p.setBridge(origBridge);
  check(android.view.View.hapticCalls==1, "null bridge/webView still invoked haptic");
  String[] semanticStyles = new String[]{"selection", "light", "warning", "medium", ""};
  int[] semanticExpected = new int[]{
    android.view.HapticFeedbackConstants.CLOCK_TICK,
    android.view.HapticFeedbackConstants.CLOCK_TICK,
    android.view.HapticFeedbackConstants.VIRTUAL_KEY,
    android.view.HapticFeedbackConstants.LONG_PRESS,
    android.view.HapticFeedbackConstants.LONG_PRESS,
  };
  for (int si = 0; si < semanticStyles.length; si++) {
    PluginCall styleCall = new PluginCall().setArg("style", semanticStyles[si]);
    p.performHaptic(styleCall);
    await(styleCall.done);
    check(android.view.View.lastFeedback == semanticExpected[si]
      && android.view.View.lastFlags == android.view.HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING,
      "performHaptic mismatch for style=" + semanticStyles[si]);
  }
  int prevSdkInt = android.os.Build.VERSION.SDK_INT;
  try {
    android.os.Build.VERSION.SDK_INT = android.os.Build.VERSION_CODES.R - 1;
    PluginCall successPreR = new PluginCall().setArg("style", "success");
    p.performHaptic(successPreR);
    await(successPreR.done);
    check(android.view.View.lastFeedback == android.view.HapticFeedbackConstants.VIRTUAL_KEY,
      "expected VIRTUAL_KEY for success below Android R, got " + android.view.View.lastFeedback);
    android.os.Build.VERSION.SDK_INT = android.os.Build.VERSION_CODES.R;
    PluginCall successOnR = new PluginCall().setArg("style", "success");
    p.performHaptic(successOnR);
    await(successOnR.done);
    check(android.view.View.lastFeedback == android.view.HapticFeedbackConstants.CONFIRM,
      "expected CONFIRM for success on Android R+, got " + android.view.View.lastFeedback);
  } finally {
    android.os.Build.VERSION.SDK_INT = prevSdkInt;
  }
  check(android.view.View.hapticCalls == 1 + semanticStyles.length + 2, "unexpected total hapticCalls=" + android.view.View.hapticCalls);
  System.out.println("HAPTIC_OK");
  // System TTS tests: missing engine, chunking, audio focus, events, stop, and shutdown
  android.speech.tts.TextToSpeech.reset();
  android.media.AudioManager.reset();
  Subject ttsFailPlugin = new Subject();
  android.speech.tts.TextToSpeech.nextInitStatus = android.speech.tts.TextToSpeech.ERROR;
  PluginCall ttsFail = new PluginCall().setArg("text", "Hello world");
  ttsFailPlugin.speak(ttsFail);
  await(ttsFail.done);
  check(ttsFail.error != null && ttsFail.error.contains("unavailable"), "expected unavailable error, got " + ttsFail.error);
  check(ttsFailPlugin.events.stream().anyMatch(x -> x.contains("ttsState:") && x.contains("error")), ttsFailPlugin.events);
  ttsFailPlugin.destroy();

  android.speech.tts.TextToSpeech.reset();
  android.media.AudioManager.reset();
  android.speech.tts.TextToSpeech.maxInputLen = 300; // maxLen = 200
  android.speech.tts.TextToSpeech.nextVoices.add(new android.speech.tts.Voice("en-us-net-vhigh", java.util.Locale.US, android.speech.tts.Voice.QUALITY_VERY_HIGH, true));
  android.speech.tts.TextToSpeech.nextVoices.add(new android.speech.tts.Voice("en-us-off-normal", java.util.Locale.US, android.speech.tts.Voice.QUALITY_NORMAL, false));
  android.speech.tts.TextToSpeech.nextVoices.add(new android.speech.tts.Voice("en-us-off-vhigh", java.util.Locale.US, android.speech.tts.Voice.QUALITY_VERY_HIGH, false));
  android.speech.tts.TextToSpeech.nextVoices.add(new android.speech.tts.Voice("en-gb-off-vhigh", java.util.Locale.UK, android.speech.tts.Voice.QUALITY_VERY_HIGH, false));
  android.speech.tts.TextToSpeech.nextVoices.add(new android.speech.tts.Voice("fr-fr-off-high", java.util.Locale.FRANCE, android.speech.tts.Voice.QUALITY_HIGH, false));
  Subject ttsPlugin = new Subject();
  StringBuilder longTts = new StringBuilder();
  for (int i = 0; i < 4; i++) longTts.append("Sentence ").append(i).append(" has enough words to exceed limit safely. ");
  PluginCall speakCall = new PluginCall().setArg("text", longTts.toString()).setArg("lang", "en-US").setArg("rate", 1.25);
  ttsPlugin.speak(speakCall);
  await(speakCall.done);
  check(speakCall.error == null, speakCall.error);
  check(android.speech.tts.TextToSpeech.lastVoice != null && "en-us-off-vhigh".equals(android.speech.tts.TextToSpeech.lastVoice.getName()), "expected offline VERY_HIGH en-US voice, got " + android.speech.tts.TextToSpeech.lastVoice);
  check(android.speech.tts.TextToSpeech.spokenTexts.size() >= 2, "expected chunked TTS output");
  check(android.speech.tts.TextToSpeech.queueModes.get(0) == android.speech.tts.TextToSpeech.QUEUE_FLUSH, "first chunk must flush");
  check(android.speech.tts.TextToSpeech.queueModes.get(1) == android.speech.tts.TextToSpeech.QUEUE_ADD, "next chunk must add");
  check(Math.abs(android.speech.tts.TextToSpeech.lastRate - 1.25f) < 0.001f, "rate mismatch");
  check(android.media.AudioManager.focusRequests == 1, "expected AudioFocus request");
  android.speech.tts.TextToSpeech.latest.emitStart(android.speech.tts.TextToSpeech.utteranceIds.get(0));
  PluginCall isSpeakingCall = new PluginCall();
  ttsPlugin.isSpeaking(isSpeakingCall);
  await(isSpeakingCall.done);
  check(isSpeakingCall.value.contains("speaking=true"), isSpeakingCall.value);
  // Pausing / locking screen must NOT interrupt active TTS or abandon audio focus prematurely.
  ttsPlugin.pause();
  check(android.speech.tts.TextToSpeech.stopCalls == 0, "handleOnPause must not stop active TTS");
  check(android.media.AudioManager.focusAbandons == 0, "handleOnPause must not abandon TTS audio focus");
  PluginCall isSpeakingAfterPause = new PluginCall();
  ttsPlugin.isSpeaking(isSpeakingAfterPause);
  await(isSpeakingAfterPause.done);
  check(isSpeakingAfterPause.value.contains("speaking=true"), "TTS must keep speaking across handleOnPause: " + isSpeakingAfterPause.value);
  android.speech.tts.TextToSpeech.latest.emitDone(android.speech.tts.TextToSpeech.utteranceIds.get(android.speech.tts.TextToSpeech.utteranceIds.size() - 1));
  check(android.media.AudioManager.focusAbandons == 1, "expected AudioFocus abandon on done");
  check(ttsPlugin.events.stream().anyMatch(x -> x.contains("status=started")) && ttsPlugin.events.stream().anyMatch(x -> x.contains("status=stopped")), ttsPlugin.events);

  // Audio focus loss must still stop active TTS and abandon audio focus.
  PluginCall focusSpeak = new PluginCall().setArg("text", "Interrupt me on call").setArg("lang", "en-US");
  ttsPlugin.speak(focusSpeak);
  await(focusSpeak.done);
  android.speech.tts.TextToSpeech.latest.emitStart(android.speech.tts.TextToSpeech.utteranceIds.get(android.speech.tts.TextToSpeech.utteranceIds.size() - 1));
  check(android.media.AudioManager.lastFocusListener != null, "expected focus listener registration");
  android.media.AudioManager.lastFocusListener.onAudioFocusChange(android.media.AudioManager.AUDIOFOCUS_LOSS);
  check(android.speech.tts.TextToSpeech.stopCalls >= 1, "AUDIOFOCUS_LOSS must stop TTS");
  check(android.media.AudioManager.focusAbandons == 2, "AUDIOFOCUS_LOSS must abandon audio focus");

  // handleOnPause must still immediately stop active STT capture.
  AudioRecord.chunksPerStart = 100;
  PluginCall sttBeforePause = new PluginCall();
  ttsPlugin.start(sttBeforePause);
  await(sttBeforePause.done);
  check(AudioRecord.latest.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING, "expected active recording before pause");
  ttsPlugin.pause();
  check(AudioRecord.latest.getRecordingState() == 0, "handleOnPause must stop STT capture");

  // Primary-subtag offline fallback & null/throwing getVoices fallback to setLanguage
  android.speech.tts.TextToSpeech.lastVoice = null;
  android.speech.tts.TextToSpeech.lastLocale = null;
  PluginCall frSpeak = new PluginCall().setArg("text", "Bonjour tout le monde").setArg("lang", "fr-CA");
  ttsPlugin.speak(frSpeak);
  await(frSpeak.done);
  check(android.speech.tts.TextToSpeech.lastVoice != null && "fr-fr-off-high".equals(android.speech.tts.TextToSpeech.lastVoice.getName()), "expected fr-FR primary-subtag offline voice");
  android.speech.tts.TextToSpeech.latest.emitDone(android.speech.tts.TextToSpeech.utteranceIds.get(android.speech.tts.TextToSpeech.utteranceIds.size() - 1));

  android.speech.tts.TextToSpeech.lastVoice = null;
  android.speech.tts.TextToSpeech.lastLocale = null;
  android.speech.tts.TextToSpeech.returnNullVoices = true;
  PluginCall nullVoicesSpeak = new PluginCall().setArg("text", "Fallback null voices").setArg("lang", "en-US");
  ttsPlugin.speak(nullVoicesSpeak);
  await(nullVoicesSpeak.done);
  check(android.speech.tts.TextToSpeech.lastVoice == null && android.speech.tts.TextToSpeech.lastLocale != null, "null getVoices must fall back to setLanguage");
  android.speech.tts.TextToSpeech.latest.emitDone(android.speech.tts.TextToSpeech.utteranceIds.get(android.speech.tts.TextToSpeech.utteranceIds.size() - 1));

  android.speech.tts.TextToSpeech.returnNullVoices = false;
  android.speech.tts.TextToSpeech.throwOnGetVoices = true;
  android.speech.tts.TextToSpeech.lastVoice = null;
  android.speech.tts.TextToSpeech.lastLocale = null;
  PluginCall throwVoicesSpeak = new PluginCall().setArg("text", "Fallback throwing voices").setArg("lang", "en-US");
  ttsPlugin.speak(throwVoicesSpeak);
  await(throwVoicesSpeak.done);
  check(android.speech.tts.TextToSpeech.lastVoice == null && android.speech.tts.TextToSpeech.lastLocale != null, "throwing getVoices must fall back to setLanguage");
  android.speech.tts.TextToSpeech.latest.emitDone(android.speech.tts.TextToSpeech.utteranceIds.get(android.speech.tts.TextToSpeech.utteranceIds.size() - 1));
  android.speech.tts.TextToSpeech.throwOnGetVoices = false;

  PluginCall emptySpeak = new PluginCall().setArg("text", "   ");
  ttsPlugin.speak(emptySpeak);
  await(emptySpeak.done);
  check(emptySpeak.error != null, "empty TTS text must reject");
  PluginCall stopSpeak = new PluginCall();
  ttsPlugin.stopSpeaking(stopSpeak);
  await(stopSpeak.done);
  ttsPlugin.destroy();
  check(android.speech.tts.TextToSpeech.shutdownCalls >= 1, "destroy must shutdown TTS");
  // openTtsSettings primary intent and safe fallbacks
  android.content.Context.resetIntents();
  Subject settingsPlugin = new Subject();
  PluginCall primarySettings = new PluginCall();
  settingsPlugin.openTtsSettings(primarySettings);
  await(primarySettings.done);
  check(primarySettings.value != null && primarySettings.value.contains("opened=true"), primarySettings.value);
  check(android.content.Context.startedActions.equals(java.util.Arrays.asList("com.android.settings.TTS_SETTINGS")), android.content.Context.startedActions);
  check((android.content.Context.startedFlags.get(0) & android.content.Intent.FLAG_ACTIVITY_NEW_TASK) != 0, "expected NEW_TASK flag");

  android.content.Context.resetIntents();
  android.content.Context.failingActions.add("com.android.settings.TTS_SETTINGS");
  PluginCall installFallback = new PluginCall();
  settingsPlugin.openTtsSettings(installFallback);
  await(installFallback.done);
  check(installFallback.value != null && installFallback.value.contains("opened=true"), installFallback.value);
  check(android.content.Context.startedActions.equals(java.util.Arrays.asList("com.android.settings.TTS_SETTINGS", "android.speech.tts.engine.INSTALL_TTS_DATA")), android.content.Context.startedActions);

  android.content.Context.resetIntents();
  android.content.Context.failingActions.add("com.android.settings.TTS_SETTINGS");
  android.content.Context.throwSecurityOnInstallTts = true;
  PluginCall osSettingsFallback = new PluginCall();
  settingsPlugin.openTtsSettings(osSettingsFallback);
  await(osSettingsFallback.done);
  check(osSettingsFallback.value != null && osSettingsFallback.value.contains("opened=true"), osSettingsFallback.value);
  check(android.content.Context.startedActions.equals(java.util.Arrays.asList("com.android.settings.TTS_SETTINGS", "android.speech.tts.engine.INSTALL_TTS_DATA", "android.settings.SETTINGS")), android.content.Context.startedActions);

  android.content.Context.resetIntents();
  android.content.Context.failingActions.add("com.android.settings.TTS_SETTINGS");
  android.content.Context.failingActions.add("android.speech.tts.engine.INSTALL_TTS_DATA");
  android.content.Context.failingActions.add("android.settings.SETTINGS");
  PluginCall allFailSettings = new PluginCall();
  settingsPlugin.openTtsSettings(allFailSettings);
  await(allFailSettings.done);
  check(allFailSettings.error == null && allFailSettings.value != null && allFailSettings.value.contains("opened=false"), allFailSettings.value);

  // openAppSettings primary intent, fallback to ACTION_SETTINGS, and STARTED vs CREATED lifecycle check
  androidx.lifecycle.Lifecycle.currentState = androidx.lifecycle.Lifecycle.State.CREATED;
  PluginCall createdCapture = new PluginCall();
  settingsPlugin.startRawPcmCapture(createdCapture);
  await(createdCapture.done);
  check("Speech requires a foreground app".equals(createdCapture.error), "CREATED lifecycle must be rejected, got " + createdCapture.error);

  androidx.lifecycle.Lifecycle.currentState = androidx.lifecycle.Lifecycle.State.STARTED;
  AudioRecord.chunksPerStart = 1;
  AudioRecord.silentChunksPerStart = 0;
  PluginCall startedCapture = new PluginCall();
  settingsPlugin.startRawPcmCapture(startedCapture);
  await(startedCapture.done);
  check(startedCapture.error == null, "STARTED lifecycle must be allowed, got " + startedCapture.error);
  PluginCall stopStartedCapture = new PluginCall();
  settingsPlugin.stopRawPcmCapture(stopStartedCapture);
  await(stopStartedCapture.done);
  androidx.lifecycle.Lifecycle.currentState = androidx.lifecycle.Lifecycle.State.RESUMED;

  android.content.Context.resetIntents();
  PluginCall appSettings = new PluginCall();
  settingsPlugin.openAppSettings(appSettings);
  await(appSettings.done);
  check(appSettings.value != null && appSettings.value.contains("opened=true"), appSettings.value);
  check(android.content.Context.startedActions.equals(java.util.Arrays.asList("android.settings.APPLICATION_DETAILS_SETTINGS")), android.content.Context.startedActions);
  check((android.content.Context.startedFlags.get(0) & android.content.Intent.FLAG_ACTIVITY_NEW_TASK) != 0, "expected NEW_TASK flag on openAppSettings");

  android.content.Context.resetIntents();
  android.content.Context.failingActions.add("android.settings.APPLICATION_DETAILS_SETTINGS");
  PluginCall appSettingsFallback = new PluginCall();
  settingsPlugin.openAppSettings(appSettingsFallback);
  await(appSettingsFallback.done);
  check(appSettingsFallback.value != null && appSettingsFallback.value.contains("opened=true"), appSettingsFallback.value);
  check(android.content.Context.startedActions.equals(java.util.Arrays.asList("android.settings.APPLICATION_DETAILS_SETTINGS", "android.settings.SETTINGS")), android.content.Context.startedActions);
  settingsPlugin.destroy();
  System.out.println("TTS_ANDROID_OK");

  // Built-in mic device preference + startRawPcmCapture/stopRawPcmCapture + mutual exclusion
  AudioRecord.lastPreferredDevice = null;
  AudioRecord.chunksPerStart = 3;
  AudioRecord.silentChunksPerStart = 0;
  Subject rawPlugin = new Subject();
  rawPlugin.load();
  PluginCall rawStart = new PluginCall();
  rawPlugin.startRawPcmCapture(rawStart);
  await(rawStart.done);
  check(rawStart.error == null, "startRawPcmCapture failed: " + rawStart.error);
  check(AudioRecord.lastPreferredDevice != null && AudioRecord.lastPreferredDevice.getType() == android.media.AudioDeviceInfo.TYPE_BUILTIN_MIC,
    "expected TYPE_BUILTIN_MIC preferred device, got " + AudioRecord.lastPreferredDevice);
  await(AudioRecord.delivered);
  PluginCall rawStop = new PluginCall();
  rawPlugin.stopRawPcmCapture(rawStop);
  await(rawStop.done);
  check(rawStop.error == null, "stopRawPcmCapture failed: " + rawStop.error);
  long rawChunks = rawPlugin.events.stream().filter(x -> x.startsWith("rawPcmChunk:")).count();
  check(rawChunks >= 1, "expected at least 1 rawPcmChunk event, got " + rawPlugin.events);
  // Mutual exclusion: raw PCM capture followed by offline STT must stop raw PCM cleanly
  AudioRecord.chunksPerStart = 100;
  PluginCall rawHold = new PluginCall();
  rawPlugin.startRawPcmCapture(rawHold);
  await(rawHold.done);
  AudioRecord rawHolderRecord = AudioRecord.latest;
  check(rawHolderRecord != null && rawHolderRecord.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING, "expected raw PCM active");
  AudioRecord.lastPreferredDevice = null;
  PluginCall sttOverride = new PluginCall();
  rawPlugin.start(sttOverride);
  await(sttOverride.done);
  check(rawHolderRecord.getRecordingState() == 0, "STT start must stop active raw PCM capture");
  check(AudioRecord.lastPreferredDevice != null && AudioRecord.lastPreferredDevice.getType() == android.media.AudioDeviceInfo.TYPE_BUILTIN_MIC,
    "offline STT start must also set TYPE_BUILTIN_MIC preferred device");
  PluginCall sttStop = new PluginCall();
  rawPlugin.stop(sttStop);
  await(sttStop.done);
  rawPlugin.destroy();
  System.out.println("RAW_PCM_AND_BUILTIN_MIC_OK");
  SpeechGainTest.main(new String[0]);
 }
}
`,
    };
    const sources: string[] = [];
    for (const [relative, content] of Object.entries(files)) { const full=join(srcDir, relative); await mkdir(dirname(full),{recursive:true});await writeFile(full,content);sources.push(full); }
    for (const name of ['SpeechGain.java', 'SpeechModelExtractor.java', 'StreamingSpeechPlugin.java', 'Qwen3OnnxDecoder.java', 'Qwen3SpeechWindow.java', 'Qwen3Tokenizer.java', 'WhisperMelExtractor.java']) {
      sources.push(fileURLToPath(new URL(`../../web/plugins/streaming-speech/android/src/main/java/com/imcodes/speech/${name}`, import.meta.url)));
    }
    sources.push(fileURLToPath(new URL('../../web/plugins/streaming-speech/android/src/test/java/com/imcodes/speech/SpeechGainTest.java', import.meta.url)));
    sources.push(fileURLToPath(new URL('../../web/plugins/streaming-speech/android/src/test/java/com/imcodes/speech/Qwen3SpeechTests.java', import.meta.url)));
    await runNativeOrThrow('javac', ['-d', classesDir, ...sources], { timeout: 30000 });
    const unitOut = (await runNativeOrThrow('java', ['-cp', classesDir, 'com.imcodes.speech.Qwen3SpeechTests'], { timeout: 15000 })).trim();
    expect(unitOut).toBe('QWEN3_JAVA_UNIT_TESTS:PASS');
    for (const dtype of ['FLOAT', 'FLOAT16']) {
      const output = (await runNativeOrThrow('java', ['-Djava.io.tmpdir=' + root, '-DortDtype=' + dtype, '-cp', classesDir, 'Harness'], { timeout: 15000 })).trim().split('\n');
      expect(output, `ORT dtype ${dtype}`).toEqual(['COLD_STOP_OK','WARM_REUSE_OK','SINGLE_TAIL_DRAIN_OK','SILENCE_SEGMENT_OK','WINDOW_AND_RELEASE_OK','NO_AGC_OK','SOURCE_FALLBACK_OK','OVERFLOW_OK','OWNER_RETIRE_OK','HAPTIC_OK','TTS_ANDROID_OK','RAW_PCM_AND_BUILTIN_MIC_OK','SpeechGainTest: ALL 7 TESTS PASSED']);
    }
  }, 95000);
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
    static func clearMetalCache() {}
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
    static func resolveLanguage(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        let lower = trimmed.lowercased()
        if lower == "auto" { return nil }
        if lower.hasPrefix("zh") || lower == "chinese" { return "Chinese" }
        if lower.hasPrefix("en") || lower == "english" { return "English" }
        return trimmed
    }
    func safePrefixTokensForRollback(_ tokens: [Int32], rollbackCount: Int = 5, expectLanguageHeader: Bool = false) -> [Int32] {
        _ = expectLanguageHeader
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

// 2B. partial already emitted (>=SpeechWindow.stride) + 8000 tail backgrounded -> NO partial-as-final, error before stopped, ACK rejects
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
    coordB.offerSamples(speech(SpeechWindow.stride), owner: owner, now: 0.20) {}
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
    coord.offerSamples(speech(SpeechWindow.stride), owner: owner, now: 0.20) {}
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
    coord.offerSamples(speech(SpeechWindow.stride), owner: owner1, now: 0.20) {}
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
            coord.markStarted(owner: freshOwner)
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
                let tokens = prefix.isEmpty ? stepTokens : prefix + stepTokens.suffix(6)
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
        coord.offerSamples(speech(SpeechWindow.stride), owner: owner, now: TimeInterval(step)) {}
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
    require(evs.contains(.final("t:\\(seenPrefixes[4].count + 6)")), "K: missing expected final: \\(evs)")
    print("COORDINATOR_PREFIX_ROLLBACK:PASS")
}

// 2L. SpeechGain + SpeechInbox adaptive quiet-speech gain, soft-knee limiting & noise-floor VAD
do {
    func sinePCM(_ count: Int, rms: Float) -> [Float] {
        let peak = rms * sqrt(2.0)
        return (0..<count).map { i in peak * sin(2.0 * .pi * 220.0 * Float(i) / 16000.0) }
    }

    // Quiet speech (RMS 0.0025) stays clean unboosted (unity gain 1.0x) and opens VAD without clipping.
    var gain = SpeechGain()
    let quiet = sinePCM(1600, rms: 0.0025)
    let g1 = gain.process(quiet)
    require(abs(g1.boostedRMS - g1.rawRMS) <= 1e-5, "L: quiet speech chunk1 was unexpectedly boosted: \\(g1.boostedRMS) vs \\(g1.rawRMS)")
    require(abs(gain.currentGain - 1.0) <= 1e-6, "L: gain must stay unity 1.0: \\(gain.currentGain)")
    require(g1.anyVoiced, "L: quiet speech chunk1 failed VAD")
    require(g1.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 }, "L: quiet speech chunk1 clipped")
    let g2 = gain.process(quiet)
    require(abs(g2.boostedRMS - g2.rawRMS) <= 1e-5 && gain.currentGain <= SpeechGain.maxGain, "L: quiet speech chunk2 gain unexpected: rms=\\(g2.boostedRMS) gain=\\(gain.currentGain)")

    // Loud burst stays strictly inside (-1.0, 1.0) via softLimit without hard clipping.
    let loud = sinePCM(1600, rms: 0.85)
    let gLoud = gain.process(loud)
    require(gLoud.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 }, "L: loud burst hard clipped")
    require(abs(gain.currentGain - 1.0) <= 1e-6, "L: gain failed unity invariant: \\(gain.currentGain)")

    // Cold-start pure silence and ultra-low noise floor stay unboosted and unvoiced.
    var inbox = SpeechInbox()
    _ = try! inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
    let noise = sinePCM(1600, rms: 0.0003)
    _ = try! inbox.offer(noise)
    require(!inbox.lastVoiced, "L: ultra-low noise triggered voiced")
    let noiseBatch = inbox.take()!
    require(!noiseBatch.speech && noiseBatch.trailingSilence == noise.count, "L: noise marked as speech")
    require(SpeechGain.rms(noiseBatch.samples) <= 0.0004, "L: noise floor was wildly amplified")

    // Quiet speech in inbox opens VAD, emits clean rawRMS * 4.0 audioLevel (~0.010), and trailing ambient floor releases VAD.
    _ = try! inbox.offer(quiet)
    require(inbox.lastVoiced, "L: quiet speech failed VAD onset")
    let quietLevel = inbox.pollAudioLevel(now: 0.1)
    require(abs((quietLevel ?? 0) - 0.010) <= 8e-4, "L: quiet audioLevel must match rawRMS * 4.0 ~0.010: \\(String(describing: quietLevel))")
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
    require(evs.contains { if case .audioLevel(let lvl) = $0 { return abs(lvl - 0.010) <= 8e-4 }; return false }, "L: missing scaled rawRMS * 4.0 audioLevel event: \\(evs)")

    // F1 class test: steady 60Hz hum and broadband fan noise (0.0012..0.003) after 0.2s speech must adapt & allow SpeechWindow VAD pause commit.
    func tonePCM(_ count: Int, rms: Float, freqHz: Float, phaseOffset: Int = 0) -> [Float] {
        let peak = rms * sqrt(2.0)
        return (0..<count).map { i in peak * sin(2.0 * .pi * freqHz * Float(phaseOffset + i) / 16000.0) }
    }
    func fanPCM(_ count: Int, rms: Float, seed: UInt64) -> [Float] {
        var state = seed
        var raw = [Float](repeating: 0, count: count)
        var sumSq: Double = 0
        for i in 0..<count {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            let u = Float(Int32(bitPattern: UInt32(truncatingIfNeeded: state >> 32))) / Float(Int32.max)
            raw[i] = u
            sumSq += Double(u) * Double(u)
        }
        let actualRMS = Float(sqrt(sumSq / Double(max(1, count))))
        let scale = actualRMS > 0 ? rms / actualRMS : 0
        return raw.map { $0 * scale }
    }
    for chunkSize in [400, 1600, 19200] {
        for (kind, rms) in [("hum60", Float(0.002)), ("hum60_low", Float(0.0012)), ("hum60_high", Float(0.003)), ("fan", Float(0.002))] {
            var humInbox = SpeechInbox()
            var humWin = SpeechWindow()
            let decodeSpeech: SpeechWindow.DecodeFn = { _, _ in ("speech", [1, 2]) }
            _ = try! humInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
            for step in 0..<8 {
                _ = try! humInbox.offer(tonePCM(400, rms: 0.005, freqHz: 220, phaseOffset: step * 400))
                if let batch = humInbox.take() {
                    try! humWin.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: decodeSpeech) { _ in }
                }
            }
            require(!humWin.samples.isEmpty, "L: speech failed to open window before noise (\\(kind)/\\(chunkSize))")
            var voicedNoiseFrames = 0
            var offset = 0
            while offset < 19200 {
                let n = min(chunkSize, 19200 - offset)
                let noiseChunk = kind == "fan"
                    ? fanPCM(n, rms: rms, seed: UInt64(0xAA00_0001 + offset))
                    : tonePCM(n, rms: rms, freqHz: 60, phaseOffset: offset)
                _ = try! humInbox.offer(noiseChunk)
                if humInbox.lastVoiced { voicedNoiseFrames += 1 }
                if let batch = humInbox.take() {
                    try! humWin.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: decodeSpeech) { _ in }
                }
                offset += n
            }
            require(!humInbox.lastVoiced && humWin.samples.isEmpty && humWin.committed == "speech",
                    "L: steady noise blocked VAD commit (\\(kind)/\\(rms)/chunk=\\(chunkSize)): left=\\(humWin.samples.count) voiced=\\(voicedNoiseFrames)")
        }
    }

    // Cold-start steady noise adapts, and modulated quiet speech (0.003..0.0055) over the noise still opens & boosts cleanly.
    var ambientInbox = SpeechInbox()
    _ = try! ambientInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
    for step in 0..<48 {
        _ = try! ambientInbox.offer(fanPCM(400, rms: 0.0015, seed: UInt64(0xBB00_0001 + step)))
        _ = ambientInbox.take()
    }
    require(!ambientInbox.lastVoiced, "L: cold-start fan noise stayed voiced")
    for (idx, rms) in [Float(0.0040), 0.0055, 0.0032, 0.0050, 0.0035].enumerated() {
        _ = try! ambientInbox.offer(tonePCM(400, rms: rms, freqHz: 240, phaseOffset: idx * 400))
        require(ambientInbox.lastVoiced, "L: modulated quiet speech blocked over noise at rms=\\(rms)")
        let batch = ambientInbox.take()!
        require(batch.speech && abs(SpeechGain.rms(batch.samples) - rms) <= 2e-4 && batch.samples.allSatisfy { $0 > -1.0 && $0 < 1.0 },
                "L: modulated quiet speech clean PCM/bounds invalid at rms=\\(rms)")
    }

    // Regression: iPhone 16 .spokenAudio 10s silence profile (digital zeros + 50ms settle pulse + unpitched noise bursts)
    // must keep noiseFloor intact, never open SpeechWindow, and invoke 0 decodes; genuine 200ms soft speech still decodes completely.
    do {
        var zeroGain = SpeechGain()
        for _ in 0..<4 { _ = zeroGain.process([Float](repeating: 0, count: 400)) }
        require(abs(zeroGain.noiseFloorRMS - SpeechGain.initialNoiseFloorRMS) <= 1e-6,
                "L: digital zeros dragged noiseFloorRMS down: \\(zeroGain.noiseFloorRMS)")

        var silInbox = SpeechInbox()
        var silWin = SpeechWindow()
        var silDecodes = 0
        let silDecode: SpeechWindow.DecodeFn = { _, _ in silDecodes += 1; return ("嗯", [1]) }
        _ = try! silInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for frame in 0..<400 {
            let chunk: [Float]
            if frame < 3 {
                chunk = [Float](repeating: 0, count: 400)
            } else if frame == 11 || frame == 12 {
                chunk = tonePCM(400, rms: 0.0014, freqHz: 240, phaseOffset: frame * 400)
            } else if frame == 184 || (frame >= 190 && frame <= 195) {
                chunk = fanPCM(400, rms: frame == 184 ? 0.0042 : 0.0021, seed: UInt64(0xCAFE_0000 + frame))
            } else {
                chunk = fanPCM(400, rms: 0.00048, seed: UInt64(0xFACE_0000 + frame))
            }
            _ = try! silInbox.offer(chunk)
            if let batch = silInbox.take() {
                try! silWin.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: silDecode) { _ in }
            }
        }
        let silText = try! silWin.finish(decode: silDecode)
        require(silWin.samples.isEmpty && silDecodes == 0 && silText.isEmpty,
                "L: 10s silence profile leaked to decoder (decodes=\\(silDecodes) text=\\(silText))")

        require(!SpeechWindow.hasDecodableEnergy(in: fanPCM(32000, rms: 0.0008, seed: 0xBEEF)),
                "L: pre-decode energy guard accepted 0.0008 noise")
        var qInbox = SpeechInbox()
        var qWin = SpeechWindow()
        var qDecodedLen = 0
        let qDecode: SpeechWindow.DecodeFn = { s, _ in qDecodedLen = s.count; return ("嗯", [42]) }
        _ = try! qInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for step in 0..<8 {
            _ = try! qInbox.offer(tonePCM(400, rms: 0.0025, freqHz: 220, phaseOffset: step * 400))
            if let batch = qInbox.take() {
                try! qWin.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: qDecode) { _ in }
            }
        }
        let qOut = try! qWin.finish(decode: qDecode)
        require(qOut == "嗯" && qDecodedLen == 3200 + SpeechWindow.finalSilencePadding,
                "L: genuine 200ms soft word dropped or truncated (len=\\(qDecodedLen) out=\\(qOut))")
    }

    // F1-R2 class test: sustained quiet speech (2.0s @ RMS 0.0025 / 220Hz) and slowly varying harmonic quiet speech (<0.004)
    // must NOT be learned as stationary noise; all 80 frames remain voiced and SpeechWindow keeps full 32,000 samples.
    do {
        var sustainInbox = SpeechInbox()
        var sustainWin = SpeechWindow()
        var maxDecoded = 0
        let dec: SpeechWindow.DecodeFn = { s, _ in
            maxDecoded = max(maxDecoded, s.count)
            return ("sustain", [1, 2])
        }
        _ = try! sustainInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        var voicedFrames = 0
        for step in 0..<80 {
            _ = try! sustainInbox.offer(tonePCM(400, rms: 0.0025, freqHz: 220, phaseOffset: step * 400))
            if sustainInbox.lastVoiced { voicedFrames += 1 }
            if let batch = sustainInbox.take() {
                try! sustainWin.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: dec) { _ in }
            }
        }
        require(voicedFrames == 80 && sustainInbox.lastVoiced && sustainWin.samples.count == 32000 && sustainWin.committed.isEmpty && maxDecoded >= SpeechWindow.stride,
                "L: sustained quiet speech was swallowed as noise (voiced=\\(voicedFrames)/80 active=\\(sustainWin.samples.count) committed=\\(sustainWin.committed) maxDecoded=\\(maxDecoded))")
    }
    do {
        var modInbox = SpeechInbox()
        var modWin = SpeechWindow()
        var maxDecoded = 0
        let dec: SpeechWindow.DecodeFn = { s, _ in
            maxDecoded = max(maxDecoded, s.count)
            return ("harmonic", [3, 4])
        }
        _ = try! modInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        var voicedFrames = 0
        for step in 0..<80 {
            let targetRMS: Float = 0.0025 + 0.0011 * sin(2.0 * .pi * Float(step) / 40.0) // 0.0014..0.0036 (< 0.0040)
            var raw = [Float](repeating: 0, count: 400)
            var sumSq: Double = 0
            for i in 0..<400 {
                let t = Float(step * 400 + i) / 16000.0
                let v = 0.45 * sin(2.0 * .pi * 145.0 * t)
                    + 0.35 * sin(2.0 * .pi * 290.0 * t)
                    + 0.25 * sin(2.0 * .pi * 580.0 * t)
                    + 0.15 * sin(2.0 * .pi * 1160.0 * t)
                raw[i] = v
                sumSq += Double(v) * Double(v)
            }
            let scale = targetRMS / Float(sqrt(sumSq / 400.0))
            _ = try! modInbox.offer(raw.map { $0 * scale })
            if modInbox.lastVoiced { voicedFrames += 1 }
            if let batch = modInbox.take() {
                try! modWin.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: dec) { _ in }
            }
        }
        require(voicedFrames == 80 && modInbox.lastVoiced && modWin.samples.count == 32000 && modWin.committed.isEmpty && maxDecoded >= SpeechWindow.stride,
                "L: slowly modulated <0.004 quiet speech was swallowed (voiced=\\(voicedFrames)/80 active=\\(modWin.samples.count) committed=\\(modWin.committed) maxDecoded=\\(maxDecoded))")
    }
    // Mixed 60Hz hum + broadband fan noise (0.002 total) after 0.2s speech also learns noise and commits VAD pause.
    do {
        var mixInbox = SpeechInbox()
        var mixWin = SpeechWindow()
        let dec: SpeechWindow.DecodeFn = { _, _ in ("mixspeech", [5]) }
        _ = try! mixInbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for step in 0..<8 {
            _ = try! mixInbox.offer(tonePCM(400, rms: 0.005, freqHz: 220, phaseOffset: step * 400))
            if let batch = mixInbox.take() {
                try! mixWin.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: dec) { _ in }
            }
        }
        for step in 0..<48 {
            let h = tonePCM(400, rms: 0.0014, freqHz: 60, phaseOffset: step * 400)
            let f = fanPCM(400, rms: 0.0014, seed: UInt64(0xCC00_0001 + step))
            let mixed = zip(h, f).map(+)
            _ = try! mixInbox.offer(mixed)
            if let batch = mixInbox.take() {
                try! mixWin.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, decode: dec) { _ in }
            }
        }
        require(!mixInbox.lastVoiced && mixWin.samples.isEmpty && mixWin.committed == "mixspeech",
                "L: mixed hum+fan noise blocked VAD commit: left=\\(mixWin.samples.count) committed=\\(mixWin.committed)")
    }
    // Real KOCA's iPhone 16 34s silence profile (measured p50=0.0022..0.0030 RMS, 117/148/531Hz ambient hum+fan
    // producing hpRatio ~0.76 and 25ms autocorrelation 0.45..0.67) must adapt noiseFloorRMS and decode 0 times
    // well past 2x segmentCapacity (13.5s), while soft speech above the room floor still opens and decodes.
    do {
        var ip16Inbox = SpeechInbox()
        var ip16Win = SpeechWindow()
        var ip16Decodes = 0
        let ip16Decode: SpeechWindow.DecodeFn = { _, _ in ip16Decodes += 1; return ("嗯", [1]) }
        _ = try! ip16Inbox.offer([Float](repeating: 0, count: SpeechInbox.warmupSamples))
        for step in 0..<340 {
            let off = step * 1600
            let h1 = tonePCM(1600, rms: 0.0016, freqHz: 117, phaseOffset: off)
            let h2 = tonePCM(1600, rms: 0.0014, freqHz: 148, phaseOffset: off)
            let h3 = tonePCM(1600, rms: 0.0012, freqHz: 531, phaseOffset: off)
            let n = fanPCM(1600, rms: 0.0016, seed: UInt64(0x16_0000 + step))
            let chunk = (0..<1600).map { h1[$0] + h2[$0] + h3[$0] + n[$0] }
            _ = try! ip16Inbox.offer(chunk)
            if let batch = ip16Inbox.take() {
                try! ip16Win.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, activeSamples: batch.activeSamples, noiseFloorRMS: batch.noiseFloorRMS, decode: ip16Decode) { _ in }
            }
        }
        let silOut = try! ip16Win.finish(decode: ip16Decode)
        require(ip16Inbox.currentNoiseFloorRMS >= 0.0020, "L: iPhone 16 noiseFloorRMS froze at \\(ip16Inbox.currentNoiseFloorRMS)")
        require(ip16Win.samples.isEmpty && ip16Decodes == 0 && silOut.isEmpty,
                "L: 34s iPhone 16 room silence hallucinated (decodes=\\(ip16Decodes) out=\\(silOut))")
        // Verify soft speech (0.0055 RMS) over that adapted 0.0028+ floor still opens and decodes cleanly.
        for s in 0..<4 {
            _ = try! ip16Inbox.offer(tonePCM(1600, rms: 0.0055, freqHz: 220, phaseOffset: s * 1600))
            if let batch = ip16Inbox.take() {
                try! ip16Win.append(batch.samples, speech: batch.speech, trailingSilence: batch.trailingSilence, activeSamples: batch.activeSamples, noiseFloorRMS: batch.noiseFloorRMS, decode: ip16Decode) { _ in }
            }
        }
        let softOut = try! ip16Win.finish(decode: ip16Decode)
        require(softOut == "嗯" && ip16Decodes == 1, "L: soft speech over iPhone 16 noise floor failed (decodes=\\(ip16Decodes) out=\\(softOut))")
    }
    print("SPEECH_GAIN_AND_INBOX_VAD:PASS")
}
`);
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', file, '-o', executable], { timeout: 120000 });
  const result = await runNativeOrThrow(executable, [emptyDir, biasedDir], { timeout: 90000 });
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
}, 240_000);

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
    qwenSrc.indexOf('    private static let supportedLanguageMap'),
    qwenSrc.indexOf('    static func buildInputEmbeds(')
  );
  expect(rollbackSlice).toContain('hasSuffix("\\u{FFFD}")');
  expect(promptSlice).toContain('suffix.append(contentsOf: prefixTokens)');
  expect(promptSlice).toContain('if let lang = resolveLanguage(language)');

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

// Auto-detect (language: nil / "auto") ends at assistant newline without pre-inserting <asr_text>.
let (_, suffixAutoEmpty) = PrefixRollbackBridge.buildPromptTokenIds(language: nil, context: nil, tokenizer: tokenizer)
assert(suffixAutoEmpty.last == Int32(Qwen3ASRTokens.newlineTokenId) && !suffixAutoEmpty.contains(Int32(Qwen3ASRTokens.asrTextTokenId)), "auto empty prefixTokens must end with assistant newline without asrTextTokenId: \\(suffixAutoEmpty)")
let (_, suffixAutoKeyword) = PrefixRollbackBridge.buildPromptTokenIds(language: "auto", context: nil, tokenizer: tokenizer)
assert(suffixAutoKeyword == suffixAutoEmpty, "'auto' keyword must match nil prompt suffix")

// In auto-detect mode, incomplete header tokens without <asr_text> must not freeze a rollback prefix.
assert(PrefixRollbackBridge.safePrefixTokensForRollback([200], rollbackCount: 0, tokenizer: tokenizer, expectLanguageHeader: true).isEmpty, "auto rollback without <asr_text> must return []")

// Auto rollback prefix already contains language ...<asr_text>; prompt must preserve single <asr_text>.
let autoPrefix: [Int32] = [200, Int32(Qwen3ASRTokens.asrTextTokenId), 201, 202, 203]
let (_, suffixAutoCont) = PrefixRollbackBridge.buildPromptTokenIds(language: nil, context: nil, tokenizer: tokenizer, prefixTokens: autoPrefix)
assert(suffixAutoCont.filter { $0 == Int32(Qwen3ASRTokens.asrTextTokenId) }.count == 1, "auto continuation must keep single asrTextTokenId: \\(suffixAutoCont)")
assert(Array(suffixAutoCont.suffix(autoPrefix.count)) == autoPrefix, "auto continuation must append prefixTokens verbatim")

// Forced language ("Chinese" / "zh-Hans") appends language <Lang><asr_text> and inserts prefixTokens strictly after <asr_text>.
let (_, suffixForcedEmpty) = PrefixRollbackBridge.buildPromptTokenIds(language: "zh-Hans", context: nil, tokenizer: tokenizer)
assert(suffixForcedEmpty.last == Int32(Qwen3ASRTokens.asrTextTokenId), "forced language empty prefixTokens must end with asrTextTokenId")
let (_, suffixWithPrefix) = PrefixRollbackBridge.buildPromptTokenIds(language: "Chinese", context: nil, tokenizer: tokenizer, prefixTokens: [201, 202, 203])
let asrIdx = suffixWithPrefix.firstIndex(of: Int32(Qwen3ASRTokens.asrTextTokenId))!
assert(Array(suffixWithPrefix[(asrIdx + 1)...]) == [201, 202, 203], "prefixTokens missing after asrTextTokenId: \\(suffixWithPrefix)")
print("PROMPT_PREFIX_INSERTION:PASS")
`);
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', file, '-o', executable], { timeout: 120000 });
  const result = await runNativeOrThrow(executable, [], { timeout: 90000 });
  for (const name of ['UTF8_ROLLBACK_GUARD', 'HEADER_AND_SHORT_GUARD', 'PROMPT_PREFIX_INSERTION']) {
    expect(result).toContain(name + ':PASS');
  }
}, 240_000);

it.skipIf(!swiftCompiler)('executes the actual Swift bounded window through token prefix rollback, repeated phrases, VAD, disjoint low-RMS cut and final tails', async () => {
  await setup();
  const source = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', import.meta.url), 'utf8');
  const state = source.slice(source.indexOf('struct SpeechWindow {'));
  expect(state).toContain('mutating func finish(');
  const file = join(root, 'SpeechWindowTests.swift'), executable = join(root, 'speech-window-tests');
  await writeFile(file, 'import Foundation\n' + state + '\n' + swiftWindowCases);
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', file, '-o', executable], { timeout: 120000 });
  const result = await runNativeOrThrow(executable, [], { timeout: 90000 });
  for (const name of ['TAIL', 'PREFIX_ROLLBACK_CADENCE', 'REPEATED_PHRASE_PUNCTUATION', 'VAD', 'PUNCTUATION', 'REPEATED_SENTENCE', 'LONG_CONTINUOUS', 'LONG_TRANSCRIPT', 'VARIABLE_TAP', 'BACKLOG_CHUNKING', 'DISJOINT_LOW_RMS_PARTITION', 'FAILURE', 'UNICODE', 'EMPTY', 'IN_FLIGHT_STOP', 'ZERO_LAG', 'WARMUP', 'AUDIO_LEVEL_THROTTLE', 'OVERLOAD', 'TAIL_BATCH', 'MID_DECODE_CANCEL']) {
    expect(result).toContain(name + ':PASS');
  }
}, 240_000);

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
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', swiftFile, '-o', binFile], { timeout: 120000 });
  expect((await runNativeOrThrow(binFile, [root], { timeout: 90000 })).trim()).toBe('OTA_RECONCILE:PASS');
}, 240_000);

it.skipIf(!swiftCompiler)('executes the actual Swift TtsVoiceSelector priority, Siri/novelty handling, fallback, and locale rules', async () => {
  await setup();
  const plugin = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', import.meta.url), 'utf8');
  const start = plugin.indexOf('struct TtsVoiceCandidate: Equatable {');
  const end = plugin.indexOf('/// Pure Foundation/Dispatch session coordinator');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const voiceSelectorSlice = plugin.slice(start, end);
  const swiftFile = join(root, 'TtsVoiceSelectorTest.swift');
  const binFile = join(root, 'tts-voice-selector-test');
  await writeFile(swiftFile, `import Foundation
${voiceSelectorSlice}
func require(_ cond: @autoclosure () -> Bool, _ msg: String) {
    if !cond() { FileHandle.standardError.write(Data(("FAIL: " + msg + "\\n").utf8)); exit(1) }
}
func voice(_ id: String, _ name: String, _ lang: String = "zh-CN", _ q: TtsVoiceCandidate.QualityTier = .standard, novelty: Bool = false) -> TtsVoiceCandidate {
    TtsVoiceCandidate(identifier: id, name: name, language: lang, quality: q, isNoveltyVoice: novelty)
}
let eddy = voice("com.apple.eloquence.zh-CN.Eddy", "Eddy")
let legacy = voice("com.apple.speech.synthesis.voice.Albert", "Albert")
let novelty = voice("com.apple.voice.compact.zh-CN.Weird", "Weird", "zh-CN", .standard, novelty: true)
let genericDefault = voice("com.apple.ttsbundle.custom.zh-CN", "Generic")
let superCompact = voice("com.apple.voice.super-compact.zh-CN.Tingting", "Tingting")
let compact = voice("com.apple.voice.compact.zh-CN.Tingting", "Tingting")
let siriDefault = voice("com.apple.ttsbundle.siri_yu-shu_zh-CN_compact", "Yushu")
let enhanced = voice("com.apple.voice.enhanced.zh-CN.Tingting", "Tingting (Enhanced)", "zh-CN", .enhanced)
let siriEnhanced = voice("com.apple.ttsbundle.siri_yu-shu_zh-CN_compact", "Yushu (Enhanced)", "zh-CN", .enhanced)
let premium = voice("com.apple.voice.premium.zh-CN.Lili", "Lili (Premium)", "zh-CN", .premium)

require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eddy, legacy, novelty, compact]) == compact, "compact must beat eloquence/legacy/novelty")
require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [genericDefault, superCompact, compact]) == compact, "compact must beat super-compact and generic default")
require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [genericDefault, superCompact]) == superCompact, "super-compact must beat generic default")
require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eddy, compact, siriDefault]) == siriDefault, "Siri neural voice must beat compact and eloquence")
require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eddy, compact, siriDefault, enhanced]) == enhanced, "enhanced must beat default Siri and compact")
require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [enhanced, siriEnhanced]) == siriEnhanced, "Siri enhanced must beat plain enhanced")
require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eddy, compact, siriDefault, enhanced, siriEnhanced, premium]) == premium, "premium must beat all tiers")
require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: [eddy]) == eddy, "eloquence must still be selected as last fallback")
require(TtsVoiceSelector.selectCandidate(for: "zh-CN", from: []) == nil, "empty voices returns nil for AVSpeechSynthesisVoice(language:) fallback")

let twEnhanced = voice("com.apple.voice.enhanced.zh-TW.Meijia", "Meijia", "zh-TW", .enhanced)
require(TtsVoiceSelector.selectCandidate(for: "zh_CN", from: [twEnhanced, compact]) == compact, "exact zh-CN match must beat cross-region zh-TW enhanced")
require(TtsVoiceSelector.selectCandidate(for: "zh-HK", from: [twEnhanced, compact]) == twEnhanced, "primary subtag fallback picks best zh candidate")
print("TTS_VOICE_SELECTOR:PASS")
`);
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', swiftFile, '-o', binFile], { timeout: 120000 });
  expect((await runNativeOrThrow(binFile, [], { timeout: 30000 })).trim()).toBe('TTS_VOICE_SELECTOR:PASS');
}, 180_000);

it.skipIf(!swiftCompiler)('executes the actual Swift TtsBackgroundLifecyclePolicy across backgrounding, active TTS, capture races, and interruptions', async () => {
  await setup();
  const plugin = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', import.meta.url), 'utf8');
  const start = plugin.indexOf('enum TtsLifecycleEvent: Equatable {');
  const end = plugin.indexOf('/// Pure Foundation/Dispatch session coordinator');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const policySlice = plugin.slice(start, end);
  const swiftFile = join(root, 'TtsBackgroundLifecycleTest.swift');
  const binFile = join(root, 'tts-background-lifecycle-test');
  await writeFile(swiftFile, `import Foundation
${policySlice}
func require(_ cond: @autoclosure () -> Bool, _ msg: String) {
    if !cond() { FileHandle.standardError.write(Data(("FAIL: " + msg + "\\n").utf8)); exit(1) }
}
for event in [TtsLifecycleEvent.willResignActive, .didEnterBackground] {
    let ttsOnly = TtsBackgroundLifecyclePolicy.decide(event: event, isTtsActive: true, hasActiveCapture: false)
    require(ttsOnly == TtsLifecycleDecision(shouldStopCapture: false, shouldStopTts: false, shouldDeactivateAudioSession: false, shouldScheduleWarmHold: false), "active TTS must not stop TTS or touch AVAudioSession on \\(event)")
    let ttsWithCaptureRace = TtsBackgroundLifecyclePolicy.decide(event: event, isTtsActive: true, hasActiveCapture: true)
    require(ttsWithCaptureRace == TtsLifecycleDecision(shouldStopCapture: true, shouldStopTts: false, shouldDeactivateAudioSession: false, shouldScheduleWarmHold: false), "active TTS with capture race must stop capture without deactivating or warm-hold on \\(event)")
    let idleOrStt = TtsBackgroundLifecyclePolicy.decide(event: event, isTtsActive: false, hasActiveCapture: true)
    require(idleOrStt == TtsLifecycleDecision(shouldStopCapture: true, shouldStopTts: false, shouldDeactivateAudioSession: true, shouldScheduleWarmHold: false), "inactive TTS must stop capture and deactivate session on \\(event)")
}
let interruptionBegan = TtsBackgroundLifecyclePolicy.decide(event: .audioSessionInterruptionBegan, isTtsActive: true, hasActiveCapture: false)
require(interruptionBegan == TtsLifecycleDecision(shouldStopCapture: true, shouldStopTts: true, shouldDeactivateAudioSession: true, shouldScheduleWarmHold: false), "AVAudioSession interruption began must stop TTS and deactivate session")
let interruptionEnded = TtsBackgroundLifecyclePolicy.decide(event: .audioSessionInterruptionEnded, isTtsActive: true, hasActiveCapture: false)
require(interruptionEnded == TtsLifecycleDecision(shouldStopCapture: false, shouldStopTts: false, shouldDeactivateAudioSession: false, shouldScheduleWarmHold: false), "AVAudioSession interruption ended must be a no-op")
print("TTS_BACKGROUND_LIFECYCLE:PASS")
`);
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', swiftFile, '-o', binFile], { timeout: 120000 });
  expect((await runNativeOrThrow(binFile, [], { timeout: 30000 })).trim()).toBe('TTS_BACKGROUND_LIFECYCLE:PASS');
}, 180_000);

it.skipIf(!swiftCompiler)('executes the production Swift built-in mic route policy and raw PCM chunk encoder', async () => {
  await setup();
  const plugin = await readFile(new URL('../../web/plugins/streaming-speech/ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', import.meta.url), 'utf8');
  const start = plugin.indexOf('struct AudioInputCandidate: Equatable {');
  const end = plugin.indexOf('// MARK: - System TTS Voice Selection');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const micAndPcmSlice = plugin.slice(start, end);
  const swiftFile = join(root, 'builtin_mic_pcm.swift');
  const binFile = join(root, 'builtin_mic_pcm');
  await writeFile(swiftFile, `import Foundation

${micAndPcmSlice}

func check(_ ok: Bool, _ msg: String) {
    if !ok { fatalError(msg) }
}

// 1. Prefer built-in mic even when Bluetooth HFP / USB headset appear first.
let inputs = [
    AudioInputCandidate(uid: "bt-hfp", portType: "BluetoothHFP"),
    AudioInputCandidate(uid: "usb-mic", portType: "USBAudio"),
    AudioInputCandidate(uid: "phone-mic", portType: "MicrophoneBuiltIn"),
]
check(BuiltInMicRoutePolicy.selectPreferredBuiltInMicUid(inputs: inputs, currentPreferredUid: "bt-hfp") == "phone-mic", "must switch to MicrophoneBuiltIn")
check(BuiltInMicRoutePolicy.selectPreferredBuiltInMicUid(inputs: inputs, currentPreferredUid: "phone-mic") == nil, "must avoid redundant setPreferredInput when already phone-mic")
check(BuiltInMicRoutePolicy.selectPreferredBuiltInMicUid(inputs: [AudioInputCandidate(uid: "bt-hfp", portType: "BluetoothHFP")], currentPreferredUid: nil) == nil, "no built-in mic returns nil")

// 2. Route change re-enforcement and engine invalidation policy.
check(BuiltInMicRoutePolicy.shouldReenforceOnRouteChange(hasActiveCapture: false, hasActiveRawPcmCapture: true, audioSessionActive: false), "must re-enforce during raw PCM capture")
check(BuiltInMicRoutePolicy.shouldInvalidateEngineOnRouteChange(reasonRawValue: 1, routeChangedFromBuiltIn: false), "newDeviceAvailable invalidates engine")
check(BuiltInMicRoutePolicy.shouldInvalidateEngineOnRouteChange(reasonRawValue: 0, routeChangedFromBuiltIn: true), "routeChangedFromBuiltIn invalidates engine")
check(!BuiltInMicRoutePolicy.shouldInvalidateEngineOnRouteChange(reasonRawValue: 0, routeChangedFromBuiltIn: false), "unknown unchanged route does not invalidate engine")

// 3. RawPcmChunkEncoder batches 1600 samples per chunk, encodes little-endian Int16 base64, and flushes remainder.
let encoder = RawPcmChunkEncoder()
check(encoder.append(samples: Array(repeating: 0.5, count: 1000)).isEmpty, "below 1600 samples must buffer")
let first = encoder.append(samples: Array(repeating: 0.5, count: 1000))
check(first.count == 1, "expected 1 full chunk after 2000 samples")
let decodedFirst = Data(base64Encoded: first[0].pcmBase64)!
check(decodedFirst.count == 3200, "1600 Int16 samples must equal 3200 bytes")
check(first[0].level > 0.99 && first[0].level <= 1.0, "expected normalized clamped level near 1.0")
let tail = encoder.flush()
check(tail != nil, "expected tail flush for 400 remaining samples")
check(Data(base64Encoded: tail!.pcmBase64)!.count == 800, "400 Int16 samples must equal 800 bytes")
check(encoder.flush() == nil, "second flush must be nil")

// 4. Signed extrema clamp safely.
let extreme = RawPcmChunkEncoder.encode([-2.0, -1.0, 0.0, 1.0, 2.0, .nan])
let extremeData = Data(base64Encoded: extreme.pcmBase64)!
let ints: [Int16] = stride(from: 0, to: extremeData.count, by: 2).map { i in
    let lo = UInt16(extremeData[i])
    let hi = UInt16(extremeData[i + 1]) << 8
    return Int16(bitPattern: lo | hi)
}
check(ints == [-32768, -32768, 0, 32767, 32767, 0], "extrema/NaN encoding mismatch: \\(ints)")
print("BUILTIN_MIC_RAW_PCM_SWIFT:PASS")
`);
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', swiftFile, '-o', binFile], { timeout: 120000 });
  expect((await runNativeOrThrow(binFile, [], { timeout: 30000 })).trim()).toBe('BUILTIN_MIC_RAW_PCM_SWIFT:PASS');
}, 180_000);

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
        return samples.count == SpeechWindow.stride ? ("before tail", [1, 2]) : ("before tail last word", [1, 2, 3, 4])
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
        try window.append(pcm(SpeechWindow.stride), speech: true, decode: rollbackDecode) { emitted.append($0) }
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
        try window.append(pcm(SpeechWindow.stride), speech: true, decode: phraseDecode) { _ in }
    }
    let phraseOut = try window.finish(decode: phraseDecode)
    check(phraseOut == repeatedPhrase, "repeated phrase corrupted: " + phraseOut)

    // Across segmentCapacity split too: repeated CJK tokens are never dropped
    window = SpeechWindow()
    let repeatTokens: SpeechWindow.DecodeFn = { samples, prefix in
        let count = max(1, Int((Double(samples.count) / Double(SpeechWindow.stride)).rounded()))
        let toks = (0..<count).map { Int32(3000 + $0) }
        return (Array(repeating: "哈", count: count).joined(), prefix.isEmpty ? toks : prefix + toks.suffix(min(toks.count, 5)))
    }
    for _ in 0..<10 {
        try window.append(pcm(SpeechWindow.stride), speech: true, decode: repeatTokens) { _ in }
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
        try window.append(pcm(SpeechWindow.stride), speech: true, decode: { _, prefix in
            if s == 1 { sawSecondSegmentEmptyPrefix = prefix.isEmpty }
            return ("第二句", [601, 602, 603, 604, 605, 606])
        }) { _ in }
    }
    check(sawSecondSegmentEmptyPrefix, "new segment after VAD leaked prior prefix")
    print("VAD:PASS")

    window = SpeechWindow()
    let sentence: SpeechWindow.DecodeFn = { _, _ in ("同一句。", [701, 702]) }
    try window.append(pcm(SpeechWindow.stride), speech: true, decode: sentence) { _ in }
    try window.append(pcm(6400), speech: false, decode: sentence) { _ in }
    check(window.samples.isEmpty && window.committed == "同一句。", "punctuation pause did not commit")
    print("PUNCTUATION:PASS")
    try window.append(pcm(SpeechWindow.stride), speech: true, decode: sentence) { _ in }
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
    let totalSamples = 1200 * 1600
    let fullSegments = totalSamples / SpeechWindow.segmentCapacity
    let decodesPerSegment = (SpeechWindow.segmentCapacity + SpeechWindow.stride - 1) / SpeechWindow.stride
    let tailSamples = totalSamples % SpeechWindow.segmentCapacity
    let tailDecodes = tailSamples > 0 ? (tailSamples + SpeechWindow.stride - 1) / SpeechWindow.stride : 0
    let expectedCalls = fullSegments * decodesPerSegment + tailDecodes
    check(calls.count == expectedCalls && calls.max() == SpeechWindow.segmentCapacity, "2 minute decode cadence/bound failed: \\(calls.count) != \\(expectedCalls) max=\\(calls.max() ?? -1)")
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
    try window.append(pcm(SpeechWindow.segmentCapacity + SpeechWindow.stride), speech: true, decode: longDecode) { _ in }
    check(calls == [SpeechWindow.segmentCapacity, SpeechWindow.stride] && window.samples.count == SpeechWindow.stride, "live backlog exceeded segmentCapacity: \\(calls)")
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
                    let end = min(quietGapSignal.count, offset + SpeechWindow.stride)
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
                // Feed in stride batches so chunkCount >= 2 before reaching capacity, ending with final voiced+300ms silence batch hitting capacity+1600
                var pos = 0
                while pos < 192_000 {
                    try vadWin.append(Array(chunk[pos..<(pos + SpeechWindow.stride)]), speech: true, trailingSilence: 0, decode: vadDecode) { _ in }
                    pos += SpeechWindow.stride
                }
                let tailWithSilence = Array(chunk[pos..<216_000]) + Array(repeating: Float(0.0), count: 1_600)
                // Last 4,800 + 1,600 = 6,400 samples (< 11,200 vadPause) trailing silence; carried tail has speech + 6,400 trailing silence
                try vadWin.append(tailWithSilence, speech: true, trailingSilence: 6_400, decode: vadDecode) { _ in }
                check(!vadWin.samples.isEmpty, "carried tail unexpectedly cleared before 700ms pause")
                // Adding 300ms more silence (6,400 + 4,800 = 11,200 == vadPause) MUST commit and clear samples
                try vadWin.append(pcm(4_800), speech: false, decode: vadDecode) { _ in }
                check(vadWin.samples.isEmpty, "F1 regression: carried trailing silence lost across cap split, left \\(vadWin.samples.count) samples")
            } else {
                try vadWin.append(Array(repeating: Float(0.25), count: SpeechWindow.stride), speech: true, trailingSilence: 4_800, decode: vadDecode) { _ in }
                try vadWin.append(pcm(6_400), speech: false, decode: vadDecode) { _ in }
                check(vadWin.samples.isEmpty, "no-cap control did not commit at 700ms pause")
            }
            // Subsequent speech MUST start isolated with two warmup chunks (empty prefixTokens)
            seenPrefixes.removeAll()
            try vadWin.append(Array(repeating: Float(0.25), count: SpeechWindow.stride), speech: true, decode: vadDecode) { _ in }
            try vadWin.append(Array(repeating: Float(0.25), count: SpeechWindow.stride), speech: true, decode: vadDecode) { _ in }
            try vadWin.append(Array(repeating: Float(0.25), count: SpeechWindow.stride), speech: true, decode: vadDecode) { _ in }
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
            try spanWin.append(Array(repeating: Float(0.25), count: SpeechWindow.stride), speech: true, decode: spanDecode) { _ in }
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
    check(firstLevel != nil && abs(firstLevel! - 0.010) < 8e-4, "first quiet post-warmup audioLevel out of range: \\(String(describing: firstLevel))")
    _ = try levelInbox.offer(Array(repeating: 0.2, count: 320))
    check(levelInbox.pollAudioLevel(now: 0.07) == nil, "audioLevel not throttled at +20ms")
    _ = try levelInbox.offer(Array(repeating: 0.2, count: 320))
    check(levelInbox.pollAudioLevel(now: 0.099) == nil, "audioLevel not throttled at +49ms")
    let secondLevel = levelInbox.pollAudioLevel(now: 0.10)
    check(secondLevel != nil && abs(secondLevel! - 0.8) < 0.04, "throttled audioLevel did not emit scaled 0.8 at +50ms: \\(String(describing: secondLevel))")
    check(levelInbox.pollAudioLevel(now: 0.20) == nil, "duplicate audioLevel emitted without new samples")
    _ = try levelInbox.offer(Array(repeating: 1.5, count: 320))
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
    try window.append(pcm(SpeechWindow.stride), speech: true, decode: longDecode) { _ in }
    let beforeStop = calls.count
    // Remaining 32s accepted backlog on stop: split into 216,000-sample (13.5s) segments + bounded tail
    try window.append(pcm(SpeechInbox.limit), speech: true, final: true, decode: longDecode) { _ in fatalError("stop emitted partial") }
    _ = try window.finish(decode: longDecode)
    let stopCalls = Array(calls.dropFirst(beforeStop))
    let expectedStopTail = SpeechWindow.stride + SpeechInbox.limit - SpeechWindow.segmentCapacity * 2
    check(stopCalls == [216000, 216000, expectedStopTail + SpeechWindow.finalSilencePadding], "unexpected 32s stop split cadence: \\(stopCalls)")
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
    try window.append(pcm(SpeechWindow.stride), speech: true, decode: sentence) { _ in }
    try window.append(pcm(100), speech: true, decode: sentence) { _ in }
    do { _ = try window.finish(decode: { _, _ in nil }); fatalError("decode failure swallowed") }
    catch SpeechWindow.Failure.decode { check(window.text == "同一句。" && window.samples.count == SpeechWindow.stride + 100, "failed flush discarded previous text/PCM") }
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
        try! capture.window.append(pcm(SpeechWindow.stride), speech: true, decode: capture.decode) { _ in capture.events.append("partial") }
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
    check(capture.lengths == [SpeechWindow.stride, SpeechWindow.stride + 137 + SpeechWindow.finalSilencePadding], "accepted tail lost or decoded twice")
    check(capture.events == ["partial", "before tail last word", "stopped/ACK"], "final did not precede stopped/ACK")
    print("IN_FLIGHT_STOP:PASS")

    // Mid-decode & pre-append cancellation throws Failure.cancelled instead of Failure.decode or silent return
    window = SpeechWindow()
    do {
        try window.append(pcm(SpeechWindow.stride), speech: true, shouldContinue: { false }, decode: { _, _ in fatalError("should not decode after shouldContinue=false") }) { _ in }
        fatalError("pre-append cancellation returned silently")
    } catch SpeechWindow.Failure.cancelled { }
    var keepGoing = true
    do {
        try window.append(pcm(SpeechWindow.stride), speech: true, shouldContinue: { keepGoing }, decode: { _, _ in
            keepGoing = false
            return nil
        }) { _ in }
        fatalError("mid-decode cancellation did not throw Failure.cancelled")
    } catch SpeechWindow.Failure.cancelled {
        check(window.newSamples == SpeechWindow.stride, "cancelled decode lost un-flushed sample count")
    }
    print("MID_DECODE_CANCEL:PASS")
}
try run()
`;

it.skipIf(!swiftCompiler)('parses iOS StreamingSpeechPlugin.swift and executes prefill & transcribePcm offline PCM tests', async () => {
  await setup();
  const pluginPath = fileURLToPath(new URL('../../web/plugins/streaming-speech/ios/Sources/StreamingSpeechPlugin/StreamingSpeechPlugin.swift', import.meta.url));
  const plugin = await readFile(pluginPath, 'utf8');
  // 1. Full-file Swift parse check catches syntax/type-signature typos across the plugin.
  await runNativeOrThrow(swiftCompiler!, ['-parse', '-swift-version', '5', pluginPath], { timeout: 60000 });

  // 2. Execute production SpeechCoordinator prefill + StreamingSpeechPcmCodec offline transcription.
  const coordinatorSlice = plugin.slice(plugin.indexOf('final class SpeechCoordinator {'), plugin.indexOf('/// The same Capacitor'));
  const recognizerSlice = plugin.slice(plugin.indexOf('final class SpeechRecognizer {'), plugin.indexOf('// MARK: - Token Prefix Rollback'));
  const windowAndInboxSlice = plugin.slice(plugin.indexOf('struct SpeechWindow {'));
  expect(windowAndInboxSlice).toContain('enum StreamingSpeechPcmCodec');
  expect(coordinatorSlice).toContain('warmupSamples');

  const swiftFile = join(root, 'IosPrefillTranscribeTests.swift');
  const binFile = join(root, 'ios-prefill-transcribe-tests');
  await writeFile(swiftFile, `import Foundation
func check(_ cond: @autoclosure () -> Bool, _ msg: String) {
    if !cond() { FileHandle.standardError.write(Data(("FAIL: " + msg + "\\n").utf8)); exit(1) }
}
func MTLCreateSystemDefaultDevice() -> AnyObject? { NSObject() }
struct Qwen3DecodingOptions {
    var maxTokens: Int = 448
    var language: String? = nil
    var context: String? = nil
}
final class Qwen3ASRModel {
    let root: URL
    init(root: URL) { self.root = root }
    static func clearMetalCache() {}
    static func loadLocal(from root: URL) throws -> Qwen3ASRModel { Qwen3ASRModel(root: root) }
    func transcribeSegmentWithCancellation(
        audio: [Float],
        sampleRate: Int,
        options: Qwen3DecodingOptions,
        prefixTokens: [Int32] = [],
        checkCancellation: () throws -> Void
    ) throws -> (text: String, tokens: [Int32]) {
        try checkCancellation()
        return ("ok:\\(audio.count)", prefixTokens + [10, 11])
    }
    static func resolveLanguage(_ raw: String?) -> String? { raw }
    func safePrefixTokensForRollback(_ tokens: [Int32], rollbackCount: Int = 5, expectLanguageHeader: Bool = false) -> [Int32] {
        tokens.count > rollbackCount ? Array(tokens.dropLast(rollbackCount)) : []
    }
}
${recognizerSlice}
${windowAndInboxSlice}
${coordinatorSlice}

// 1. Decode little-endian Int16 base64 cleanly and reject corrupt odd-byte / invalid base64.
let intSamples: [Int16] = [0, 16384, -16384, 32767, -32768]
var pcmData = Data(capacity: intSamples.count * 2)
for s in intSamples {
    var le = s.littleEndian
    withUnsafeBytes(of: &le) { pcmData.append(contentsOf: $0) }
}
let decoded = StreamingSpeechPcmCodec.decodePcm16Base64(pcmData.base64EncodedString())
check(decoded != nil && decoded!.count == intSamples.count, "decode failed")
check(abs(decoded![1] - 0.5) < 1e-4 && abs(decoded![2] + 0.5) < 1e-4, "scaled decode mismatch")
check(StreamingSpeechPcmCodec.decodePcm16Base64("not-base64!") == nil, "invalid base64 must return nil")

// 2. SpeechCoordinator prefill with warmupSamples: 0 preserves all initial + live samples in chronological order.
let emitQ = DispatchQueue(label: "ios.prefill.emit")
var capturedSizes: [Int] = []
var capturedFirst: Float = 0
var events: [SpeechCoordinator.Event] = []
let coord = SpeechCoordinator(emitQueue: emitQ) { events.append($0) }
let initial = (0..<1600).map { Float($0 + 1) * 0.0001 }
let live = (0..<800).map { Float(2000 + $0) * 0.0001 }
let owner = coord.beginStart(
    warmupSamples: 0,
    makeDecode: {
        SpeechCoordinator.Decoder(
            decode: { samples, prefix, _ in
                capturedSizes.append(samples.count)
                capturedFirst = samples.first ?? 0
                return ("prefill_ok", prefix)
            },
            rollbackPrefix: { prefix, _ in prefix }
        )
    },
    onStartReady: {},
    onSetupFailureTeardown: {}
)
coord.offerSamples(initial, owner: owner, now: 0.01) {}
coord.offerSamples(live, owner: owner, now: 0.05) {}
let stopSem = DispatchSemaphore(value: 0)
var stopErr: String? = nil
coord.endCapture(stopCompletion: { err in stopErr = err; stopSem.signal() }, stopAudio: {})
check(stopSem.wait(timeout: .now() + 5) == .success && stopErr == nil, "stop timed out or erred")
check(capturedSizes.last == initial.count + live.count + SpeechWindow.finalSilencePadding,
      "unexpected prefill+live+padding count: \\(capturedSizes)")
check(capturedFirst > 0, "expected zero warmup clipping on first prefill sample")
check(emitQ.sync { events.contains(.final("prefill_ok")) }, "missing final event")

// 3. Offline transcribeOfflineSamples decodes >216,000 samples without truncating tail.
var offlineSizes: [Int] = []
var offlinePcm = [Float](repeating: 0.25, count: 250_000)
let offlineText = try StreamingSpeechPcmCodec.transcribeOfflineSamples(
    offlinePcm,
    rollbackPrefix: { tokens, _ in tokens },
    decode: { samples, prefix in
        offlineSizes.append(samples.count)
        return ("chunk_\\(offlineSizes.count)", prefix + [1, 2])
    },
    shouldContinue: { true }
)
check(offlineSizes.count >= 2 && !offlineText.isEmpty, "offline transcribe failed to decode multi-segment >216k audio")
print("IOS_PREFILL_TRANSCRIBE:PASS")
`);
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', swiftFile, '-o', binFile], { timeout: 120000 });
  expect((await runNativeOrThrow(binFile, [], { timeout: 60000 })).trim()).toBe('IOS_PREFILL_TRANSCRIBE:PASS');
}, 180_000);

it.skipIf(!swiftCompiler)('parses macOS ImcodesSpeechMlx main.swift and executes >216000-sample immediate stop & stop-before-finish segmentation', async () => {
  await setup();
  const mainSwiftPath = fileURLToPath(new URL('../../apps/pc-app/native/qwen3-asr/Sources/ImcodesSpeechMlx/main.swift', import.meta.url));
  const mainSwift = await readFile(mainSwiftPath, 'utf8');
  // 1. Full-file Swift parse check across main.swift.
  await runNativeOrThrow(swiftCompiler!, ['-parse', '-swift-version', '5', mainSwiftPath], { timeout: 60000 });

  // 2. Slice production joinTranscriptSegments, sanitizeAsrRepetitionLoop, and QwenSegmentedDecodeEngine.
  const joinSlice = mainSwift.slice(
    mainSwift.indexOf('func joinTranscriptSegments('),
    mainSwift.indexOf('private func readHotwords('),
  );
  const engineStart = mainSwift.indexOf('// MARK: - Segmented Decode Engine (Pure Foundation)');
  const engineEnd = mainSwift.indexOf('// MARK: - End Segmented Decode Engine');
  expect(engineStart).toBeGreaterThan(-1);
  expect(engineEnd).toBeGreaterThan(engineStart);
  const engineSlice = mainSwift.slice(engineStart, engineEnd);

  const swiftFile = join(root, 'MacSegmentedDecodeTests.swift');
  const binFile = join(root, 'mac-segmented-decode-tests');
  await writeFile(swiftFile, `import Foundation
func check(_ cond: @autoclosure () -> Bool, _ msg: String) {
    if !cond() { FileHandle.standardError.write(Data(("FAIL: " + msg + "\\n").utf8)); exit(1) }
}
${joinSlice}
${engineSlice}

func makeMarkedPcm(_ total: Int, _ seg1: Float, _ seg2: Float) -> [Float] {
    var pcm = [Float](repeating: seg1, count: total)
    if total > 216_000 {
        for i in 216_000..<total { pcm[i] = seg2 }
    }
    return pcm
}
func markerText(_ samples: [Float]) -> String {
    guard let first = samples.first else { return "" }
    return first < 0.35 ? "seg-one" : "seg-two"
}

// 1. >216,000 samples (250,000) prefilled + immediate normal stop -> decodes [216000, 34000] and emits ONE isFinal=true "seg-one seg-two".
do {
    let emitLock = NSLock()
    var emitted: [[String: Any]] = []
    var decodeSizes: [Int] = []
    let done = DispatchSemaphore(value: 0)
    let engine = QwenSegmentedDecodeEngine(
        expectLanguageHeader: false,
        decodeFn: { samples, prefix, checkCancel in
            try checkCancel()
            decodeSizes.append(samples.count)
            return QwenSegmentedDecodeResult(text: markerText(samples), tokens: prefix + [1])
        },
        rollbackPrefixFn: { tokens, _, _ in tokens },
        emitJsonFn: { payload in
            emitLock.lock()
            emitted.append(payload)
            emitLock.unlock()
        },
        onLoopFinishedFn: {
            done.signal()
        }
    )
    engine.preload(makeMarkedPcm(250_000, 0.2, 0.8))
    DispatchQueue.global(qos: .userInitiated).async { engine.runLoop() }
    engine.requestStop(abort: false, producerAlsoFinished: true)
    check(done.wait(timeout: .now() + 5) == .success, "case 1 timed out")
    check(decodeSizes == [216_000, 34_000], "case 1 decodeSizes mismatch: \\(decodeSizes)")
    let finals = emitted.filter { ($0["type"] as? String) == "result" && ($0["isFinal"] as? Bool) == true }
    check(finals.count == 1 && (finals[0]["text"] as? String) == "seg-one seg-two", "case 1 final mismatch: \\(finals)")
}

// 2. Trailing samples enqueued AFTER requestStop(abort: false, producerAlsoFinished: false) and BEFORE markProducerFinished() must be decoded.
do {
    let emitLock = NSLock()
    var emitted: [[String: Any]] = []
    let done = DispatchSemaphore(value: 0)
    let engine = QwenSegmentedDecodeEngine(
        expectLanguageHeader: false,
        decodeFn: { samples, prefix, checkCancel in
            try checkCancel()
            return QwenSegmentedDecodeResult(text: markerText(samples), tokens: prefix + [1])
        },
        rollbackPrefixFn: { tokens, _, _ in tokens },
        emitJsonFn: { payload in
            emitLock.lock()
            emitted.append(payload)
            emitLock.unlock()
        },
        onLoopFinishedFn: { done.signal() }
    )
    engine.preload([Float](repeating: 0.2, count: 216_000))
    DispatchQueue.global(qos: .userInitiated).async { engine.runLoop() }
    engine.requestStop(abort: false, producerAlsoFinished: false)
    Thread.sleep(forTimeInterval: 0.02)
    check(engine.enqueue([Float](repeating: 0.8, count: 4_000)), "trailing enqueue before markProducerFinished rejected")
    engine.markProducerFinished()
    check(done.wait(timeout: .now() + 5) == .success, "case 2 timed out")
    let finals = emitted.filter { ($0["type"] as? String) == "result" && ($0["isFinal"] as? Bool) == true }
    check(finals.count == 1 && (finals[0]["text"] as? String) == "seg-one seg-two", "case 2 final mismatch: \\(finals)")
}

// 3. Abort rejects new samples and never emits isFinal=true.
do {
    var emitted: [[String: Any]] = []
    let engine = QwenSegmentedDecodeEngine(
        expectLanguageHeader: false,
        decodeFn: { samples, prefix, checkCancel in
            try checkCancel()
            return QwenSegmentedDecodeResult(text: markerText(samples), tokens: prefix + [1])
        },
        rollbackPrefixFn: { tokens, _, _ in tokens },
        emitJsonFn: { emitted.append($0) },
        onLoopFinishedFn: {}
    )
    engine.preload(makeMarkedPcm(250_000, 0.2, 0.8))
    engine.requestStop(abort: true, producerAlsoFinished: true)
    engine.runLoop()
    check(!emitted.contains { ($0["isFinal"] as? Bool) == true }, "abort emitted isFinal")
}
print("MAC_SEGMENTED_DECODE:PASS")
`);
  await runNativeOrThrow(swiftCompiler!, ['-swift-version', '5', swiftFile, '-o', binFile], { timeout: 120000 });
  expect((await runNativeOrThrow(binFile, [], { timeout: 60000 })).trim()).toBe('MAC_SEGMENTED_DECODE:PASS');
}, 180_000);
