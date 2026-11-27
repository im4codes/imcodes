package com.im.codes;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class BackgroundPushServiceTest {
    @Test
    public void normalizeServerUrl_enforcesHttpsInReleaseAndAllowsDebugLoopbackOnly() {
        // Release (allowDebugLoopback = false): rejects ALL http:// including loopback
        assertEquals("https://app.im.codes", BackgroundPushService.normalizeServerUrl("https://app.im.codes/", false));
        assertNull(BackgroundPushService.normalizeServerUrl("http://app.im.codes", false));
        assertNull(BackgroundPushService.normalizeServerUrl("http://127.0.0.1:18765", false));
        assertNull(BackgroundPushService.normalizeServerUrl("http://localhost:18765", false));
        assertNull(BackgroundPushService.normalizeServerUrl("https://user:pass@app.im.codes", false));

        // Debug (allowDebugLoopback = true): allows loopback http:// only, rejects remote http://
        assertEquals("http://127.0.0.1:18765", BackgroundPushService.normalizeServerUrl("http://127.0.0.1:18765/", true));
        assertEquals("http://localhost:8080", BackgroundPushService.normalizeServerUrl("http://localhost:8080", true));
        assertNull(BackgroundPushService.normalizeServerUrl("http://192.168.1.25:8080", true));
        assertNull(BackgroundPushService.normalizeServerUrl("http://example.com", true));
    }

    @Test
    public void isSseContentType_validatesEventStreamPrefixOnly() {
        assertTrue(BackgroundPushService.isSseContentType("text/event-stream"));
        assertTrue(BackgroundPushService.isSseContentType("text/event-stream; charset=utf-8"));
        assertFalse(BackgroundPushService.isSseContentType("text/html; charset=utf-8"));
        assertFalse(BackgroundPushService.isSseContentType("application/json"));
        assertFalse(BackgroundPushService.isSseContentType(null));
    }

    @Test
    public void streamSessionTracker_doesNotResetBackoffOnImmediateEofAndResetsOnlyAfterStableDuration() {
        AtomicLong clockMs = new AtomicLong(1_000L);
        BackgroundPushService.StreamSessionTracker immediateEof =
                new BackgroundPushService.StreamSessionTracker(clockMs::get);
        // 200 OK followed by immediate EOF with 0 frames
        assertFalse(immediateEof.hasReceivedValidFrame());
        assertFalse(immediateEof.shouldResetBackoff());

        // 200 OK + : connected line followed by immediate EOF (< STABLE_CONNECTION_MS)
        immediateEof.markFrameReceived();
        clockMs.addAndGet(500L);
        assertFalse(immediateEof.shouldResetBackoff());

        int idx = 0;
        assertEquals(2_000L, BackgroundPushService.computeRetryDelayMs(idx, immediateEof.shouldResetBackoff()));
        idx = BackgroundPushService.nextBackoffIndex(idx, immediateEof.shouldResetBackoff());
        assertEquals(1, idx);
        assertEquals(4_000L, BackgroundPushService.computeRetryDelayMs(idx, immediateEof.shouldResetBackoff()));
        idx = BackgroundPushService.nextBackoffIndex(idx, immediateEof.shouldResetBackoff());
        assertEquals(2, idx);
        assertEquals(8_000L, BackgroundPushService.computeRetryDelayMs(idx, immediateEof.shouldResetBackoff()));

        // Stable SSE stream surviving >= STABLE_CONNECTION_MS resets backoff to 2s
        BackgroundPushService.StreamSessionTracker stable =
                new BackgroundPushService.StreamSessionTracker(clockMs::get);
        stable.markFrameReceived();
        clockMs.addAndGet(BackgroundPushService.STABLE_CONNECTION_MS);
        assertTrue(stable.shouldResetBackoff());
        assertEquals(2_000L, BackgroundPushService.computeRetryDelayMs(idx, stable.shouldResetBackoff()));
        assertEquals(0, BackgroundPushService.nextBackoffIndex(idx, stable.shouldResetBackoff()));
    }
}
