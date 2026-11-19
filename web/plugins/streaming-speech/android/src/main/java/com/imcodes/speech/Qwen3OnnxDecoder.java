package com.imcodes.speech;

import ai.onnxruntime.NodeInfo;
import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtLoggingLevel;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.nio.ShortBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;

/**
 * Direct ONNX Runtime Qwen3-ASR decoder supporting true Token Prefix Rollback.
 *
 * Replaces sherpa-onnx's high-level OfflineRecognizer with direct execution of
 * conv_frontend.onnx -> encoder.int4.onnx -> decoder.int4.onnx KV-cache loop,
 * allowing post-<asr_text> prefixTokens to be conditioned directly in the
 * assistant prompt turn without character-level seam stitching.
 */
public final class Qwen3OnnxDecoder implements AutoCloseable {
    public static final int DEFAULT_MAX_TOTAL_LEN = 768;
    public static final int DEFAULT_MAX_NEW_TOKENS = 192;
    private static final int QWEN3_CHUNK_SIZE = 100;
    private static final int QWEN3_CONV_TOKENS_PER_CHUNK = 13;
    private static final int QWEN3_ENC_WINDOW_TOKENS = 104;
    private static final float SILENT_FRAME_EPS = 1e-6f;
    private static final int LOOP_WINDOW = 64;
    private static final int LOOP_MAX_DISTINCT = 3;

    private static final String SYSTEM_PREFIX = "<|im_start|>system\n";
    private static final String SYSTEM_SUFFIX = "<|im_end|>\n<|im_start|>user\n<|audio_start|>";
    private static final String ASSISTANT_SUFFIX = "<|audio_end|><|im_end|>\n<|im_start|>assistant\n";

    private static final Map<String, String> LANGUAGE_MAP = buildLanguageMap();

    // Use HashMap + Collections.unmodifiableMap for minSdk 24 compatibility (avoid Java 9+ factory helpers).
    private static Map<String, String> buildLanguageMap() {
        Map<String, String> m = new HashMap<>(64);
        m.put("zh", "Chinese");
        m.put("cmn", "Chinese");
        m.put("chinese", "Chinese");
        m.put("yue", "Cantonese");
        m.put("cantonese", "Cantonese");
        m.put("en", "English");
        m.put("english", "English");
        m.put("ja", "Japanese");
        m.put("jp", "Japanese");
        m.put("japanese", "Japanese");
        m.put("ko", "Korean");
        m.put("korean", "Korean");
        m.put("es", "Spanish");
        m.put("spanish", "Spanish");
        m.put("ru", "Russian");
        m.put("russian", "Russian");
        m.put("fr", "French");
        m.put("french", "French");
        m.put("de", "German");
        m.put("german", "German");
        m.put("it", "Italian");
        m.put("italian", "Italian");
        m.put("pt", "Portuguese");
        m.put("portuguese", "Portuguese");
        m.put("ar", "Arabic");
        m.put("arabic", "Arabic");
        m.put("tr", "Turkish");
        m.put("turkish", "Turkish");
        m.put("vi", "Vietnamese");
        m.put("vietnamese", "Vietnamese");
        m.put("th", "Thai");
        m.put("thai", "Thai");
        m.put("id", "Indonesian");
        m.put("indonesian", "Indonesian");
        m.put("ms", "Malay");
        m.put("malay", "Malay");
        m.put("hi", "Hindi");
        m.put("hindi", "Hindi");
        m.put("nl", "Dutch");
        m.put("dutch", "Dutch");
        m.put("pl", "Polish");
        m.put("polish", "Polish");
        m.put("sv", "Swedish");
        m.put("swedish", "Swedish");
        m.put("da", "Danish");
        m.put("danish", "Danish");
        m.put("fi", "Finnish");
        m.put("finnish", "Finnish");
        m.put("cs", "Czech");
        m.put("czech", "Czech");
        m.put("el", "Greek");
        m.put("greek", "Greek");
        m.put("hu", "Hungarian");
        m.put("hungarian", "Hungarian");
        m.put("ro", "Romanian");
        m.put("romanian", "Romanian");
        m.put("fa", "Persian");
        m.put("persian", "Persian");
        m.put("fil", "Filipino");
        m.put("tl", "Filipino");
        m.put("filipino", "Filipino");
        m.put("mk", "Macedonian");
        m.put("macedonian", "Macedonian");
        return Collections.unmodifiableMap(m);
    }

    /**
     * Maps a BCP-47 locale tag or canonical language name to the canonical Qwen3-ASR
     * language string, or returns null for auto-detect (null, blank, "auto", or unknown).
     */
    public static String resolveLanguage(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) return null;
        String normalized = trimmed.replace('_', '-').toLowerCase(Locale.ROOT);
        if ("auto".equals(normalized)) return null;
        String exact = LANGUAGE_MAP.get(normalized);
        if (exact != null) return exact;
        int dash = normalized.indexOf('-');
        String primary = dash > 0 ? normalized.substring(0, dash) : normalized;
        return LANGUAGE_MAP.get(primary);
    }

    /** Builds the assistant prompt suffix, pinning a canonical language when requested or leaving it unconstrained for auto-detect. */
    public static String buildAssistantSuffix(String rawLanguage) {
        String canonical = resolveLanguage(rawLanguage);
        if (canonical == null) {
            return ASSISTANT_SUFFIX;
        }
        return ASSISTANT_SUFFIX + "language " + canonical + "<asr_text>";
    }

    private final OrtEnvironment env;
    private final OrtSession convSession;
    private final OrtSession encoderSession;
    private final OrtSession decoderSession;
    private final WhisperMelExtractor melExtractor;
    private final Qwen3Tokenizer tokenizer;

    private final String convInputName;
    private final String convOutputName;
    private final String encFeatureInputName;
    private final String encMaskInputName;
    private final String encOutputName;
    private final OnnxJavaType decoderAudioFeaturesType;
    private final String[] cacheKeyInputNames;
    private final String[] cacheValInputNames;
    private final String[] deltaKeyOutputNames;
    private final String[] deltaValOutputNames;

    private final int numLayers;
    private final int kvHeads;
    private final int headDim;
    private final int maxTotalLen;
    private final int maxNewTokens;
    private final OnnxJavaType kvKeyType;
    private final OnnxJavaType kvValType;
    private final int kvKeyElemBytes;
    private final int kvValElemBytes;
    private final int audioHiddenDim;

    private final ByteBuffer[] cacheKeyBuffers;
    private final ByteBuffer[] cacheValBuffers;
    private final OnnxTensor[] cacheKeyTensors;
    private final OnnxTensor[] cacheValTensors;

    private final int[] promptBeforeIds;
    private final int[] promptAfterIds;
    private final WhisperMelExtractor.IncrementalExtractor incrementalMel;
    private float[] cachedConvFeatures = new float[0];
    private int cachedConvMelFrames = 0;
    private int cachedConvTokens = 0;
    private int cachedConvHiddenDim = 0;
    private float[] cachedEncFeatures = new float[0];
    private int cachedEncTokens = 0;
    private int cachedEncHiddenDim = 0;
    private boolean kvPromptBeforeCached = false;
    private int kvCachedAudioTokens = 0;
    private float[] logitsScratch = new float[0];
    private volatile boolean closed = false;

    public Qwen3OnnxDecoder(
        File modelDir,
        String hotwordsFormatted,
        int numThreads,
        int configuredMaxTotalLen,
        int maxNewTokens
    ) throws IOException, OrtException {
        this.melExtractor = new WhisperMelExtractor();
        this.incrementalMel = this.melExtractor.new IncrementalExtractor();
        this.tokenizer = Qwen3Tokenizer.fromDirectory(new File(modelDir, "tokenizer"));
        this.maxNewTokens = maxNewTokens > 0 ? maxNewTokens : DEFAULT_MAX_NEW_TOKENS;

        String hw = hotwordsFormatted != null ? hotwordsFormatted.trim() : "";
        this.promptBeforeIds = tokenizer.encode(SYSTEM_PREFIX + hw + SYSTEM_SUFFIX);
        this.promptAfterIds = tokenizer.encode(ASSISTANT_SUFFIX);

        this.env = OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR, "qwen3-asr");
        try (OrtSession.SessionOptions opts = createSessionOptions(numThreads)) {
            this.convSession = env.createSession(new File(modelDir, "conv_frontend.onnx").getPath(), opts);
            this.encoderSession = env.createSession(new File(modelDir, "encoder.int4.onnx").getPath(), opts);
            this.decoderSession = env.createSession(new File(modelDir, "decoder.int4.onnx").getPath(), opts);
        } catch (OrtException | RuntimeException e) {
            closeQuietly();
            throw e;
        }

        this.convInputName = singleName(convSession.getInputNames(), "conv_frontend input");
        this.convOutputName = singleName(convSession.getOutputNames(), "conv_frontend output");

        Map<String, NodeInfo> encInputs = encoderSession.getInputInfo();
        String maskName = null;
        String featName = null;
        for (Map.Entry<String, NodeInfo> entry : encInputs.entrySet()) {
            TensorInfo ti = (TensorInfo) entry.getValue().getInfo();
            if (ti.type == OnnxJavaType.BOOL) {
                maskName = entry.getKey();
            } else {
                featName = entry.getKey();
            }
        }
        if (maskName == null || featName == null) {
            closeQuietly();
            throw new OrtException("encoder inputs must include float features and bool mask");
        }
        this.encFeatureInputName = featName;
        this.encMaskInputName = maskName;
        this.encOutputName = singleName(encoderSession.getOutputNames(), "encoder output");

        Map<String, NodeInfo> decInputs = decoderSession.getInputInfo();
        Set<String> decOutputNames = decoderSession.getOutputNames();
        if (decOutputNames.size() < 1 || ((decOutputNames.size() - 1) % 2) != 0) {
            closeQuietly();
            throw new OrtException("Unexpected decoder output count: " + decOutputNames.size());
        }
        this.numLayers = (decOutputNames.size() - 1) / 2;

        TensorInfo audioTi = (TensorInfo) decInputs.get("audio_features").getInfo();
        this.decoderAudioFeaturesType = audioTi.type;
        long[] audioShape = audioTi.getShape();
        this.audioHiddenDim = (audioShape.length >= 3 && audioShape[2] > 0) ? (int) audioShape[2] : 1024;

        NodeInfo key0Node = decInputs.get("cache_key_0");
        NodeInfo val0Node = decInputs.get("cache_value_0");
        if (key0Node == null || val0Node == null) {
            closeQuietly();
            throw new OrtException("decoder missing cache_key_0 / cache_value_0 inputs");
        }
        TensorInfo key0Info = (TensorInfo) key0Node.getInfo();
        TensorInfo val0Info = (TensorInfo) val0Node.getInfo();
        long[] keyShape = key0Info.getShape();
        if (keyShape.length < 4) {
            closeQuietly();
            throw new OrtException("Invalid cache_key_0 rank: " + keyShape.length);
        }
        int modelMaxLen = keyShape[1] > 0 ? (int) keyShape[1] : Integer.MAX_VALUE;
        int requestedMaxLen = configuredMaxTotalLen > 0 ? configuredMaxTotalLen : DEFAULT_MAX_TOTAL_LEN;
        this.maxTotalLen = Math.min(modelMaxLen, requestedMaxLen);
        this.kvHeads = (int) keyShape[2];
        this.headDim = (int) keyShape[3];
        this.kvKeyType = key0Info.type;
        this.kvValType = val0Info.type;
        this.kvKeyElemBytes = elementByteSize(kvKeyType);
        this.kvValElemBytes = elementByteSize(kvValType);

        this.cacheKeyInputNames = new String[numLayers];
        this.cacheValInputNames = new String[numLayers];
        this.deltaKeyOutputNames = new String[numLayers];
        this.deltaValOutputNames = new String[numLayers];
        this.cacheKeyBuffers = new ByteBuffer[numLayers];
        this.cacheValBuffers = new ByteBuffer[numLayers];
        this.cacheKeyTensors = new OnnxTensor[numLayers];
        this.cacheValTensors = new OnnxTensor[numLayers];

        int keyLayerCapBytes = this.maxTotalLen * this.kvHeads * this.headDim * this.kvKeyElemBytes;
        int valLayerCapBytes = this.maxTotalLen * this.kvHeads * this.headDim * this.kvValElemBytes;
        long[] cacheTensorShape = new long[] { 1L, this.maxTotalLen, this.kvHeads, this.headDim };
        try {
            for (int i = 0; i < numLayers; i++) {
                cacheKeyInputNames[i] = "cache_key_" + i;
                cacheValInputNames[i] = "cache_value_" + i;
                deltaKeyOutputNames[i] = "key_delta_" + i;
                deltaValOutputNames[i] = "value_delta_" + i;
                cacheKeyBuffers[i] = ByteBuffer.allocateDirect(keyLayerCapBytes).order(ByteOrder.nativeOrder());
                cacheValBuffers[i] = ByteBuffer.allocateDirect(valLayerCapBytes).order(ByteOrder.nativeOrder());
                cacheKeyTensors[i] = OnnxTensor.createTensor(env, cacheKeyBuffers[i], cacheTensorShape, kvKeyType);
                cacheValTensors[i] = OnnxTensor.createTensor(env, cacheValBuffers[i], cacheTensorShape, kvValType);
            }
        } catch (OrtException | RuntimeException e) {
            closeQuietly();
            throw e;
        }
    }

    private static OrtSession.SessionOptions createSessionOptions(int numThreads) throws OrtException {
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        int threads = numThreads > 0 ? numThreads : Math.min(4, Math.max(2, Runtime.getRuntime().availableProcessors() / 2));
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        opts.setIntraOpNumThreads(threads);
        opts.addConfigEntry("session.intra_op.allow_spinning", "0");
        opts.addConfigEntry("session.set_denormal_as_zero", "1");
        return opts;
    }

    private static String singleName(Set<String> names, String label) throws OrtException {
        if (names == null || names.size() != 1) {
            throw new OrtException("Expected exactly 1 " + label + ", found " + (names == null ? 0 : names.size()));
        }
        return names.iterator().next();
    }

    private static int elementByteSize(OnnxJavaType type) throws OrtException {
        if (type == OnnxJavaType.FLOAT) return 4;
        if (type == OnnxJavaType.FLOAT16 || type == OnnxJavaType.INT16 || type == OnnxJavaType.UINT8) {
            if (type == OnnxJavaType.UINT8) throw new OrtException("Unsupported KV element type: " + type);
            return 2;
        }
        throw new OrtException("Unsupported KV element type: " + type);
    }

    public int[] safePrefixTokensForRollback(int[] tokens, int rollbackCount) {
        return tokenizer.safePrefixTokensForRollback(tokens, rollbackCount);
    }

    public int[] safePrefixTokensForRollback(int[] tokens, int rollbackCount, boolean expectLanguageHeader) {
        return tokenizer.safePrefixTokensForRollback(tokens, rollbackCount, expectLanguageHeader);
    }

    /** Encodes the assistant prompt suffix tokens for the given language (or default unconstrained auto-detect suffix). */
    public static int[] encodePromptAfterIds(Qwen3Tokenizer tokenizer, String rawLanguage) {
        return tokenizer.encode(buildAssistantSuffix(rawLanguage));
    }

    /** Resets streaming mel/conv/encoder/KV segment caches between independent speech segments. */
    public synchronized void resetStreamingCache() {
        incrementalMel.reset();
        cachedConvMelFrames = 0;
        cachedConvTokens = 0;
        cachedEncTokens = 0;
        kvCachedAudioTokens = 0;
    }

    public synchronized Qwen3SpeechWindow.DecodeResult transcribe(
        float[] audio,
        int length,
        int[] prefixTokens,
        BooleanSupplier shouldContinue
    ) throws OrtException {
        return transcribe(audio, length, prefixTokens, null, shouldContinue);
    }

    public synchronized Qwen3SpeechWindow.DecodeResult transcribe(
        float[] audio,
        int length,
        int[] prefixTokens,
        String language,
        BooleanSupplier shouldContinue
    ) throws OrtException {
        if (closed || !shouldContinue.getAsBoolean()) return null;
        if (audio == null || length <= 0) {
            return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
        }

        WhisperMelExtractor.IncrementalMelResult incMel = incrementalMel.extract(audio, length);
        WhisperMelExtractor.MelFeatures mel = incMel.mel;
        if (mel.numFrames < 2) {
            return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
        }
        if (!shouldContinue.getAsBoolean()) return null;

        float[] trimmedAudioFeatures;
        int validAudioLen;
        int hiddenDim;
        int reuseEncTokens;

        OnnxTensor convInput = null;
        OrtSession.Result convRes = null;
        OnnxTensor encInput = null;
        OnnxTensor maskTensor = null;
        OrtSession.Result encRes = null;
        try {
            int maxReuseMel = Math.max(0, ((mel.numFrames - 1) / QWEN3_CHUNK_SIZE) * QWEN3_CHUNK_SIZE);
            int reuseMelFrames = Math.min(incMel.unchangedMelFrames, Math.min(cachedConvMelFrames, maxReuseMel));
            if (reuseMelFrames == 0) {
                cachedConvMelFrames = 0;
                cachedConvTokens = 0;
                cachedEncTokens = 0;
                kvCachedAudioTokens = 0;
            }
            int reuseConvTokens = (reuseMelFrames / QWEN3_CHUNK_SIZE) * QWEN3_CONV_TOKENS_PER_CHUNK;
            int tailMelFrames = mel.numFrames - reuseMelFrames;
            float[] tailMelData = reuseMelFrames == 0
                ? mel.data
                : Arrays.copyOfRange(mel.data, reuseMelFrames * WhisperMelExtractor.N_MELS, mel.numFrames * WhisperMelExtractor.N_MELS);

            convInput = OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(tailMelData),
                new long[] { 1L, tailMelFrames, WhisperMelExtractor.N_MELS }
            );
            convRes = convSession.run(Collections.singletonMap(convInputName, convInput));
            convInput.close();
            convInput = null;

            OnnxTensor convOut = getTensorOutput(convRes, convOutputName);
            long[] convShape = ((TensorInfo) convOut.getInfo()).getShape();
            if (convShape.length < 3 || convShape[1] <= 0 || convShape[2] <= 0) {
                return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
            }
            int tailConvFrames = (int) convShape[1];
            int convDim = (int) convShape[2];
            float[] tailConvFloats = readTensorAsFloats(convOut);
            convRes.close();
            convRes = null;

            if (cachedConvHiddenDim != convDim) {
                cachedConvHiddenDim = convDim;
                cachedConvMelFrames = 0;
                cachedConvTokens = 0;
                reuseConvTokens = 0;
            }
            int convFrames = reuseConvTokens + tailConvFrames;
            float[] fullConvFloats;
            if (reuseConvTokens == 0) {
                fullConvFloats = tailConvFloats;
            } else {
                fullConvFloats = new float[convFrames * convDim];
                System.arraycopy(cachedConvFeatures, 0, fullConvFloats, 0, reuseConvTokens * convDim);
                System.arraycopy(tailConvFloats, 0, fullConvFloats, reuseConvTokens * convDim, tailConvFrames * convDim);
            }
            int completeConvMelFrames = (mel.numFrames / QWEN3_CHUNK_SIZE) * QWEN3_CHUNK_SIZE;
            int completeConvTokens = Math.min(convFrames, (completeConvMelFrames / QWEN3_CHUNK_SIZE) * QWEN3_CONV_TOKENS_PER_CHUNK);
            if (completeConvTokens > 0) {
                int neededConvFloats = completeConvTokens * convDim;
                if (cachedConvFeatures.length < neededConvFloats) {
                    cachedConvFeatures = Arrays.copyOf(cachedConvFeatures, neededConvFloats);
                }
                if (completeConvTokens > reuseConvTokens) {
                    System.arraycopy(
                        fullConvFloats,
                        reuseConvTokens * convDim,
                        cachedConvFeatures,
                        reuseConvTokens * convDim,
                        (completeConvTokens - reuseConvTokens) * convDim
                    );
                }
                cachedConvMelFrames = completeConvMelFrames;
                cachedConvTokens = completeConvTokens;
            } else {
                cachedConvMelFrames = 0;
                cachedConvTokens = 0;
            }

            int expectedAudioTokens = featToAudioTokensLen(mel.numFrames, QWEN3_CHUNK_SIZE);
            int validFrames = Math.min(expectedAudioTokens, convFrames);
            if (validFrames <= 0 || !shouldContinue.getAsBoolean()) {
                return validFrames <= 0 ? new Qwen3SpeechWindow.DecodeResult("", new int[0]) : null;
            }

            int maxReuseEnc = Math.max(0, ((validFrames - 1) / QWEN3_ENC_WINDOW_TOKENS) * QWEN3_ENC_WINDOW_TOKENS);
            int maxAlignedConvEnc = (reuseConvTokens / QWEN3_ENC_WINDOW_TOKENS) * QWEN3_ENC_WINDOW_TOKENS;
            reuseEncTokens = Math.min(maxAlignedConvEnc, Math.min(cachedEncTokens, maxReuseEnc));
            if (reuseEncTokens == 0) {
                cachedEncTokens = 0;
                kvCachedAudioTokens = 0;
            }
            int encTailInFrames = convFrames - reuseEncTokens;
            int encTailValidFrames = validFrames - reuseEncTokens;
            float[] encTailIn = reuseEncTokens == 0
                ? fullConvFloats
                : Arrays.copyOfRange(fullConvFloats, reuseEncTokens * convDim, convFrames * convDim);

            encInput = OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(encTailIn),
                new long[] { 1L, encTailInFrames, convDim }
            );
            boolean[][] mask = new boolean[1][encTailInFrames];
            Arrays.fill(mask[0], 0, encTailValidFrames, true);
            maskTensor = OnnxTensor.createTensor(env, mask);

            Map<String, OnnxTensor> encInputs = new HashMap<>(2);
            encInputs.put(encFeatureInputName, encInput);
            encInputs.put(encMaskInputName, maskTensor);
            encRes = encoderSession.run(encInputs);

            maskTensor.close();
            maskTensor = null;
            encInput.close();
            encInput = null;

            OnnxTensor encOut = getTensorOutput(encRes, encOutputName);
            TensorInfo encInfo = (TensorInfo) encOut.getInfo();
            long[] encShape = encInfo.getShape();
            if (encShape.length < 3 || encShape[1] <= 0 || encShape[2] <= 0) {
                return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
            }
            int tailEncFrames = (int) encShape[1];
            hiddenDim = (int) encShape[2];
            float[] tailEncFloats = readTensorAsFloats(encOut);
            encRes.close();
            encRes = null;

            if (cachedEncHiddenDim != hiddenDim) {
                cachedEncHiddenDim = hiddenDim;
                cachedEncTokens = 0;
                kvCachedAudioTokens = 0;
                reuseEncTokens = 0;
            }
            int boundedFrames = Math.min(validFrames, reuseEncTokens + tailEncFrames);
            float[] allEnc = new float[boundedFrames * hiddenDim];
            if (reuseEncTokens > 0) {
                System.arraycopy(cachedEncFeatures, 0, allEnc, 0, reuseEncTokens * hiddenDim);
            }
            int tailCopyFrames = boundedFrames - reuseEncTokens;
            if (tailCopyFrames > 0) {
                System.arraycopy(tailEncFloats, 0, allEnc, reuseEncTokens * hiddenDim, tailCopyFrames * hiddenDim);
            }

            int completeEncTokens = (boundedFrames / QWEN3_ENC_WINDOW_TOKENS) * QWEN3_ENC_WINDOW_TOKENS;
            if (completeEncTokens > 0) {
                int neededEncFloats = completeEncTokens * hiddenDim;
                if (cachedEncFeatures.length < neededEncFloats) {
                    cachedEncFeatures = Arrays.copyOf(cachedEncFeatures, neededEncFloats);
                }
                if (completeEncTokens > reuseEncTokens) {
                    System.arraycopy(
                        allEnc,
                        reuseEncTokens * hiddenDim,
                        cachedEncFeatures,
                        reuseEncTokens * hiddenDim,
                        (completeEncTokens - reuseEncTokens) * hiddenDim
                    );
                }
                cachedEncTokens = completeEncTokens;
            } else {
                cachedEncTokens = 0;
            }

            validAudioLen = countNonSilentFrames(allEnc, boundedFrames, hiddenDim);
            if (validAudioLen <= 0) {
                return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
            }
            trimmedAudioFeatures = validAudioLen == boundedFrames
                ? allEnc
                : Arrays.copyOf(allEnc, validAudioLen * hiddenDim);
        } finally {
            closeQuietly(convInput, convRes, encInput, maskTensor, encRes);
        }

        if (!shouldContinue.getAsBoolean()) return null;

        String canonicalLanguage = resolveLanguage(language);
        boolean expectLanguageHeader = canonicalLanguage == null;
        int[] activePromptAfterIds = canonicalLanguage == null
            ? promptAfterIds
            : encodePromptAfterIds(tokenizer, canonicalLanguage);

        int[] activePrefix = prefixTokens != null ? prefixTokens : new int[0];
        int scaffoldLen = promptBeforeIds.length + activePromptAfterIds.length;
        int maxAudioRoom = Math.max(0, maxTotalLen - scaffoldLen - activePrefix.length - 1);
        if (maxAudioRoom == 0 && activePrefix.length > 0) {
            // Preserve audio capacity if unusually long hotwords + prefix tightens context.
            activePrefix = new int[0];
            maxAudioRoom = Math.max(0, maxTotalLen - scaffoldLen - 1);
        }
        if (validAudioLen > maxAudioRoom) {
            validAudioLen = maxAudioRoom;
            if (validAudioLen <= 0) {
                return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
            }
            trimmedAudioFeatures = Arrays.copyOf(trimmedAudioFeatures, validAudioLen * hiddenDim);
        }

        return runDecoderLoop(
            trimmedAudioFeatures,
            validAudioLen,
            hiddenDim,
            reuseEncTokens,
            activePromptAfterIds,
            activePrefix,
            expectLanguageHeader,
            shouldContinue
        );
    }

    private void ensurePromptBeforeKvCached(int keyRowStrideBytes, int valRowStrideBytes) throws OrtException {
        if (kvPromptBeforeCached) return;
        if (promptBeforeIds.length == 0) {
            kvPromptBeforeCached = true;
            return;
        }
        int len = promptBeforeIds.length;
        long[] ids = new long[len];
        long[] mask = new long[len];
        long[] pos = new long[len];
        for (int i = 0; i < len; i++) {
            ids[i] = promptBeforeIds[i];
            mask[i] = 1L;
            pos[i] = i;
        }
        OnnxTensor dummyAudio = null;
        OnnxTensor idsTensor = null;
        OnnxTensor maskTensor = null;
        OnnxTensor posTensor = null;
        OrtSession.Result res = null;
        try {
            dummyAudio = createAudioFeaturesTensor(new float[audioHiddenDim], 1, audioHiddenDim);
            idsTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(ids), new long[] { 1L, len });
            maskTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(mask), new long[] { 1L, len });
            posTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(pos), new long[] { len });

            Map<String, OnnxTensor> inputs = new HashMap<>(4 + 2 * numLayers);
            inputs.put("audio_features", dummyAudio);
            inputs.put("input_ids", idsTensor);
            inputs.put("attention_mask", maskTensor);
            inputs.put("cache_position", posTensor);
            for (int i = 0; i < numLayers; i++) {
                inputs.put(cacheKeyInputNames[i], cacheKeyTensors[i]);
                inputs.put(cacheValInputNames[i], cacheValTensors[i]);
            }
            res = decoderSession.run(inputs);
            applyKvDeltaInplace(res, 0, len, keyRowStrideBytes, valRowStrideBytes);
            kvPromptBeforeCached = true;
            kvCachedAudioTokens = 0;
        } finally {
            closeQuietly(dummyAudio, idsTensor, maskTensor, posTensor, res);
        }
    }

    private Qwen3SpeechWindow.DecodeResult runDecoderLoop(
        float[] audioFeatures,
        int audioFrames,
        int hiddenDim,
        int reuseEncTokens,
        int[] activePromptAfterIds,
        int[] activePrefix,
        boolean expectLanguageHeader,
        BooleanSupplier shouldContinue
    ) throws OrtException {
        OnnxTensor audioTensor = null;
        int keyRowStrideBytes = kvHeads * headDim * kvKeyElemBytes;
        int valRowStrideBytes = kvHeads * headDim * kvValElemBytes;

        int kvReusableAudio = (reuseEncTokens > 0 && kvCachedAudioTokens > 0)
            ? Math.min(reuseEncTokens, Math.min(kvCachedAudioTokens, Math.max(0, audioFrames - 1)))
            : 0;
        if (kvReusableAudio > 0 && !kvPromptBeforeCached) {
            ensurePromptBeforeKvCached(keyRowStrideBytes, valRowStrideBytes);
        }

        boolean includePromptBeforeInPrefill = (kvReusableAudio == 0 && !kvPromptBeforeCached);
        int pos0 = includePromptBeforeInPrefill ? 0 : (promptBeforeIds.length + kvReusableAudio);
        int tailAudioFrames = audioFrames - kvReusableAudio;
        float[] tailAudioFeatures = kvReusableAudio == 0
            ? audioFeatures
            : Arrays.copyOfRange(audioFeatures, kvReusableAudio * hiddenDim, audioFrames * hiddenDim);

        int promptBeforeLen = includePromptBeforeInPrefill ? promptBeforeIds.length : 0;
        int tailCtxLen = promptBeforeLen + tailAudioFrames + activePromptAfterIds.length + activePrefix.length;
        long[] tailIds = new long[tailCtxLen];
        int p = 0;
        if (includePromptBeforeInPrefill) {
            for (int id : promptBeforeIds) tailIds[p++] = id;
        }
        for (int i = 0; i < tailAudioFrames; i++) tailIds[p++] = tokenizer.audioPadTokenId;
        for (int id : activePromptAfterIds) tailIds[p++] = id;
        for (int id : activePrefix) tailIds[p++] = id;
        int contextLen = pos0 + tailCtxLen;

        try {
            audioTensor = createAudioFeaturesTensor(tailAudioFeatures, tailAudioFrames, hiddenDim);

            Map<String, OnnxTensor> decoderInputs = new HashMap<>(4 + 2 * numLayers);
            decoderInputs.put("audio_features", audioTensor);
            for (int i = 0; i < numLayers; i++) {
                decoderInputs.put(cacheKeyInputNames[i], cacheKeyTensors[i]);
                decoderInputs.put(cacheValInputNames[i], cacheValTensors[i]);
            }

            long[] attnMask = new long[tailCtxLen];
            Arrays.fill(attnMask, 1L);
            long[] cachePos = new long[tailCtxLen];
            for (int i = 0; i < tailCtxLen; i++) cachePos[i] = pos0 + i;

            int nextId;
            OnnxTensor idsTensor = null;
            OnnxTensor maskTensor = null;
            OnnxTensor posTensor = null;
            OrtSession.Result prefillRes = null;
            try {
                idsTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(tailIds), new long[] { 1L, tailCtxLen });
                maskTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(attnMask), new long[] { 1L, tailCtxLen });
                posTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(cachePos), new long[] { tailCtxLen });
                decoderInputs.put("input_ids", idsTensor);
                decoderInputs.put("attention_mask", maskTensor);
                decoderInputs.put("cache_position", posTensor);

                prefillRes = decoderSession.run(decoderInputs);
                applyKvDeltaInplace(prefillRes, pos0, tailCtxLen, keyRowStrideBytes, valRowStrideBytes);
                if (includePromptBeforeInPrefill) {
                    kvPromptBeforeCached = true;
                }
                kvCachedAudioTokens = Math.min(cachedEncTokens, audioFrames);
                OnnxTensor logitsTensor = getTensorOutput(prefillRes, "logits");
                nextId = sampleGreedyFromLogits(logitsTensor, tailCtxLen - 1, -1);
            } catch (OrtException | RuntimeException e) {
                kvCachedAudioTokens = 0;
                throw e;
            } finally {
                closeQuietly(idsTensor, maskTensor, posTensor, prefillRes);
            }

            if (nextId < 0 || nextId == tokenizer.eosTokenId) {
                return buildDecodeResult(activePrefix, new int[0], 0, expectLanguageHeader);
            }

            int[] generated = new int[maxNewTokens];
            int genCount = 0;
            generated[genCount++] = nextId;
            int curLen = contextLen;

            long[] oneId = new long[1];
            long[] oneMask = new long[] { 1L };
            long[] onePos = new long[1];
            long[] oneShape2d = new long[] { 1L, 1L };
            long[] oneShape1d = new long[] { 1L };

            for (int step = 1; step < maxNewTokens; step++) {
                if (!shouldContinue.getAsBoolean()) return null;
                if (curLen >= maxTotalLen) break;

                oneId[0] = nextId;
                onePos[0] = curLen;

                OnnxTensor stepIds = null;
                OnnxTensor stepMask = null;
                OnnxTensor stepPos = null;
                OrtSession.Result stepRes = null;
                int sampled;
                try {
                    stepIds = OnnxTensor.createTensor(env, LongBuffer.wrap(oneId), oneShape2d);
                    stepMask = OnnxTensor.createTensor(env, LongBuffer.wrap(oneMask), oneShape2d);
                    stepPos = OnnxTensor.createTensor(env, LongBuffer.wrap(onePos), oneShape1d);
                    decoderInputs.put("input_ids", stepIds);
                    decoderInputs.put("attention_mask", stepMask);
                    decoderInputs.put("cache_position", stepPos);

                    stepRes = decoderSession.run(decoderInputs);
                    applyKvDeltaInplace(stepRes, curLen, 1, keyRowStrideBytes, valRowStrideBytes);
                    OnnxTensor logitsTensor = getTensorOutput(stepRes, "logits");
                    long[] logShape = ((TensorInfo) logitsTensor.getInfo()).getShape();
                    if (logShape.length < 3 || logShape[1] < 1) break;
                    sampled = sampleGreedyFromLogits(logitsTensor, (int) logShape[1] - 1, -1);
                } finally {
                    closeQuietly(stepIds, stepMask, stepPos, stepRes);
                }

                if (sampled < 0 || sampled == tokenizer.eosTokenId) break;
                nextId = sampled;
                generated[genCount++] = nextId;
                curLen++;

                if (isDegenerateRepetition(generated, genCount)) {
                    genCount = trimDegenerateTail(generated, genCount);
                    break;
                }
            }

            return buildDecodeResult(activePrefix, generated, genCount, expectLanguageHeader);
        } finally {
            closeQuietly(audioTensor);
        }
    }

    private Qwen3SpeechWindow.DecodeResult buildDecodeResult(
        int[] activePrefix,
        int[] generated,
        int genCount,
        boolean expectLanguageHeader
    ) {
        int cleanGen = genCount;
        while (cleanGen > 0 && (generated[cleanGen - 1] == tokenizer.eosTokenId || generated[cleanGen - 1] == tokenizer.padTokenId)) {
            cleanGen--;
        }
        int prefixLen = activePrefix != null ? activePrefix.length : 0;
        int[] fullTokens = new int[prefixLen + cleanGen];
        if (prefixLen > 0) {
            System.arraycopy(activePrefix, 0, fullTokens, 0, prefixLen);
        }
        if (cleanGen > 0) {
            System.arraycopy(generated, 0, fullTokens, prefixLen, cleanGen);
        }
        String text = tokenizer.extractFinalText(fullTokens, expectLanguageHeader);
        return new Qwen3SpeechWindow.DecodeResult(text, fullTokens);
    }

    private OnnxTensor createAudioFeaturesTensor(float[] audioFeatures, int frames, int hiddenDim) throws OrtException {
        long[] shape = new long[] { 1L, frames, hiddenDim };
        if (decoderAudioFeaturesType == OnnxJavaType.FLOAT16) {
            ByteBuffer bb = ByteBuffer.allocateDirect(audioFeatures.length * 2).order(ByteOrder.nativeOrder());
            ShortBuffer sb = bb.asShortBuffer();
            for (float v : audioFeatures) {
                sb.put(floatToHalfBits(v));
            }
            return OnnxTensor.createTensor(env, bb, shape, OnnxJavaType.FLOAT16);
        }
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(audioFeatures), shape);
    }

    private void applyKvDeltaInplace(
        OrtSession.Result result,
        int pos0,
        int seqLen,
        int keyRowStrideBytes,
        int valRowStrideBytes
    ) throws OrtException {
        int clampedSeq = Math.min(seqLen, maxTotalLen - pos0);
        if (clampedSeq <= 0) return;

        for (int layer = 0; layer < numLayers; layer++) {
            OnnxTensor deltaK = getTensorOutput(result, deltaKeyOutputNames[layer]);
            OnnxTensor deltaV = getTensorOutput(result, deltaValOutputNames[layer]);
            copyDeltaSlice(deltaK, cacheKeyBuffers[layer], pos0, clampedSeq, keyRowStrideBytes, kvKeyType);
            copyDeltaSlice(deltaV, cacheValBuffers[layer], pos0, clampedSeq, valRowStrideBytes, kvValType);
        }
    }

    private static void copyDeltaSlice(
        OnnxTensor srcTensor,
        ByteBuffer dstBuffer,
        int pos0,
        int copySeq,
        int rowStrideBytes,
        OnnxJavaType dstType
    ) throws OrtException {
        TensorInfo info = (TensorInfo) srcTensor.getInfo();
        ByteBuffer srcBytes = srcTensor.getByteBuffer().duplicate().order(ByteOrder.nativeOrder());
        int totalCopyBytes = copySeq * rowStrideBytes;
        ByteBuffer dstSlice = dstBuffer.duplicate().order(ByteOrder.nativeOrder());
        dstSlice.position(pos0 * rowStrideBytes);

        if (info.type == dstType) {
            int limit = Math.min(srcBytes.remaining(), totalCopyBytes);
            srcBytes.limit(srcBytes.position() + limit);
            dstSlice.put(srcBytes);
            return;
        }
        // Fallback element conversion when delta dtype differs from cache dtype (fp16 <-> fp32).
        int count = copySeq * (rowStrideBytes / (dstType == OnnxJavaType.FLOAT ? 4 : 2));
        if (info.type == OnnxJavaType.FLOAT && dstType == OnnxJavaType.FLOAT16) {
            FloatBuffer fb = srcTensor.getFloatBuffer();
            ShortBuffer db = dstSlice.asShortBuffer();
            for (int i = 0; i < count; i++) db.put(floatToHalfBits(fb.get(i)));
        } else if (info.type == OnnxJavaType.FLOAT16 && dstType == OnnxJavaType.FLOAT) {
            ShortBuffer sb = srcTensor.getShortBuffer();
            FloatBuffer fb = dstSlice.asFloatBuffer();
            for (int i = 0; i < count; i++) fb.put(halfBitsToFloat(sb.get(i)));
        } else {
            throw new OrtException("Incompatible KV delta type: src=" + info.type + " dst=" + dstType);
        }
    }

    private int sampleGreedyFromLogits(OnnxTensor logitsTensor, int timeIndex, int avoidTokenId) {
        TensorInfo info = (TensorInfo) logitsTensor.getInfo();
        long[] shape = info.getShape();
        if (shape.length < 3 || timeIndex < 0 || timeIndex >= shape[1] || shape[2] <= 0) {
            return -1;
        }
        int vocabSize = (int) shape[2];
        int offset = timeIndex * vocabSize;
        int best = -1;
        float bestVal = Float.NEGATIVE_INFINITY;

        if (info.type == OnnxJavaType.FLOAT16 || info.type == OnnxJavaType.INT16) {
            ShortBuffer sb = logitsTensor.getShortBuffer();
            for (int i = 0; i < vocabSize; i++) {
                if (i == avoidTokenId) continue;
                float v = halfBitsToFloat(sb.get(offset + i));
                if (Float.isFinite(v) && v > bestVal) {
                    bestVal = v;
                    best = i;
                }
            }
        } else {
            if (logitsScratch.length < vocabSize) {
                logitsScratch = new float[vocabSize];
            }
            FloatBuffer fb = logitsTensor.getFloatBuffer().duplicate();
            fb.position(offset);
            fb.get(logitsScratch, 0, vocabSize);
            for (int i = 0; i < vocabSize; i++) {
                if (i == avoidTokenId) continue;
                float v = logitsScratch[i];
                if (Float.isFinite(v) && v > bestVal) {
                    bestVal = v;
                    best = i;
                }
            }
        }
        return best;
    }

    private static OnnxTensor getTensorOutput(OrtSession.Result res, String name) throws OrtException {
        OnnxValue value = res.get(name).orElseThrow(() -> new OrtException("Missing ORT output: " + name));
        if (!(value instanceof OnnxTensor)) {
            throw new OrtException("Expected tensor output for " + name);
        }
        return (OnnxTensor) value;
    }

    private static float[] readTensorAsFloats(OnnxTensor tensor) throws OrtException {
        TensorInfo info = (TensorInfo) tensor.getInfo();
        int count = (int) info.getNumElements();
        float[] out = new float[count];
        if (info.type == OnnxJavaType.FLOAT16 || info.type == OnnxJavaType.INT16) {
            ShortBuffer sb = tensor.getShortBuffer();
            for (int i = 0; i < count; i++) {
                out[i] = halfBitsToFloat(sb.get(i));
            }
        } else {
            FloatBuffer fb = tensor.getFloatBuffer();
            fb.get(out, 0, count);
        }
        return out;
    }

    static int countNonSilentFrames(float[] features, int frames, int hiddenDim) {
        for (int a = frames - 1; a >= 0; a--) {
            int rowOffset = a * hiddenDim;
            float maxEnergy = 0.0f;
            for (int h = 0; h < hiddenDim; h++) {
                float absVal = Math.abs(features[rowOffset + h]);
                if (absVal > maxEnergy) maxEnergy = absVal;
            }
            if (maxEnergy > SILENT_FRAME_EPS) {
                return a + 1;
            }
        }
        return 0;
    }

    static int featToAudioTokensLen(int featLen, int chunkSize) {
        if (featLen <= 0 || chunkSize <= 0) return 0;
        int full = featLen / chunkSize;
        int rem = featLen % chunkSize;
        int tn = convOutLen3xStride2(chunkSize);
        int out = full * tn;
        if (rem > 0) {
            out += afterCnn(rem);
        }
        return Math.max(out, 0);
    }

    private static int convOutLen3xStride2(int n) {
        int x = (n + 1) / 2;
        x = (x + 1) / 2;
        return (x + 1) / 2;
    }

    private static int afterCnn(int x) {
        if (x <= 0) return 0;
        x = (x - 1) / 2 + 1;
        x = (x - 1) / 2 + 1;
        return (x - 1) / 2 + 1;
    }

    static boolean isDegenerateRepetition(int[] ids, int len) {
        if (len < LOOP_WINDOW) return false;
        int[] distinct = new int[LOOP_MAX_DISTINCT];
        int numDistinct = 0;
        for (int i = len - LOOP_WINDOW; i < len; i++) {
            int val = ids[i];
            boolean seen = false;
            for (int k = 0; k < numDistinct; k++) {
                if (distinct[k] == val) {
                    seen = true;
                    break;
                }
            }
            if (seen) continue;
            if (numDistinct == LOOP_MAX_DISTINCT) return false;
            distinct[numDistinct++] = val;
        }
        return true;
    }

    static int trimDegenerateTail(int[] ids, int len) {
        if (len < LOOP_WINDOW) return len;
        int[] distinct = new int[LOOP_MAX_DISTINCT];
        int numDistinct = 0;
        int windowStart = len - LOOP_WINDOW;
        for (int i = windowStart; i < len; i++) {
            int val = ids[i];
            boolean seen = false;
            for (int k = 0; k < numDistinct; k++) {
                if (distinct[k] == val) {
                    seen = true;
                    break;
                }
            }
            if (!seen && numDistinct < LOOP_MAX_DISTINCT) {
                distinct[numDistinct++] = val;
            }
        }
        int keep = len;
        while (keep > windowStart) {
            int val = ids[keep - 1];
            boolean inLoop = false;
            for (int k = 0; k < numDistinct; k++) {
                if (distinct[k] == val) {
                    inLoop = true;
                    break;
                }
            }
            if (!inLoop) break;
            keep--;
        }
        return keep;
    }

    static float halfBitsToFloat(short halfBits) {
        int h = halfBits & 0xFFFF;
        int sign = (h & 0x8000) << 16;
        int exp = (h & 0x7C00) >>> 10;
        int mant = h & 0x03FF;
        if (exp == 0) {
            if (mant == 0) return Float.intBitsToFloat(sign);
            while ((mant & 0x0400) == 0) {
                mant <<= 1;
                exp -= 1;
            }
            exp += 1;
            mant &= 0x03FF;
        } else if (exp == 31) {
            return Float.intBitsToFloat(sign | 0x7F800000 | (mant << 13));
        }
        int fExp = (exp + (127 - 15)) << 23;
        return Float.intBitsToFloat(sign | fExp | (mant << 13));
    }

    static short floatToHalfBits(float val) {
        int bits = Float.floatToRawIntBits(val);
        int sign = (bits >>> 16) & 0x8000;
        int exp = ((bits >>> 23) & 0xFF) - 127 + 15;
        int mant = bits & 0x007FFFFF;
        if (exp <= 0) {
            if (exp < -10) return (short) sign;
            mant |= 0x00800000;
            int shift = 14 - exp;
            return (short) (sign | (mant >>> shift));
        }
        if (exp >= 31) {
            return (short) (sign | 0x7C00 | (mant != 0 ? 0x0200 : 0));
        }
        return (short) (sign | (exp << 10) | (mant >>> 13));
    }

    private static void closeQuietly(AutoCloseable... closeables) {
        for (AutoCloseable c : closeables) {
            if (c != null) {
                try {
                    c.close();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void closeQuietly() {
        if (cacheKeyTensors != null) {
            for (OnnxTensor t : cacheKeyTensors) closeQuietly(t);
        }
        if (cacheValTensors != null) {
            for (OnnxTensor t : cacheValTensors) closeQuietly(t);
        }
        closeQuietly(convSession, encoderSession, decoderSession);
    }

    @Override
    public synchronized void close() {
        if (closed) return;
        closed = true;
        closeQuietly();
    }
}
