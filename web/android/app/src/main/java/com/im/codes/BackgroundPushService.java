package com.im.codes;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Pure Android SDK / JDK persistent SSE foreground service for the withoutFcm build.
 * Strictly no third-party push SDK and strictly no WebSocket: maintains one light
 * GET /api/push/stream SSE connection over HttpURLConnection/HttpsURLConnection.
 */
public class BackgroundPushService extends Service {
    private static final String TAG = "BackgroundPushService";

    public static final String ACTION_START = "com.im.codes.action.BG_PUSH_START";
    public static final String ACTION_STOP = "com.im.codes.action.BG_PUSH_STOP";
    public static final String EXTRA_PUSH_SERVER_ID = "push_server_id";
    public static final String EXTRA_PUSH_SESSION = "push_session";

    public static final String STATE_DISABLED = "disabled";
    public static final String STATE_STOPPED = "stopped";
    public static final String STATE_CONNECTING = "connecting";
    public static final String STATE_CONNECTED = "connected";
    public static final String STATE_WAITING_NETWORK = "waiting_network";
    public static final String STATE_AUTH_ERROR = "auth_error";

    private static final String PREFS_NAME = "imcodes_bg_push_prefs";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String KEY_API_KEY = "api_key";
    private static final String KEY_STATUS_TITLE = "status_title";
    private static final String KEY_STATUS_TEXT = "status_text";

    private static final String STATUS_CHANNEL_ID = "imcodes_bg_push_status";
    private static final String ALERTS_CHANNEL_ID = "imcodes_bg_push_alerts";
    private static final int STATUS_NOTIFICATION_ID = 4201;
    private static final int ALERT_NOTIFICATION_BASE_ID = 5100;

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 75_000;
    static final long STABLE_CONNECTION_MS = 10_000L;
    private static final long[] BACKOFF_MS = { 2_000L, 4_000L, 8_000L, 15_000L, 30_000L, 60_000L };

    private static final AtomicInteger ALERT_ID_SEQ = new AtomicInteger(0);
    private static final AtomicInteger ACTIVE_SERVICE_GENERATION = new AtomicInteger(0);
    private static volatile boolean serviceRunning = false;
    private static volatile String currentConnectionState = STATE_STOPPED;
    @Nullable
    private static volatile BackgroundPushService activeInstance = null;

    private final Object stateLock = new Object();
    private volatile boolean stopped = false;
    private volatile boolean networkAvailable = true;
    @Nullable
    private volatile HttpURLConnection activeConnection;
    @Nullable
    private Thread workerThread;
    @Nullable
    private ConnectivityManager.NetworkCallback networkCallback;
    private int workerGeneration = 0;

    public static boolean isEnabled(Context context) {
        if (BuildConfig.HAS_FCM || context == null) {
            return false;
        }
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    public static boolean isConfiguredAndEnabled(Context context) {
        if (BuildConfig.HAS_FCM || context == null) {
            return false;
        }
        SharedPreferences p = prefs(context);
        if (!p.getBoolean(KEY_ENABLED, false)) {
            return false;
        }
        String rawUrl = p.getString(KEY_SERVER_URL, null);
        String serverUrl = normalizeServerUrl(context, rawUrl);
        String apiKey = p.getString(KEY_API_KEY, null);
        if (serverUrl == null || apiKey == null || apiKey.trim().isEmpty()) {
            // Purge legacy/invalid cleartext config on restore instead of carrying it forward
            p.edit()
                    .putBoolean(KEY_ENABLED, false)
                    .remove(KEY_API_KEY)
                    .remove(KEY_SERVER_URL)
                    .commit();
            return false;
        }
        return true;
    }

    public static boolean isRunning() {
        return !BuildConfig.HAS_FCM && serviceRunning;
    }

    public static String getConnectionState(Context context) {
        if (BuildConfig.HAS_FCM) {
            return STATE_DISABLED;
        }
        if (!serviceRunning && !isEnabled(context)) {
            return STATE_STOPPED;
        }
        return currentConnectionState;
    }

    public static boolean configureAndStart(
            Context context,
            @Nullable String rawServerUrl,
            @Nullable String rawApiKey,
            @Nullable String statusTitle,
            @Nullable String statusText) {
        if (BuildConfig.HAS_FCM || context == null) {
            return false;
        }
        String serverUrl = normalizeServerUrl(context, rawServerUrl);
        String apiKey = rawApiKey != null ? rawApiKey.trim() : "";
        if (serverUrl == null || apiKey.isEmpty()) {
            return false;
        }

        // Synchronously invalidate any earlier connection generation before persisting new creds.
        ACTIVE_SERVICE_GENERATION.incrementAndGet();

        SharedPreferences.Editor editor = prefs(context).edit()
                .putBoolean(KEY_ENABLED, true)
                .putString(KEY_SERVER_URL, serverUrl)
                .putString(KEY_API_KEY, apiKey);
        if (statusTitle != null && !statusTitle.trim().isEmpty()) {
            editor.putString(KEY_STATUS_TITLE, statusTitle.trim());
        } else {
            editor.remove(KEY_STATUS_TITLE);
        }
        if (statusText != null && !statusText.trim().isEmpty()) {
            editor.putString(KEY_STATUS_TEXT, statusText.trim());
        } else {
            editor.remove(KEY_STATUS_TEXT);
        }
        editor.commit();

        return startFromSavedConfig(context);
    }

    public static boolean startFromSavedConfig(Context context) {
        if (!isConfiguredAndEnabled(context)) {
            return false;
        }
        Intent intent = new Intent(context, BackgroundPushService.class);
        intent.setAction(ACTION_START);
        try {
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "Unable to start BackgroundPushService", e);
            return false;
        }
    }

    public static void stopAndClear(Context context) {
        if (context == null) {
            return;
        }
        ACTIVE_SERVICE_GENERATION.incrementAndGet();
        prefs(context).edit()
                .putBoolean(KEY_ENABLED, false)
                .remove(KEY_API_KEY)
                .remove(KEY_SERVER_URL)
                .remove(KEY_STATUS_TITLE)
                .remove(KEY_STATUS_TEXT)
                .commit();
        currentConnectionState = STATE_STOPPED;
        serviceRunning = false;
        BackgroundPushService instance = activeInstance;
        if (instance != null) {
            instance.invalidateWorkerAndConnection();
        }
        BackgroundPushPlugin.notifyStateChanged(STATE_STOPPED, false);
        if (BuildConfig.HAS_FCM) {
            return;
        }
        try {
            context.stopService(new Intent(context, BackgroundPushService.class));
        } catch (RuntimeException e) {
            Log.w(TAG, "Unable to stop BackgroundPushService", e);
        }
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (BuildConfig.HAS_FCM || (intent != null && ACTION_STOP.equals(intent.getAction())) || !isConfiguredAndEnabled(this)) {
            stopForegroundAndSelf(startId);
            return START_NOT_STICKY;
        }

        ensureNotificationChannels();
        activeInstance = this;
        stopped = false;
        final int serviceGen = ACTIVE_SERVICE_GENERATION.get();
        synchronized (stateLock) {
            final int nextWorkerGen = workerGeneration + 1;
            stopped = false;
            updateConnectionState(serviceGen, workerGeneration, STATE_CONNECTING);
            Notification notification = buildStatusNotification(STATE_CONNECTING);
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    startForeground(STATUS_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
                } else {
                    startForeground(STATUS_NOTIFICATION_ID, notification);
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "startForeground failed for BackgroundPushService", e);
                stopForegroundAndSelf(startId);
                return START_NOT_STICKY;
            }
            serviceRunning = true;
            registerNetworkCallback();
            restartWorker(serviceGen, nextWorkerGen);
        }
        BackgroundPushPlugin.notifyStateChanged(currentConnectionState, true);
        return START_STICKY;
    }

    @Override
    public void onTimeout(int startId) {
        ACTIVE_SERVICE_GENERATION.incrementAndGet();
        stopForegroundAndSelf(startId);
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        ACTIVE_SERVICE_GENERATION.incrementAndGet();
        stopForegroundAndSelf(startId);
    }

    @Override
    public void onDestroy() {
        ACTIVE_SERVICE_GENERATION.incrementAndGet();
        if (activeInstance == this) {
            activeInstance = null;
        }
        stopped = true;
        serviceRunning = false;
        currentConnectionState = STATE_STOPPED;
        unregisterNetworkCallback();
        stopWorker();
        stopForegroundCompat();
        BackgroundPushPlugin.notifyStateChanged(STATE_STOPPED, false);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void invalidateWorkerAndConnection() {
        stopped = true;
        stopWorker();
    }

    private void restartWorker(int serviceGen, int nextWorkerGen) {
        stopWorker();
        synchronized (stateLock) {
            stopped = false;
            workerGeneration = nextWorkerGen;
            workerThread = new Thread(() -> runStreamLoop(serviceGen, nextWorkerGen), "imcodes-bg-push-sse");
            workerThread.setDaemon(true);
            workerThread.start();
        }
    }

    private void stopWorker() {
        final HttpURLConnection conn = activeConnection;
        activeConnection = null;
        if (conn != null) {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                Thread closer = new Thread(() -> {
                    try {
                        conn.disconnect();
                    } catch (Throwable ignored) {
                        // ignore
                    }
                }, "imcodes-bg-push-disconnect");
                closer.setDaemon(true);
                closer.start();
            } else {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                    // ignore
                }
            }
        }
        Thread t;
        synchronized (stateLock) {
            workerGeneration++;
            t = workerThread;
            workerThread = null;
            stateLock.notifyAll();
        }
        if (t != null) {
            t.interrupt();
        }
    }

    private void runStreamLoop(int myServiceGen, int myWorkerGen) {
        int backoffIdx = 0;
        while (isActiveGeneration(myServiceGen, myWorkerGen) && isConfiguredAndEnabled(this)) {
            if (!isNetworkCurrentlyAvailable()) {
                updateConnectionState(myServiceGen, myWorkerGen, STATE_WAITING_NETWORK);
                waitForRetryOrNetwork(myServiceGen, myWorkerGen, 30_000L);
                continue;
            }

            SharedPreferences p = prefs(this);
            String serverUrl = normalizeServerUrl(this, p.getString(KEY_SERVER_URL, null));
            String apiKey = p.getString(KEY_API_KEY, null);
            if (serverUrl == null || apiKey == null || apiKey.trim().isEmpty()) {
                break;
            }

            final StreamSessionTracker tracker = new StreamSessionTracker(SystemClock::elapsedRealtime);
            HttpURLConnection conn = null;
            try {
                updateConnectionState(myServiceGen, myWorkerGen, STATE_CONNECTING);
                URL url = new URL(serverUrl + "/api/push/stream");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setUseCaches(false);
                conn.setDoInput(true);
                conn.setRequestProperty("Authorization", "Bearer " + apiKey.trim());
                conn.setRequestProperty("Accept", "text/event-stream");
                conn.setRequestProperty("Cache-Control", "no-cache");
                conn.setRequestProperty("Connection", "keep-alive");

                activeConnection = conn;
                if (!isActiveGeneration(myServiceGen, myWorkerGen)) {
                    break;
                }
                int status = conn.getResponseCode();
                if (status == 401 || status == 403) {
                    if (isActiveGeneration(myServiceGen, myWorkerGen)) {
                        Log.w(TAG, "Push stream authentication rejected with HTTP " + status);
                        updateConnectionState(myServiceGen, myWorkerGen, STATE_AUTH_ERROR);
                    }
                    break;
                }
                if (status >= 300 && status < 400) {
                    throw new IOException("Redirect refused (" + status + ")");
                }
                if (status < 200 || status >= 300) {
                    Log.w(TAG, "Push stream connection failed with HTTP " + status);
                    throw new IOException("HTTP " + status);
                }
                String contentType = conn.getContentType();
                if (!isSseContentType(contentType)) {
                    throw new IOException("Unexpected Content-Type: " + contentType);
                }

                readSseStream(conn, myServiceGen, myWorkerGen, tracker);
            } catch (Exception e) {
                if (isActiveGeneration(myServiceGen, myWorkerGen)) {
                    Log.w(TAG, "Push SSE stream disconnected: " + e.getMessage());
                }
            } finally {
                if (activeConnection == conn) {
                    activeConnection = null;
                }
                if (conn != null) {
                    try {
                        conn.disconnect();
                    } catch (RuntimeException ignored) {
                        // ignore
                    }
                }
            }

            if (!isActiveGeneration(myServiceGen, myWorkerGen) || !isConfiguredAndEnabled(this)) {
                break;
            }
            if (STATE_AUTH_ERROR.equals(currentConnectionState)) {
                break;
            }
            boolean resetBackoff = tracker.shouldResetBackoff();
            long delayMs = computeRetryDelayMs(backoffIdx, resetBackoff);
            backoffIdx = nextBackoffIndex(backoffIdx, resetBackoff);
            updateConnectionState(
                    myServiceGen,
                    myWorkerGen,
                    isNetworkCurrentlyAvailable() ? STATE_CONNECTING : STATE_WAITING_NETWORK);
            waitForRetryOrNetwork(myServiceGen, myWorkerGen, delayMs);
        }
    }

    private void readSseStream(
            HttpURLConnection conn,
            int myServiceGen,
            int myWorkerGen,
            StreamSessionTracker tracker) throws IOException {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            String eventId = null;
            String eventType = null;
            StringBuilder dataBuf = new StringBuilder();
            String line;
            while (isActiveGeneration(myServiceGen, myWorkerGen) && (line = reader.readLine()) != null) {
                if (!isActiveGeneration(myServiceGen, myWorkerGen)) {
                    break;
                }
                if (!tracker.hasReceivedValidFrame() && isValidSseProtocolLine(line)) {
                    tracker.markFrameReceived();
                    updateConnectionState(myServiceGen, myWorkerGen, STATE_CONNECTED);
                }
                if (line.isEmpty()) {
                    if (dataBuf.length() > 0 && isActiveGeneration(myServiceGen, myWorkerGen)) {
                        String finalType = eventType != null ? eventType : "message";
                        String payloadData = dataBuf.toString();
                        if ("push".equals(finalType)) {
                            handlePushEvent(myServiceGen, myWorkerGen, eventId, payloadData);
                        }
                    }
                    eventId = null;
                    eventType = null;
                    dataBuf.setLength(0);
                    continue;
                }
                if (line.startsWith(":")) {
                    // SSE comment / keepalive frame
                    continue;
                }
                int colon = line.indexOf(':');
                String field;
                String value;
                if (colon >= 0) {
                    field = line.substring(0, colon);
                    value = line.substring(colon + 1);
                    if (value.startsWith(" ")) {
                        value = value.substring(1);
                    }
                } else {
                    field = line;
                    value = "";
                }
                switch (field) {
                    case "id":
                        eventId = value;
                        break;
                    case "event":
                        eventType = value;
                        break;
                    case "data":
                        if (dataBuf.length() > 0) {
                            dataBuf.append('\n');
                        }
                        dataBuf.append(value);
                        break;
                    default:
                        break;
                }
            }
        }
    }

    private void handlePushEvent(int myServiceGen, int myWorkerGen, @Nullable String eventId, String jsonStr) {
        if (!isActiveGeneration(myServiceGen, myWorkerGen)) {
            return;
        }
        try {
            JSONObject obj = new JSONObject(jsonStr);
            String title = obj.optString("title", getString(R.string.bg_push_notification_title));
            String body = obj.optString("body", "");
            JSONObject data = obj.optJSONObject("data");
            String serverId = data != null ? data.optString("serverId", "") : "";
            String session = data != null ? data.optString("session", "") : "";

            showAlertNotification(myServiceGen, myWorkerGen, eventId, title, body, serverId, session);
        } catch (Exception e) {
            Log.w(TAG, "Failed to parse push SSE event", e);
        }
    }

    private void showAlertNotification(
            int myServiceGen,
            int myWorkerGen,
            @Nullable String eventId,
            String title,
            String body,
            String serverId,
            String session) {
        if (!isActiveGeneration(myServiceGen, myWorkerGen)) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }

        int notificationId;
        if (eventId != null && !eventId.trim().isEmpty()) {
            notificationId = ALERT_NOTIFICATION_BASE_ID + Math.abs(eventId.trim().hashCode() % 10_000);
        } else {
            notificationId = ALERT_NOTIFICATION_BASE_ID + (ALERT_ID_SEQ.getAndIncrement() % 10_000);
        }

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (!serverId.isEmpty()) {
            launchIntent.putExtra(EXTRA_PUSH_SERVER_ID, serverId);
        }
        if (!session.isEmpty()) {
            launchIntent.putExtra(EXTRA_PUSH_SESSION, session);
        }

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, notificationId, launchIntent, pendingFlags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, ALERTS_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(contentIntent);

        try {
            if (isActiveGeneration(myServiceGen, myWorkerGen)) {
                manager.notify(notificationId, builder.build());
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Failed to post alert notification", e);
        }
    }

    private void ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        if (manager.getNotificationChannel(STATUS_CHANNEL_ID) == null) {
            NotificationChannel statusChannel = new NotificationChannel(
                    STATUS_CHANNEL_ID,
                    getString(R.string.bg_push_channel_name),
                    NotificationManager.IMPORTANCE_LOW);
            statusChannel.setSound(null, null);
            statusChannel.enableVibration(false);
            statusChannel.setShowBadge(false);
            manager.createNotificationChannel(statusChannel);
        }
        if (manager.getNotificationChannel(ALERTS_CHANNEL_ID) == null) {
            NotificationChannel alertChannel = new NotificationChannel(
                    ALERTS_CHANNEL_ID,
                    getString(R.string.bg_push_alert_channel_name),
                    NotificationManager.IMPORTANCE_HIGH);
            alertChannel.enableVibration(true);
            alertChannel.setShowBadge(true);
            manager.createNotificationChannel(alertChannel);
        }
    }

    private Notification buildStatusNotification(String connState) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, STATUS_NOTIFICATION_ID, launchIntent, pendingFlags);

        SharedPreferences p = prefs(this);
        String customTitle = p.getString(KEY_STATUS_TITLE, null);
        String title = (customTitle != null && !customTitle.isEmpty())
                ? customTitle
                : getString(R.string.bg_push_notification_title);

        String text;
        if (STATE_CONNECTED.equals(connState)) {
            String customText = p.getString(KEY_STATUS_TEXT, null);
            text = (customText != null && !customText.isEmpty())
                    ? customText
                    : getString(R.string.bg_push_notification_text_connected);
        } else if (STATE_WAITING_NETWORK.equals(connState)) {
            text = getString(R.string.bg_push_notification_text_waiting_network);
        } else {
            text = getString(R.string.bg_push_notification_text_connecting);
        }

        return new NotificationCompat.Builder(this, STATUS_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(contentIntent)
                .build();
    }

    private void updateConnectionState(int myServiceGen, int myWorkerGen, String nextState) {
        if (!isActiveGeneration(myServiceGen, myWorkerGen)) {
            return;
        }
        boolean changed = !nextState.equals(currentConnectionState);
        currentConnectionState = nextState;
        if (serviceRunning) {
            try {
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null && changed) {
                    manager.notify(STATUS_NOTIFICATION_ID, buildStatusNotification(nextState));
                }
            } catch (RuntimeException ignored) {
                // ignore
            }
        }
        if (changed) {
            BackgroundPushPlugin.notifyStateChanged(nextState, serviceRunning);
        }
    }

    private boolean isActiveGeneration(int myServiceGen, int myWorkerGen) {
        return !stopped && ACTIVE_SERVICE_GENERATION.get() == myServiceGen && isCurrentWorker(myWorkerGen);
    }

    private boolean isCurrentWorker(int myGeneration) {
        synchronized (stateLock) {
            return myGeneration == workerGeneration;
        }
    }

    private void waitForRetryOrNetwork(int myServiceGen, int myWorkerGen, long delayMs) {
        synchronized (stateLock) {
            if (!isActiveGeneration(myServiceGen, myWorkerGen)) {
                return;
            }
            try {
                stateLock.wait(delayMs);
            } catch (InterruptedException ignored) {
                // wake cleanly
            }
        }
    }

    private boolean isNetworkCurrentlyAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) {
            return networkAvailable;
        }
        Network active = cm.getActiveNetwork();
        if (active == null) {
            return false;
        }
        NetworkCapabilities caps = cm.getNetworkCapabilities(active);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void registerNetworkCallback() {
        if (networkCallback != null) {
            return;
        }
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) {
            return;
        }
        networkAvailable = isNetworkCurrentlyAvailable();
        ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                networkAvailable = true;
                synchronized (stateLock) {
                    stateLock.notifyAll();
                }
            }

            @Override
            public void onLost(@NonNull Network network) {
                if (!isNetworkCurrentlyAvailable()) {
                    networkAvailable = false;
                    HttpURLConnection conn = activeConnection;
                    if (conn != null) {
                        try {
                            conn.disconnect();
                        } catch (RuntimeException ignored) {
                            // ignore
                        }
                    }
                }
            }
        };
        try {
            cm.registerDefaultNetworkCallback(cb);
            networkCallback = cb;
        } catch (RuntimeException e) {
            Log.w(TAG, "Failed to register network callback", e);
        }
    }

    private void unregisterNetworkCallback() {
        ConnectivityManager.NetworkCallback cb = networkCallback;
        networkCallback = null;
        if (cb == null) {
            return;
        }
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            try {
                cm.unregisterNetworkCallback(cb);
            } catch (RuntimeException ignored) {
                // ignore
            }
        }
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (RuntimeException ignored) {
            // ignore
        }
    }

    private void stopForegroundAndSelf(int startId) {
        serviceRunning = false;
        stopForegroundCompat();
        if (startId >= 0) {
            stopSelf(startId);
        } else {
            stopSelf();
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static boolean isDebugBuild(@Nullable Context context) {
        if (context == null || context.getApplicationInfo() == null) {
            return false;
        }
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private static boolean isLoopbackHost(@Nullable String host) {
        if (host == null) {
            return false;
        }
        String lower = host.trim().toLowerCase(Locale.ROOT);
        return "localhost".equals(lower)
                || "127.0.0.1".equals(lower)
                || "::1".equals(lower)
                || "[::1]".equals(lower);
    }

    @Nullable
    static String normalizeServerUrl(@Nullable Context context, @Nullable String raw) {
        return normalizeServerUrl(raw, isDebugBuild(context));
    }

    @Nullable
    static String normalizeServerUrl(@Nullable String raw, boolean allowDebugLoopback) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        if (trimmed.isEmpty()) {
            return null;
        }
        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null || host.isEmpty() || uri.getUserInfo() != null) {
            return null;
        }
        if ("https".equalsIgnoreCase(scheme)) {
            return trimmed;
        }
        if ("http".equalsIgnoreCase(scheme) && allowDebugLoopback && isLoopbackHost(host)) {
            return trimmed;
        }
        return null;
    }

    static boolean isSseContentType(@Nullable String contentType) {
        if (contentType == null) {
            return false;
        }
        String normalized = contentType.trim().toLowerCase(Locale.ROOT);
        return normalized.equals("text/event-stream") || normalized.startsWith("text/event-stream;");
    }

    static boolean isValidSseProtocolLine(@Nullable String line) {
        if (line == null || line.isEmpty()) {
            return false;
        }
        return line.startsWith(":")
                || line.startsWith("id:")
                || line.startsWith("event:")
                || line.startsWith("data:")
                || line.startsWith("retry:");
    }

    static long computeRetryDelayMs(int backoffIdx, boolean resetBackoff) {
        if (resetBackoff) {
            return BACKOFF_MS[0];
        }
        int clamped = Math.max(0, Math.min(backoffIdx, BACKOFF_MS.length - 1));
        return BACKOFF_MS[clamped];
    }

    static int nextBackoffIndex(int backoffIdx, boolean resetBackoff) {
        if (resetBackoff) {
            return 0;
        }
        return Math.min(backoffIdx + 1, BACKOFF_MS.length - 1);
    }

    interface Clock {
        long elapsedMs();
    }

    static final class StreamSessionTracker {
        private final Clock clock;
        private boolean frameReceived = false;
        private long firstFrameAtMs = -1L;

        StreamSessionTracker(Clock clock) {
            this.clock = clock;
        }

        boolean hasReceivedValidFrame() {
            return frameReceived;
        }

        void markFrameReceived() {
            if (!frameReceived) {
                frameReceived = true;
                firstFrameAtMs = clock.elapsedMs();
            }
        }

        boolean shouldResetBackoff() {
            if (!frameReceived || firstFrameAtMs < 0L) {
                return false;
            }
            return (clock.elapsedMs() - firstFrameAtMs) >= STABLE_CONNECTION_MS;
        }
    }
}
