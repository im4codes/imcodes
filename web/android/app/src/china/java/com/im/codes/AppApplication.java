package com.im.codes;

import android.app.Application;
import android.util.Log;

import cn.jpush.android.api.JPushInterface;

/**
 * China flavor — 国内 build. Bootstraps the 极光推送 JPush SDK so the
 * registration_id is provisioned on the very first launch and the persistent
 * push channel is up before any Activity runs.
 *
 * Vendor channel plugins (Xiaomi / vivo, etc.) initialise themselves through
 * manifestPlaceholders during JPushInterface.init — no per-vendor call here.
 */
public class AppApplication extends Application {
    private static final String TAG = "AppApplication";

    @Override
    public void onCreate() {
        super.onCreate();

        // Enable verbose JPush logging in debug builds for triage. Always set
        // BEFORE init() so the init pass itself is logged.
        JPushInterface.setDebugMode(BuildConfig.DEBUG);
        try {
            JPushInterface.init(this);
            Log.i(TAG, "JPush init dispatched (registration_id arrives asynchronously via JPushReceiver)");
        } catch (Throwable t) {
            // Never let JPush init kill the app — push is a best-effort enhancement,
            // not a hard dependency for the app to function.
            Log.e(TAG, "JPush init threw; push disabled this session", t);
        }
    }
}
