package com.im.codes;

import android.app.Application;

/**
 * Global flavor —海外 Play Store build. Push runs through FCM via the standard
 * Capacitor `@capacitor/push-notifications` plugin, which initialises itself
 * on demand from the Activity; this Application class is therefore a no-op
 * scaffold that exists only because the manifest declares `android:name`.
 */
public class AppApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
    }
}
