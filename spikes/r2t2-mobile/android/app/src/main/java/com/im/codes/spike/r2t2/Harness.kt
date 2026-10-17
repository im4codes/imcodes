package com.im.codes.spike.r2t2

import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Process-wide harness state shared by the activity and the live service. */
object Harness {
    @Volatile var handle: Long = 0L
    @Volatile var live: Long = 0L
    @Volatile var lastEvent: String = ""

    fun modelDir(ctx: Context): File = ctx.getExternalFilesDir(null)!!.also { it.mkdirs() }

    /** Pinned names first, else any mmproj*.gguf + other *.gguf in the app's files dir. */
    fun locate(ctx: Context): Pair<File, File>? {
        val files = modelDir(ctx).listFiles { f -> f.name.endsWith(".gguf") }?.sortedBy { it.name } ?: return null
        val model = files.firstOrNull { it.name == BuildConfig.MODEL_FILE } ?: files.firstOrNull { !it.name.startsWith("mmproj") }
        val mmproj = files.firstOrNull { it.name == BuildConfig.MMPROJ_FILE } ?: files.firstOrNull { it.name.startsWith("mmproj") }
        return if (model != null && mmproj != null) model to mmproj else null
    }

    fun resultsDir(ctx: Context): File = File(modelDir(ctx), "results").also { it.mkdirs() }

    fun appendRun(ctx: Context, kind: String, extra: Map<String, Any>, reportJson: String) {
        val header = JSONObject().apply {
            put("kind", kind)
            put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            put("soc", if (Build.VERSION.SDK_INT >= 31) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}" else Build.HARDWARE)
            put("android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            put("thermal", thermal(ctx))
            extra.forEach { (k, v) -> put(k, v) }
        }
        val line = header.toString().dropLast(1) + ",\"report\":" + reportJson + "}\n"
        FileOutputStream(File(resultsDir(ctx), "runs.jsonl"), true).use { it.write(line.toByteArray()) }
    }

    fun thermal(ctx: Context): String {
        if (Build.VERSION.SDK_INT < 29) return "unknown"
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        return when (pm.currentThermalStatus) {
            PowerManager.THERMAL_STATUS_NONE -> "none"
            PowerManager.THERMAL_STATUS_LIGHT -> "light"
            PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
            PowerManager.THERMAL_STATUS_SEVERE -> "severe"
            PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
            PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
            PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
            else -> "unknown"
        }
    }

    fun stamp(): String = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

    /** Resumable download of one pinned file with size + SHA-256 verification. */
    fun download(ctx: Context, endpoint: String, name: String, size: Long, sha256: String, progress: (Double) -> Unit) {
        val dest = File(modelDir(ctx), name)
        if (dest.exists() && dest.length() == size) return
        val part = File(modelDir(ctx), "$name.part")
        val url = URL("$endpoint/${BuildConfig.GGUF_REPO}/resolve/${BuildConfig.GGUF_REVISION}/$name")
        var conn = url.openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = true
        if (part.exists() && part.length() > 0) conn.setRequestProperty("Range", "bytes=${part.length()}-")
        conn.connect()
        val append = conn.responseCode == 206
        if (!append) part.delete()
        RandomAccessFile(part, "rw").use { raf ->
            raf.seek(if (append) part.length() else 0)
            conn.inputStream.use { input ->
                val buf = ByteArray(1 shl 20)
                var done = raf.filePointer
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    raf.write(buf, 0, n)
                    done += n
                    progress(done.toDouble() / size)
                }
            }
        }
        conn.disconnect()
        require(part.length() == size) { "$name: size ${part.length()} != $size" }
        val digest = MessageDigest.getInstance("SHA-256")
        part.inputStream().use { input ->
            val buf = ByteArray(8 shl 20)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        require(hex == sha256) { "$name: SHA-256 mismatch" }
        require(part.renameTo(dest)) { "$name: rename failed" }
    }
}

/** Battery / thermal / memory CSV sampler for the sustained and locked-screen runs. */
class DeviceLog(private val ctx: Context, name: String) {
    val file = File(Harness.resultsDir(ctx), "$name-${Harness.stamp()}.csv")
    private val start = System.currentTimeMillis()
    @Volatile private var running = true
    private val thread: Thread

    init {
        file.writeText("elapsed_s,battery_pct,charging,battery_temp_c,thermal_status,thermal_headroom_10s,mem_mb,audio_s,backlog_s\n")
        thread = Thread({
            while (running) {
                sample()
                try { Thread.sleep(30_000) } catch (_: InterruptedException) { break }
            }
        }, "r2t2-devicelog")
        thread.start()
    }

    @Volatile var audioSec = 0.0
    @Volatile var backlogSec = 0.0

    private fun sample() {
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = bm.isCharging
        val sticky = ctx.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        val tempC = (sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1) / 10.0
        val headroom = if (Build.VERSION.SDK_INT >= 30) {
            (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).getThermalHeadroom(10).toString()
        } else "na"
        val line = "%d,%d,%b,%.1f,%s,%s,%.0f,%.1f,%.2f\n".format(
            Locale.US, (System.currentTimeMillis() - start) / 1000, pct, charging, tempC, Harness.thermal(ctx),
            headroom, Native.currentMemory() / 1048576.0, audioSec, backlogSec,
        )
        file.appendText(line)
    }

    fun stop() {
        running = false
        thread.interrupt()
        sample()
    }
}
