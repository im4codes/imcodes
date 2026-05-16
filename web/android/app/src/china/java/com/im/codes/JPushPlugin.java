package com.im.codes;

import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import cn.jpush.android.api.JPushInterface;

/**
 * Capacitor bridge for the 极光推送 JPush SDK (china flavor only).
 *
 * Exposed JS API (see web/src/push-notifications.ts):
 *   - getRegistrationID() → { registrationID: string }
 *       Resolves with the JPush RegistrationID. SDK provisioning is
 *       asynchronous after JPushInterface.init() — this method polls for
 *       up to 30 seconds before rejecting, which covers a cold start on
 *       a slow network.
 *   - clearAllNotifications() → void
 *       Clears the system tray for the app (matches Android iOS badge-reset).
 *
 * Events emitted to JS:
 *   - notificationOpened: { extras: Record<string, any>, title, alert }
 *       Forwarded from JPushReceiver when the user taps a notification.
 *   - notificationReceived: { extras: Record<string, any>, title, alert }
 *       Forwarded when a notification is delivered with app in the foreground.
 *
 * Receiver-to-plugin bridging uses the static `instance` reference because
 * JPushMessageReceiver is constructed by the Android framework, not by
 * Capacitor — we have no other handle on the live plugin instance.
 */
@CapacitorPlugin(name = "JPush")
public class JPushPlugin extends Plugin {
    private static final String TAG = "JPushPlugin";
    private static final long REGISTRATION_POLL_INTERVAL_MS = 500;
    private static final long REGISTRATION_POLL_TIMEOUT_MS = 30_000;

    private static volatile JPushPlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
        Log.i(TAG, "JPushPlugin loaded");
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getRegistrationID(PluginCall call) {
        Handler handler = new Handler(Looper.getMainLooper());
        long deadline = System.currentTimeMillis() + REGISTRATION_POLL_TIMEOUT_MS;
        handler.post(new Runnable() {
            @Override
            public void run() {
                String id = JPushInterface.getRegistrationID(getContext());
                if (!TextUtils.isEmpty(id)) {
                    JSObject ret = new JSObject();
                    ret.put("registrationID", id);
                    call.resolve(ret);
                    return;
                }
                if (System.currentTimeMillis() >= deadline) {
                    call.reject("JPush registration_id not provisioned within "
                            + (REGISTRATION_POLL_TIMEOUT_MS / 1000) + "s");
                    return;
                }
                handler.postDelayed(this, REGISTRATION_POLL_INTERVAL_MS);
            }
        });
    }

    @PluginMethod
    public void clearAllNotifications(PluginCall call) {
        JPushInterface.clearAllNotifications(getContext());
        call.resolve();
    }

    // ── Receiver bridge (static, package-private) ────────────────────────

    static void emitRegistration(String registrationId) {
        JPushPlugin p = instance;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("registrationID", registrationId);
        p.notifyListeners("registration", data);
    }

    static void emitNotificationReceived(String title, String alert, String extrasJson) {
        emit("notificationReceived", title, alert, extrasJson);
    }

    static void emitNotificationOpened(String title, String alert, String extrasJson) {
        emit("notificationOpened", title, alert, extrasJson);
    }

    private static void emit(String eventName, String title, String alert, String extrasJson) {
        JPushPlugin p = instance;
        if (p == null) return;
        JSObject data = new JSObject();
        data.put("title", title);
        data.put("alert", alert);
        try {
            data.put("extras", extrasJson != null ? new JSObject(extrasJson) : new JSObject());
        } catch (Throwable t) {
            // Bad/empty JSON — surface empty extras so the JS side never throws on undefined.
            data.put("extras", new JSObject());
        }
        p.notifyListeners(eventName, data);
    }
}
