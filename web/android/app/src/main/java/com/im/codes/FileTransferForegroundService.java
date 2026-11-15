package com.im.codes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps Android file uploads alive when the app moves to the background using
 * a low-priority dataSync foreground service and a bounded partial wake lock.
 */
public class FileTransferForegroundService extends Service {
    private static final String TAG = "FileTransferFGS";
    public static final String ACTION_START = "com.im.codes.action.FILE_TRANSFER_START";
    public static final String ACTION_STOP = "com.im.codes.action.FILE_TRANSFER_STOP";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";

    private static final String CHANNEL_ID = "imcodes_file_transfer";
    private static final int NOTIFICATION_ID = 4102;
    private static final long MAX_WAKE_LOCK_TIMEOUT_MS = 30L * 60L * 1000L;

    @Nullable
    private PowerManager.WakeLock wakeLock;

    public static boolean start(Context context, @Nullable String title, @Nullable String text) {
        if (context == null) {
            return false;
        }
        Intent intent = new Intent(context, FileTransferForegroundService.class);
        intent.setAction(ACTION_START);
        if (title != null && !title.isEmpty()) {
            intent.putExtra(EXTRA_TITLE, title);
        }
        if (text != null && !text.isEmpty()) {
            intent.putExtra(EXTRA_TEXT, text);
        }
        try {
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (RuntimeException e) {
            // Android 12+ throws ForegroundServiceStartNotAllowedException if the app
            // already transitioned to background before startForegroundService ran.
            // Degrade safely to foreground-resume upload recovery instead of crashing.
            Log.w(TAG, "Unable to start foreground transfer service", e);
            return false;
        }
    }

    public static void stop(Context context) {
        if (context == null) {
            return;
        }
        try {
            context.stopService(new Intent(context, FileTransferForegroundService.class));
        } catch (RuntimeException e) {
            Log.w(TAG, "Unable to stop foreground transfer service", e);
        }
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForegroundAndSelf(startId);
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();
        acquireWakeLock();

        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        if (title == null || title.isEmpty()) {
            title = getString(R.string.bg_upload_notification_title);
        }
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        if (text == null || text.isEmpty()) {
            text = getString(R.string.bg_upload_notification_text);
        }

        Notification notification = buildNotification(title, text);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "startForeground failed", e);
            stopForegroundAndSelf(startId);
        }

        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId) {
        stopForegroundAndSelf(startId);
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopForegroundAndSelf(startId);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopForegroundAndSelf(-1);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        stopForegroundCompat();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.bg_upload_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String title, String text) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, pendingFlags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(contentIntent)
                .build();
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "imcodes:file-transfer-wakelock");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null) {
            try {
                wakeLock.acquire(MAX_WAKE_LOCK_TIMEOUT_MS);
            } catch (RuntimeException e) {
                Log.w(TAG, "Failed to acquire wake lock", e);
            }
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (RuntimeException ignored) {
                // Ignore already-released wake lock
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
            // Ignore if service was never promoted to foreground
        }
    }

    private void stopForegroundAndSelf(int startId) {
        releaseWakeLock();
        stopForegroundCompat();
        if (startId >= 0) {
            stopSelf(startId);
        } else {
            stopSelf();
        }
    }
}
