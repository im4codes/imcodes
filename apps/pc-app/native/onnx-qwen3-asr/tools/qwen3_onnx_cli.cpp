#include "qwen3_onnx_engine.hpp"
#include "streaming_pipeline.hpp"
#include "text_guards.hpp"

#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

bool load_wav_16k_mono(const std::filesystem::path& wav_path, std::vector<float>& out_samples, std::string& out_error) {
  std::ifstream ifs(wav_path, std::ios::binary);
  if (!ifs.is_open()) {
    out_error = "Failed to open WAV file";
    return false;
  }
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
  if (bytes.size() < 44 || std::memcmp(bytes.data(), "RIFF", 4) != 0 ||
      std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    out_error = "Invalid RIFF/WAVE header";
    return false;
  }

  auto read_u16 = [&](size_t off) -> uint16_t {
    return static_cast<uint16_t>(bytes[off]) | (static_cast<uint16_t>(bytes[off + 1]) << 8);
  };
  auto read_u32 = [&](size_t off) -> uint32_t {
    return static_cast<uint32_t>(bytes[off]) |
           (static_cast<uint32_t>(bytes[off + 1]) << 8) |
           (static_cast<uint32_t>(bytes[off + 2]) << 16) |
           (static_cast<uint32_t>(bytes[off + 3]) << 24);
  };

  uint16_t audio_format = 0;
  uint16_t channels = 0;
  uint32_t sample_rate = 0;
  uint16_t bits_per_sample = 0;
  size_t data_offset = 0;
  uint32_t data_size = 0;

  size_t pos = 12;
  while (pos + 8 <= bytes.size()) {
    const uint32_t chunk_size = read_u32(pos + 4);
    if (std::memcmp(bytes.data() + pos, "fmt ", 4) == 0 && pos + 8 + 16 <= bytes.size()) {
      audio_format = read_u16(pos + 8);
      channels = read_u16(pos + 10);
      sample_rate = read_u32(pos + 12);
      bits_per_sample = read_u16(pos + 22);
    } else if (std::memcmp(bytes.data() + pos, "data", 4) == 0) {
      data_offset = pos + 8;
      data_size = chunk_size;
      break;
    }
    pos += 8 + chunk_size + (chunk_size & 1u);
  }

  if (data_offset == 0 || channels == 0 || sample_rate != 16000 ||
      !((audio_format == 1 && bits_per_sample == 16) || (audio_format == 3 && bits_per_sample == 32))) {
    out_error = "WAV must be 16kHz PCM16 or Float32";
    return false;
  }

  const size_t avail = std::min<size_t>(data_size, bytes.size() - data_offset);
  const size_t bytes_per_sample = bits_per_sample / 8;
  const size_t frame_bytes = bytes_per_sample * channels;
  const size_t num_frames = avail / frame_bytes;
  out_samples.resize(num_frames, 0.0f);

  for (size_t i = 0; i < num_frames; ++i) {
    double acc = 0.0;
    for (uint16_t c = 0; c < channels; ++c) {
      const size_t off = data_offset + i * frame_bytes + c * bytes_per_sample;
      if (audio_format == 1) {
        const int16_t v = static_cast<int16_t>(read_u16(off));
        acc += static_cast<double>(v) / 32768.0;
      } else {
        float v = 0.0f;
        std::memcpy(&v, bytes.data() + off, sizeof(float));
        acc += v;
      }
    }
    out_samples[i] = static_cast<float>(acc / channels);
  }
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  std::string model_dir;
  std::string wav_path;
  std::string hotwords;
  std::string language;
  std::string provider = "auto";
  int num_threads = 0;
  int max_new_tokens = 256;
  bool test_prefix = false;
  bool test_stream = false;
  bool silence_test = false;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--model-dir" && i + 1 < argc) model_dir = argv[++i];
    else if (arg == "--wav" && i + 1 < argc) wav_path = argv[++i];
    else if (arg == "--hotwords" && i + 1 < argc) hotwords = argv[++i];
    else if (arg == "--language" && i + 1 < argc) language = argv[++i];
    else if (arg == "--provider" && i + 1 < argc) provider = argv[++i];
    else if (arg == "--threads" && i + 1 < argc) num_threads = std::stoi(argv[++i]);
    else if (arg == "--max-new-tokens" && i + 1 < argc) max_new_tokens = std::stoi(argv[++i]);
    else if (arg == "--test-prefix") test_prefix = true;
    else if (arg == "--stream") test_stream = true;
    else if (arg == "--silence") silence_test = true;
  }

  if (model_dir.empty() || (wav_path.empty() && !silence_test)) {
    std::cerr << "Usage: qwen3_onnx_cli --model-dir <dir> (--wav <16k.wav> | --silence) "
              << "[--hotwords \"a,b\"] [--language auto|zh|en] [--provider auto|cpu|directml|cuda] "
              << "[--threads N] [--test-prefix] [--stream]\n";
    return 2;
  }

  imcodes::qwen3::Qwen3OnnxEngine engine;
  imcodes::qwen3::EngineConfig cfg;
  cfg.model_dir = model_dir;
  cfg.requested_provider = provider;
  cfg.num_threads = num_threads;

  std::string err;
  const auto t0 = std::chrono::steady_clock::now();
  if (!engine.init(cfg, err)) {
    std::cerr << "Init failed: " << err << "\n";
    return 1;
  }
  const auto t1 = std::chrono::steady_clock::now();
  const auto init_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
  std::cout << "Initialized provider=" << engine.active_provider()
            << " layers=" << engine.num_layers()
            << " init_ms=" << init_ms << "\n";

  std::vector<float> samples;
  if (silence_test) {
    samples.assign(32000, 0.0f);  // 2s pure digital silence
  } else if (!load_wav_16k_mono(wav_path, samples, err)) {
    std::cerr << "WAV error: " << err << "\n";
    return 1;
  }

  const auto merged_hw = imcodes::qwen3::merge_session_hotwords_raw({}, hotwords);

  if (test_stream) {
    imcodes::qwen3::StreamingPipelineConfig pcfg;
    pcfg.hotwords_context = merged_hw.context;
    pcfg.hotword_terms = merged_hw.terms;
    pcfg.language = language;
    pcfg.expect_language_header = imcodes::qwen3::resolve_qwen3_language(language).empty();

    imcodes::qwen3::Qwen3StreamingPipeline pipe(
        pcfg,
        engine.tokenizer(),
        [&](const std::vector<float>& chunk, const imcodes::qwen3::DecodeOptions& dopts) {
          const auto d0 = std::chrono::steady_clock::now();
          const auto r = engine.decode(chunk, dopts);
          const auto d1 = std::chrono::steady_clock::now();
          const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(d1 - d0).count();
          std::cout << "[STREAM PASS] samples=" << chunk.size()
                    << " prefix_len=" << dopts.prefix_tokens.size()
                    << " prefill=" << r.prefill_len
                    << " steps=" << r.generated_steps
                    << " elapsed_ms=" << ms
                    << " (mel=" << r.mel_ms
                    << " conv=" << r.conv_ms
                    << " enc=" << r.enc_ms
                    << " pre=" << r.prefill_ms
                    << " loop=" << r.decode_loop_ms
                    << " kv=" << engine.kv_physical_len() << ")\n";
          return r;
        },
        [](const imcodes::qwen3::TranscriptUpdate& upd) {
          std::cout << "[STREAM isFinal=" << (upd.is_final ? "true" : "false") << "] "
                    << upd.text << "\n";
        },
        []() { std::cout << "[STREAM END]\n"; });

    const size_t chunk_sz = 6400;  // 400ms chunks
    for (size_t off = 0; off < samples.size(); off += chunk_sz) {
      const size_t n = std::min(chunk_sz, samples.size() - off);
      pipe.push_samples(samples.data() + off, n);
    }
    pipe.request_stop(false, true);
    pipe.run_loop();
    return 0;
  }

  imcodes::qwen3::DecodeOptions opts;
  opts.hotwords_context = merged_hw.context;
  opts.language = language;
  opts.max_new_tokens = max_new_tokens;

  if (silence_test && !imcodes::qwen3::has_utterance_speech_energy(samples)) {
    std::cout << "Silence energy gate triggered -> text=\"\"\n";
    return 0;
  }

  const auto d0 = std::chrono::steady_clock::now();
  const auto res = engine.decode(samples, opts);
  const auto d1 = std::chrono::steady_clock::now();
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(d1 - d0).count();

  if (!res.error.empty()) {
    std::cerr << "Decode error: " << res.error << "\n";
    return 1;
  }
  const std::string guarded = imcodes::qwen3::sanitize_asr_repetition_loop(
      imcodes::qwen3::strip_voice_hotword_hallucination(res.text, merged_hw.terms, true));

  std::cout << "Unprefixed: prefill=" << res.prefill_len
            << " steps=" << res.generated_steps
            << " elapsed_ms=" << ms
            << " (mel=" << res.mel_ms
            << " conv=" << res.conv_ms
            << " enc=" << res.enc_ms
            << " pre=" << res.prefill_ms
            << " loop=" << res.decode_loop_ms
            << " kv=" << engine.kv_physical_len() << ")"
            << " text=\"" << guarded << "\"\n";

  if (test_prefix && !res.raw_tokens.empty()) {
    const auto prefix = imcodes::qwen3::rollback_prefix_tokens(
        res.raw_tokens, engine.tokenizer(), 5, imcodes::qwen3::resolve_qwen3_language(language).empty());
    imcodes::qwen3::DecodeOptions popts = opts;
    popts.prefix_tokens = prefix;
    const auto p0 = std::chrono::steady_clock::now();
    const auto pres = engine.decode(samples, popts);
    const auto p1 = std::chrono::steady_clock::now();
    const auto pms = std::chrono::duration_cast<std::chrono::milliseconds>(p1 - p0).count();
    const std::string pguarded = imcodes::qwen3::sanitize_asr_repetition_loop(
        imcodes::qwen3::strip_voice_hotword_hallucination(pres.text, merged_hw.terms, true));
    std::cout << "Prefixed(rollback=5, prefix_len=" << prefix.size() << "):"
              << " prefill=" << pres.prefill_len
              << " steps=" << pres.generated_steps
              << " elapsed_ms=" << pms
              << " text=\"" << pguarded << "\"\n";
  }

  return 0;
}
