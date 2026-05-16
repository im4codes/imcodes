package com.im.codes;

import android.app.Application;

/**
 * International edition (Google Play / non-Mainland-China distribution).
 * Push runs through FCM via the standard Capacitor `@capacitor/push-notifications`
 * plugin, which initialises itself on demand from the Activity; this
 * Application class is therefore a no-op scaffold that exists only because
 * the manifest declares `android:name`.
 */
public class AppApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
    }
}
