package com.im.codes;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.lang.ref.WeakReference;

/**
 * Native Capacitor bridge for withoutFcm persistent SSE background push.
 * Completely no-ops on withFcm builds (BuildConfig.HAS_FCM == true).
 */
@CapacitorPlugin(
        name = "BackgroundPush",
        permissions = {
                @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
        }
)
public class BackgroundPushPlugin extends Plugin {
    private static final Object LOCK = new Object();
    private static JSObject pendingNotification;
    private static WeakReference<BackgroundPushPlugin> activeInstanceRef = new WeakReference<>(null);

    @Override
    public void load() {
        super.load();
        synchronized (LOCK) {
            activeInstanceRef = new WeakReference<>(this);
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (LOCK) {
            if (activeInstanceRef.get() == this) {
                activeInstanceRef = new WeakReference<>(null);
            }
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatusObject());
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (BuildConfig.HAS_FCM) {
            JSObject ret = new JSObject();
            ret.put("supported", false);
            ret.put("granted", false);
            call.resolve(ret);
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || areNotificationsGranted()) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsPermissionCallback");
    }

    @PermissionCallback
    private void notificationsPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", !BuildConfig.HAS_FCM);
        ret.put("granted", !BuildConfig.HAS_FCM && areNotificationsGranted());
        call.resolve(ret);
        notifyStateChanged(
                BackgroundPushService.getConnectionState(getContext()),
                BackgroundPushService.isRunning());
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        if (BuildConfig.HAS_FCM) {
            JSObject ret = new JSObject();
            ret.put("supported", false);
            ret.put("granted", false);
            call.resolve(ret);
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || isIgnoringBatteryOptimizations()) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        Context context = getContext();
        if (context == null || getActivity() == null) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("granted", false);
            call.resolve(ret);
            return;
        }
        Intent directIntent = new Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + context.getPackageName()));
        try {
            startActivityForResult(call, directIntent, "batteryOptimizationCallback");
            return;
        } catch (ActivityNotFoundException | SecurityException ignored) {
            // Fall through to system list settings below
        }
        Intent fallbackIntent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        try {
            startActivityForResult(call, fallbackIntent, "batteryOptimizationCallback");
        } catch (ActivityNotFoundException | SecurityException ignored) {
            JSObject ret = new JSObject();
            ret.put("supported", true);
            ret.put("granted", isIgnoringBatteryOptimizations());
            call.resolve(ret);
        }
    }

    @ActivityCallback
    private void batteryOptimizationCallback(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        ret.put("supported", !BuildConfig.HAS_FCM);
        ret.put("granted", !BuildConfig.HAS_FCM && isIgnoringBatteryOptimizations());
        call.resolve(ret);
        notifyStateChanged(
                BackgroundPushService.getConnectionState(getContext()),
                BackgroundPushService.isRunning());
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (BuildConfig.HAS_FCM) {
            JSObject ret = new JSObject();
            ret.put("supported", false);
            ret.put("started", false);
            call.resolve(ret);
            return;
        }
        Context context = getContext();
        String serverUrl = call.getString("serverUrl");
        String apiKey = call.getString("apiKey");
        String statusTitle = call.getString("statusTitle");
        String statusText = call.getString("statusText");
        boolean started = BackgroundPushService.configureAndStart(context, serverUrl, apiKey, statusTitle, statusText);
        JSObject ret = new JSObject();
        ret.put("supported", true);
        ret.put("started", started);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!BuildConfig.HAS_FCM && getContext() != null) {
            BackgroundPushService.stopAndClear(getContext());
        }
        JSObject ret = new JSObject();
        ret.put("supported", !BuildConfig.HAS_FCM);
        ret.put("stopped", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void consumePendingNotification(PluginCall call) {
        JSObject ret = new JSObject();
        if (BuildConfig.HAS_FCM) {
            ret.put("notification", JSObject.NULL);
            call.resolve(ret);
            return;
        }
        JSObject payload;
        synchronized (LOCK) {
            payload = pendingNotification;
            pendingNotification = null;
        }
        ret.put("notification", payload != null ? payload : JSObject.NULL);
        call.resolve(ret);
    }

    public static void handleNotificationIntent(Intent intent) {
        if (BuildConfig.HAS_FCM || intent == null) {
            return;
        }
        String serverId = intent.getStringExtra(BackgroundPushService.EXTRA_PUSH_SERVER_ID);
        String session = intent.getStringExtra(BackgroundPushService.EXTRA_PUSH_SESSION);
        if ((serverId == null || serverId.isEmpty()) && (session == null || session.isEmpty())) {
            return;
        }
        JSObject payload = new JSObject();
        if (serverId != null && !serverId.isEmpty()) {
            payload.put("serverId", serverId);
        }
        if (session != null && !session.isEmpty()) {
            payload.put("session", session);
        }
        BackgroundPushPlugin active;
        synchronized (LOCK) {
            pendingNotification = payload;
            active = activeInstanceRef.get();
        }
        if (active != null && active.hasListeners("backgroundPushActionPerformed")) {
            synchronized (LOCK) {
                pendingNotification = null;
            }
            active.notifyListeners("backgroundPushActionPerformed", payload);
        }
    }

    public static void notifyStateChanged(String connectionState, boolean running) {
        if (BuildConfig.HAS_FCM) {
            return;
        }
        BackgroundPushPlugin active;
        synchronized (LOCK) {
            active = activeInstanceRef.get();
        }
        if (active != null) {
            JSObject payload = active.buildStatusObject();
            payload.put("connectionState", connectionState);
            payload.put("running", running);
            active.notifyListeners("backgroundPushStateChanged", payload);
        }
    }

    private JSObject buildStatusObject() {
        JSObject ret = new JSObject();
        if (BuildConfig.HAS_FCM) {
            ret.put("supported", false);
            ret.put("hasFcm", true);
            ret.put("enabled", false);
            ret.put("running", false);
            ret.put("connectionState", BackgroundPushService.STATE_DISABLED);
            ret.put("notificationsGranted", areNotificationsGranted());
            ret.put("batteryOptimizationIgnored", false);
            return ret;
        }
        Context context = getContext();
        ret.put("supported", true);
        ret.put("hasFcm", false);
        ret.put("enabled", BackgroundPushService.isEnabled(context));
        ret.put("running", BackgroundPushService.isRunning());
        ret.put("connectionState", BackgroundPushService.getConnectionState(context));
        ret.put("notificationsGranted", areNotificationsGranted());
        ret.put("batteryOptimizationIgnored", isIgnoringBatteryOptimizations());
        return ret;
    }

    private boolean areNotificationsGranted() {
        Context context = getContext();
        if (context == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isIgnoringBatteryOptimizations() {
        Context context = getContext();
        if (context == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
    }
}
