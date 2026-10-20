#include "r2t2_engine.h"

#include "llama.h"
#include "mtmd.h"
#include "mtmd-helper.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <stdexcept>

namespace r2t2 {

double now_ms() {
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

namespace {

const char * const kQwenAudioTriplet = "<|audio_start|><|audio_pad|><|audio_end|>";

std::string replace_all(std::string value, const std::string & from, const std::string & to) {
    size_t pos = 0;
    while ((pos = value.find(from, pos)) != std::string::npos) {
        value.replace(pos, from.size(), to);
        pos += to.size();
    }
    return value;
}

struct BitmapGuard {
    mtmd_bitmap * p = nullptr;
    ~BitmapGuard() { if (p) mtmd_bitmap_free(p); }
};

struct ChunksGuard {
    mtmd_input_chunks * p = nullptr;
    ~ChunksGuard() { if (p) mtmd_input_chunks_free(p); }
};

struct SamplerGuard {
    llama_sampler * p = nullptr;
    ~SamplerGuard() { if (p) llama_sampler_free(p); }
};

} // namespace

std::string build_asr_prompt(const std::string & context, const std::string & force_language) {
    std::string prompt =
        "<|im_start|>system\n" + context + "<|im_end|>\n"
        "<|im_start|>user\n" + std::string(kQwenAudioTriplet) + "<|im_end|>\n"
        "<|im_start|>assistant\n";
    if (!force_language.empty()) prompt += "language " + force_language + "<asr_text>";
    return prompt;
}

namespace {
void quiet_log(enum ggml_log_level level, const char * text, void *) {
    if (level >= GGML_LOG_LEVEL_WARN) std::fputs(text, stderr);
}
} // namespace

std::unique_ptr<Engine> Engine::load(const EngineConfig & cfg) {
    const char * verbose = std::getenv("R2T2_VERBOSE");
    if (!(verbose && verbose[0] == '1')) {
        llama_log_set(quiet_log, nullptr);
        mtmd_helper_log_set(quiet_log, nullptr);
    }
    std::unique_ptr<Engine> e(new Engine());
    e->cfg_ = cfg;
    const double t0 = now_ms();
    llama_backend_init();

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = cfg.use_gpu ? cfg.n_gpu_layers : 0;
    e->model_ = llama_model_load_from_file(cfg.model_path.c_str(), mp);
    if (!e->model_) throw std::runtime_error("failed to load llama model: " + cfg.model_path);

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = static_cast<uint32_t>(cfg.n_ctx);
    cp.n_batch = static_cast<uint32_t>(cfg.n_batch);
    cp.n_ubatch = static_cast<uint32_t>(std::min(cfg.n_batch, 512));
    cp.n_seq_max = 1;
    cp.n_threads = cfg.n_threads;
    cp.n_threads_batch = cfg.n_threads;
    cp.flash_attn_type = cfg.flash_attn ? LLAMA_FLASH_ATTN_TYPE_ENABLED : LLAMA_FLASH_ATTN_TYPE_DISABLED;
    cp.offload_kqv = cfg.use_gpu;
    e->ctx_ = llama_init_from_model(e->model_, cp);
    if (!e->ctx_) throw std::runtime_error("failed to create llama context");

    mtmd_context_params mtp = mtmd_context_params_default();
    mtp.use_gpu = cfg.use_gpu;
    mtp.n_threads = cfg.n_threads;
    mtp.warmup = cfg.mtmd_warmup;
    mtp.print_timings = false;
    e->mtmd_ = mtmd_init_from_file(cfg.mmproj_path.c_str(), e->model_, mtp);
    if (!e->mtmd_) throw std::runtime_error("failed to load mtmd projector: " + cfg.mmproj_path);
    if (!mtmd_support_audio(e->mtmd_)) throw std::runtime_error("the mtmd projector does not support audio");
    e->load_ms_ = now_ms() - t0;
    return e;
}

Engine::~Engine() {
    if (mtmd_) mtmd_free(mtmd_);
    if (ctx_) llama_free(ctx_);
    if (model_) llama_model_free(model_);
}

std::string Engine::system_info() const { return llama_print_system_info(); }

GenerateResult Engine::generate(const float * pcm, size_t n_samples, const std::string & prompt, int max_tokens) {
    if (!pcm || n_samples == 0) throw std::invalid_argument("audio must be non-empty");
    if (max_tokens <= 0) throw std::invalid_argument("max_tokens must be positive");
    GenerateResult r;
    const double t_start = now_ms();

    llama_memory_clear(llama_get_memory(ctx_), true);

    const std::string mtmd_prompt = replace_all(prompt, kQwenAudioTriplet, mtmd_default_marker());
    if (mtmd_prompt.find(mtmd_default_marker()) == std::string::npos) {
        throw std::invalid_argument("prompt must contain one Qwen3-ASR audio marker");
    }

    BitmapGuard bitmap{mtmd_bitmap_init_from_audio(n_samples, pcm)};
    if (!bitmap.p) throw std::runtime_error("failed to create mtmd audio bitmap");

    mtmd_input_text text{mtmd_prompt.data(), mtmd_prompt.size(), true /*add_special*/, true /*parse_special*/};
    const mtmd_bitmap * bitmaps[] = {bitmap.p};
    ChunksGuard chunks{mtmd_input_chunks_init()};
    const int32_t tok = mtmd_tokenize(mtmd_, chunks.p, &text, bitmaps, 1);
    if (tok != 0) throw std::runtime_error("mtmd_tokenize failed with code " + std::to_string(tok));

    llama_pos n_past = 0;
    const size_t n_chunks = mtmd_input_chunks_size(chunks.p);
    r.prompt_tokens = static_cast<int>(mtmd_helper_get_n_tokens(chunks.p));
    for (size_t i = 0; i < n_chunks; ++i) {
        const mtmd_input_chunk * chunk = mtmd_input_chunks_get(chunks.p, i);
        const bool is_last = i + 1 == n_chunks;
        llama_pos new_n_past = n_past;
        int32_t res = 0;
        if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_TEXT) {
            const double t = now_ms();
            res = mtmd_helper_eval_chunk_single(mtmd_, ctx_, chunk, n_past, 0, cfg_.n_batch, is_last, &new_n_past);
            r.prefill_ms += now_ms() - t;
        } else {
            r.audio_tokens += static_cast<int>(mtmd_input_chunk_get_n_tokens(chunk));
            const double t_enc = now_ms();
            res = mtmd_encode_chunk(mtmd_, chunk);
            r.encode_ms += now_ms() - t_enc;
            if (res == 0) {
                float * embd = mtmd_get_output_embd(mtmd_);
                if (!embd) throw std::runtime_error("mtmd returned no audio embedding");
                const double t_dec = now_ms();
                res = mtmd_helper_decode_image_chunk(mtmd_, ctx_, chunk, embd, n_past, 0, cfg_.n_batch,
                                                     &new_n_past, nullptr, nullptr);
                r.prefill_ms += now_ms() - t_dec;
            }
        }
        if (res != 0) {
            throw std::runtime_error("failed to evaluate mtmd chunk " + std::to_string(i) + ", code " + std::to_string(res));
        }
        n_past = new_n_past;
    }

    SamplerGuard sampler{llama_sampler_init_greedy()};
    if (!sampler.p) throw std::runtime_error("failed to create greedy sampler");
    const llama_vocab * vocab = llama_model_get_vocab(model_);
    const double t_gen = now_ms();
    char buf[512];
    for (int i = 0; i < max_tokens; ++i) {
        const llama_token token = llama_sampler_sample(sampler.p, ctx_, -1);
        r.token_ids.push_back(token);
        llama_sampler_accept(sampler.p, token);
        if (llama_vocab_is_eog(vocab, token)) {
            r.stopped = true;
            break;
        }
        // Upstream detokenizes all generated ids with special=false; EOG
        // pieces are empty so appending per token is equivalent.
        const int32_t n = llama_token_to_piece(vocab, token, buf, sizeof(buf), 0, false);
        if (n > 0) r.text.append(buf, static_cast<size_t>(n));
        // Upstream also decodes after the final budgeted token; that result is
        // never read, so skipping it changes no output and saves one step.
        if (i + 1 == max_tokens) break;
        llama_token next = token;
        llama_batch batch = llama_batch_get_one(&next, 1);
        if (llama_decode(ctx_, batch) != 0) throw std::runtime_error("llama_decode failed during generation");
        ++n_past;
    }
    r.decode_ms = now_ms() - t_gen;
    r.total_ms = now_ms() - t_start;
    return r;
}

std::vector<int32_t> Engine::tokenize(const std::string & text, bool add_special, bool parse_special) const {
    const llama_vocab * vocab = llama_model_get_vocab(model_);
    if (text.size() > static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
        throw std::invalid_argument("text is too large to tokenize");
    }
    std::vector<llama_token> tokens(std::max<size_t>(2, text.size() + 2));
    int32_t count = llama_tokenize(vocab, text.data(), static_cast<int32_t>(text.size()), tokens.data(),
                                   static_cast<int32_t>(tokens.size()), add_special, parse_special);
    if (count < 0) {
        tokens.resize(static_cast<size_t>(-count));
        count = llama_tokenize(vocab, text.data(), static_cast<int32_t>(text.size()), tokens.data(),
                               static_cast<int32_t>(tokens.size()), add_special, parse_special);
    }
    if (count < 0) throw std::runtime_error("llama_tokenize failed with code " + std::to_string(count));
    tokens.resize(static_cast<size_t>(count));
    return std::vector<int32_t>(tokens.begin(), tokens.end());
}

std::string Engine::detokenize(const std::vector<int32_t> & tokens, bool unparse_special) const {
    if (tokens.empty()) return {};
    const llama_vocab * vocab = llama_model_get_vocab(model_);
    std::string text(std::max<size_t>(64, tokens.size() * 8), '\0');
    int32_t count = llama_detokenize(vocab, tokens.data(), static_cast<int32_t>(tokens.size()), text.data(),
                                     static_cast<int32_t>(text.size()), false, unparse_special);
    if (count < 0) {
        text.resize(static_cast<size_t>(-count));
        count = llama_detokenize(vocab, tokens.data(), static_cast<int32_t>(tokens.size()), text.data(),
                                 static_cast<int32_t>(text.size()), false, unparse_special);
    }
    if (count < 0) throw std::runtime_error("llama_detokenize failed with code " + std::to_string(count));
    text.resize(static_cast<size_t>(count));
    return text;
}

} // namespace r2t2
