package com.im.codes;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Restarts BackgroundPushService after device reboot or app update on withoutFcm builds
 * when the user has enabled background push and valid credentials remain saved.
 */
public class BackgroundPushBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (BuildConfig.HAS_FCM || context == null || intent == null) {
            return;
        }
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        if (!BackgroundPushService.isConfiguredAndEnabled(context)) {
            return;
        }
        BackgroundPushService.startFromSavedConfig(context);
    }
}
