package com.imcodes.speech;

import androidx.lifecycle.Lifecycle;
import org.junit.Assert;
import org.junit.Test;

public final class StreamingSpeechPluginLifecycleTest {
    @Test
    public void foregroundCheckAllowsStartedDuringPermissionCallbackAndRejectsBackgroundedStates() {
        Assert.assertTrue(StreamingSpeechPlugin.isActivityForegroundForSpeech(Lifecycle.State.STARTED));
        Assert.assertTrue(StreamingSpeechPlugin.isActivityForegroundForSpeech(Lifecycle.State.RESUMED));
        Assert.assertFalse(StreamingSpeechPlugin.isActivityForegroundForSpeech(Lifecycle.State.CREATED));
        Assert.assertFalse(StreamingSpeechPlugin.isActivityForegroundForSpeech(Lifecycle.State.INITIALIZED));
        Assert.assertFalse(StreamingSpeechPlugin.isActivityForegroundForSpeech(Lifecycle.State.DESTROYED));
        Assert.assertFalse(StreamingSpeechPlugin.isActivityForegroundForSpeech(null));
    }
}
