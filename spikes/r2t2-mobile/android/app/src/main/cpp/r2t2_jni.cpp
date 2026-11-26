// JNI bridge for the Android harness over core/r2t2_harness.h.
// Kotlin side: com.im.codes.spike.r2t2.Native
#include "r2t2_harness.h"

#include <jni.h>

#include <string>
#include <vector>

namespace {

JavaVM * g_vm = nullptr;

jstring take(JNIEnv * env, char * s) {
    jstring out = env->NewStringUTF(s ? s : "{}");
    r2t2_free_string(s);
    return out;
}

std::string str(JNIEnv * env, jstring s) {
    if (!s) return {};
    const char * c = env->GetStringUTFChars(s, nullptr);
    std::string out(c ? c : "");
    if (c) env->ReleaseStringUTFChars(s, c);
    return out;
}

std::vector<float> floats(JNIEnv * env, jfloatArray a, jint n) {
    std::vector<float> out(static_cast<size_t>(n));
    env->GetFloatArrayRegion(a, 0, n, out.data());
    return out;
}

// Delivers event JSON to a Kotlin `EventListener.onEvent(String)` from any thread.
struct Listener {
    jobject ref = nullptr;
    jmethodID method = nullptr;
};

Listener * make_listener(JNIEnv * env, jobject listener) {
    if (!listener) return nullptr;
    auto * l = new Listener();
    l->ref = env->NewGlobalRef(listener);
    l->method = env->GetMethodID(env->GetObjectClass(listener), "onEvent", "(Ljava/lang/String;)V");
    return l;
}

void free_listener(JNIEnv * env, Listener * l) {
    if (!l) return;
    env->DeleteGlobalRef(l->ref);
    delete l;
}

void on_event(const char * json, void * user) {
    auto * l = static_cast<Listener *>(user);
    if (!l || !g_vm) return;
    JNIEnv * env = nullptr;
    bool attached = false;
    if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
    }
    jstring s = env->NewStringUTF(json);
    env->CallVoidMethod(l->ref, l->method, s);
    env->DeleteLocalRef(s);
    if (env->ExceptionCheck()) env->ExceptionClear();
    if (attached) g_vm->DetachCurrentThread();
}

struct LiveHandle {
    r2t2_live * live = nullptr;
    Listener * listener = nullptr;
};

} // namespace

extern "C" {

JNIEXPORT jint JNI_OnLoad(JavaVM * vm, void *) {
    g_vm = vm;
    return JNI_VERSION_1_6;
}

// Returns load JSON; writes the handle (0 on failure) into out[0].
JNIEXPORT jstring JNICALL Java_com_im_codes_spike_r2t2_Native_load(JNIEnv * env, jclass, jstring model, jstring mmproj,
                                                                   jint threads, jint ctx, jboolean gpu, jlongArray out) {
    const std::string m = str(env, model), p = str(env, mmproj);
    r2t2_harness_params params{};
    params.model_path = m.c_str();
    params.mmproj_path = p.c_str();
    params.n_threads = threads;
    params.n_ctx = ctx;
    params.use_gpu = gpu ? 1 : 0;
    params.n_gpu_layers = gpu ? -1 : 0;
    r2t2_harness * h = nullptr;
    char * json = r2t2_harness_load(&params, &h);
    jlong handle = reinterpret_cast<jlong>(h);
    env->SetLongArrayRegion(out, 0, 1, &handle);
    return take(env, json);
}

JNIEXPORT void JNICALL Java_com_im_codes_spike_r2t2_Native_free(JNIEnv *, jclass, jlong h) {
    r2t2_harness_free(reinterpret_cast<r2t2_harness *>(h));
}

JNIEXPORT jstring JNICALL Java_com_im_codes_spike_r2t2_Native_oneshot(JNIEnv * env, jclass, jlong h, jfloatArray pcm,
                                                                      jstring language) {
    const auto samples = floats(env, pcm, env->GetArrayLength(pcm));
    const std::string lang = str(env, language);
    return take(env, r2t2_harness_oneshot(reinterpret_cast<r2t2_harness *>(h), samples.data(), samples.size(),
                                          lang.empty() ? nullptr : lang.c_str(), 4096));
}

JNIEXPORT jstring JNICALL Java_com_im_codes_spike_r2t2_Native_stream(JNIEnv * env, jclass, jlong h, jfloatArray pcm,
                                                                     jstring language, jint chunkMs, jboolean realtime,
                                                                     jdouble repeatSeconds, jobject listener) {
    const auto samples = floats(env, pcm, env->GetArrayLength(pcm));
    const std::string lang = str(env, language);
    Listener * l = make_listener(env, listener);
    char * json = r2t2_harness_stream(reinterpret_cast<r2t2_harness *>(h), samples.data(), samples.size(),
                                      lang.empty() ? nullptr : lang.c_str(), chunkMs, 160, 1, realtime ? 1 : 0,
                                      repeatSeconds, l ? on_event : nullptr, l);
    free_listener(env, l);
    return take(env, json);
}

JNIEXPORT void JNICALL Java_com_im_codes_spike_r2t2_Native_cancel(JNIEnv *, jclass, jlong h) {
    r2t2_harness_cancel(reinterpret_cast<r2t2_harness *>(h));
}

JNIEXPORT jlong JNICALL Java_com_im_codes_spike_r2t2_Native_liveStart(JNIEnv * env, jclass, jlong h, jstring language,
                                                                      jint chunkMs, jdouble maxUtteranceSec,
                                                                      jobject listener) {
    const std::string lang = str(env, language);
    auto * lh = new LiveHandle();
    lh->listener = make_listener(env, listener);
    lh->live = r2t2_live_start(reinterpret_cast<r2t2_harness *>(h), lang.empty() ? nullptr : lang.c_str(), chunkMs,
                               160, 1, maxUtteranceSec, lh->listener ? on_event : nullptr, lh->listener);
    if (!lh->live) {
        free_listener(env, lh->listener);
        delete lh;
        return 0;
    }
    return reinterpret_cast<jlong>(lh);
}

JNIEXPORT void JNICALL Java_com_im_codes_spike_r2t2_Native_livePush(JNIEnv * env, jclass, jlong live, jfloatArray pcm,
                                                                    jint n) {
    auto * lh = reinterpret_cast<LiveHandle *>(live);
    if (!lh || n <= 0) return;
    jfloat * data = env->GetFloatArrayElements(pcm, nullptr);
    r2t2_live_push(lh->live, data, static_cast<size_t>(n));
    env->ReleaseFloatArrayElements(pcm, data, JNI_ABORT);
}

JNIEXPORT jstring JNICALL Java_com_im_codes_spike_r2t2_Native_liveStop(JNIEnv * env, jclass, jlong live) {
    auto * lh = reinterpret_cast<LiveHandle *>(live);
    if (!lh) return env->NewStringUTF("{\"error\":\"no live session\"}");
    char * json = r2t2_live_stop(lh->live);
    free_listener(env, lh->listener);
    delete lh;
    return take(env, json);
}

JNIEXPORT jfloatArray JNICALL Java_com_im_codes_spike_r2t2_Native_readWav(JNIEnv * env, jclass, jbyteArray bytes) {
    const jsize len = env->GetArrayLength(bytes);
    std::vector<uint8_t> buf(static_cast<size_t>(len));
    env->GetByteArrayRegion(bytes, 0, len, reinterpret_cast<jbyte *>(buf.data()));
    size_t n = 0;
    char * err = nullptr;
    float * p = r2t2_read_wav_memory(buf.data(), buf.size(), &n, &err);
    if (!p) {
        r2t2_free_string(err);
        return nullptr;
    }
    jfloatArray out = env->NewFloatArray(static_cast<jsize>(n));
    env->SetFloatArrayRegion(out, 0, static_cast<jsize>(n), p);
    r2t2_free_floats(p);
    return out;
}

JNIEXPORT jlong JNICALL Java_com_im_codes_spike_r2t2_Native_currentMemory(JNIEnv *, jclass) {
    return static_cast<jlong>(r2t2_current_memory());
}

} // extern "C"
