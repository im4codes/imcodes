package com.im.codes;

import android.content.Context;
import android.util.Log;

import cn.jpush.android.api.CmdMessage;
import cn.jpush.android.api.CustomMessage;
import cn.jpush.android.api.JPushMessage;
import cn.jpush.android.api.NotificationMessage;
import cn.jpush.android.service.JPushMessageReceiver;

/**
 * Translates JPush SDK callbacks into Capacitor events on the live JPushPlugin
 * instance (see JPushPlugin.emit*). Registered in china/AndroidManifest.xml
 * with the `cn.jpush.android.intent.RECEIVE_MESSAGE` intent-filter.
 *
 * We only forward the events JS code needs:
 *   - onRegister:               the registration_id arrived
 *   - onNotifyMessageOpened:    user tapped a notification (cold or warm)
 *   - onNotifyMessageArrived:   notification delivered with app foregrounded
 * Other callbacks (custom message, alias/tag results, command results) are
 * logged at INFO and otherwise ignored — JS doesn't care about them today.
 */
public class JPushReceiver extends JPushMessageReceiver {
    private static final String TAG = "JPushReceiver";

    @Override
    public void onRegister(Context context, String registrationId) {
        Log.i(TAG, "onRegister: " + (registrationId == null ? "<null>" : registrationId.substring(0, Math.min(8, registrationId.length())) + "***"));
        if (registrationId != null) {
            JPushPlugin.emitRegistration(registrationId);
        }
    }

    @Override
    public void onNotifyMessageOpened(Context context, NotificationMessage message) {
        Log.i(TAG, "onNotifyMessageOpened: " + message.notificationTitle);
        JPushPlugin.emitNotificationOpened(message.notificationTitle, message.notificationContent, message.notificationExtras);
    }

    @Override
    public void onNotifyMessageArrived(Context context, NotificationMessage message) {
        Log.i(TAG, "onNotifyMessageArrived: " + message.notificationTitle);
        JPushPlugin.emitNotificationReceived(message.notificationTitle, message.notificationContent, message.notificationExtras);
    }

    @Override
    public void onMessage(Context context, CustomMessage message) {
        // Custom (pass-through) messages — not used by IM.codes today.
        Log.d(TAG, "onMessage (custom): " + message.message);
    }

    @Override
    public void onCommandResult(Context context, CmdMessage message) {
        Log.d(TAG, "onCommandResult: code=" + message.cmd + " err=" + message.errorCode);
    }

    @Override
    public void onTagOperatorResult(Context context, JPushMessage message) {
        Log.d(TAG, "onTagOperatorResult: " + message);
    }

    @Override
    public void onAliasOperatorResult(Context context, JPushMessage message) {
        Log.d(TAG, "onAliasOperatorResult: " + message);
    }
}
