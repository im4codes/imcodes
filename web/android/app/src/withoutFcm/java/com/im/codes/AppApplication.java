package com.im.codes;

import android.app.Application;

import com.imcodes.speech.SpeechModelExtractor;

/** Pure build application entry point; no push SDK is initialized. */
public class AppApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        SpeechModelExtractor.warmUpAsync(this);
    }
}
