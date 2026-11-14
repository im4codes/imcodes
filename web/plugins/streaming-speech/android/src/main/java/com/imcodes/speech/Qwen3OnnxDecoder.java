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
    private static final float SILENT_FRAME_EPS = 1e-6f;
    private static final int LOOP_WINDOW = 64;
    private static final int LOOP_MAX_DISTINCT = 3;

    private static final String SYSTEM_PREFIX = "<|im_start|>system\n";
    private static final String SYSTEM_SUFFIX = "<|im_end|>\n<|im_start|>user\n<|audio_start|>";
    private static final String ASSISTANT_SUFFIX = "<|audio_end|><|im_end|>\n<|im_start|>assistant\n";

    private static final Map<String, String> LANGUAGE_MAP = Map.ofEntries(
        Map.entry("zh", "Chinese"),
        Map.entry("cmn", "Chinese"),
        Map.entry("chinese", "Chinese"),
        Map.entry("yue", "Cantonese"),
        Map.entry("cantonese", "Cantonese"),
        Map.entry("en", "English"),
        Map.entry("english", "English"),
        Map.entry("ja", "Japanese"),
        Map.entry("jp", "Japanese"),
        Map.entry("japanese", "Japanese"),
        Map.entry("ko", "Korean"),
        Map.entry("korean", "Korean"),
        Map.entry("es", "Spanish"),
        Map.entry("spanish", "Spanish"),
        Map.entry("ru", "Russian"),
        Map.entry("russian", "Russian"),
        Map.entry("fr", "French"),
        Map.entry("french", "French"),
        Map.entry("de", "German"),
        Map.entry("german", "German"),
        Map.entry("it", "Italian"),
        Map.entry("italian", "Italian"),
        Map.entry("pt", "Portuguese"),
        Map.entry("portuguese", "Portuguese"),
        Map.entry("ar", "Arabic"),
        Map.entry("arabic", "Arabic"),
        Map.entry("tr", "Turkish"),
        Map.entry("turkish", "Turkish"),
        Map.entry("vi", "Vietnamese"),
        Map.entry("vietnamese", "Vietnamese"),
        Map.entry("th", "Thai"),
        Map.entry("thai", "Thai"),
        Map.entry("id", "Indonesian"),
        Map.entry("indonesian", "Indonesian"),
        Map.entry("ms", "Malay"),
        Map.entry("malay", "Malay"),
        Map.entry("hi", "Hindi"),
        Map.entry("hindi", "Hindi"),
        Map.entry("nl", "Dutch"),
        Map.entry("dutch", "Dutch"),
        Map.entry("pl", "Polish"),
        Map.entry("polish", "Polish"),
        Map.entry("sv", "Swedish"),
        Map.entry("swedish", "Swedish"),
        Map.entry("da", "Danish"),
        Map.entry("danish", "Danish"),
        Map.entry("fi", "Finnish"),
        Map.entry("finnish", "Finnish"),
        Map.entry("cs", "Czech"),
        Map.entry("czech", "Czech"),
        Map.entry("el", "Greek"),
        Map.entry("greek", "Greek"),
        Map.entry("hu", "Hungarian"),
        Map.entry("hungarian", "Hungarian"),
        Map.entry("ro", "Romanian"),
        Map.entry("romanian", "Romanian"),
        Map.entry("fa", "Persian"),
        Map.entry("persian", "Persian"),
        Map.entry("fil", "Filipino"),
        Map.entry("tl", "Filipino"),
        Map.entry("filipino", "Filipino"),
        Map.entry("mk", "Macedonian"),
        Map.entry("macedonian", "Macedonian")
    );

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

    private final ByteBuffer[] cacheKeyBuffers;
    private final ByteBuffer[] cacheValBuffers;

    private final int[] promptBeforeIds;
    private final int[] promptAfterIds;
    private volatile boolean closed = false;

    public Qwen3OnnxDecoder(
        File modelDir,
        String hotwordsFormatted,
        int numThreads,
        int configuredMaxTotalLen,
        int maxNewTokens
    ) throws IOException, OrtException {
        this.melExtractor = new WhisperMelExtractor();
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

        int keyLayerCapBytes = this.maxTotalLen * this.kvHeads * this.headDim * this.kvKeyElemBytes;
        int valLayerCapBytes = this.maxTotalLen * this.kvHeads * this.headDim * this.kvValElemBytes;
        for (int i = 0; i < numLayers; i++) {
            cacheKeyInputNames[i] = "cache_key_" + i;
            cacheValInputNames[i] = "cache_value_" + i;
            deltaKeyOutputNames[i] = "key_delta_" + i;
            deltaValOutputNames[i] = "value_delta_" + i;
            cacheKeyBuffers[i] = ByteBuffer.allocateDirect(keyLayerCapBytes).order(ByteOrder.nativeOrder());
            cacheValBuffers[i] = ByteBuffer.allocateDirect(valLayerCapBytes).order(ByteOrder.nativeOrder());
        }
    }

    private static OrtSession.SessionOptions createSessionOptions(int numThreads) throws OrtException {
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        int threads = numThreads > 0 ? numThreads : Math.min(4, Math.max(2, Runtime.getRuntime().availableProcessors() / 2));
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        opts.setIntraOpNumThreads(threads);
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

    /** Encodes the assistant prompt suffix tokens for the given language (or default unconstrained auto-detect suffix). */
    public static int[] encodePromptAfterIds(Qwen3Tokenizer tokenizer, String rawLanguage) {
        return tokenizer.encode(buildAssistantSuffix(rawLanguage));
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

        WhisperMelExtractor.MelFeatures mel = melExtractor.extract(audio, length);
        if (mel.numFrames < 2) {
            return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
        }
        if (!shouldContinue.getAsBoolean()) return null;

        float[] trimmedAudioFeatures;
        int validAudioLen;
        int hiddenDim;

        OnnxTensor convInput = null;
        OrtSession.Result convRes = null;
        OnnxTensor maskTensor = null;
        OrtSession.Result encRes = null;
        try {
            convInput = OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(mel.data),
                new long[] { 1L, mel.numFrames, WhisperMelExtractor.N_MELS }
            );
            convRes = convSession.run(Map.of(convInputName, convInput));
            convInput.close();
            convInput = null;

            OnnxTensor convOut = getTensorOutput(convRes, convOutputName);
            long[] convShape = ((TensorInfo) convOut.getInfo()).getShape();
            if (convShape.length < 3 || convShape[1] <= 0) {
                return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
            }
            int convFrames = (int) convShape[1];
            int expectedAudioTokens = featToAudioTokensLen(mel.numFrames, QWEN3_CHUNK_SIZE);
            int validFrames = Math.min(expectedAudioTokens, convFrames);
            if (validFrames <= 0 || !shouldContinue.getAsBoolean()) {
                return validFrames <= 0 ? new Qwen3SpeechWindow.DecodeResult("", new int[0]) : null;
            }

            boolean[][] mask = new boolean[1][convFrames];
            Arrays.fill(mask[0], 0, validFrames, true);
            maskTensor = OnnxTensor.createTensor(env, mask);

            Map<String, OnnxTensor> encInputs = new HashMap<>(2);
            encInputs.put(encFeatureInputName, convOut);
            encInputs.put(encMaskInputName, maskTensor);
            encRes = encoderSession.run(encInputs);

            maskTensor.close();
            maskTensor = null;
            convRes.close();
            convRes = null;

            OnnxTensor encOut = getTensorOutput(encRes, encOutputName);
            TensorInfo encInfo = (TensorInfo) encOut.getInfo();
            long[] encShape = encInfo.getShape();
            if (encShape.length < 3 || encShape[1] <= 0 || encShape[2] <= 0) {
                return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
            }
            int encFrames = (int) encShape[1];
            hiddenDim = (int) encShape[2];
            int boundedFrames = Math.min(validFrames, encFrames);
            float[] allEnc = readTensorAsFloats(encOut);
            encRes.close();
            encRes = null;

            validAudioLen = countNonSilentFrames(allEnc, boundedFrames, hiddenDim);
            if (validAudioLen <= 0) {
                return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
            }
            trimmedAudioFeatures = Arrays.copyOf(allEnc, validAudioLen * hiddenDim);
        } finally {
            closeQuietly(convInput, convRes, maskTensor, encRes);
        }

        if (!shouldContinue.getAsBoolean()) return null;

        String canonicalLanguage = resolveLanguage(language);
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

        int contextLen = scaffoldLen + validAudioLen + activePrefix.length;
        long[] sourceIds = new long[contextLen];
        int p = 0;
        for (int id : promptBeforeIds) sourceIds[p++] = id;
        for (int i = 0; i < validAudioLen; i++) sourceIds[p++] = tokenizer.audioPadTokenId;
        for (int id : activePromptAfterIds) sourceIds[p++] = id;
        for (int id : activePrefix) sourceIds[p++] = id;

        return runDecoderLoop(trimmedAudioFeatures, validAudioLen, hiddenDim, sourceIds, activePrefix, shouldContinue);
    }

    private Qwen3SpeechWindow.DecodeResult runDecoderLoop(
        float[] audioFeatures,
        int audioFrames,
        int hiddenDim,
        long[] sourceIds,
        int[] activePrefix,
        BooleanSupplier shouldContinue
    ) throws OrtException {
        OnnxTensor audioTensor = null;
        OnnxTensor[] cacheKeyTensors = new OnnxTensor[numLayers];
        OnnxTensor[] cacheValTensors = new OnnxTensor[numLayers];
        int keyRowStrideBytes = kvHeads * headDim * kvKeyElemBytes;
        int valRowStrideBytes = kvHeads * headDim * kvValElemBytes;

        try {
            audioTensor = createAudioFeaturesTensor(audioFeatures, audioFrames, hiddenDim);

            long[] cacheShape = new long[] { 1L, maxTotalLen, kvHeads, headDim };
            for (int i = 0; i < numLayers; i++) {
                zeroDirectBuffer(cacheKeyBuffers[i]);
                zeroDirectBuffer(cacheValBuffers[i]);
                cacheKeyBuffers[i].clear();
                cacheValBuffers[i].clear();
                cacheKeyTensors[i] = OnnxTensor.createTensor(env, cacheKeyBuffers[i], cacheShape, kvKeyType);
                cacheValTensors[i] = OnnxTensor.createTensor(env, cacheValBuffers[i], cacheShape, kvValType);
            }

            Map<String, OnnxTensor> decoderInputs = new HashMap<>(4 + 2 * numLayers);
            decoderInputs.put("audio_features", audioTensor);
            for (int i = 0; i < numLayers; i++) {
                decoderInputs.put(cacheKeyInputNames[i], cacheKeyTensors[i]);
                decoderInputs.put(cacheValInputNames[i], cacheValTensors[i]);
            }

            int contextLen = sourceIds.length;
            long[] attnMask = new long[contextLen];
            Arrays.fill(attnMask, 1L);
            long[] cachePos = new long[contextLen];
            for (int i = 0; i < contextLen; i++) cachePos[i] = i;

            int nextId;
            OnnxTensor idsTensor = null;
            OnnxTensor maskTensor = null;
            OnnxTensor posTensor = null;
            OrtSession.Result prefillRes = null;
            try {
                idsTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(sourceIds), new long[] { 1L, contextLen });
                maskTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(attnMask), new long[] { 1L, contextLen });
                posTensor = OnnxTensor.createTensor(env, LongBuffer.wrap(cachePos), new long[] { contextLen });
                decoderInputs.put("input_ids", idsTensor);
                decoderInputs.put("attention_mask", maskTensor);
                decoderInputs.put("cache_position", posTensor);

                prefillRes = decoderSession.run(decoderInputs);
                applyKvDeltaInplace(prefillRes, 0, contextLen, keyRowStrideBytes, valRowStrideBytes);
                OnnxTensor logitsTensor = getTensorOutput(prefillRes, "logits");
                nextId = sampleGreedyFromLogits(logitsTensor, contextLen - 1, -1);
                if (nextId == tokenizer.eosTokenId && activePrefix.length == 0) {
                    nextId = sampleGreedyFromLogits(logitsTensor, contextLen - 1, tokenizer.eosTokenId);
                }
            } finally {
                closeQuietly(idsTensor, maskTensor, posTensor, prefillRes);
            }

            if (nextId < 0 || nextId == tokenizer.eosTokenId) {
                return buildDecodeResult(activePrefix, new int[0], 0);
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

            return buildDecodeResult(activePrefix, generated, genCount);
        } finally {
            closeQuietly(audioTensor);
            for (OnnxTensor t : cacheKeyTensors) closeQuietly(t);
            for (OnnxTensor t : cacheValTensors) closeQuietly(t);
        }
    }

    private Qwen3SpeechWindow.DecodeResult buildDecodeResult(int[] activePrefix, int[] generated, int genCount) {
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
        String text = tokenizer.extractFinalText(fullTokens);
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

    private static int sampleGreedyFromLogits(OnnxTensor logitsTensor, int timeIndex, int avoidTokenId) {
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
            FloatBuffer fb = logitsTensor.getFloatBuffer();
            for (int i = 0; i < vocabSize; i++) {
                if (i == avoidTokenId) continue;
                float v = fb.get(offset + i);
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

    private static void zeroDirectBuffer(ByteBuffer buf) {
        ByteBuffer dup = buf.duplicate();
        dup.clear();
        byte[] zeros = new byte[Math.min(4096, dup.remaining())];
        while (dup.remaining() > 0) {
            int n = Math.min(zeros.length, dup.remaining());
            dup.put(zeros, 0, n);
        }
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
        closeQuietly(convSession, encoderSession, decoderSession);
    }

    @Override
    public synchronized void close() {
        if (closed) return;
        closed = true;
        closeQuietly();
    }
}
