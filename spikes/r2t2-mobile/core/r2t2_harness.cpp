#include "r2t2_harness.h"

#include "r2t2_engine.h"
#include "r2t2_metrics.h"
#include "r2t2_stream.h"
#include "r2t2_text.h"

#include <algorithm>
#include <chrono>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

struct r2t2_harness {
    std::unique_ptr<r2t2::Engine> engine;
    std::atomic<bool> cancel{false};
};

namespace {

class Json {
public:
    Json & key(const char * k) {
        sep();
        str(k);
        os_ << ':';
        pending_value_ = true;
        return *this;
    }
    Json & val(const std::string & s) { if (!pending_value_) sep(); str(s); pending_value_ = false; return *this; }
    Json & val(const char * s) { return val(std::string(s ? s : "")); }
    Json & val(double d) {
        if (!pending_value_) sep();
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.3f", d);
        os_ << buf;
        pending_value_ = false;
        return *this;
    }
    Json & val(int64_t i) { if (!pending_value_) sep(); os_ << i; pending_value_ = false; return *this; }
    Json & val(int i) { return val(static_cast<int64_t>(i)); }
    Json & val(uint64_t i) { return val(static_cast<int64_t>(i)); }
    Json & val(bool b) { if (!pending_value_) sep(); os_ << (b ? "true" : "false"); pending_value_ = false; return *this; }
    Json & raw(const std::string & r) { if (!pending_value_) sep(); os_ << r; pending_value_ = false; return *this; }
    Json & begin_obj() { if (!pending_value_) sep(); os_ << '{'; first_ = true; pending_value_ = false; return *this; }
    Json & end_obj() { os_ << '}'; first_ = false; return *this; }
    Json & begin_arr() { if (!pending_value_) sep(); os_ << '['; first_ = true; pending_value_ = false; return *this; }
    Json & end_arr() { os_ << ']'; first_ = false; return *this; }
    std::string str() const { return os_.str(); }

private:
    void sep() {
        if (!first_) os_ << ',';
        first_ = false;
    }
    void str(const std::string & s) {
        os_ << '"';
        for (unsigned char c : r2t2::sanitize_utf8(s)) {
            switch (c) {
                case '"': os_ << "\\\""; break;
                case '\\': os_ << "\\\\"; break;
                case '\n': os_ << "\\n"; break;
                case '\r': os_ << "\\r"; break;
                case '\t': os_ << "\\t"; break;
                default:
                    if (c < 0x20) { char b[8]; std::snprintf(b, sizeof(b), "\\u%04x", c); os_ << b; }
                    else os_ << c;
            }
        }
        os_ << '"';
    }
    std::ostringstream os_;
    bool first_ = true;
    bool pending_value_ = false;
};

char * dup(const std::string & s) {
    char * p = static_cast<char *>(std::malloc(s.size() + 1));
    std::memcpy(p, s.c_str(), s.size() + 1);
    return p;
}

char * error_json(const std::string & msg) {
    Json j;
    j.begin_obj().key("error").val(msg).end_obj();
    return dup(j.str());
}

double mb(uint64_t b) { return b / (1024.0 * 1024.0); }

double percentile(std::vector<double> v, double p) {
    if (v.empty()) return 0;
    std::sort(v.begin(), v.end());
    const size_t idx = std::min(v.size() - 1, static_cast<size_t>(p * (v.size() - 1) + 0.5));
    return v[idx];
}

int default_threads() {
    const unsigned hw = std::thread::hardware_concurrency();
    // Phones: stay on the performance cluster; leave headroom for UI/audio.
    return static_cast<int>(std::max(2u, std::min(hw > 2 ? hw - 2 : hw, 6u)));
}

void write_memory(Json & j, uint64_t sampled_peak) {
    j.key("mem_source").val(r2t2::memory_source())
     .key("mem_current_mb").val(mb(r2t2::current_memory_bytes()))
     .key("mem_peak_mb").val(mb(std::max(r2t2::peak_memory_bytes(), sampled_peak)));
}

} // namespace

struct r2t2_live {
    r2t2_harness * h = nullptr;
    r2t2::StreamConfig cfg;
    double max_utterance_sec = 0;
    r2t2_progress_cb cb = nullptr;
    void * user = nullptr;

    std::mutex mu;
    std::condition_variable cv;
    std::deque<float> queue;
    bool stopping = false;
    std::thread worker;

    // stats (worker thread only, read after join)
    double pushed_sec = 0;          // written under mu
    double processed_sec = 0;
    double max_backlog_sec = 0;
    int utterances = 0;
    int steps = 0;
    std::vector<double> step_ms;
    std::string transcript;         // committed text of finished utterances, one per line
    double started_ms = 0;
};

namespace {

void live_emit(r2t2_live * L, Json & j) {
    if (L->cb) L->cb(j.str().c_str(), L->user);
}

void live_worker(r2t2_live * L) {
    std::unique_ptr<r2t2::StreamDriver> driver;
    double utt_audio = 0;
    auto make_driver = [&] {
        ++L->utterances;
        utt_audio = 0;
        driver = std::make_unique<r2t2::StreamDriver>(*L->h->engine, L->cfg, [L](const r2t2::CommitEvent & ev) {
            if (ev.step.decoded) {
                L->step_ms.push_back(ev.step.step_ms);
                ++L->steps;
            }
            double backlog;
            {
                std::lock_guard<std::mutex> lk(L->mu);
                backlog = L->queue.size() / 16000.0;
            }
            L->max_backlog_sec = std::max(L->max_backlog_sec, backlog);
            Json j;
            j.begin_obj()
             .key("type").val("commit")
             .key("utterance").val(L->utterances)
             .key("audio_sec").val(ev.step.audio_sec)
             .key("step_ms").val(ev.step.step_ms)
             .key("backlog_sec").val(backlog)
             .key("committed").val(ev.committed)
             .key("delta").val(ev.delta)
             .key("partial").val(ev.partial)
             .key("mem_current_mb").val(mb(r2t2::current_memory_bytes()))
             .end_obj();
            live_emit(L, j);
        });
    };
    auto finish_utterance = [&](const char * reason) {
        if (!driver) return;
        const std::string final_text = driver->finish();
        if (!final_text.empty()) {
            if (!L->transcript.empty()) L->transcript.push_back('\n');
            L->transcript += final_text;
        }
        Json j;
        j.begin_obj().key("type").val("restart").key("reason").val(reason).key("utterance").val(L->utterances)
         .key("final_text").val(final_text).end_obj();
        live_emit(L, j);
        driver.reset();
    };
    std::vector<float> block;
    for (;;) {
        {
            std::unique_lock<std::mutex> lk(L->mu);
            L->cv.wait(lk, [L] { return L->stopping || !L->queue.empty(); });
            if (L->queue.empty() && L->stopping) break;
            const size_t n = L->queue.size();
            block.assign(L->queue.begin(), L->queue.begin() + n);
            L->queue.erase(L->queue.begin(), L->queue.begin() + n);
        }
        size_t off = 0;
        while (off < block.size()) {
            if (!driver) make_driver();
            size_t take = block.size() - off;
            if (L->max_utterance_sec > 0) {
                const size_t room = static_cast<size_t>(std::max(0.0, (L->max_utterance_sec - utt_audio) * 16000.0));
                take = std::min(take, std::max<size_t>(room, 1));
            }
            driver->feed(block.data() + off, take);
            off += take;
            utt_audio += take / 16000.0;
            L->processed_sec += take / 16000.0;
            if (L->max_utterance_sec > 0 && utt_audio >= L->max_utterance_sec) finish_utterance("max_utterance_sec");
        }
    }
    finish_utterance("stop");
}

} // namespace

extern "C" {

char * r2t2_harness_load(const r2t2_harness_params * p, r2t2_harness ** out) {
    if (out) *out = nullptr;
    if (!p || !p->model_path || !p->mmproj_path) return error_json("model_path and mmproj_path are required");
    try {
        r2t2::PeakSampler sampler;
        const uint64_t before = r2t2::current_memory_bytes();
        r2t2::EngineConfig cfg;
        cfg.model_path = p->model_path;
        cfg.mmproj_path = p->mmproj_path;
        cfg.n_threads = p->n_threads > 0 ? p->n_threads : default_threads();
        if (p->n_ctx > 0) cfg.n_ctx = p->n_ctx;
        cfg.use_gpu = p->use_gpu != 0;
        cfg.n_gpu_layers = p->n_gpu_layers;
        auto h = std::make_unique<r2t2_harness>();
        h->engine = r2t2::Engine::load(cfg);
        Json j;
        j.begin_obj()
         .key("load_ms").val(h->engine->load_ms())
         .key("n_threads").val(cfg.n_threads)
         .key("n_ctx").val(cfg.n_ctx)
         .key("use_gpu").val(cfg.use_gpu)
         .key("mem_before_load_mb").val(mb(before));
        write_memory(j, sampler.peak());
        j.key("system_info").val(h->engine->system_info()).end_obj();
        *out = h.release();
        return dup(j.str());
    } catch (const std::exception & e) {
        return error_json(e.what());
    }
}

void r2t2_harness_free(r2t2_harness * h) { delete h; }

void r2t2_harness_cancel(r2t2_harness * h) { if (h) h->cancel = true; }

char * r2t2_harness_oneshot(r2t2_harness * h, const float * pcm, size_t n, const char * language, int max_tokens) {
    if (!h || !h->engine) return error_json("not loaded");
    try {
        r2t2::PeakSampler sampler;
        const std::string lang = language ? language : "";
        // upstream onetime_llama: generate_once(language=language or "Chinese")
        const std::string prompt = r2t2::build_asr_prompt("", lang.empty() ? "Chinese" : lang);
        const r2t2::GenerateResult r = h->engine->generate(pcm, n, prompt, max_tokens > 0 ? max_tokens : 4096);
        const std::string text = r2t2::u32_to_utf8(r2t2::py_strip(r2t2::utf8_to_u32(r2t2::sanitize_utf8(r.text))));
        const double audio_sec = n / 16000.0;
        const int gen_tokens = static_cast<int>(r.token_ids.size());
        Json j;
        j.begin_obj()
         .key("mode").val("oneshot")
         .key("audio_sec").val(audio_sec)
         .key("latency_ms").val(r.total_ms)
         .key("encode_ms").val(r.encode_ms)
         .key("prefill_ms").val(r.prefill_ms)
         .key("decode_ms").val(r.decode_ms)
         .key("prompt_tokens").val(r.prompt_tokens)
         .key("audio_tokens").val(r.audio_tokens)
         .key("gen_tokens").val(gen_tokens)
         .key("tok_per_s").val(r.decode_ms > 0 ? gen_tokens / (r.decode_ms / 1000.0) : 0.0)
         .key("prefill_tok_per_s").val((r.encode_ms + r.prefill_ms) > 0 ? r.prompt_tokens / ((r.encode_ms + r.prefill_ms) / 1000.0) : 0.0)
         .key("rtf").val(audio_sec > 0 ? (r.total_ms / 1000.0) / audio_sec : 0.0)
         .key("stopped").val(r.stopped)
         .key("text").val(text);
        write_memory(j, sampler.peak());
        j.end_obj();
        return dup(j.str());
    } catch (const std::exception & e) {
        return error_json(e.what());
    }
}

char * r2t2_harness_stream(r2t2_harness * h, const float * pcm, size_t n, const char * language,
                           int chunk_ms, int lookahead_ms, int unfixed_token_num,
                           int realtime, double repeat_seconds,
                           r2t2_progress_cb progress, void * user) {
    if (!h || !h->engine) return error_json("not loaded");
    if (!pcm || n == 0) return error_json("empty audio");
    h->cancel = false;
    try {
        r2t2::PeakSampler sampler;
        r2t2::StreamConfig cfg;
        cfg.chunk_size_ms = chunk_ms > 0 ? chunk_ms : 160;
        cfg.lookahead_ms = lookahead_ms >= 0 ? lookahead_ms : 160;
        cfg.unfixed_token_num = unfixed_token_num >= 0 ? unfixed_token_num : 1;
        cfg.language = language ? language : "";

        std::vector<double> step_ms;
        std::vector<double> step_audio_sec;
        double max_lag_ms = 0;
        double final_lag_ms = 0;
        int clips = 0;
        int regressions = 0;
        int steps_total = 0;
        double first_commit_audio_sec = -1;
        double first_commit_wall_ms = -1;
        std::string last_final;
        std::string last_committed;
        std::vector<std::string> fixed_lines;
        const double target_audio = repeat_seconds > 0 ? repeat_seconds : n / 16000.0;
        double audio_done = 0;
        const size_t block = 320;  // 20 ms at 16 kHz, like a mic callback
        const double t_start = r2t2::now_ms();

        while (audio_done + 1e-9 < target_audio && !h->cancel) {
            ++clips;
            const double clip_wall_start = r2t2::now_ms();
            double clip_first_commit = -1;
            r2t2::StreamDriver driver(*h->engine, cfg, [&](const r2t2::CommitEvent & ev) {
                if (ev.step.decoded) {
                    step_ms.push_back(ev.step.step_ms);
                    step_audio_sec.push_back(ev.step.audio_sec);
                    ++steps_total;
                }
                if (clips == 1 && ev.step.call_index >= 0) fixed_lines.push_back(ev.step.fixed_text);
                if (!ev.delta.empty() && clip_first_commit < 0) {
                    clip_first_commit = r2t2::now_ms() - clip_wall_start;
                    if (first_commit_audio_sec < 0) {
                        first_commit_audio_sec = ev.step.audio_sec;
                        first_commit_wall_ms = clip_first_commit;
                    }
                }
                if (progress) {
                    Json e;
                    e.begin_obj()
                     .key("clip").val(clips)
                     .key("call").val(ev.step.call_index)
                     .key("audio_sec").val(ev.step.audio_sec)
                     .key("step_ms").val(ev.step.step_ms)
                     .key("committed").val(ev.committed)
                     .key("delta").val(ev.delta)
                     .key("partial").val(ev.partial)
                     .key("mem_current_mb").val(mb(r2t2::current_memory_bytes()))
                     .end_obj();
                    progress(e.str().c_str(), user);
                }
            });
            const double clip_audio_start = audio_done;
            for (size_t off = 0; off < n && !h->cancel; off += block) {
                const size_t len = std::min(block, n - off);
                if (realtime) {
                    const double target = t_start + (clip_audio_start + (off + len) / 16000.0) * 1000.0;
                    const double now = r2t2::now_ms();
                    if (now < target) {
                        std::this_thread::sleep_for(std::chrono::microseconds(static_cast<int64_t>((target - now) * 1000)));
                    } else {
                        max_lag_ms = std::max(max_lag_ms, now - target);
                    }
                }
                driver.feed(pcm + off, len);
            }
            last_final = driver.finish();
            last_committed = driver.committed();
            regressions += driver.fixed_regressions();
            audio_done += n / 16000.0;
            if (realtime) final_lag_ms = std::max(0.0, r2t2::now_ms() - (t_start + audio_done * 1000.0));
        }

        const double wall_ms = r2t2::now_ms() - t_start;
        double compute_ms = 0;
        for (double s : step_ms) compute_ms += s;
        Json j;
        j.begin_obj()
         .key("mode").val("stream")
         .key("realtime").val(realtime != 0)
         .key("cancelled").val(h->cancel.load())
         .key("chunk_ms").val(cfg.chunk_size_ms)
         .key("lookahead_ms").val(cfg.lookahead_ms)
         .key("unfixed_token_num").val(cfg.unfixed_token_num)
         .key("clips").val(clips)
         .key("audio_sec").val(audio_done)
         .key("wall_ms").val(wall_ms)
         .key("compute_ms").val(compute_ms)
         .key("compute_rtf").val(audio_done > 0 ? compute_ms / 1000.0 / audio_done : 0.0)
         .key("steps").val(steps_total)
         .key("step_ms_p50").val(percentile(step_ms, 0.5))
         .key("step_ms_p90").val(percentile(step_ms, 0.9))
         .key("step_ms_max").val(step_ms.empty() ? 0.0 : *std::max_element(step_ms.begin(), step_ms.end()))
         .key("last_step_ms").val(step_ms.empty() ? 0.0 : step_ms.back())
         .key("last_step_audio_sec").val(step_audio_sec.empty() ? 0.0 : step_audio_sec.back())
         .key("first_commit_audio_sec").val(first_commit_audio_sec)
         .key("first_commit_wall_ms").val(first_commit_wall_ms)
         .key("max_lag_ms").val(max_lag_ms)
         .key("final_lag_ms").val(final_lag_ms)
         .key("fixed_regressions").val(regressions)
         .key("committed").val(last_committed)
         .key("final_text").val(last_final);
        j.key("fixed_lines").begin_arr();
        for (const auto & l : fixed_lines) j.val(l);
        j.end_arr();
        write_memory(j, sampler.peak());
        j.end_obj();
        return dup(j.str());
    } catch (const std::exception & e) {
        return error_json(e.what());
    }
}

r2t2_live * r2t2_live_start(r2t2_harness * h, const char * language, int chunk_ms, int lookahead_ms,
                            int unfixed_token_num, double max_utterance_sec, r2t2_progress_cb cb, void * user) {
    if (!h || !h->engine) return nullptr;
    auto * L = new r2t2_live();
    L->h = h;
    L->cfg.chunk_size_ms = chunk_ms > 0 ? chunk_ms : 160;
    L->cfg.lookahead_ms = lookahead_ms >= 0 ? lookahead_ms : 160;
    L->cfg.unfixed_token_num = unfixed_token_num >= 0 ? unfixed_token_num : 1;
    L->cfg.language = language ? language : "";
    L->max_utterance_sec = max_utterance_sec;
    L->cb = cb;
    L->user = user;
    L->started_ms = r2t2::now_ms();
    L->worker = std::thread(live_worker, L);
    return L;
}

void r2t2_live_push(r2t2_live * L, const float * pcm, size_t n) {
    if (!L || !pcm || n == 0) return;
    {
        std::lock_guard<std::mutex> lk(L->mu);
        if (L->stopping) return;
        L->queue.insert(L->queue.end(), pcm, pcm + n);
        L->pushed_sec += n / 16000.0;
    }
    L->cv.notify_one();
}

char * r2t2_live_stop(r2t2_live * L) {
    if (!L) return error_json("no live session");
    {
        std::lock_guard<std::mutex> lk(L->mu);
        L->stopping = true;
    }
    L->cv.notify_one();
    if (L->worker.joinable()) L->worker.join();
    double compute = 0;
    for (double v : L->step_ms) compute += v;
    Json j;
    j.begin_obj()
     .key("mode").val("live")
     .key("chunk_ms").val(L->cfg.chunk_size_ms)
     .key("wall_sec").val((r2t2::now_ms() - L->started_ms) / 1000.0)
     .key("audio_sec").val(L->processed_sec)
     .key("utterances").val(L->utterances)
     .key("steps").val(L->steps)
     .key("compute_rtf").val(L->processed_sec > 0 ? compute / 1000.0 / L->processed_sec : 0.0)
     .key("step_ms_p50").val(percentile(L->step_ms, 0.5))
     .key("step_ms_p90").val(percentile(L->step_ms, 0.9))
     .key("step_ms_max").val(L->step_ms.empty() ? 0.0 : *std::max_element(L->step_ms.begin(), L->step_ms.end()))
     .key("max_backlog_sec").val(L->max_backlog_sec)
     .key("transcript").val(L->transcript);
    write_memory(j, 0);
    j.end_obj();
    delete L;
    return dup(j.str());
}

float * r2t2_read_wav_memory(const uint8_t * data, size_t size, size_t * n_out, char ** err) {
    try {
        std::vector<float> v = r2t2::read_wav_16k_mono_from_memory(data, size);
        float * p = static_cast<float *>(std::malloc(sizeof(float) * std::max<size_t>(1, v.size())));
        std::memcpy(p, v.data(), sizeof(float) * v.size());
        if (n_out) *n_out = v.size();
        return p;
    } catch (const std::exception & e) {
        if (err) *err = error_json(e.what());
        return nullptr;
    }
}

float * r2t2_read_wav(const char * path, size_t * n_out, char ** err) {
    try {
        std::vector<float> v = r2t2::read_wav_16k_mono(path ? path : "");
        float * p = static_cast<float *>(std::malloc(sizeof(float) * std::max<size_t>(1, v.size())));
        std::memcpy(p, v.data(), sizeof(float) * v.size());
        if (n_out) *n_out = v.size();
        return p;
    } catch (const std::exception & e) {
        if (err) *err = error_json(e.what());
        return nullptr;
    }
}

void r2t2_free_floats(float * p) { std::free(p); }
uint64_t r2t2_current_memory(void) { return r2t2::current_memory_bytes(); }
uint64_t r2t2_peak_memory(void) { return r2t2::peak_memory_bytes(); }
void r2t2_free_string(char * s) { std::free(s); }

} // extern "C"
