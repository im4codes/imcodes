// C++ port of the upstream R2T2 `stream_llama` route, pinned to
// netease-youdao/Confucius4-R2T2 @ 26d55a54ce5670cff9947a167d8ed95d569fd4d9:
//
//   R2T2Stream   <- r2t2/r2t2_asr.py R2T2ASRModel.init_streaming_state /
//                   streaming_transcribe / finish_streaming_transcribe
//                   (rollback_punctuation=False, the default)
//   StreamDriver <- example.py run_streaming (the schedule upstream's
//                   r2t2_llama/example_llama.py uses for --infer_mode stream_llama):
//                   first segment = chunk + lookahead, then one chunk per call,
//                   adaptive max_new_tokens, finish flush with the first budget.
//
// Deliberate deviations (documented in README):
//   - token rollback uses the llama.cpp GGUF vocab instead of the HF tokenizer
//     (same Qwen2 BPE; upstream ships the llama.cpp variant commented out);
//   - r2t2's parse_language_output (used only to detect "Chinese") is replaced
//     by qwen_asr.parse_asr_output's language field (differs only when the
//     repetition fixer rewrites the `language X` header).
#pragma once

#include "r2t2_engine.h"

#include <functional>
#include <string>
#include <vector>

namespace r2t2 {

struct StreamConfig {
    int chunk_size_ms = 160;
    int lookahead_ms = 160;
    int unfixed_chunk_num = 0;   // example.py passes 0
    int unfixed_token_num = 1;
    std::string language;        // "" = auto (upstream default for the example)
    std::string context;         // hotword / context hint
};

struct StepInfo {
    int call_index = 0;
    double audio_sec = 0;        // accumulated audio re-fed this step
    int max_new_tokens = 0;
    std::string prefix;          // assistant prefix after rollback
    std::string gen_text;        // raw new text from the model
    std::string text;            // state.text
    std::string fixed_text;      // stable prefix upstream returns ("text=" line)
    GenerateResult gen;
    double step_ms = 0;          // wall time of this decode step
    bool decoded = false;        // false when the segment was only buffered
};

class R2T2Stream {
public:
    R2T2Stream(Engine & engine, const StreamConfig & cfg);

    // streaming_transcribe(pcm, state, max_new_tokens): buffers pcm and runs
    // one decode per full chunk. Returns (state.text, fixed_text).
    std::pair<std::string, std::string> transcribe(const float * pcm, size_t n, int max_new_tokens,
                                                   std::vector<StepInfo> * steps = nullptr);
    // finish_streaming_transcribe: flush the tail without padding.
    std::string finish(int max_new_tokens, StepInfo * step = nullptr);

    void set_chunk_size_samples(size_t n) { chunk_size_samples_ = n; }
    const std::string & text() const { return text_; }
    const std::string & language() const { return language_; }
    const std::string & raw_decoded() const { return raw_decoded_; }
    size_t buffered_samples() const { return buffer_.size(); }
    double accumulated_sec() const { return audio_accum_.size() / 16000.0; }

private:
    std::string rollback(const std::string & raw, int k) const;
    GenerateResult run(const std::string & prompt, int max_new_tokens);

    Engine & engine_;
    StreamConfig cfg_;
    size_t chunk_size_samples_;
    int chunk_id_ = 0;
    std::vector<float> buffer_;
    std::vector<float> audio_accum_;
    std::string prompt_raw_;
    std::string language_;
    std::string text_;
    std::string raw_decoded_;
};

struct CommitEvent {
    std::string committed;   // append-only committed text so far
    std::string delta;       // newly committed suffix (may be empty)
    std::string partial;     // latest state.text (display-only, may change)
    StepInfo step;
};

// Real-time driver. Feed arbitrary-length 16 kHz mono float PCM; it cuts the
// same segments as example.py run_streaming and emits one event per decode.
class StreamDriver {
public:
    StreamDriver(Engine & engine, const StreamConfig & cfg, std::function<void(const CommitEvent &)> on_event);

    void feed(const float * pcm, size_t n);
    // Flush remaining audio, returns the final text (upstream "final_result").
    std::string finish();

    const std::string & committed() const { return committed_; }
    int fixed_regressions() const { return regressions_; }   // fixed_text not extending the previous one
    int steps() const { return call_id_; }

private:
    void run_segment(const float * seg, size_t n);
    void apply_fixed(const std::string & fixed, StepInfo && step);

    R2T2Stream stream_;
    StreamConfig cfg_;
    std::function<void(const CommitEvent &)> on_event_;
    size_t step_;
    size_t lookahead_;
    std::vector<float> pending_;
    bool is_first_ = true;
    int max_new_tokens_;
    int first_max_new_tokens_;
    int max_new_tokens_floor_;
    std::string last_text_tmp_;
    int call_id_ = 0;
    std::string committed_;
    std::string last_fixed_;
    int regressions_ = 0;
};

} // namespace r2t2
