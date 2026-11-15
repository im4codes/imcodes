package com.im.codes;

import android.app.Application;

import com.imcodes.speech.SpeechModelExtractor;

/**
 * International edition (Google Play / non-Mainland-China distribution).
 * Push runs through FCM via the standard Capacitor `@capacitor/push-notifications`
 * plugin, which initialises itself on demand from the Activity; triggers idempotent
 * background extraction of offline speech assets early at process startup.
 */
public class AppApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        SpeechModelExtractor.warmUpAsync(this);
    }
}
