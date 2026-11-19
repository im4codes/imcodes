package com.imcodes.speech;

/**
 * Pure JDK unit tests for {@link SpeechGain} covering quiet speech pickup,
 * loud-speech soft-knee limiting, noise-floor gating, trailing silence flush,
 * and finite sample bounds. Runnable directly via {@code javac}/{@code java}.
 */
public final class SpeechGainTest {
    private static final int CHUNK_SAMPLES = 1600; // 100ms at 16kHz

    public static void main(String[] args) {
        testQuietHandheldSpeechBoostedImmediately();
        testMediumQuietSpeechBoostedAndResponsiveLevel();
        testLoudSpeechAttenuatedAndSoftKneeLimitedWithoutHardClipping();
        testUltraLowRoomFloorDoesNotTriggerFalseVoicedOrInfiniteGain();
        testSilenceAfterSpeechDropsVoicedImmediately();
        testNonFiniteAndEdgeInputsRemainBounded();
        testSubBassHumRejectedAndFanNoiseAdaptsFloorWhileSpeechStillTriggers();
        System.out.println("SpeechGainTest: ALL 7 TESTS PASSED");
    }

    private static void testQuietHandheldSpeechBoostedImmediately() {
        SpeechGain gain = new SpeechGain();
        float[] chunk = sineWithRms(CHUNK_SAMPLES, 0.0025f);
        double level = gain.processChunk(chunk, chunk.length);
        double outRms = rms(chunk);

        assertTrue(Math.abs(outRms - 0.0025) < 1e-4, "quiet speech must stay clean unboosted near 0.0025, got " + outRms);
        assertTrue(Math.abs(level - 0.0025) < 1e-4, "level must report unscaled clean RMS near 0.0025, got " + level);
        assertTrue(level >= SpeechGain.VAD_LEVEL_THRESHOLD, "quiet speech first chunk should exceed VAD threshold, got " + level);
        assertTrue(SpeechGain.isVoiced(chunk), "quiet speech (RMS 0.0025) must trigger voiced == true");
        assertTrue(gain.getCurrentGain() == 1.0f, "gain must remain unity 1.0f");
        assertAllSamplesBounded(chunk);
    }

    private static void testMediumQuietSpeechBoostedAndResponsiveLevel() {
        SpeechGain gain = new SpeechGain();
        double lastLevel = 0.0;
        for (int i = 0; i < 4; i++) {
            float[] chunk = sineWithRms(CHUNK_SAMPLES, 0.005f);
            lastLevel = gain.processChunk(chunk, chunk.length);
            assertTrue(SpeechGain.isVoiced(chunk), "0.005 RMS speech chunk " + i + " must be voiced");
            assertAllSamplesBounded(chunk);
        }
        assertTrue(Math.abs(lastLevel - 0.005) < 1e-4, "HUD audioLevel should reflect unscaled RMS 0.005, got " + lastLevel);
        assertTrue(gain.getCurrentGain() == 1.0f, "gain must remain unity 1.0f");
    }

    private static void testLoudSpeechAttenuatedAndSoftKneeLimitedWithoutHardClipping() {
        SpeechGain gain = new SpeechGain();
        gain.processChunk(sineWithRms(CHUNK_SAMPLES, 0.0025f));

        float[] firstLoud = sineWithRms(CHUNK_SAMPLES, 0.85f);
        gain.processChunk(firstLoud, firstLoud.length);
        assertAllSamplesBounded(firstLoud);
        assertTrue(maxAbs(firstLoud) < 1.0f || Math.abs(maxAbs(firstLoud) - 1.0f) <= 1e-6f, "first loud chunk must stay within [-1, 1]");

        float[] steadyLoud = sineWithRms(CHUNK_SAMPLES, 0.70f);
        for (int i = 0; i < 4; i++) {
            steadyLoud = sineWithRms(CHUNK_SAMPLES, 0.70f);
            gain.processChunk(steadyLoud, steadyLoud.length);
            assertAllSamplesBounded(steadyLoud);
        }
        assertTrue(Math.abs(rms(steadyLoud) - 0.70) < 0.05, "steady loud speech below soft knee should stay clean, got " + rms(steadyLoud));
        assertTrue(SpeechGain.isVoiced(steadyLoud), "loud speech must remain voiced");

        // Verify softLimit itself compresses > 1.0 smoothly without flat-top hard clipping
        float high = SpeechGain.softLimit(1.8f);
        float higher = SpeechGain.softLimit(2.4f);
        assertTrue(high > SpeechGain.SOFT_KNEE && high < 1.0f, "softLimit(1.8) should be strictly below 1.0, got " + high);
        assertTrue(higher > high && higher <= 1.0f, "softLimit must remain monotonic instead of flat-topping");
    }

    private static void testUltraLowRoomFloorDoesNotTriggerFalseVoicedOrInfiniteGain() {
        SpeechGain gain = new SpeechGain();
        float[] zeroSilence = new float[CHUNK_SAMPLES];
        double zeroLevel = gain.processChunk(zeroSilence, zeroSilence.length);
        assertTrue(zeroLevel == 0.0, "zero silence level must be 0.0");
        assertTrue(!SpeechGain.isVoiced(zeroSilence), "zero silence must not trigger voiced");

        for (int i = 0; i < 50; i++) {
            float[] roomFloor = sineWithRms(CHUNK_SAMPLES, 0.0012f);
            double level = gain.processChunk(roomFloor, roomFloor.length);
            assertTrue(!SpeechGain.isVoiced(roomFloor), "room floor 0.0012 must not trigger false voiced at chunk " + i + ", level=" + level);
            assertTrue(Float.isFinite(gain.getCurrentGain()) && gain.getCurrentGain() <= SpeechGain.MAX_GAIN,
                "gain must stay finite and bounded during room silence");
            assertAllSamplesBounded(roomFloor);
        }

        // Quiet speech right after sustained room floor must still trigger voiced immediately.
        float[] onsetAfterSilence = sineWithRms(CHUNK_SAMPLES, 0.0020f);
        gain.processChunk(onsetAfterSilence, onsetAfterSilence.length);
        assertTrue(SpeechGain.isVoiced(onsetAfterSilence), "quiet speech (0.0020) after room floor must still trigger voiced");
    }

    private static void testSilenceAfterSpeechDropsVoicedImmediately() {
        SpeechGain gain = new SpeechGain();
        for (int i = 0; i < 6; i++) {
            float[] speech = sineWithRms(CHUNK_SAMPLES, 0.0025f);
            gain.processChunk(speech, speech.length);
            assertTrue(SpeechGain.isVoiced(speech), "speech chunk should be voiced");
        }
        assertTrue(gain.getCurrentGain() == 1.0f, "gain must remain unity 1.0f");

        // Next chunk drops to room floor (0.0007f): remains unboosted and immediately drops voiced == false.
        float[] trailingSilence = sineWithRms(CHUNK_SAMPLES, 0.0007f);
        double level = gain.processChunk(trailingSilence, trailingSilence.length);
        assertTrue(level < 0.001, "room floor level must stay raw (< 0.001), got " + level);
        assertTrue(!SpeechGain.isVoiced(trailingSilence),
            "trailing room silence after speech must drop voiced == false immediately, got level=" + level);
    }

    private static void testNonFiniteAndEdgeInputsRemainBounded() {
        SpeechGain gain = new SpeechGain();
        assertTrue(gain.processChunk(null, 10) == 0.0, "null array must return 0.0");
        assertTrue(gain.processChunk(new float[0], 0) == 0.0, "empty array must return 0.0");
        assertTrue(SpeechGain.computeLevel(null) == 0.0, "computeLevel(null) must return 0.0");
        assertTrue(!SpeechGain.isVoiced(new float[0]), "empty chunk must not be voiced");

        float[] dirty = new float[] { Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, 0.05f, -0.05f, 3.0f, -3.0f };
        double level = gain.processChunk(dirty, dirty.length);
        assertTrue(Double.isFinite(level) && level >= 0.0 && level <= 1.0, "level must remain finite in [0,1]");
        assertAllSamplesBounded(dirty);
    }

    private static void testSubBassHumRejectedAndFanNoiseAdaptsFloorWhileSpeechStillTriggers() {
        SpeechGain gain = new SpeechGain();
        // 60 Hz sub-bass hum below 125 Hz HPF cutoff at 0.01 RMS must NOT be marked voiced.
        float[] hum60 = new float[CHUNK_SAMPLES];
        for (int i = 0; i < hum60.length; i++) {
            hum60[i] = (float) (0.01 * Math.sqrt(2.0) * Math.sin(2.0 * Math.PI * 60.0 * i / 16000.0));
        }
        SpeechGain.Result humRes = gain.processDetailed(hum60, hum60.length);
        assertTrue(!humRes.anyVoiced, "60Hz sub-bass hum must be rejected by 125Hz HPF");
        assertTrue(gain.getCurrentGain() == 1.0f, "unity gain preserved during hum");

        // Sustained broadband fan noise (~0.0025 RMS) adapts noiseFloor up above initial 0.00075
        // without locking voiced.
        long seed = 0x160000L;
        for (int step = 0; step < 30; step++) {
            float[] fan = new float[CHUNK_SAMPLES];
            double sumSq = 0.0;
            for (int i = 0; i < fan.length; i++) {
                seed = seed * 6364136223846793005L + 1442695040888963407L;
                float u = ((seed >>> 40) & 0xFFFFFF) / (float) (1 << 24) * 2.0f - 1.0f;
                fan[i] = u;
                sumSq += (double) u * u;
            }
            float scale = (float) (0.0025 / Math.sqrt(sumSq / fan.length));
            for (int i = 0; i < fan.length; i++) fan[i] *= scale;
            SpeechGain.Result fanRes = gain.processDetailed(fan, fan.length);
            if (step >= 10) {
                assertTrue(!fanRes.anyVoiced, "stationary broadband fan noise must not falsely trigger voiced at step " + step);
            }
        }
        assertTrue(gain.getNoiseFloor() >= 0.0018f, "noiseFloor must adapt to stationary fan noise, got " + gain.getNoiseFloor());

        // Soft 220Hz speech (0.0055 RMS) over adapted floor must still trigger voiced cleanly at unity gain.
        float[] speech = sineWithRms(CHUNK_SAMPLES, 0.0055f);
        SpeechGain.Result speechRes = gain.processDetailed(speech, speech.length);
        assertTrue(speechRes.anyVoiced && speechRes.voicedSamples == CHUNK_SAMPLES,
            "soft speech over adapted floor must still trigger voiced");
        assertTrue(gain.getCurrentGain() == 1.0f, "unity gain preserved during speech");
    }

    private static float[] sineWithRms(int length, float targetRms) {
        float[] out = new float[length];
        double amplitude = targetRms * Math.sqrt(2.0);
        for (int i = 0; i < length; i++) {
            out[i] = (float) (amplitude * Math.sin(2.0 * Math.PI * 220.0 * i / 16000.0));
        }
        return out;
    }

    private static double rms(float[] samples) {
        double power = 0.0;
        for (float s : samples) {
            power += (double) s * s;
        }
        return Math.sqrt(power / samples.length);
    }

    private static float maxAbs(float[] samples) {
        float max = 0.0f;
        for (float s : samples) {
            float a = Math.abs(s);
            if (a > max) max = a;
        }
        return max;
    }

    private static void assertAllSamplesBounded(float[] samples) {
        for (int i = 0; i < samples.length; i++) {
            float s = samples[i];
            assertTrue(Float.isFinite(s), "sample[" + i + "] must be finite, got " + s);
            assertTrue(Math.abs(s) <= 1.0f, "sample[" + i + "] out of [-1, 1] bounds: " + s);
        }
    }

    private static void assertTrue(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
