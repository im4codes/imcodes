package com.im.codes.spike.r2t2

/** JNI surface over core/r2t2_harness.h (see app/src/main/cpp/r2t2_jni.cpp). */
object Native {
    init { System.loadLibrary("r2t2_harness") }

    fun interface EventListener { fun onEvent(json: String) }

    @JvmStatic external fun load(model: String, mmproj: String, threads: Int, ctx: Int, gpu: Boolean, out: LongArray): String
    @JvmStatic external fun free(handle: Long)
    @JvmStatic external fun oneshot(handle: Long, pcm: FloatArray, language: String?): String
    @JvmStatic external fun stream(
        handle: Long, pcm: FloatArray, language: String?, chunkMs: Int,
        realtime: Boolean, repeatSeconds: Double, listener: EventListener?,
    ): String
    @JvmStatic external fun cancel(handle: Long)
    @JvmStatic external fun liveStart(handle: Long, language: String?, chunkMs: Int, maxUtteranceSec: Double, listener: EventListener?): Long
    @JvmStatic external fun livePush(live: Long, pcm: FloatArray, n: Int)
    @JvmStatic external fun liveStop(live: Long): String
    @JvmStatic external fun readWav(bytes: ByteArray): FloatArray?
    @JvmStatic external fun currentMemory(): Long
}
