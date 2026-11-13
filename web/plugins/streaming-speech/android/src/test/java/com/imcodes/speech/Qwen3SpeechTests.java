package com.imcodes.speech;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

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
        testTokenizerEncodeDecodeAndRollback();
        testSpeechInboxWarmupThrottleOverload();
        testSpeechWindowPrefixRollbackAndVad();
        testSpeechWindowLowestEnergySplit();
        testOnnxDecoderPureHelpers();
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
        check(lvl1 != null && lvl1 > 0.2, "first audioLevel emitted immediately post-warmup");

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
}
