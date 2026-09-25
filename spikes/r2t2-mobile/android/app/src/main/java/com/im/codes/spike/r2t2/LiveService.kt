package com.im.codes.spike.r2t2

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONObject

/**
 * Microphone foreground service for the live / locked-screen run (task 1.4).
 * Started from the visible activity (Android 14+ only grants while-in-use
 * microphone access to a service started from the foreground), then keeps
 * capturing with a partial wake lock after the screen locks.
 */
class LiveService : Service() {
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var log: DeviceLog? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopLive()
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundCompat()
        startLive(
            intent?.getStringExtra(EXTRA_LANGUAGE),
            intent?.getIntExtra(EXTRA_CHUNK_MS, 320) ?: 320,
        )
        return START_NOT_STICKY
    }

    private fun startForegroundCompat() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "R2T2 live", NotificationManager.IMPORTANCE_LOW))
        val n = Notification.Builder(this, CHANNEL)
            .setContentTitle("R2T2 spike recording")
            .setContentText("On-device transcription is running")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 30) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    @SuppressLint("MissingPermission")
    private fun startLive(language: String?, chunkMs: Int) {
        if (running || Harness.handle == 0L) return
        val deviceLog = DeviceLog(this, "live")
        log = deviceLog
        val live = Native.liveStart(Harness.handle, language, chunkMs, 30.0) { json ->
            Harness.lastEvent = json
            runCatching {
                val e = JSONObject(json)
                if (e.has("audio_sec")) deviceLog.audioSec = e.getDouble("audio_sec")
                if (e.has("backlog_sec")) deviceLog.backlogSec = e.getDouble("backlog_sec")
            }
        }
        if (live == 0L) return
        Harness.live = live
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "r2t2:live").also { it.acquire(2 * 60 * 60 * 1000L) }
        val minBuf = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_FLOAT, maxOf(minBuf, 16000 * 4 / 5),
        )
        record = rec
        running = true
        rec.startRecording()
        thread = Thread({
            val buf = FloatArray(320)  // 20 ms
            while (running) {
                val n = rec.read(buf, 0, buf.size, AudioRecord.READ_BLOCKING)
                if (n > 0) Native.livePush(live, buf, n)
            }
        }, "r2t2-mic").also { it.start() }
    }

    private fun stopLive() {
        if (!running) return
        running = false
        thread?.join(2000)
        record?.stop()
        record?.release()
        record = null
        log?.stop()
        val summary = Native.liveStop(Harness.live)
        Harness.live = 0L
        Harness.lastEvent = summary
        Harness.appendRun(this, "live", mapOf("device_log" to (log?.file?.name ?: "")), summary)
        log = null
        wakeLock?.release()
        wakeLock = null
    }

    override fun onDestroy() {
        stopLive()
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "stop"
        const val EXTRA_LANGUAGE = "language"
        const val EXTRA_CHUNK_MS = "chunk_ms"
        private const val CHANNEL = "r2t2-live"
        private const val NOTIFICATION_ID = 42
    }
}
