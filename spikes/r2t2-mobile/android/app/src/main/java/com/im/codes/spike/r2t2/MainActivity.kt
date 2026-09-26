package com.im.codes.spike.r2t2

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.Executors

/** Plain-views harness UI (no AppCompat/Compose, to keep the throwaway app tiny). */
class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var modelInfo: TextView
    private lateinit var metrics: TextView
    private lateinit var transcript: TextView
    private lateinit var gpu: CheckBox
    private var sample = "zh_upstream_test"
    private var language: String? = null
    private var chunkMs = 320
    private var busy = false
    private var liveRunning = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 48, 32, 32) }
        fun label(t: String) = TextView(this).apply { text = t; textSize = 16f; setPadding(0, 24, 0, 8) }
        fun button(t: String, onClick: () -> Unit) = Button(this).apply { text = t; setOnClickListener { onClick() } }
        fun spinner(items: List<String>, initial: Int, onPick: (String) -> Unit) = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, items)
            setSelection(initial)
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) = onPick(items[pos])
                override fun onNothingSelected(p: AdapterView<*>?) {}
            }
        }

        root.addView(label("Model (app files dir, see README)"))
        modelInfo = TextView(this).also { root.addView(it) }
        root.addView(button("Download pinned model (huggingface.co)") { download("https://huggingface.co") })
        root.addView(button("Download pinned model (hf-mirror.com, CN)") { download("https://hf-mirror.com") })
        gpu = CheckBox(this).apply { text = "GPU offload (Vulkan builds only; CPU otherwise)"; isChecked = false }
        root.addView(gpu)
        root.addView(button("Load model") { load() })
        root.addView(label("Bundled sample / settings"))
        root.addView(spinner(listOf("zh_upstream_test", "en_tts", "zh_quiet_onset"), 0) { sample = it })
        root.addView(spinner(listOf("auto", "Chinese", "English"), 0) { language = if (it == "auto") null else it })
        root.addView(spinner(listOf("160", "320", "640", "1000"), 1) { chunkMs = it.toInt() })
        root.addView(button("1.2 One-shot") { runOneshot() })
        root.addView(button("1.3 Streaming (fast)") { runStream("stream", realtime = false, repeat = 0.0) })
        root.addView(button("1.4 Sustained 10 min (sample loop, real time)") { runStream("sustained10m", true, 600.0) })
        root.addView(button("Cancel run") { if (Harness.handle != 0L) Native.cancel(Harness.handle) })
        root.addView(label("1.4 Live microphone (foreground service; works locked)"))
        root.addView(button("Start / stop live") { toggleLive() })
        transcript = TextView(this).apply { textSize = 18f }.also { root.addView(it) }
        root.addView(label("Last result"))
        metrics = TextView(this).apply { typeface = android.graphics.Typeface.MONOSPACE; textSize = 12f }.also { root.addView(it) }
        status = TextView(this).apply { setPadding(0, 24, 0, 0) }.also { root.addView(it) }
        setContentView(ScrollView(this).apply { addView(root) })
        refreshModel()
        pollLiveEvents()
    }

    private fun refreshModel() {
        val found = Harness.locate(this)
        modelInfo.text = found?.let { "${it.first.name}\n${it.second.name}" }
            ?: "No model in ${Harness.modelDir(this)}.\nadb push both .gguf files there, or tap Download."
    }

    private fun setStatus(s: String) { main.post { status.text = s } }

    private fun background(kind: String, block: () -> String) {
        if (busy) return
        busy = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setStatus("Running $kind…")
        worker.execute {
            val json = runCatching(block).getOrElse { "{\"error\":\"${it.message}\"}" }
            main.post {
                busy = false
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                show(json)
                status.text = "$kind done"
                if (kind != "load") {
                    Harness.appendRun(this, kind, mapOf("sample" to sample, "chunk_ms" to chunkMs, "gpu" to gpu.isChecked), json)
                }
            }
        }
    }

    private fun show(json: String) {
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return run { metrics.text = json }
        val keys = listOf("load_ms", "mem_current_mb", "mem_peak_mb", "latency_ms", "encode_ms", "prefill_ms", "decode_ms",
            "tok_per_s", "rtf", "steps", "step_ms_p50", "step_ms_p90", "step_ms_max", "compute_rtf", "max_lag_ms",
            "final_lag_ms", "max_backlog_sec", "fixed_regressions", "n_threads", "error")
        metrics.text = keys.filter { o.has(it) }.joinToString("\n") { "%-18s %s".format(it, o.get(it)) }
        (o.optString("text").ifEmpty { o.optString("final_text").ifEmpty { o.optString("transcript") } })
            .takeIf { it.isNotEmpty() }?.let { transcript.text = it }
    }

    private fun download(endpoint: String) = background("download") {
        Harness.download(this, endpoint, BuildConfig.MMPROJ_FILE, BuildConfig.MMPROJ_SIZE, BuildConfig.MMPROJ_SHA256) {
            setStatus("mmproj %.0f%%".format(it * 100))
        }
        Harness.download(this, endpoint, BuildConfig.MODEL_FILE, BuildConfig.MODEL_SIZE, BuildConfig.MODEL_SHA256) {
            setStatus("model %.0f%%".format(it * 100))
        }
        main.post { refreshModel() }
        "{\"status\":\"downloaded and verified (size + SHA-256)\"}"
    }

    private fun load() = background("load") {
        val found = Harness.locate(this) ?: return@background "{\"error\":\"no model files\"}"
        if (Harness.handle != 0L) { Native.free(Harness.handle); Harness.handle = 0L }
        val out = LongArray(1)
        val json = Native.load(found.first.absolutePath, found.second.absolutePath, 0, 4096, gpu.isChecked, out)
        Harness.handle = out[0]
        Harness.appendRun(this, "load", mapOf("gpu" to gpu.isChecked), json)
        json
    }

    private fun samplePcm(): FloatArray? = runCatching {
        Native.readWav(assets.open("$sample.wav").use { it.readBytes() })
    }.getOrNull()

    private fun runOneshot() {
        if (Harness.handle == 0L) return setStatus("Load the model first")
        val pcm = samplePcm() ?: return setStatus("sample missing")
        background("oneshot") { Native.oneshot(Harness.handle, pcm, language) }
    }

    private fun runStream(kind: String, realtime: Boolean, repeat: Double) {
        if (Harness.handle == 0L) return setStatus("Load the model first")
        val pcm = samplePcm() ?: return setStatus("sample missing")
        background(kind) {
            val log = if (repeat > 0) DeviceLog(this, kind) else null
            val json = Native.stream(Harness.handle, pcm, language, chunkMs, realtime, repeat) { event ->
                runCatching { JSONObject(event).optString("committed") }.getOrNull()?.let { c -> main.post { transcript.text = c } }
            }
            log?.stop()
            json
        }
    }

    private fun toggleLive() {
        if (liveRunning) {
            startService(Intent(this, LiveService::class.java).setAction(LiveService.ACTION_STOP))
            liveRunning = false
            main.postDelayed({ show(Harness.lastEvent); setStatus("Live stopped (results/runs.jsonl + live-*.csv)") }, 1500)
            return
        }
        if (Harness.handle == 0L) return setStatus("Load the model first")
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) needed += Manifest.permission.POST_NOTIFICATIONS
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) return requestPermissions(missing.toTypedArray(), 1)
        startForegroundService(Intent(this, LiveService::class.java)
            .putExtra(LiveService.EXTRA_LANGUAGE, language)
            .putExtra(LiveService.EXTRA_CHUNK_MS, chunkMs))
        liveRunning = true
        setStatus("Live: speak, or lock the screen for the battery run")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (grantResults.all { it == PackageManager.PERMISSION_GRANTED }) toggleLive() else setStatus("microphone permission denied")
    }

    private fun pollLiveEvents() {
        main.postDelayed({
            if (liveRunning) runCatching { JSONObject(Harness.lastEvent) }.getOrNull()?.let { e ->
                e.optString("committed").takeIf { it.isNotEmpty() }?.let { transcript.text = it }
                status.text = "live audio %.0fs backlog %.2fs".format(e.optDouble("audio_sec", 0.0), e.optDouble("backlog_sec", 0.0))
            }
            pollLiveEvents()
        }, 500)
    }
}
