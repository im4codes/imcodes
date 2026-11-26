// C API shared by the macOS CLI, the iOS harness (Swift via a bridging header)
// and the Android harness (JNI). Every call returns a heap JSON string the
// caller releases with r2t2_free_string(). Errors come back as {"error": "..."}.
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct r2t2_harness r2t2_harness;

typedef struct r2t2_harness_params {
    const char * model_path;
    const char * mmproj_path;
    int n_threads;       // <= 0: platform default
    int n_ctx;           // <= 0: 4096
    int use_gpu;         // Metal on iOS/macOS; CPU build ignores it
    int n_gpu_layers;    // -1 = all
} r2t2_harness_params;

// Loads the model + projector. On success *out is set and the JSON contains
// load_ms and memory figures; on failure *out stays NULL.
char * r2t2_harness_load(const r2t2_harness_params * params, r2t2_harness ** out);
void r2t2_harness_free(r2t2_harness * h);

// One-shot transcription of a whole clip (upstream onetime_llama).
char * r2t2_harness_oneshot(r2t2_harness * h, const float * pcm16k, size_t n, const char * language, int max_tokens);

// Streaming run of the ported stream_llama loop over a clip.
//   realtime != 0 paces feeding at wall-clock speed (for sustained/locked-screen
//   runs) instead of as fast as possible.
//   repeat_seconds > 0 loops the clip until that much audio has been streamed,
//   restarting the stream per clip (one utterance per clip, like upstream).
typedef void (*r2t2_progress_cb)(const char * event_json, void * user);
char * r2t2_harness_stream(r2t2_harness * h, const float * pcm16k, size_t n, const char * language,
                           int chunk_ms, int lookahead_ms, int unfixed_token_num,
                           int realtime, double repeat_seconds,
                           r2t2_progress_cb progress, void * user);

// Live session (microphone): push PCM from the audio callback; inference runs
// on a worker thread. Events: {"type":"commit"|"restart"|"stats", ...}.
// max_utterance_sec > 0 restarts the stream (new utterance) after that much
// audio - upstream stream_llama re-encodes all audio since the utterance began,
// so unbounded sessions need segmentation.
typedef struct r2t2_live r2t2_live;
r2t2_live * r2t2_live_start(r2t2_harness * h, const char * language, int chunk_ms, int lookahead_ms,
                            int unfixed_token_num, double max_utterance_sec, r2t2_progress_cb cb, void * user);
void r2t2_live_push(r2t2_live * live, const float * pcm16k, size_t n);
// Stops, flushes the current utterance, joins the worker, returns summary JSON.
char * r2t2_live_stop(r2t2_live * live);

// Cancels a running r2t2_harness_stream from another thread.
void r2t2_harness_cancel(r2t2_harness * h);

// WAV helpers (16 kHz mono float out). Caller frees with r2t2_free_floats.
float * r2t2_read_wav(const char * path, size_t * n_out, char ** error_json);
float * r2t2_read_wav_memory(const uint8_t * data, size_t size, size_t * n_out, char ** error_json);
void r2t2_free_floats(float * p);

// Process memory in bytes (see r2t2_metrics.h).
uint64_t r2t2_current_memory(void);
uint64_t r2t2_peak_memory(void);

void r2t2_free_string(char * s);

#ifdef __cplusplus
}
#endif
