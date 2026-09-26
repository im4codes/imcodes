// Minimal R2T2 (Qwen3-ASR architecture) inference engine over pinned llama.cpp
// + mtmd. `generate()` is a port of `Qwen3ASRNative::generate_once` from the
// pinned upstream `r2t2_llama/native_ext.cpp`: clear KV, tokenize the prompt
// with the audio marker, encode the audio with mtmd, prefill, greedy decode.
// Shared by the macOS CLI, the iOS harness and the Android harness.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct llama_model;
struct llama_context;
struct mtmd_context;

namespace r2t2 {

struct EngineConfig {
    std::string model_path;
    std::string mmproj_path;
    // Upstream defaults are n_ctx=32768 / n_batch=8192 (a 3.7 GB f16 KV cache
    // for this model). Phones cannot afford that; 4096 covers several minutes
    // of accumulated audio per utterance.
    int n_ctx = 4096;
    int n_batch = 2048;
    int n_threads = 4;
    bool use_gpu = true;       // Metal on Apple; ignored when no GPU backend is compiled in
    int n_gpu_layers = -1;     // -1 = all
    bool flash_attn = true;
    bool mtmd_warmup = false;  // upstream: false
};

struct GenerateResult {
    std::string text;              // raw bytes of the generated tokens (may end mid-UTF-8)
    std::vector<int32_t> token_ids;
    bool stopped = false;          // hit EOG (upstream finish_reason "stop") vs "length"
    int prompt_tokens = 0;         // mtmd_helper_get_n_tokens (text + audio)
    int audio_tokens = 0;
    double encode_ms = 0;          // mel + audio encoder (mtmd_encode_chunk)
    double prefill_ms = 0;         // text chunk eval + audio embedding decode
    double decode_ms = 0;          // token generation
    double total_ms = 0;
};

class Engine {
public:
    // Throws std::runtime_error on failure.
    static std::unique_ptr<Engine> load(const EngineConfig & cfg);
    ~Engine();

    Engine(const Engine &) = delete;
    Engine & operator=(const Engine &) = delete;

    // `prompt` must contain "<|audio_start|><|audio_pad|><|audio_end|>" exactly
    // once (replaced by the mtmd media marker, as upstream does).
    GenerateResult generate(const float * pcm16k, size_t n_samples, const std::string & prompt, int max_tokens);

    std::vector<int32_t> tokenize(const std::string & text, bool add_special = false, bool parse_special = true) const;
    // llama_detokenize(remove_special=false, unparse_special=true): raw bytes.
    std::string detokenize(const std::vector<int32_t> & tokens, bool unparse_special = true) const;

    double load_ms() const { return load_ms_; }
    const EngineConfig & config() const { return cfg_; }
    std::string system_info() const;

private:
    Engine() = default;

    EngineConfig cfg_;
    llama_model * model_ = nullptr;
    llama_context * ctx_ = nullptr;
    mtmd_context * mtmd_ = nullptr;
    double load_ms_ = 0;
};

// Upstream build_asr_prompt() / R2T2ASRModel._build_text_prompt().
std::string build_asr_prompt(const std::string & context, const std::string & force_language);

double now_ms();

} // namespace r2t2
