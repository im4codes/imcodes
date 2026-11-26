package com.imcodes.speech;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;

/**
 * Standalone JDK-21 unit tests for pure-Java Whisper mel extraction, Qwen3 BPE
 * tokenization / U+FFFD rollback, SpeechWindow segmentation, and SpeechInbox.
 */
public final class Qwen3SpeechTests {
    private static void check(boolean cond, String message) {
        if (!cond) {
            throw new AssertionError("FAIL: " + message);
        }
    }

    private static void checkEquals(Object expected, Object actual, String message) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError("FAIL: " + message + " (expected=" + expected + ", actual=" + actual + ")");
        }
    }

    public static void main(String[] args) throws Exception {
        testWhisperMelReferenceMatch();
        testWhisperMelEdgeCases();
        testIncrementalMelExtractorParityAndReset();
        testTokenizerEncodeDecodeAndRollback();
        testTokenizerFromDirectory();
        testSpeechInboxWarmupThrottleOverload();
        testSpeechInboxZeroWarmupPreservesPrefillOrder();
        testDecodePcm16LittleEndianAndTranscribeOfflineSamples();
        testSpeechWindowPrefixRollbackAndVad();
        testSpeechWindowLowestEnergySplit();
        testSilencePreOnsetAndDecodeEnergyGuard();
        testAmbientHumFanAdaptationZeroDecodesAndPauseClock();
        testOnnxDecoderPureHelpers();
        testLanguagePromptMappingAndEncoding();
        testPretokenizePatternAndMultiScript();
        System.out.println("QWEN3_JAVA_UNIT_TESTS:PASS");
    }

    private static double hzToMelRef(double hz) {
        if (hz < 1000.0) return 3.0 * hz / 200.0;
        return 15.0 + Math.log(hz / 1000.0) * (27.0 / Math.log(6.4));
    }

    private static double melToHzRef(double mel) {
        if (mel < 15.0) return 200.0 * mel / 3.0;
        return 1000.0 * Math.exp((mel - 15.0) * (Math.log(6.4) / 27.0));
    }

    private static void testWhisperMelReferenceMatch() {
        WhisperMelExtractor extractor = new WhisperMelExtractor();
        int n = 16000;
        float[] pcm = new float[n];
        for (int i = 0; i < n; i++) {
            double t = i / 16000.0;
            pcm[i] = (float) (0.4 * Math.sin(2 * Math.PI * 440.0 * t) + 0.25 * Math.sin(2 * Math.PI * 1800.0 * t));
        }

        WhisperMelExtractor.MelFeatures out = extractor.extract(pcm, pcm.length);
        int expectedFrames = n / WhisperMelExtractor.HOP_LENGTH; // 100 frames
        checkEquals(expectedFrames, out.numFrames, "mel frame count matches floor(N/160)");
        checkEquals(WhisperMelExtractor.N_MELS, out.melBins, "mel bins == 128");
        checkEquals(expectedFrames * 128, out.data.length, "mel array flat length");

        // Independent double-precision naive 400-point DFT + Slaney mel filterbank reference across all 100 frames.
        double[] hann = new double[400];
        for (int k = 0; k < 400; k++) {
            hann[k] = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * k / 400.0));
        }
        double[][] refFilter = new double[128][201];
        double[] melPts = new double[130];
        double mMin = hzToMelRef(0.0), mMax = hzToMelRef(8000.0);
        for (int i = 0; i < 130; i++) melPts[i] = melToHzRef(mMin + i * (mMax - mMin) / 129.0);
        for (int m = 0; m < 128; m++) {
            double enorm = 2.0 / (melPts[m + 2] - melPts[m]);
            double dUp = melPts[m + 1] - melPts[m];
            double dDn = melPts[m + 2] - melPts[m + 1];
            for (int k = 0; k < 201; k++) {
                double f = k * 16000.0 / 400.0;
                double w = Math.max(0.0, Math.min((f - melPts[m]) / dUp, (melPts[m + 2] - f) / dDn));
                refFilter[m][k] = w * enorm;
            }
        }
        double[] refLog = new double[expectedFrames * 128];
        double globalMax = Double.NEGATIVE_INFINITY;
        for (int f = 0; f < expectedFrames; f++) {
            int center = f * 160;
            double[] mag2 = new double[201];
            for (int k = 0; k < 201; k++) {
                double re = 0.0, im = 0.0;
                for (int j = 0; j < 400; j++) {
                    double s = pcm[WhisperMelExtractor.reflectIndex(center + j - 200, n)] * hann[j];
                    double ang = 2.0 * Math.PI * k * j / 400.0;
                    re += s * Math.cos(ang);
                    im -= s * Math.sin(ang);
                }
                mag2[k] = re * re + im * im;
            }
            for (int m = 0; m < 128; m++) {
                double sum = 0.0;
                for (int k = 0; k < 201; k++) sum += mag2[k] * refFilter[m][k];
                double lv = Math.log10(Math.max(sum, 1e-10));
                refLog[f * 128 + m] = lv;
                if (lv > globalMax) globalMax = lv;
            }
        }
        float maxDiff = 0.0f;
        for (int i = 0; i < refLog.length; i++) {
            double clamped = Math.max(refLog[i], globalMax - 8.0);
            float refScaled = (float) ((clamped + 4.0) / 4.0);
            float diff = Math.abs(refScaled - out.data[i]);
            if (diff > maxDiff) maxDiff = diff;
        }
        check(maxDiff < 1e-4f, "symmetric-folded mel differs from full naive DFT by " + maxDiff);
    }

    private static void testWhisperMelEdgeCases() {
        WhisperMelExtractor extractor = new WhisperMelExtractor();
        checkEquals(0, extractor.extract(new float[0], 0).numFrames, "empty pcm -> 0 frames");
        checkEquals(0, extractor.extract(new float[] { 0.1f }, 1).numFrames, "1 sample -> 0 frames");
        // Short audio < 200 samples must safely reflect-pad without IndexOutOfBoundsException.
        WhisperMelExtractor.MelFeatures shortOut = extractor.extract(new float[] { 0.1f, -0.1f, 0.2f, -0.2f }, 4);
        checkEquals(0, shortOut.numFrames, "4 samples -> rawFrames=2, trimmedFrames=1 < 2 -> 0 frames");
        float[] tinyValid = new float[320];
        for (int i = 0; i < tinyValid.length; i++) tinyValid[i] = 0.2f * (float) Math.sin(i * 0.1);
        WhisperMelExtractor.MelFeatures twoFrameOut = extractor.extract(tinyValid, tinyValid.length);
        checkEquals(2, twoFrameOut.numFrames, "320 samples -> 2 mel frames");
    }

    private static String byteToGpt2Unicode(byte b) {
        int unsigned = b & 0xFF;
        int cp;
        if ((unsigned >= 33 && unsigned <= 126) || (unsigned >= 161 && unsigned <= 172) || (unsigned >= 174 && unsigned <= 255)) {
            cp = unsigned;
        } else {
            int offset = 0;
            for (int v = 0; v < unsigned; v++) {
                boolean direct = (v >= 33 && v <= 126) || (v >= 161 && v <= 172) || (v >= 174 && v <= 255);
                if (!direct) offset++;
            }
            cp = 256 + offset;
        }
        return new String(Character.toChars(cp));
    }

    private static String jsonEscape(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') sb.append("\\\"");
            else if (c == '\\') sb.append("\\\\");
            else if (c == '\n') sb.append("\\n");
            else if (c < 0x20 || c > 0x7E) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        sb.append('"');
        return sb.toString();
    }

    private static Qwen3Tokenizer buildFixtureTokenizer() throws Exception {
        StringBuilder vocab = new StringBuilder("{");
        List<String> entries = new ArrayList<>();
        // Register all 256 byte-level single tokens (ids 0..255)
        for (int b = 0; b < 256; b++) {
            entries.add(jsonEscape(byteToGpt2Unicode((byte) b)) + ":" + b);
        }
        // Multi-byte / word merged tokens
        entries.add(jsonEscape("language") + ":300");
        entries.add(jsonEscape(byteToGpt2Unicode((byte) ' ') + "Chinese") + ":301");
        entries.add(jsonEscape(byteToGpt2Unicode((byte) ' ') + "English") + ":302");
        entries.add(jsonEscape("hello") + ":303");
        entries.add(jsonEscape(byteToGpt2Unicode((byte) ' ') + "world") + ":304");
        // Chinese 3-byte char "你" (E4 BD A0) & "好" (E5 A5 BD) & split UTF-8 byte token pair
        String ni = byteToGpt2Unicode((byte) 0xE4) + byteToGpt2Unicode((byte) 0xBD) + byteToGpt2Unicode((byte) 0xA0);
        String haoLead2 = byteToGpt2Unicode((byte) 0xE5) + byteToGpt2Unicode((byte) 0xA5); // incomplete 2/3 bytes -> triggers U+FFFD!
        String haoTail1 = byteToGpt2Unicode((byte) 0xBD);
        entries.add(jsonEscape(ni) + ":305");
        entries.add(jsonEscape(haoLead2) + ":306");
        entries.add(jsonEscape(haoTail1) + ":307");
        entries.add(jsonEscape("!") + ":308");
        entries.add(jsonEscape("don") + ":309");
        entries.add(jsonEscape("'t") + ":310");
        // Special tokens
        entries.add(jsonEscape("<|endoftext|>") + ":151643");
        entries.add(jsonEscape("<|im_start|>") + ":151644");
        entries.add(jsonEscape("<|im_end|>") + ":151645");
        entries.add(jsonEscape("<|audio_start|>") + ":151669");
        entries.add(jsonEscape("<|audio_end|>") + ":151670");
        entries.add(jsonEscape("<|audio_pad|>") + ":151676");
        entries.add(jsonEscape("<asr_text>") + ":151704");
        vocab.append(String.join(",", entries)).append("}");

        String merges = String.join("\n", Arrays.asList(
            "#version: 0.2",
            "h e", "he l", "hel l", "hell o",
            byteToGpt2Unicode((byte) ' ') + " w", byteToGpt2Unicode((byte) ' ') + "w o", byteToGpt2Unicode((byte) ' ') + "wo r", byteToGpt2Unicode((byte) ' ') + "wor l", byteToGpt2Unicode((byte) ' ') + "worl d",
            "d o", "do n",
            byteToGpt2Unicode((byte) 0xE4) + " " + byteToGpt2Unicode((byte) 0xBD),
            byteToGpt2Unicode((byte) 0xE4) + byteToGpt2Unicode((byte) 0xBD) + " " + byteToGpt2Unicode((byte) 0xA0)
        ));

        String config = "{\"eos_token\":\"<|im_end|>\",\"pad_token\":\"<|endoftext|>\","
            + "\"added_tokens_decoder\":{"
            + "\"151643\":{\"content\":\"<|endoftext|>\",\"special\":true},"
            + "\"151644\":{\"content\":\"<|im_start|>\",\"special\":true},"
            + "\"151645\":{\"content\":\"<|im_end|>\",\"special\":true},"
            + "\"151669\":{\"content\":\"<|audio_start|>\",\"special\":true},"
            + "\"151670\":{\"content\":\"<|audio_end|>\",\"special\":true},"
            + "\"151676\":{\"content\":\"<|audio_pad|>\",\"special\":true},"
            + "\"151704\":{\"content\":\"<asr_text>\",\"special\":false}"
            + "}}";
        return Qwen3Tokenizer.fromContents(vocab.toString(), merges, config);
    }

    private static void testTokenizerEncodeDecodeAndRollback() throws Exception {
        Qwen3Tokenizer tok = buildFixtureTokenizer();
        int[] promptIds = tok.encode("<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|><|audio_pad|><|audio_end|><|im_end|>\n<|im_start|>assistant\n");
        check(promptIds[0] == 151644, "im_start special id");
        check(promptIds[promptIds.length - 2] == tok.getTokenId("assistant") || promptIds.length > 8, "prompt tokens encoded");

        // Contraction + roundtrip check
        int[] english = tok.encode("don't");
        checkEquals("don't", tok.decode(english), "contraction roundtrip");

        // CJK + header stripping + U+FFFD rollback check:
        // [language, " Chinese", <asr_text>, "你", haoLead2(306), haoTail1(307), t1, t2, t3, eos]
        int[] t1 = tok.encode("hello");
        int[] t2 = tok.encode(" world");
        int[] full = new int[] { 300, 301, 151704, 305, 306, 307, t1[0], t2[0], 308, 151645 };
        checkEquals("你好hello world!", tok.extractFinalText(full), "extractFinalText strips header + eos");

        // Rolling back 4 text tokens cuts right after 306 (incomplete lead 2 bytes of '好' -> U+FFFD!),
        // so safePrefixTokensForRollback MUST back off one extra token to 305 ("你"), preserving header.
        int[] rolled = tok.safePrefixTokensForRollback(full, 4);
        check(Arrays.equals(new int[] { 300, 301, 151704, 305 }, rolled),
            "safePrefixTokensForRollback walked back across U+FFFD token: " + Arrays.toString(rolled));

        // Rolling back >= speech token count returns empty instead of bleeding into header.
        int[] tooShort = tok.safePrefixTokensForRollback(full, 6);
        checkEquals(0, tooShort.length, "never roll back into <asr_text> header");
    }

    private static void writeUtf8(File file, String text) throws Exception {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteTree(c);
        }
        f.delete();
    }

    private static void testTokenizerFromDirectory() throws Exception {
        String ni = byteToGpt2Unicode((byte) 0xE4) + byteToGpt2Unicode((byte) 0xBD) + byteToGpt2Unicode((byte) 0xA0);
        String haoLead2 = byteToGpt2Unicode((byte) 0xE5) + byteToGpt2Unicode((byte) 0xA5);
        String haoTail1 = byteToGpt2Unicode((byte) 0xBD);
        StringBuilder vocab = new StringBuilder("{");
        List<String> entries = new ArrayList<>();
        for (int b = 0; b < 256; b++) {
            entries.add(jsonEscape(byteToGpt2Unicode((byte) b)) + ":" + b);
        }
        entries.add(jsonEscape("ab") + ":300");
        entries.add(jsonEscape(ni) + ":305");
        entries.add(jsonEscape(haoLead2) + ":306");
        entries.add(jsonEscape(haoTail1) + ":307");
        entries.add(jsonEscape("<|endoftext|>") + ":151643");
        entries.add(jsonEscape("<|im_start|>") + ":151644");
        entries.add(jsonEscape("<|im_end|>") + ":151645");
        entries.add(jsonEscape("<|audio_start|>") + ":151669");
        entries.add(jsonEscape("<|audio_end|>") + ":151670");
        entries.add(jsonEscape("<|audio_pad|>") + ":151676");
        entries.add(jsonEscape("<asr_text>") + ":151704");
        vocab.append(String.join(",", entries)).append("}");
        String vocabJson = vocab.toString();
        String merges = "#version: 0.2\na b\n";
        String config = "{\"eos_token\":\"<|im_end|>\",\"pad_token\":\"<|endoftext|>\","
            + "\"added_tokens_decoder\":{\"151704\":{\"content\":\"<asr_text>\",\"special\":false}}}";

        File baseTmp = new File(System.getProperty("java.io.tmpdir"));
        File dirWithConfig = new File(baseTmp, "qwen3_tok_dir_" + System.nanoTime());
        File dirNoConfig = new File(baseTmp, "qwen3_tok_noconfig_" + System.nanoTime());
        try {
            check(dirWithConfig.mkdirs() && dirNoConfig.mkdirs(), "create temp tokenizer fixture dirs");
            writeUtf8(new File(dirWithConfig, "vocab.json"), vocabJson);
            writeUtf8(new File(dirWithConfig, "merges.txt"), merges);
            writeUtf8(new File(dirWithConfig, "tokenizer_config.json"), config);

            Qwen3Tokenizer expected = Qwen3Tokenizer.fromContents(vocabJson, merges, config);
            Qwen3Tokenizer actual = Qwen3Tokenizer.fromDirectory(dirWithConfig);

            checkEquals(expected.eosTokenId, actual.eosTokenId, "fromDirectory eosTokenId");
            checkEquals(expected.padTokenId, actual.padTokenId, "fromDirectory padTokenId");
            checkEquals(expected.asrTextTokenId, actual.asrTextTokenId, "fromDirectory asrTextTokenId");
            check(Arrays.equals(expected.encode("ab<asr_text>"), actual.encode("ab<asr_text>")),
                "fromDirectory encode matches fromContents");
            int[] splitUtf8 = new int[] { 300, 305, 306 }; // "ab" + "你" + incomplete 2/3 bytes of '好' (U+FFFD)
            checkEquals(expected.decode(splitUtf8), actual.decode(splitUtf8),
                "fromDirectory decode matches fromContents");
            int[] withHeader = new int[] { 151704, 300, 305, 306 };
            check(Arrays.equals(
                    expected.safePrefixTokensForRollback(withHeader, 0),
                    actual.safePrefixTokensForRollback(withHeader, 0)),
                "fromDirectory U+FFFD rollback matches fromContents");

            // Optional tokenizer_config.json absent -> defaults still work without throwing
            writeUtf8(new File(dirNoConfig, "vocab.json"), vocabJson);
            writeUtf8(new File(dirNoConfig, "merges.txt"), merges);
            Qwen3Tokenizer fallback = Qwen3Tokenizer.fromDirectory(dirNoConfig);
            checkEquals(151704, fallback.asrTextTokenId, "fromDirectory without config still resolves <asr_text>");
            checkEquals("ab你", fallback.decode(fallback.encode("ab你")),
                "fromDirectory without config encodes/decodes UTF-8 normally");
        } finally {
            deleteTree(dirWithConfig);
            deleteTree(dirNoConfig);
        }
    }

    private static void testSpeechInboxWarmupThrottleOverload() throws Exception {
        Qwen3SpeechWindow.SpeechInbox inbox = new Qwen3SpeechWindow.SpeechInbox();
        float[] warmup = new float[320];
        Arrays.fill(warmup, 0.5f);
        boolean admittedWarmup = inbox.offer(warmup, warmup.length);
        check(!admittedWarmup, "first 320 samples (20ms) dropped during warmup");
        checkEquals(0, inbox.getWarmupRemaining(), "warmupRemaining == 0 after 320 samples");
        check(inbox.pollAudioLevel(1_000_000_000L) == null, "no audioLevel emitted for warmup drop");

        float[] speech = new float[800];
        Arrays.fill(speech, 0.1f);
        check(inbox.offer(speech, speech.length), "post-warmup chunk admitted");
        Double lvl1 = inbox.pollAudioLevel(1_000_000_000L);
        check(lvl1 != null && Math.abs(lvl1 - 0.1) < 1e-3, "first audioLevel emitted immediately post-warmup");

        // Burst within 50ms must be throttled
        check(inbox.offer(speech, speech.length), "second chunk admitted");
        check(inbox.pollAudioLevel(1_020_000_000L) == null, "audioLevel throttled under 50ms");
        Double lvl2 = inbox.pollAudioLevel(1_055_000_000L);
        check(lvl2 != null, "audioLevel emitted once 50ms elapsed");

        // Overload guard at 512,000 samples (32s capacity)
        inbox.take();
        float[] huge = new float[Qwen3SpeechWindow.SpeechInbox.LIMIT + 1];
        boolean threwOverload = false;
        try {
            inbox.offer(huge, huge.length);
        } catch (Exception expected) {
            threwOverload = expected.getMessage().contains("overloaded");
        }
        check(threwOverload, "SpeechInbox throws overload above 512,000 samples");
    }

    private static void testSpeechWindowPrefixRollbackAndVad() {
        Qwen3SpeechWindow window = new Qwen3SpeechWindow();
        List<int[]> observedPrefixes = new ArrayList<>();
        List<String> emissions = new ArrayList<>();

        Qwen3SpeechWindow.DecodeFn fakeDecoder = (pcm, count, prefix) -> {
            observedPrefixes.add(Arrays.copyOf(prefix, prefix.length));
            int callIdx = observedPrefixes.size();
            if (callIdx == 1) {
                return new Qwen3SpeechWindow.DecodeResult("one two", new int[] { 10, 11 });
            } else if (callIdx == 2) {
                return new Qwen3SpeechWindow.DecodeResult("one two three four five six seven", new int[] { 10, 11, 12, 13, 14, 15, 16 });
            } else if (callIdx == 3) {
                return new Qwen3SpeechWindow.DecodeResult("one two hello.", new int[] { 10, 11, 20, 21 });
            } else if (callIdx == 4) {
                return new Qwen3SpeechWindow.DecodeResult("one two hello.", new int[] { 10, 11, 20, 21 });
            }
            return new Qwen3SpeechWindow.DecodeResult("next sentence", new int[] { 30, 31 });
        };

        float[] strideSpeech = new float[Qwen3SpeechWindow.STRIDE];
        Arrays.fill(strideSpeech, 0.1f);
        // Chunk 1 -> chunkCount becomes 1 (< UNFIXED_CHUNK_NUM = 2), prefix=[]
        window.append(strideSpeech, true, 0, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, fakeDecoder, emissions::add);
        // Chunk 2 -> chunkCount becomes 2, still prefix=[]
        window.append(strideSpeech, true, 0, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, fakeDecoder, emissions::add);
        // Chunk 3 -> chunkCount >= 2, receives rolled back prefix (7 - 5 = 2 tokens: [10, 11])
        window.append(strideSpeech, true, 0, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, fakeDecoder, emissions::add);

        checkEquals(3, observedPrefixes.size(), "3 stride decodes invoked");
        checkEquals(0, observedPrefixes.get(0).length, "chunk 1 prefix empty");
        checkEquals(0, observedPrefixes.get(1).length, "chunk 2 prefix empty");
        check(Arrays.equals(new int[] { 10, 11 }, observedPrefixes.get(2)), "chunk 3 receives rolled back prefix");

        // Chunk 3 ended in punctuation "." -> 400ms (6400 samples) unvoiced should commit segment!
        float[] pause400 = new float[Qwen3SpeechWindow.PUNCTUATION_PAUSE];
        window.append(pause400, false, pause400.length, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, fakeDecoder, emissions::add);
        checkEquals("one two hello.", window.getCommitted(), "400ms pause after punctuation commits segment");
        checkEquals(0, window.getSampleCount(), "sample buffer cleared after segment commit");

        // Subsequent speech starts a fresh segment and appends cleanly
        window.append(strideSpeech, true, 0, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, fakeDecoder, emissions::add);
        String finalText = window.finish(() -> true, Qwen3SpeechWindow::defaultRollbackPrefix, fakeDecoder);
        checkEquals("one two hello. next sentence", finalText, "second segment joins cleanly");
    }

    private static void testSpeechWindowLowestEnergySplit() {
        int cap = Qwen3SpeechWindow.SEGMENT_CAPACITY; // 216,000 samples (13.5s)
        float[] loudWithQuietValley = new float[cap];
        Arrays.fill(loudWithQuietValley, 0.4f);
        // Create a distinct quiet valley centered at cap - 20000 (inside trailing 40,000-sample search window).
        int valleyStart = cap - 21000;
        int valleyEnd = cap - 19000;
        for (int i = valleyStart; i < valleyEnd; i++) {
            loudWithQuietValley[i] = 0.0005f;
        }
        int splitIdx = Qwen3SpeechWindow.lowestEnergySplitIndex(loudWithQuietValley, cap);
        check(splitIdx >= valleyStart && splitIdx <= valleyEnd,
            "lowestEnergySplitIndex picked quiet valley midpoint (" + splitIdx + " in [" + valleyStart + ", " + valleyEnd + "])");

        // Uniform signal splits cleanly at sampleCount
        float[] uniform = new float[cap];
        Arrays.fill(uniform, 0.25f);
        checkEquals(cap, Qwen3SpeechWindow.lowestEnergySplitIndex(uniform, cap), "uniform signal splits at end");
    }

    private static void testSilencePreOnsetAndDecodeEnergyGuard() {
        Qwen3SpeechWindow noiseWindow = new Qwen3SpeechWindow();
        int[] decodeCalls = new int[] { 0 };
        Qwen3SpeechWindow.DecodeFn countingDecode = (pcm, count, prefix) -> {
            decodeCalls[0]++;
            return new Qwen3SpeechWindow.DecodeResult("嗯", new int[] { 99 });
        };

        // Brief 100ms low-level click (< 150ms onset confirm) followed by 200ms silence must discard without opening window.
        float[] briefLow = new float[1600];
        Arrays.fill(briefLow, 0.0025f);
        float[] gap = new float[3200];
        noiseWindow.append(briefLow, true, 0, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, countingDecode, s -> {});
        noiseWindow.append(gap, false, gap.length, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, countingDecode, s -> {});
        checkEquals(0, noiseWindow.getSampleCount(), "brief low-level transient cleared before opening window");
        checkEquals("", noiseWindow.finish(() -> true, Qwen3SpeechWindow::defaultRollbackPrefix, countingDecode), "transient must not emit text");
        checkEquals(0, decodeCalls[0], "transient burst must not invoke decoder");

        // Pre-decode acoustic energy guard rejects flat room noise and accepts genuine 200ms quiet speech.
        float[] flatNoise = new float[32000];
        Arrays.fill(flatNoise, 0.0008f);
        check(!Qwen3SpeechWindow.hasDecodableEnergy(flatNoise, flatNoise.length), "flat low-energy noise fails energy guard");
        float[] quietWord = new float[3200];
        for (int i = 0; i < quietWord.length; i++) {
            quietWord[i] = (float) (0.0025 * Math.sqrt(2.0) * Math.sin(2.0 * Math.PI * 220.0 * i / 16000.0));
        }
        check(Qwen3SpeechWindow.hasDecodableEnergy(quietWord, quietWord.length), "200ms quiet speech passes energy guard");

        Qwen3SpeechWindow quietWindow = new Qwen3SpeechWindow();
        int[] decodedLengths = new int[1];
        Qwen3SpeechWindow.DecodeFn captureDecode = (pcm, count, prefix) -> {
            decodedLengths[0] = count;
            return new Qwen3SpeechWindow.DecodeResult("嗯", new int[] { 99 });
        };
        quietWindow.append(quietWord, true, 0, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, captureDecode, s -> {});
        String res = quietWindow.finish(() -> true, Qwen3SpeechWindow::defaultRollbackPrefix, captureDecode);
        checkEquals("嗯", res, "genuine 200ms quiet word preserved and decoded");
        checkEquals(3200 + Qwen3SpeechWindow.FINAL_SILENCE_PADDING, decodedLengths[0], "all 3200 quiet speech samples retained");
    }

    private static void testAmbientHumFanAdaptationZeroDecodesAndPauseClock() throws Exception {
        Qwen3SpeechWindow.SpeechInbox inbox = new Qwen3SpeechWindow.SpeechInbox(new SpeechGain());
        Qwen3SpeechWindow window = new Qwen3SpeechWindow();
        int[] decodeCalls = new int[] { 0 };
        Qwen3SpeechWindow.DecodeFn decodeFn = (pcm, count, prefix) -> {
            decodeCalls[0]++;
            return new Qwen3SpeechWindow.DecodeResult("嗯", new int[] { 99 });
        };

        // Drain 20ms startup warmup
        inbox.offer(new float[Qwen3SpeechWindow.SpeechInbox.WARMUP_SAMPLES], Qwen3SpeechWindow.SpeechInbox.WARMUP_SAMPLES);

        // 34s realistic ambient room hum (117/148/531 Hz) + broadband fan noise (~0.0022-0.0030 RMS)
        long seed = 0x160000L;
        for (int step = 0; step < 340; step++) {
            int off = step * 1600;
            float[] chunk = new float[1600];
            float[] noise = new float[1600];
            double sumSqNoise = 0.0;
            for (int i = 0; i < 1600; i++) {
                seed = seed * 6364136223846793005L + 1442695040888963407L;
                float u = ((seed >>> 40) & 0xFFFFFF) / (float) (1 << 24) * 2.0f - 1.0f;
                noise[i] = u;
                sumSqNoise += (double) u * u;
            }
            float nScale = (float) (0.0016 / Math.sqrt(sumSqNoise / 1600));
            for (int i = 0; i < 1600; i++) {
                double t = (off + i) / 16000.0;
                float h1 = (float) (0.0016 * Math.sqrt(2.0) * Math.sin(2.0 * Math.PI * 117.0 * t));
                float h2 = (float) (0.0014 * Math.sqrt(2.0) * Math.sin(2.0 * Math.PI * 148.0 * t));
                float h3 = (float) (0.0012 * Math.sqrt(2.0) * Math.sin(2.0 * Math.PI * 531.0 * t));
                chunk[i] = h1 + h2 + h3 + noise[i] * nScale;
            }
            inbox.offer(chunk, chunk.length);
            Qwen3SpeechWindow.SpeechInbox.Batch batch = inbox.take();
            if (batch != null) {
                window.append(
                    batch.samples,
                    batch.speech,
                    batch.trailingSilence,
                    batch.activeSamples,
                    batch.noiseFloorRMS,
                    false,
                    () -> true,
                    () -> true,
                    Qwen3SpeechWindow::defaultRollbackPrefix,
                    decodeFn,
                    s -> {}
                );
            }
        }
        String silOut = window.finish(() -> true, Qwen3SpeechWindow::defaultRollbackPrefix, decodeFn);
        check(inbox.getCurrentNoiseFloorRMS() >= 0.0020f,
            "ambient noise floor adapted (>= 0.0020): " + inbox.getCurrentNoiseFloorRMS());
        checkEquals(0, decodeCalls[0], "34s ambient silence emits 0 decodes");
        checkEquals("", silOut, "34s ambient silence returns empty transcript");

        // Soft 220Hz speech (0.0055 RMS) over that adapted floor still opens window and decodes cleanly.
        for (int s = 0; s < 4; s++) {
            int off = s * 1600;
            float[] tone = new float[1600];
            for (int i = 0; i < 1600; i++) {
                tone[i] = (float) (0.0055 * Math.sqrt(2.0) * Math.sin(2.0 * Math.PI * 220.0 * (off + i) / 16000.0));
            }
            inbox.offer(tone, tone.length);
            Qwen3SpeechWindow.SpeechInbox.Batch batch = inbox.take();
            if (batch != null) {
                window.append(
                    batch.samples,
                    batch.speech,
                    batch.trailingSilence,
                    batch.activeSamples,
                    batch.noiseFloorRMS,
                    false,
                    () -> true,
                    () -> true,
                    Qwen3SpeechWindow::defaultRollbackPrefix,
                    decodeFn,
                    sOut -> {}
                );
            }
        }
        String softOut = window.finish(() -> true, Qwen3SpeechWindow::defaultRollbackPrefix, decodeFn);
        checkEquals("嗯", softOut, "soft speech over adapted floor decodes cleanly");
        checkEquals(1, decodeCalls[0], "soft speech invoked decoder once");

        // Single 25ms (400-sample) isolated blip inside pause must NOT reset VAD pause clock.
        Qwen3SpeechWindow pauseWin = new Qwen3SpeechWindow();
        int[] pauseCalls = new int[] { 0 };
        Qwen3SpeechWindow.DecodeFn pauseDecode = (pcm, count, prefix) -> {
            pauseCalls[0]++;
            return new Qwen3SpeechWindow.DecodeResult("短句。", new int[] { 50 });
        };
        float[] speech = new float[Qwen3SpeechWindow.STRIDE];
        Arrays.fill(speech, 0.1f);
        pauseWin.append(speech, true, 0, speech.length, 0.00075f, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, pauseDecode, s -> {});
        // 300ms silence + single 25ms (400-sample < 800) blip + 100ms silence = 425ms >= 400ms PUNCTUATION_PAUSE -> commits!
        float[] sil300 = new float[4800];
        float[] blip25 = new float[400];
        Arrays.fill(blip25, 0.004f);
        float[] sil100 = new float[1600];
        pauseWin.append(sil300, false, sil300.length, 0, 0.00075f, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, pauseDecode, s -> {});
        pauseWin.append(blip25, true, 0, blip25.length, 0.00075f, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, pauseDecode, s -> {});
        pauseWin.append(sil100, false, sil100.length, 0, 0.00075f, false, () -> true, () -> true, Qwen3SpeechWindow::defaultRollbackPrefix, pauseDecode, s -> {});
        checkEquals("短句。", pauseWin.getCommitted(), "single 25ms blip did not reset punctuation pause clock");
        checkEquals(0, pauseWin.getSampleCount(), "segment committed cleanly after pause despite 25ms blip");
    }

    private static void testOnnxDecoderPureHelpers() {
        // FeatToAudioTokensLen matching sherpa-onnx C++ (100-frame chunk -> 13 tokens)
        checkEquals(0, Qwen3OnnxDecoder.featToAudioTokensLen(0, 100), "0 frames -> 0 tokens");
        checkEquals(13, Qwen3OnnxDecoder.featToAudioTokensLen(100, 100), "100 frames -> 13 tokens");
        checkEquals(26, Qwen3OnnxDecoder.featToAudioTokensLen(200, 100), "200 frames -> 26 tokens");
        checkEquals(14, Qwen3OnnxDecoder.featToAudioTokensLen(101, 100), "101 frames -> 13 + 1");

        // countNonSilentFrames trims trailing near-zero encoder frames while keeping interior quiet frames
        float[] enc = new float[5 * 4];
        enc[0 * 4 + 1] = 0.05f;
        enc[2 * 4 + 3] = 0.02f;
        // frames 3 and 4 remain <= 1e-6f
        checkEquals(3, Qwen3OnnxDecoder.countNonSilentFrames(enc, 5, 4), "trailing silent frames trimmed");
        checkEquals(0, Qwen3OnnxDecoder.countNonSilentFrames(new float[5 * 4], 5, 4), "all silent frames -> 0");

        // Degenerate repetition detection + trim (64-token tail with <= 3 distinct tokens)
        int[] normal = new int[70];
        for (int i = 0; i < normal.length; i++) normal[i] = 100 + (i % 10);
        check(!Qwen3OnnxDecoder.isDegenerateRepetition(normal, normal.length), "diverse sequence not degenerate");

        int[] looping = new int[70];
        for (int i = 0; i < 6; i++) looping[i] = 500 + i; // real prefix tokens
        for (int i = 6; i < 70; i++) looping[i] = 42 + (i % 2); // 64 repeating tokens of 2 values
        check(Qwen3OnnxDecoder.isDegenerateRepetition(looping, 70), "64-token <=3-distinct tail flagged degenerate");
        checkEquals(6, Qwen3OnnxDecoder.trimDegenerateTail(looping, 70), "trimDegenerateTail strips repeating suffix");

        // IEEE-754 float16 roundtrip for representative values & subnormals
        float[] probes = new float[] { 0.0f, -0.0f, 1.0f, -2.5f, 0.0001f, 65504.0f };
        for (float v : probes) {
            float rt = Qwen3OnnxDecoder.halfBitsToFloat(Qwen3OnnxDecoder.floatToHalfBits(v));
            float tol = Math.max(1e-4f, Math.abs(v) * 1e-3f);
            check(Math.abs(rt - v) <= tol, "fp16 roundtrip mismatch for " + v + ": got " + rt);
        }
    }

    private static void testLanguagePromptMappingAndEncoding() throws Exception {
        checkEquals("Japanese", Qwen3OnnxDecoder.resolveLanguage("ja-JP"), "ja-JP maps to Japanese");
        checkEquals("Japanese", Qwen3OnnxDecoder.resolveLanguage("ja"), "ja maps to Japanese");
        checkEquals("Chinese", Qwen3OnnxDecoder.resolveLanguage("zh-Hans"), "zh-Hans maps to Chinese");
        checkEquals("Chinese", Qwen3OnnxDecoder.resolveLanguage("zh-Hant"), "zh-Hant maps to Chinese");
        checkEquals("Chinese", Qwen3OnnxDecoder.resolveLanguage("zh_CN"), "zh_CN maps to Chinese");
        checkEquals("English", Qwen3OnnxDecoder.resolveLanguage("en-US"), "en-US maps to English");
        checkEquals("Korean", Qwen3OnnxDecoder.resolveLanguage("ko-KR"), "ko-KR maps to Korean");
        checkEquals("Spanish", Qwen3OnnxDecoder.resolveLanguage("es-ES"), "es-ES maps to Spanish");
        checkEquals("Russian", Qwen3OnnxDecoder.resolveLanguage("ru-RU"), "ru-RU maps to Russian");
        checkEquals("Japanese", Qwen3OnnxDecoder.resolveLanguage("Japanese"), "canonical Japanese preserved");
        checkEquals(null, Qwen3OnnxDecoder.resolveLanguage(null), "null -> auto (null)");
        checkEquals(null, Qwen3OnnxDecoder.resolveLanguage("  "), "blank -> auto (null)");
        checkEquals(null, Qwen3OnnxDecoder.resolveLanguage("auto"), "auto -> null");
        checkEquals(null, Qwen3OnnxDecoder.resolveLanguage("AUTO"), "AUTO -> null");
        checkEquals(null, Qwen3OnnxDecoder.resolveLanguage("xx-unknown"), "unknown -> null");

        Qwen3Tokenizer tok = buildFixtureTokenizer();
        int[] autoIds = Qwen3OnnxDecoder.encodePromptAfterIds(tok, null);
        int[] explicitAutoIds = Qwen3OnnxDecoder.encodePromptAfterIds(tok, "auto");
        check(Arrays.equals(autoIds, explicitAutoIds), "auto and null produce identical unconstrained suffix ids");
        check(autoIds[autoIds.length - 1] != 151704, "auto suffix does not end with <asr_text>");
        checkEquals("<|audio_end|>\nassistant\n",
            tok.decode(autoIds, 0, autoIds.length, false), "auto suffix omits language scaffold");

        int[] jaIds = Qwen3OnnxDecoder.encodePromptAfterIds(tok, "ja-JP");
        checkEquals(151704, jaIds[jaIds.length - 1], "forced language suffix ends with <asr_text>");
        checkEquals("<|audio_end|>\nassistant\nlanguage Japanese<asr_text>",
            tok.decode(jaIds, 0, jaIds.length, false), "ja-JP encodes canonical Japanese prompt + <asr_text>");

        int[] zhIds = Qwen3OnnxDecoder.encodePromptAfterIds(tok, "zh-Hans");
        checkEquals(151704, zhIds[zhIds.length - 1], "zh-Hans suffix ends with <asr_text>");
        checkEquals("<|audio_end|>\nassistant\nlanguage Chinese<asr_text>",
            tok.decode(zhIds, 0, zhIds.length, false), "zh-Hans encodes canonical Chinese prompt + <asr_text>");

        // When forced language puts <asr_text> in promptAfterIds, decoder generates transcript tokens directly
        int[] generatedWithoutHeader = new int[] { 305, 306, 307, 151645 };
        checkEquals("你好", tok.extractFinalText(generatedWithoutHeader), "extractFinalText decodes direct speech tokens");
        // When auto-detect leaves <asr_text> out of prompt, decoder emits header + text which extractFinalText strips
        int[] generatedWithHeader = new int[] { 300, 301, 151704, 305, 306, 307, 151645 };
        checkEquals("你好", tok.extractFinalText(generatedWithHeader, true), "extractFinalText strips auto-detected header");
        // Incomplete header without <asr_text> in auto-detect mode must never leak "language ..."
        int[] incompleteHeader = new int[] { 300, 301 };
        checkEquals("", tok.extractFinalText(incompleteHeader, true), "extractFinalText drops incomplete auto-detect header");
        check(Arrays.equals(new int[0], tok.safePrefixTokensForRollback(incompleteHeader, 0, true)),
            "safePrefixTokensForRollback returns empty before <asr_text> in auto-detect mode");
        // With complete header + speech tokens, rollback preserves header + confirmed speech tokens
        int[] partialWithHeader = new int[] { 300, 301, 151704, 305, 306, 307, 151645 };
        int[] rollback = tok.safePrefixTokensForRollback(partialWithHeader, 1, true);
        check(Arrays.equals(new int[] { 300, 301, 151704, 305 }, rollback),
            "safePrefixTokensForRollback keeps auto-detect header and trims trailing multi-token char");
        // Forced mode keeps text starting with "language ..." when expectLanguageHeader=false
        checkEquals("language", tok.extractFinalText(new int[] { 300 }, false),
            "forced mode does not suppress literal 'language' transcript without <asr_text>");
    }

    private static List<String> pretokenizeChunks(String input) {
        List<String> chunks = new ArrayList<>();
        Matcher matcher = Qwen3Tokenizer.QWEN3_PRETOKENIZE_PATTERN.matcher(input);
        while (matcher.find()) {
            chunks.add(matcher.group());
        }
        return chunks;
    }

    private static void testPretokenizePatternAndMultiScript() throws Exception {
        checkEquals(0, Qwen3Tokenizer.QWEN3_PRETOKENIZE_PATTERN.flags(), "QWEN3_PRETOKENIZE_PATTERN must compile with flags=0 for Android ICU compatibility");

        // Contractions (mixed case)
        checkEquals(
            Arrays.asList("I", "'m", " don", "'t", " YOU", "'RE", " we", "'ve", " they", "'ll", " he", "'d", " it", "'s"),
            pretokenizeChunks("I'm don't YOU'RE we've they'll he'd it's"),
            "English contractions pretokenize cleanly"
        );

        // CJK + punctuation + digits + newlines
        checkEquals(
            Arrays.asList("你好", "，世界", "!", " abc", "1", "2", "3", "\r\n\r\n", " ", " line", "2", "\n"),
            pretokenizeChunks("你好，世界! abc123\r\n\r\n  line2\n"),
            "CJK, punctuation, digits, and CRLF/LF pretokenize cleanly"
        );

        // Unicode spaces (NBSP U+00A0 and ideographic space U+3000) across single, multi-space lookahead, CR/LF prefix, and trailing whitespace branches
        checkEquals(
            Arrays.asList("hello", "\u00A0world", "，你好", "\u3000世界"),
            pretokenizeChunks("hello\u00A0world，你好\u3000世界"),
            "NBSP and ideographic spaces attach identically to ASCII spaces"
        );
        checkEquals(
            Arrays.asList("a", "\u00A0", "\u3000b"),
            pretokenizeChunks("a\u00A0\u3000b"),
            "multi Unicode spaces preserve single leading separator before next word"
        );
        checkEquals(
            Arrays.asList("x", "\u3000\n", "end", "\u00A0\u3000"),
            pretokenizeChunks("x\u3000\nend\u00A0\u3000"),
            "Unicode spaces before newline and at end of string"
        );

        // Full Qwen3Tokenizer encode/decode round-trip across contractions, CJK, punctuation, digits, newlines, and Unicode spaces
        Qwen3Tokenizer tok = buildFixtureTokenizer();
        String multiScript = "I'm ready: 你好，世界 123\r\nhello\u00A0world\u3000测试!\n";
        int[] ids = tok.encode(multiScript);
        check(ids.length > 0, "multi-script sample encodes non-empty");
        checkEquals(multiScript, tok.decode(ids), "multi-script sample with Unicode spaces round-trips cleanly");
    }

    private static void checkMelExactMatch(WhisperMelExtractor.MelFeatures ref, WhisperMelExtractor.MelFeatures got, String label) {
        checkEquals(ref.numFrames, got.numFrames, label + " numFrames");
        checkEquals(ref.melBins, got.melBins, label + " melBins");
        checkEquals(ref.data.length, got.data.length, label + " length");
        float maxDiff = 0.0f;
        for (int i = 0; i < ref.data.length; i++) {
            float d = Math.abs(ref.data[i] - got.data[i]);
            if (d > maxDiff) maxDiff = d;
        }
        check(maxDiff < 1e-6f, label + " exact parity (maxDiff=" + maxDiff + ")");
    }

    private static void testIncrementalMelExtractorParityAndReset() {
        WhisperMelExtractor melEx = new WhisperMelExtractor();
        WhisperMelExtractor.IncrementalExtractor inc = melEx.new IncrementalExtractor();

        // Null / too-short inputs reset cleanly
        WhisperMelExtractor.IncrementalMelResult empty = inc.extract(null, 0);
        checkEquals(0, empty.mel.numFrames, "null incremental input returns empty");
        checkEquals(0, empty.unchangedMelFrames, "null incremental input has 0 unchanged frames");
        empty = inc.extract(new float[] { 0.1f }, 1);
        checkEquals(0, empty.mel.numFrames, "1-sample incremental input returns empty");

        // Monotonic growth with consistent peak in first 2s -> prefix chunks stay cached
        int total = 16000 * 13 + 8000;
        float[] pcm = new float[total];
        for (int i = 0; i < total; i++) {
            double t = i / 16000.0;
            float env = (i < 16000) ? 0.5f : 0.15f;
            pcm[i] = env * (float) (Math.sin(2 * Math.PI * 300.0 * t) + 0.4 * Math.sin(2 * Math.PI * 1200.0 * t));
        }

        int[] growSteps = new int[] { 24000, 32000, 64000, 96000, 128000, 160000, 192000, total };
        int sawNonZeroUnchanged = 0;
        for (int len : growSteps) {
            WhisperMelExtractor.MelFeatures ref = melEx.extract(pcm, len);
            WhisperMelExtractor.IncrementalMelResult res = inc.extract(pcm, len);
            checkMelExactMatch(ref, res.mel, "grow len=" + len);
            if (res.unchangedMelFrames > 0) sawNonZeroUnchanged++;
        }
        check(sawNonZeroUnchanged >= 5, "incremental growth reuses prefix chunks (" + sawNonZeroUnchanged + ")");

        // Trailing shrink (lowest-energy split 13.5s -> 11.55s) retains unchanged prefix chunks
        int splitLen = 184800;
        WhisperMelExtractor.MelFeatures splitRef = melEx.extract(pcm, splitLen);
        WhisperMelExtractor.IncrementalMelResult splitRes = inc.extract(pcm, splitLen);
        checkMelExactMatch(splitRef, splitRes.mel, "shrink splitAtLowestEnergy parity");
        check(splitRes.unchangedMelFrames >= 1000, "shrink keeps leading chunks (" + splitRes.unchangedMelFrames + ")");

        // Sudden louder peak in tail raises floor -> clamps earlier chunks differently -> must still match stateless extract
        float[] spiked = Arrays.copyOf(pcm, 16000 * 5);
        for (int i = 16000 * 4; i < 16000 * 4 + 2000; i++) {
            spiked[i] = 0.99f * (float) Math.sin(2 * Math.PI * 1000.0 * (i / 16000.0));
        }
        // First extract soft 3s then louder 5s
        inc.reset();
        checkMelExactMatch(melEx.extract(spiked, 16000 * 3), inc.extract(spiked, 16000 * 3).mel, "pre-spike 3s");
        WhisperMelExtractor.IncrementalMelResult postSpike = inc.extract(spiked, 16000 * 5);
        checkMelExactMatch(melEx.extract(spiked, 16000 * 5), postSpike.mel, "post-spike 5s floor shift");
        // Now shrink back to 3s (floor drops: newFloor < cachedFloor) -> previously clamped chunks must un-clamp accurately
        WhisperMelExtractor.IncrementalMelResult unspikeShrink = inc.extract(spiked, 16000 * 3);
        checkMelExactMatch(melEx.extract(spiked, 16000 * 3), unspikeShrink.mel, "floor-drop shrink 3s");

        // Replaced carried tail (new segment starts with different audio) invalidates cached chunks cleanly
        float[] nextSeg = new float[16000 * 3];
        for (int i = 0; i < nextSeg.length; i++) {
            nextSeg[i] = 0.3f * (float) Math.cos(2 * Math.PI * 750.0 * (i / 16000.0));
        }
        WhisperMelExtractor.IncrementalMelResult replaced = inc.extract(nextSeg, nextSeg.length);
        checkEquals(0, replaced.unchangedMelFrames, "replaced segment has 0 unchanged prefix frames");
        checkMelExactMatch(melEx.extract(nextSeg, nextSeg.length), replaced.mel, "replaced segment parity");

        // Regression: periodic frequencies (400 Hz vs 3600 Hz) that alias on sparse sampling must never collide
        inc.reset();
        float[] tone400 = new float[16000 * 2];
        float[] tone3600 = new float[16000 * 2];
        for (int i = 0; i < tone400.length; i++) {
            tone400[i] = (float) Math.sin(2.0 * Math.PI * 400.0 * i / 16000.0);
            tone3600[i] = (float) Math.sin(2.0 * Math.PI * 3600.0 * i / 16000.0);
        }
        checkMelExactMatch(melEx.extract(tone400, tone400.length), inc.extract(tone400, tone400.length).mel, "400Hz seed");
        WhisperMelExtractor.IncrementalMelResult aliasCheck = inc.extract(tone3600, tone3600.length);
        checkEquals(0, aliasCheck.unchangedMelFrames, "3600Hz replacement after 400Hz must not collide on chunk hash");
        checkMelExactMatch(melEx.extract(tone3600, tone3600.length), aliasCheck.mel, "3600Hz exact parity after 400Hz");
    }

    private static void testSpeechInboxZeroWarmupPreservesPrefillOrder() throws Exception {
        Qwen3SpeechWindow.SpeechInbox prefillInbox = new Qwen3SpeechWindow.SpeechInbox(new SpeechGain(), 0);
        checkEquals(0, prefillInbox.getWarmupRemaining(), "warmup=0 skips warmup drop");

        float[] initial = new float[1600];
        for (int i = 0; i < initial.length; i++) {
            initial[i] = 0.25f * (float) Math.sin(2.0 * Math.PI * 300.0 * i / 16000.0);
        }
        float[] live = new float[800];
        for (int i = 0; i < live.length; i++) {
            live[i] = 0.25f * (float) Math.sin(2.0 * Math.PI * 600.0 * i / 16000.0);
        }

        check(prefillInbox.offer(initial, initial.length), "prefill chunk admitted");
        check(prefillInbox.offer(live, live.length), "live chunk admitted behind prefill");
        Qwen3SpeechWindow.SpeechInbox.Batch combined = prefillInbox.take();
        check(combined != null, "batch drained");
        checkEquals(initial.length + live.length, combined.samples.length, "all 1600 prefill + 800 live samples preserved without 320-sample warmup drop");

        double initialDiff = Math.abs(combined.samples[1] - initial[1]);
        check(initialDiff < 0.05, "leading prefill samples retained at start of batch");
    }

    private static void testDecodePcm16LittleEndianAndTranscribeOfflineSamples() {
        short[] rawShorts = new short[] { 0, 16384, -16384, Short.MAX_VALUE, Short.MIN_VALUE };
        byte[] bytes = new byte[rawShorts.length * 2];
        for (int i = 0; i < rawShorts.length; i++) {
            bytes[i * 2] = (byte) (rawShorts[i] & 0xff);
            bytes[i * 2 + 1] = (byte) ((rawShorts[i] >> 8) & 0xff);
        }
        float[] decoded = Qwen3SpeechWindow.decodePcm16LittleEndian(bytes);
        check(decoded != null && decoded.length == rawShorts.length, "decoded 5 PCM16 LE samples");
        check(Math.abs(decoded[1] - 0.5f) < 1e-4f, "+16384 decodes to +0.5");
        check(Math.abs(decoded[2] + 0.5f) < 1e-4f, "-16384 decodes to -0.5");
        check(Qwen3SpeechWindow.decodePcm16LittleEndian(new byte[] { 1, 2, 3 }) == null, "odd-byte PCM rejects as null");

        int total = 16000 * 3;
        float[] speech = new float[total];
        for (int i = 0; i < total; i++) {
            speech[i] = 0.2f * (float) Math.sin(2.0 * Math.PI * 300.0 * i / 16000.0);
        }
        List<Integer> decodedCounts = new ArrayList<>();
        String out = Qwen3SpeechWindow.transcribeOfflineSamples(
            speech,
            Qwen3SpeechWindow::defaultRollbackPrefix,
            (pcm, count, prefix) -> {
                decodedCounts.add(count);
                return new Qwen3SpeechWindow.DecodeResult("本地转写完成", new int[] { 11 });
            },
            () -> true
        );
        checkEquals("本地转写完成", out, "transcribeOfflineSamples returns final text");
        check(!decodedCounts.isEmpty(), "decoder invoked across 2s chunks and final flush");
        checkEquals(
            total + Qwen3SpeechWindow.FINAL_SILENCE_PADDING,
            decodedCounts.get(decodedCounts.size() - 1),
            "final decode receives entire 3s buffer plus 200ms final silence padding"
        );
    }
}
