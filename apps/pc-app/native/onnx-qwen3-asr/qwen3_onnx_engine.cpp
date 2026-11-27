#include "qwen3_onnx_engine.hpp"

#include "text_guards.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <limits>
#include <thread>
#include <unordered_map>

#ifdef IMCODES_HAS_ONNXRUNTIME
#include <onnxruntime_cxx_api.h>
#endif

namespace imcodes::qwen3 {

#if defined(IMCODES_HAS_ONNXRUNTIME) && defined(IMCODES_ORT_HAS_DML)
bool append_dml_execution_provider(OrtSessionOptions* raw_opts, int device_id);
#endif

namespace {

std::string normalize_lang_key(const std::string& raw) {
  std::string out;
  for (char ch : raw) {
    if (ch == '_') out.push_back('-');
    else out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  }
  size_t s = 0;
  while (s < out.size() && std::isspace(static_cast<unsigned char>(out[s]))) ++s;
  size_t e = out.size();
  while (e > s && std::isspace(static_cast<unsigned char>(out[e - 1]))) --e;
  return out.substr(s, e - s);
}

const std::unordered_map<std::string, std::string>& language_map() {
  static const std::unordered_map<std::string, std::string> kMap = {
      {"zh", "Chinese"}, {"cmn", "Chinese"}, {"chinese", "Chinese"},
      {"yue", "Cantonese"}, {"cantonese", "Cantonese"},
      {"en", "English"}, {"english", "English"},
      {"ja", "Japanese"}, {"jp", "Japanese"}, {"japanese", "Japanese"},
      {"ko", "Korean"}, {"korean", "Korean"},
      {"es", "Spanish"}, {"spanish", "Spanish"},
      {"ru", "Russian"}, {"russian", "Russian"},
      {"fr", "French"}, {"french", "French"},
      {"de", "German"}, {"german", "German"},
      {"it", "Italian"}, {"italian", "Italian"},
      {"pt", "Portuguese"}, {"portuguese", "Portuguese"},
      {"ar", "Arabic"}, {"arabic", "Arabic"},
      {"tr", "Turkish"}, {"turkish", "Turkish"},
      {"vi", "Vietnamese"}, {"vietnamese", "Vietnamese"},
      {"th", "Thai"}, {"thai", "Thai"},
      {"id", "Indonesian"}, {"indonesian", "Indonesian"},
      {"ms", "Malay"}, {"malay", "Malay"},
      {"hi", "Hindi"}, {"hindi", "Hindi"},
      {"nl", "Dutch"}, {"dutch", "Dutch"},
      {"pl", "Polish"}, {"polish", "Polish"},
      {"sv", "Swedish"}, {"swedish", "Swedish"},
      {"da", "Danish"}, {"danish", "Danish"},
      {"fi", "Finnish"}, {"finnish", "Finnish"},
      {"cs", "Czech"}, {"czech", "Czech"},
      {"el", "Greek"}, {"greek", "Greek"},
      {"hu", "Hungarian"}, {"hungarian", "Hungarian"},
      {"ro", "Romanian"}, {"romanian", "Romanian"},
      {"fa", "Persian"}, {"persian", "Persian"},
      {"fil", "Filipino"}, {"tl", "Filipino"}, {"filipino", "Filipino"},
      {"mk", "Macedonian"}, {"macedonian", "Macedonian"},
  };
  return kMap;
}

inline float half_to_float_scalar(uint16_t h) {
  const uint32_t sign = static_cast<uint32_t>(h & 0x8000u) << 16;
  const uint32_t exp = (h >> 10) & 0x1Fu;
  const uint32_t mant = h & 0x03FFu;
  uint32_t bits = 0;
  if (exp == 0) {
    if (mant == 0) {
      bits = sign;
    } else {
      uint32_t m = mant;
      int shift = 0;
      while ((m & 0x0400u) == 0) {
        m <<= 1;
        ++shift;
      }
      m &= 0x03FFu;
      const uint32_t e = static_cast<uint32_t>(127 - 15 + 1 - shift);
      bits = sign | (e << 23) | (m << 13);
    }
  } else if (exp == 31) {
    bits = sign | 0x7F800000u | (mant << 13);
  } else {
    const uint32_t e = exp + (127 - 15);
    bits = sign | (e << 23) | (mant << 13);
  }
  float out = 0.0f;
  std::memcpy(&out, &bits, sizeof(out));
  return out;
}

#ifdef IMCODES_HAS_ONNXRUNTIME

inline bool is_fp16_type(ONNXTensorElementDataType dtype) {
  return dtype == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16 ||
         dtype == ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT16;
}

int64_t argmax_logits_row(
    const Ort::Value& logits_tensor,
    int64_t row_index,
    int64_t vocab_size,
    ONNXTensorElementDataType dtype,
    int64_t forbid_a = -1,
    int64_t forbid_b = -1) {
  const size_t offset = static_cast<size_t>(row_index) * static_cast<size_t>(vocab_size);
  int64_t best_id = 0;
  float best_val = -std::numeric_limits<float>::infinity();
  if (is_fp16_type(dtype)) {
    const auto* ptr = logits_tensor.GetTensorData<uint16_t>() + offset;
    for (int64_t i = 0; i < vocab_size; ++i) {
      if (i == forbid_a || i == forbid_b) continue;
      const float v = half_to_float_scalar(ptr[i]);
      if (v > best_val) {
        best_val = v;
        best_id = i;
      }
    }
  } else {
    const float* ptr = logits_tensor.GetTensorData<float>() + offset;
    for (int64_t i = 0; i < vocab_size; ++i) {
      if (i == forbid_a || i == forbid_b) continue;
      const float v = ptr[i];
      if (v > best_val) {
        best_val = v;
        best_id = i;
      }
    }
  }
  return best_id;
}

std::vector<std::string> collect_input_names(Ort::Session& sess, Ort::AllocatorWithDefaultOptions& alloc) {
  std::vector<std::string> names;
  const size_t n = sess.GetInputCount();
  names.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    auto s = sess.GetInputNameAllocated(i, alloc);
    names.emplace_back(s.get());
  }
  return names;
}

std::vector<std::string> collect_output_names(Ort::Session& sess, Ort::AllocatorWithDefaultOptions& alloc) {
  std::vector<std::string> names;
  const size_t n = sess.GetOutputCount();
  names.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    auto s = sess.GetOutputNameAllocated(i, alloc);
    names.emplace_back(s.get());
  }
  return names;
}

bool append_execution_provider(
    Ort::SessionOptions& session_opts,
    const std::string& provider,
    const EngineConfig& config) {
  (void)session_opts;
  (void)config;
  if (provider == "cpu") {
    return true;
  }
  if (provider == "directml") {
#ifdef IMCODES_ORT_HAS_DML
    // DirectML requires sequential execution and disabled memory pattern.
    session_opts.DisableMemPattern();
    session_opts.SetExecutionMode(ORT_SEQUENTIAL);
    return append_dml_execution_provider(session_opts, config.directml_device_id);
#else
    return false;
#endif
  }
  if (provider == "cuda") {
#ifdef IMCODES_ORT_HAS_CUDA
    try {
      OrtCUDAProviderOptions cuda_opts{};
      cuda_opts.device_id = config.cuda_device_id;
      session_opts.AppendExecutionProvider_CUDA(cuda_opts);
      return true;
    } catch (...) {
      return false;
    }
#else
    (void)config;
    return false;
#endif
  }
  return false;
}

#endif  // IMCODES_HAS_ONNXRUNTIME

}  // namespace

std::string resolve_qwen3_language(const std::string& raw_language) {
  const std::string norm = normalize_lang_key(raw_language);
  if (norm.empty() || norm == "auto") return {};
  const auto& m = language_map();
  if (auto it = m.find(norm); it != m.end()) {
    return it->second;
  }
  const size_t dash = norm.find('-');
  if (dash != std::string::npos) {
    const std::string primary = norm.substr(0, dash);
    if (auto it = m.find(primary); it != m.end()) {
      return it->second;
    }
  }
  return {};
}

int64_t Qwen3OnnxEngine::trim_audio_features_f32(
    const float* data,
    int64_t num_frames,
    int64_t hidden_dim,
    float threshold) {
  if (!data || num_frames <= 0 || hidden_dim <= 0) return 0;
  for (int64_t f = num_frames - 1; f >= 0; --f) {
    const float* row = data + static_cast<size_t>(f) * static_cast<size_t>(hidden_dim);
    for (int64_t d = 0; d < hidden_dim; ++d) {
      if (std::fabs(row[d]) > threshold) {
        return f + 1;
      }
    }
  }
  return 0;
}

int64_t Qwen3OnnxEngine::trim_audio_features_f16(
    const uint16_t* data,
    int64_t num_frames,
    int64_t hidden_dim,
    float threshold) {
  if (!data || num_frames <= 0 || hidden_dim <= 0) return 0;
  for (int64_t f = num_frames - 1; f >= 0; --f) {
    const uint16_t* row = data + static_cast<size_t>(f) * static_cast<size_t>(hidden_dim);
    for (int64_t d = 0; d < hidden_dim; ++d) {
      if (std::fabs(half_to_float_scalar(row[d])) > threshold) {
        return f + 1;
      }
    }
  }
  return 0;
}

void Qwen3OnnxEngine::build_bounded_prompt_tokens(
    const Qwen3Tokenizer& tokenizer,
    const std::string& hotwords_context,
    const std::string& resolved_language,
    int64_t audio_token_count,
    const std::vector<int64_t>& requested_prefix_tokens,
    int64_t max_total_len,
    int max_new_tokens,
    std::vector<int64_t>& out_source_ids,
    std::vector<int64_t>& out_effective_prefix,
    int64_t& out_effective_audio_tokens) {
  out_source_ids.clear();
  out_effective_prefix.clear();
  out_effective_audio_tokens = std::max<int64_t>(0, audio_token_count);
  if (max_total_len <= 1 || out_effective_audio_tokens <= 0) {
    out_effective_audio_tokens = 0;
    return;
  }

  const auto& sp = tokenizer.special_ids();

  auto build_before = [&](const std::string& hw) {
    std::vector<int64_t> ids = {sp.im_start, sp.system_id, sp.newline};
    if (!hw.empty()) {
      std::vector<int64_t> hw_ids = tokenizer.encode(hw, false);
      ids.insert(ids.end(), hw_ids.begin(), hw_ids.end());
    }
    ids.insert(ids.end(), {sp.im_end, sp.newline, sp.im_start, sp.user_id, sp.newline, sp.audio_start});
    return ids;
  };

  std::vector<int64_t> before = build_before(hotwords_context);
  std::vector<int64_t> after = {sp.audio_end, sp.im_end, sp.newline, sp.im_start, sp.assistant_id, sp.newline};
  if (!resolved_language.empty()) {
    std::vector<int64_t> lang_ids = tokenizer.encode("language " + resolved_language, false);
    after.insert(after.end(), lang_ids.begin(), lang_ids.end());
    after.push_back(sp.asr_text);
  }

  const int64_t requested_gen = std::max<int64_t>(1, max_new_tokens);
  // Reserve headroom so decoding never hits KV cache boundary on the prefill step.
  const int64_t min_headroom = std::min<int64_t>(requested_gen, 32);

  // If prompt + audio already crowds max_total_len, drop hotwords before sacrificing audio frames.
  if (static_cast<int64_t>(before.size() + after.size()) + out_effective_audio_tokens + 1 > max_total_len) {
    before = build_before("");
  }
  if (static_cast<int64_t>(before.size() + after.size()) + out_effective_audio_tokens + 1 > max_total_len) {
    const int64_t avail_audio = max_total_len - 1 - static_cast<int64_t>(before.size() + after.size());
    out_effective_audio_tokens = std::max<int64_t>(1, avail_audio);
  }

  const int64_t base_len =
      static_cast<int64_t>(before.size() + after.size()) + out_effective_audio_tokens;
  const int64_t prefix_budget = std::max<int64_t>(0, max_total_len - base_len - min_headroom);

  if (!requested_prefix_tokens.empty() && prefix_budget > 0) {
    if (static_cast<int64_t>(requested_prefix_tokens.size()) <= prefix_budget) {
      out_effective_prefix = requested_prefix_tokens;
    } else {
      // Find <asr_text> boundary; never split the language header.
      size_t header_end = 0;
      if (resolved_language.empty()) {
        bool found = false;
        for (size_t i = requested_prefix_tokens.size(); i > 0; --i) {
          if (requested_prefix_tokens[i - 1] == sp.asr_text) {
            header_end = i;
            found = true;
            break;
          }
        }
        if (!found) {
          header_end = requested_prefix_tokens.size();
        }
      }
      if (static_cast<int64_t>(header_end) < prefix_budget) {
        size_t keep_end = static_cast<size_t>(prefix_budget);
        // Avoid leaving trailing partial UTF-8 bytes (U+FFFD) when shrinking prefix.
        if (tokenizer.is_loaded()) {
          while (keep_end > header_end) {
            std::vector<int64_t> slice(
                requested_prefix_tokens.begin() + static_cast<std::ptrdiff_t>(header_end),
                requested_prefix_tokens.begin() + static_cast<std::ptrdiff_t>(keep_end));
            const std::string decoded = tokenizer.decode(slice, true);
            const std::string kRepl = "\xEF\xBF\xBD";
            if (decoded.size() >= kRepl.size() &&
                decoded.compare(decoded.size() - kRepl.size(), kRepl.size(), kRepl) == 0) {
              --keep_end;
            } else {
              break;
            }
          }
        }
        if (keep_end > header_end) {
          out_effective_prefix.assign(
              requested_prefix_tokens.begin(),
              requested_prefix_tokens.begin() + static_cast<std::ptrdiff_t>(keep_end));
        }
      }
    }
  }

  out_source_ids.reserve(
      before.size() + static_cast<size_t>(out_effective_audio_tokens) + after.size() + out_effective_prefix.size());
  out_source_ids.insert(out_source_ids.end(), before.begin(), before.end());
  out_source_ids.insert(out_source_ids.end(), static_cast<size_t>(out_effective_audio_tokens), sp.audio_pad);
  out_source_ids.insert(out_source_ids.end(), after.begin(), after.end());
  out_source_ids.insert(out_source_ids.end(), out_effective_prefix.begin(), out_effective_prefix.end());
}

#ifdef IMCODES_HAS_ONNXRUNTIME
struct Qwen3OnnxEngine::OrtState {
  Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "imcodes_qwen3_asr"};
  Ort::MemoryInfo mem_info{Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)};
  std::unique_ptr<Ort::Session> conv_sess;
  std::unique_ptr<Ort::Session> encoder_sess;
  std::unique_ptr<Ort::Session> decoder_sess;

  std::vector<std::string> conv_in_names;
  std::vector<std::string> conv_out_names;
  std::vector<std::string> enc_in_names;
  std::vector<std::string> enc_out_names;
  std::vector<std::string> dec_in_names;
  std::vector<std::string> dec_out_names;

  ONNXTensorElementDataType cache_elem_type{ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT};
  ONNXTensorElementDataType logits_elem_type{ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT};

  // Pre-allocated KV cache buffers per layer: [1, effective_max_total_len, num_kv_heads, head_dim]
  std::vector<std::vector<uint8_t>> cache_keys;
  std::vector<std::vector<uint8_t>> cache_values;
  int64_t dirty_cache_rows{0};
};
#else
struct Qwen3OnnxEngine::OrtState {};
#endif

Qwen3OnnxEngine::Qwen3OnnxEngine() = default;
Qwen3OnnxEngine::~Qwen3OnnxEngine() = default;

bool Qwen3OnnxEngine::is_initialized() const {
#ifdef IMCODES_HAS_ONNXRUNTIME
  return ort_ != nullptr && ort_->conv_sess != nullptr && ort_->encoder_sess != nullptr &&
         ort_->decoder_sess != nullptr && tokenizer_.is_loaded();
#else
  return false;
#endif
}

bool Qwen3OnnxEngine::init(const EngineConfig& config, std::string& out_error) {
  std::lock_guard<std::mutex> lock(decode_mutex_);
  config_ = config;
  ort_.reset();

  const std::filesystem::path conv_path = config.model_dir / "conv_frontend.onnx";
  const std::filesystem::path enc_path = config.model_dir / "encoder.int8.onnx";
  const std::filesystem::path dec_path = config.model_dir / "decoder.int8.onnx";
  const std::filesystem::path tok_dir = config.model_dir / "tokenizer";

  if (!std::filesystem::exists(conv_path) || !std::filesystem::exists(enc_path) ||
      !std::filesystem::exists(dec_path) || !std::filesystem::exists(tok_dir / "vocab.json")) {
    out_error = "Missing Qwen3-ASR ONNX model or tokenizer files in model directory";
    return false;
  }

  if (!tokenizer_.load(tok_dir, out_error)) {
    return false;
  }

#ifndef IMCODES_HAS_ONNXRUNTIME
  out_error = "ONNX Runtime support was not enabled at compile time";
  return false;
#else
  std::vector<std::string> try_providers;
  if (config.requested_provider == "directml") {
    try_providers = {"directml", "cpu"};
  } else if (config.requested_provider == "cuda") {
    try_providers = {"cuda", "cpu"};
  } else if (config.requested_provider == "cpu") {
    try_providers = {"cpu"};
  } else {
#ifdef IMCODES_ORT_HAS_DML
    try_providers.push_back("directml");
#endif
#ifdef IMCODES_ORT_HAS_CUDA
    try_providers.push_back("cuda");
#endif
    try_providers.push_back("cpu");
  }

  const int hw_threads = static_cast<int>(std::thread::hardware_concurrency());
  const int cpu_threads = config.num_threads > 0
      ? config.num_threads
      : std::clamp(hw_threads > 0 ? hw_threads / 2 : 4, 2, 8);

  std::string last_err = "Failed to initialize ONNX Runtime sessions";
  for (const std::string& provider : try_providers) {
    try {
      auto state = std::make_unique<OrtState>();

      auto make_opts = [&](int threads) {
        Ort::SessionOptions opts;
        opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        opts.SetIntraOpNumThreads(threads);
        opts.SetInterOpNumThreads(1);
        return opts;
      };

      const bool is_gpu = (provider != "cpu");
      // CPU fallback ops inside hybrid quantized graphs (e.g. DynamicQuantizeLinear/MatMulInteger)
      // also rely on intra-op threads; avoid throttling them down to 2 threads.
      const int threads = cpu_threads;

      Ort::SessionOptions conv_opts = make_opts(threads);
      Ort::SessionOptions enc_opts = make_opts(threads);
      Ort::SessionOptions dec_opts = make_opts(threads);

      if (is_gpu) {
        if (!append_execution_provider(conv_opts, provider, config) ||
            !append_execution_provider(enc_opts, provider, config) ||
            !append_execution_provider(dec_opts, provider, config)) {
          last_err = "Requested execution provider unavailable: " + provider;
          continue;
        }
      }

      state->conv_sess = std::make_unique<Ort::Session>(state->env, conv_path.c_str(), conv_opts);
      state->encoder_sess = std::make_unique<Ort::Session>(state->env, enc_path.c_str(), enc_opts);
      state->decoder_sess = std::make_unique<Ort::Session>(state->env, dec_path.c_str(), dec_opts);

      Ort::AllocatorWithDefaultOptions alloc;
      state->conv_in_names = collect_input_names(*state->conv_sess, alloc);
      state->conv_out_names = collect_output_names(*state->conv_sess, alloc);
      state->enc_in_names = collect_input_names(*state->encoder_sess, alloc);
      state->enc_out_names = collect_output_names(*state->encoder_sess, alloc);
      state->dec_in_names = collect_input_names(*state->decoder_sess, alloc);
      state->dec_out_names = collect_output_names(*state->decoder_sess, alloc);

      const size_t dec_in_count = state->dec_in_names.size();
      const size_t dec_out_count = state->dec_out_names.size();
      if (dec_in_count < 6 || (dec_in_count - 4) % 2 != 0 || dec_out_count != 1 + (dec_in_count - 4)) {
        out_error = "Unexpected decoder.int8.onnx input/output tensor count";
        return false;
      }

      num_layers_ = static_cast<int>((dec_in_count - 4) / 2);

      auto audio_info = state->decoder_sess->GetInputTypeInfo(1);
      auto audio_ti = audio_info.GetTensorTypeAndShapeInfo();
      auto audio_shape = audio_ti.GetShape();
      audio_hidden_dim_ = audio_shape.size() >= 3 && audio_shape[2] > 0 ? audio_shape[2] : 1024;

      auto kv_info = state->decoder_sess->GetInputTypeInfo(4);
      auto kv_ti = kv_info.GetTensorTypeAndShapeInfo();
      state->cache_elem_type = kv_ti.GetElementType();
      auto kv_shape = kv_ti.GetShape();
      if (kv_shape.size() != 4 || kv_shape[2] <= 0 || kv_shape[3] <= 0) {
        out_error = "Unexpected cache_key tensor shape in decoder.int8.onnx";
        return false;
      }
      num_kv_heads_ = kv_shape[2];
      head_dim_ = kv_shape[3];
      const int64_t cfg_max_len = std::max<int64_t>(2, config.max_total_len);
      if (kv_shape[1] > 0) {
        // Fixed graph KV dim1: allocate/feed exact graph shape while keeping logical limit bounded.
        kv_physical_len_ = kv_shape[1];
        effective_max_total_len_ = std::min<int64_t>(cfg_max_len, kv_physical_len_);
      } else {
        effective_max_total_len_ = cfg_max_len;
        kv_physical_len_ = effective_max_total_len_;
      }

      auto logits_info = state->decoder_sess->GetOutputTypeInfo(0);
      auto logits_ti = logits_info.GetTensorTypeAndShapeInfo();
      state->logits_elem_type = logits_ti.GetElementType();
      auto logits_shape = logits_ti.GetShape();
      if (logits_shape.size() != 3 || logits_shape[2] <= 0) {
        out_error = "Unexpected logits tensor shape in decoder.int8.onnx";
        return false;
      }
      vocab_size_ = logits_shape[2];

      const size_t elem_bytes = is_fp16_type(state->cache_elem_type) ? sizeof(uint16_t) : sizeof(float);
      const size_t kv_bytes = static_cast<size_t>(kv_physical_len_) *
                              static_cast<size_t>(num_kv_heads_) *
                              static_cast<size_t>(head_dim_) * elem_bytes;
      state->cache_keys.assign(static_cast<size_t>(num_layers_), std::vector<uint8_t>(kv_bytes, 0));
      state->cache_values.assign(static_cast<size_t>(num_layers_), std::vector<uint8_t>(kv_bytes, 0));
      state->dirty_cache_rows = 0;

      ort_ = std::move(state);
      active_provider_ = provider;
      return true;
    } catch (const std::exception& ex) {
      last_err = ex.what();
    } catch (...) {
      last_err = "Unknown exception creating ONNX Runtime sessions for provider " + provider;
    }
  }

  out_error = last_err;
  return false;
#endif
}

DecodeResult Qwen3OnnxEngine::decode(const std::vector<float>& samples_16k, const DecodeOptions& opts) {
  DecodeResult result;
#ifndef IMCODES_HAS_ONNXRUNTIME
  (void)samples_16k;
  (void)opts;
  result.error = "ONNX Runtime not linked";
  return result;
#else
  std::lock_guard<std::mutex> lock(decode_mutex_);
  if (!is_initialized()) {
    result.error = "Engine not initialized";
    return result;
  }
  if (samples_16k.empty() || !has_utterance_speech_energy(samples_16k)) {
    return result;
  }
  if (opts.should_cancel && opts.should_cancel()) {
    result.cancelled = true;
    return result;
  }

  try {
    const auto ts_0 = std::chrono::steady_clock::now();
    // 1. Acoustic features: centered STFT 128-bin Whisper log-Mel [feat_frames, 128]
    MelSpectrogram mel = mel_extractor_.extract(samples_16k);
    const auto ts_mel = std::chrono::steady_clock::now();
    result.mel_ms = std::chrono::duration_cast<std::chrono::milliseconds>(ts_mel - ts_0).count();
    if (mel.num_frames <= 0) {
      return result;
    }
    if (opts.should_cancel && opts.should_cancel()) {
      result.cancelled = true;
      return result;
    }

    // 2. conv_frontend.onnx: [1, feat_frames, 128] -> conv_output [1, conv_num_frames, hidden]
    std::array<int64_t, 3> conv_in_shape = {1, mel.num_frames, mel.num_mels};
    Ort::Value conv_in = Ort::Value::CreateTensor<float>(
        ort_->mem_info, mel.data.data(), mel.data.size(), conv_in_shape.data(), conv_in_shape.size());
    const char* conv_in_names[] = {ort_->conv_in_names[0].c_str()};
    const char* conv_out_names[] = {ort_->conv_out_names[0].c_str()};
    auto conv_outs = ort_->conv_sess->Run(
        Ort::RunOptions{nullptr}, conv_in_names, &conv_in, 1, conv_out_names, 1);
    const auto ts_conv = std::chrono::steady_clock::now();
    result.conv_ms = std::chrono::duration_cast<std::chrono::milliseconds>(ts_conv - ts_mel).count();

    auto conv_shape = conv_outs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (conv_shape.size() != 3 || conv_shape[1] <= 0) {
      return result;
    }
    const int64_t conv_num_frames = conv_shape[1];
    const int64_t expected_audio_tokens = feat_to_audio_tokens_len(mel.num_frames, 100);
    const int64_t valid_frames = std::min(expected_audio_tokens, conv_num_frames);
    if (valid_frames <= 0) {
      return result;
    }
    if (opts.should_cancel && opts.should_cancel()) {
      result.cancelled = true;
      return result;
    }

    // 3. encoder.int8.onnx: (conv_output, feature_attention_mask) -> audio_features [1, A, H]
    std::vector<uint8_t> feat_mask(static_cast<size_t>(conv_num_frames), 0);
    std::fill_n(feat_mask.begin(), static_cast<size_t>(valid_frames), static_cast<uint8_t>(1));
    std::array<int64_t, 2> mask_shape = {1, conv_num_frames};
    Ort::Value feat_mask_tensor = Ort::Value::CreateTensor(
        ort_->mem_info,
        feat_mask.data(),
        feat_mask.size(),
        mask_shape.data(),
        mask_shape.size(),
        ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL);

    const char* enc_in_names[] = {ort_->enc_in_names[0].c_str(), ort_->enc_in_names[1].c_str()};
    const char* enc_out_names[] = {ort_->enc_out_names[0].c_str()};
    std::array<Ort::Value, 2> enc_inputs = {std::move(conv_outs[0]), std::move(feat_mask_tensor)};
    const auto ts_enc_0 = std::chrono::steady_clock::now();
    auto enc_outs = ort_->encoder_sess->Run(
        Ort::RunOptions{nullptr}, enc_in_names, enc_inputs.data(), enc_inputs.size(), enc_out_names, 1);
    const auto ts_enc_1 = std::chrono::steady_clock::now();
    result.enc_ms = std::chrono::duration_cast<std::chrono::milliseconds>(ts_enc_1 - ts_enc_0).count();

    auto enc_ti = enc_outs[0].GetTensorTypeAndShapeInfo();
    const auto enc_dtype = enc_ti.GetElementType();
    auto enc_shape = enc_ti.GetShape();
    if (enc_shape.size() != 3 || enc_shape[1] <= 0 || enc_shape[2] <= 0) {
      return result;
    }
    const int64_t enc_frames = enc_shape[1];
    const int64_t hidden = enc_shape[2];
    const int64_t bounded_frames = std::min(valid_frames, enc_frames);
    if (bounded_frames <= 0) {
      return result;
    }

    // Trim trailing near-zero encoder frames (<= 1e-6); all-zero output skips decoder cleanly.
    const bool enc_is_fp16 = is_fp16_type(enc_dtype);
    const int64_t trimmed_audio_tokens = enc_is_fp16
        ? trim_audio_features_f16(enc_outs[0].GetTensorData<uint16_t>(), bounded_frames, hidden, 1e-6f)
        : trim_audio_features_f32(enc_outs[0].GetTensorData<float>(), bounded_frames, hidden, 1e-6f);
    if (trimmed_audio_tokens <= 0) {
      return result;
    }

    // 4. Assemble prompt + prefix_tokens bounded safely under effective_max_total_len_
    const std::string resolved_lang = resolve_qwen3_language(opts.language);
    std::vector<int64_t> source_ids;
    std::vector<int64_t> effective_prefix;
    int64_t audio_tokens = trimmed_audio_tokens;
    build_bounded_prompt_tokens(
        tokenizer_,
        opts.hotwords_context,
        resolved_lang,
        trimmed_audio_tokens,
        opts.prefix_tokens,
        effective_max_total_len_,
        opts.max_new_tokens,
        source_ids,
        effective_prefix,
        audio_tokens);
    if (source_ids.empty() || audio_tokens <= 0) {
      return result;
    }
    audio_tokens = std::min(audio_tokens, trimmed_audio_tokens);

    const int64_t context_len = static_cast<int64_t>(source_ids.size());
    if (context_len >= effective_max_total_len_) {
      return result;
    }
    result.prefill_len = static_cast<int>(context_len);

    // Slice encoder output to [1, audio_tokens, hidden] matching encoder dtype
    const size_t audio_elem_count = static_cast<size_t>(audio_tokens) * static_cast<size_t>(hidden);
    const size_t audio_bytes = audio_elem_count * (enc_is_fp16 ? sizeof(uint16_t) : sizeof(float));
    void* enc_raw_ptr = enc_is_fp16
        ? static_cast<void*>(const_cast<uint16_t*>(enc_outs[0].GetTensorData<uint16_t>()))
        : static_cast<void*>(const_cast<float*>(enc_outs[0].GetTensorData<float>()));
    std::array<int64_t, 3> audio_shape = {1, audio_tokens, hidden};
    auto make_audio_tensor = [&]() {
      return Ort::Value::CreateTensor(
          ort_->mem_info, enc_raw_ptr, audio_bytes, audio_shape.data(), audio_shape.size(), enc_dtype);
    };

    // Zero only the dirty portion of KV cache buffers from prior utterance
    const size_t elem_bytes = is_fp16_type(ort_->cache_elem_type) ? sizeof(uint16_t) : sizeof(float);
    const size_t row_bytes = static_cast<size_t>(num_kv_heads_) * static_cast<size_t>(head_dim_) * elem_bytes;
    if (ort_->dirty_cache_rows > 0) {
      const int64_t bounded_dirty = std::min(ort_->dirty_cache_rows, kv_physical_len_);
      const size_t clear_bytes = static_cast<size_t>(bounded_dirty) * row_bytes;
      for (int l = 0; l < num_layers_; ++l) {
        std::memset(ort_->cache_keys[static_cast<size_t>(l)].data(), 0, clear_bytes);
        std::memset(ort_->cache_values[static_cast<size_t>(l)].data(), 0, clear_bytes);
      }
      ort_->dirty_cache_rows = 0;
    }

    std::vector<const char*> dec_in_names;
    dec_in_names.reserve(ort_->dec_in_names.size());
    for (const auto& s : ort_->dec_in_names) dec_in_names.push_back(s.c_str());

    std::vector<const char*> dec_out_names;
    dec_out_names.reserve(ort_->dec_out_names.size());
    for (const auto& s : ort_->dec_out_names) dec_out_names.push_back(s.c_str());

    // Physical KV tensor shape always matches graph dim1 (fixed or configured dynamic)
    std::array<int64_t, 4> kv_shape = {1, kv_physical_len_, num_kv_heads_, head_dim_};
    auto build_kv_views = [&](std::vector<Ort::Value>& inputs) {
      for (int l = 0; l < num_layers_; ++l) {
        auto& kbuf = ort_->cache_keys[static_cast<size_t>(l)];
        auto& vbuf = ort_->cache_values[static_cast<size_t>(l)];
        inputs.push_back(Ort::Value::CreateTensor(
            ort_->mem_info, kbuf.data(), kbuf.size(), kv_shape.data(), kv_shape.size(), ort_->cache_elem_type));
        inputs.push_back(Ort::Value::CreateTensor(
            ort_->mem_info, vbuf.data(), vbuf.size(), kv_shape.data(), kv_shape.size(), ort_->cache_elem_type));
      }
    };

    auto copy_deltas = [&](const std::vector<Ort::Value>& outputs, int64_t cache_pos, int64_t seq_len) {
      if (cache_pos < 0 || seq_len <= 0 || cache_pos + seq_len > effective_max_total_len_ ||
          cache_pos + seq_len > kv_physical_len_) {
        return;
      }
      const size_t copy_bytes = static_cast<size_t>(seq_len) * row_bytes;
      const size_t dst_offset = static_cast<size_t>(cache_pos) * row_bytes;
      for (int l = 0; l < num_layers_; ++l) {
        const Ort::Value& kd = outputs[static_cast<size_t>(1 + l * 2)];
        const Ort::Value& vd = outputs[static_cast<size_t>(1 + l * 2 + 1)];
        const void* ksrc = is_fp16_type(ort_->cache_elem_type)
            ? static_cast<const void*>(kd.GetTensorData<uint16_t>())
            : static_cast<const void*>(kd.GetTensorData<float>());
        const void* vsrc = is_fp16_type(ort_->cache_elem_type)
            ? static_cast<const void*>(vd.GetTensorData<uint16_t>())
            : static_cast<const void*>(vd.GetTensorData<float>());
        std::memcpy(ort_->cache_keys[static_cast<size_t>(l)].data() + dst_offset, ksrc, copy_bytes);
        std::memcpy(ort_->cache_values[static_cast<size_t>(l)].data() + dst_offset, vsrc, copy_bytes);
      }
      ort_->dirty_cache_rows = std::max(ort_->dirty_cache_rows, cache_pos + seq_len);
    };

    // 5. Prefill step (single pass over prompt + audio_pads + prefix_tokens)
    std::vector<int64_t> prefill_attn(static_cast<size_t>(context_len), 1);
    std::vector<int64_t> prefill_pos(static_cast<size_t>(context_len));
    for (int64_t i = 0; i < context_len; ++i) prefill_pos[static_cast<size_t>(i)] = i;

    std::array<int64_t, 2> prefill_ids_shape = {1, context_len};
    std::array<int64_t, 1> prefill_pos_shape = {context_len};

    std::vector<Ort::Value> prefill_inputs;
    prefill_inputs.reserve(4 + static_cast<size_t>(num_layers_) * 2);
    prefill_inputs.push_back(Ort::Value::CreateTensor<int64_t>(
        ort_->mem_info, source_ids.data(), source_ids.size(), prefill_ids_shape.data(), prefill_ids_shape.size()));
    prefill_inputs.push_back(make_audio_tensor());
    prefill_inputs.push_back(Ort::Value::CreateTensor<int64_t>(
        ort_->mem_info, prefill_attn.data(), prefill_attn.size(), prefill_ids_shape.data(), prefill_ids_shape.size()));
    prefill_inputs.push_back(Ort::Value::CreateTensor<int64_t>(
        ort_->mem_info, prefill_pos.data(), prefill_pos.size(), prefill_pos_shape.data(), prefill_pos_shape.size()));
    build_kv_views(prefill_inputs);

    const auto ts_pre_0 = std::chrono::steady_clock::now();
    auto prefill_outs = ort_->decoder_sess->Run(
        Ort::RunOptions{nullptr},
        dec_in_names.data(),
        prefill_inputs.data(),
        prefill_inputs.size(),
        dec_out_names.data(),
        dec_out_names.size());
    const auto ts_pre_1 = std::chrono::steady_clock::now();
    result.prefill_ms = std::chrono::duration_cast<std::chrono::milliseconds>(ts_pre_1 - ts_pre_0).count();

    copy_deltas(prefill_outs, 0, context_len);

    if (opts.should_cancel && opts.should_cancel()) {
      result.cancelled = true;
      return result;
    }

    const int64_t eos_id = tokenizer_.eos_token_id();
    const int64_t eot_id = tokenizer_.endoftext_token_id();
    const auto is_stop_token = [eos_id, eot_id](int64_t tok) {
      return tok == eos_id || tok == eot_id;
    };

    int64_t next_token = argmax_logits_row(
        prefill_outs[0], context_len - 1, vocab_size_, ort_->logits_elem_type);

    std::vector<int64_t> generated_tokens;
    const int64_t max_steps = std::min<int64_t>(
        std::max(0, opts.max_new_tokens),
        effective_max_total_len_ - context_len);

    if (is_stop_token(next_token)) {
      if (!effective_prefix.empty()) {
        // Non-empty prefix_tokens already express the complete audio: stop cleanly without hallucinating.
        next_token = eos_id;
      } else {
        // Empty prefix fallback: avoid immediate EOS once, stopping if the second choice is still EOS.
        next_token = argmax_logits_row(
            prefill_outs[0], context_len - 1, vocab_size_, ort_->logits_elem_type, eos_id, eot_id);
      }
    }

    // 6. Autoregressive KV-cache decode loop
    const auto ts_loop_0 = std::chrono::steady_clock::now();
    int64_t cur_pos = context_len;
    while (!is_stop_token(next_token) &&
           static_cast<int64_t>(generated_tokens.size()) < max_steps &&
           cur_pos < effective_max_total_len_) {
      if (opts.should_cancel && opts.should_cancel()) {
        result.cancelled = true;
        result.decode_loop_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::steady_clock::now() - ts_loop_0)
                                    .count();
        return result;
      }

      generated_tokens.push_back(next_token);
      result.generated_steps += 1;

      if (is_degenerate_token_repetition(generated_tokens, 64, 3)) {
        trim_degenerate_token_tail(generated_tokens, 64, 3);
        break;
      }

      if (static_cast<int64_t>(generated_tokens.size()) >= max_steps ||
          cur_pos + 1 >= effective_max_total_len_) {
        break;
      }

      int64_t step_id = next_token;
      int64_t step_attn = 1;
      int64_t step_pos = cur_pos;
      std::array<int64_t, 2> step_ids_shape = {1, 1};
      std::array<int64_t, 1> step_pos_shape = {1};

      std::vector<Ort::Value> step_inputs;
      step_inputs.reserve(4 + static_cast<size_t>(num_layers_) * 2);
      step_inputs.push_back(Ort::Value::CreateTensor<int64_t>(
          ort_->mem_info, &step_id, 1, step_ids_shape.data(), step_ids_shape.size()));
      step_inputs.push_back(make_audio_tensor());
      step_inputs.push_back(Ort::Value::CreateTensor<int64_t>(
          ort_->mem_info, &step_attn, 1, step_ids_shape.data(), step_ids_shape.size()));
      step_inputs.push_back(Ort::Value::CreateTensor<int64_t>(
          ort_->mem_info, &step_pos, 1, step_pos_shape.data(), step_pos_shape.size()));
      build_kv_views(step_inputs);

      auto step_outs = ort_->decoder_sess->Run(
          Ort::RunOptions{nullptr},
          dec_in_names.data(),
          step_inputs.data(),
          step_inputs.size(),
          dec_out_names.data(),
          dec_out_names.size());

      copy_deltas(step_outs, cur_pos, 1);
      cur_pos += 1;

      next_token = argmax_logits_row(step_outs[0], 0, vocab_size_, ort_->logits_elem_type);
    }
    result.decode_loop_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::steady_clock::now() - ts_loop_0)
                                .count();

    // Assemble complete non-EOS raw_tokens (prefix + generated) for rollback continuation,
    // while visible text drops uncompletable trailing UTF-8 bytes without leaking U+FFFD.
    result.raw_tokens.reserve(effective_prefix.size() + generated_tokens.size());
    result.raw_tokens.insert(result.raw_tokens.end(), effective_prefix.begin(), effective_prefix.end());
    result.raw_tokens.insert(result.raw_tokens.end(), generated_tokens.begin(), generated_tokens.end());

    const std::string visible_decoded = tokenizer_.decode_visible(result.raw_tokens, true);
    const bool expect_header = resolved_lang.empty();
    result.text = extract_asr_transcript_after_header(visible_decoded, expect_header);
    return result;
  } catch (const std::exception& ex) {
    result.error = ex.what();
    return result;
  } catch (...) {
    result.error = "Unknown ONNX Runtime inference error";
    return result;
  }
#endif
}

}  // namespace imcodes::qwen3
