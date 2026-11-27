#include "mel_features.hpp"
#include "qwen3_onnx_engine.hpp"
#include "qwen3_tokenizer.hpp"
#include "streaming_pipeline.hpp"
#include "text_guards.hpp"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

int g_failures = 0;

void check(bool cond, const char* expr, const char* file, int line) {
  if (!cond) {
    std::cerr << "FAIL " << file << ":" << line << ": " << expr << "\n";
    ++g_failures;
  }
}

#define EXPECT_TRUE(x) check(static_cast<bool>(x), #x, __FILE__, __LINE__)
#define EXPECT_EQ(a, b) check((a) == (b), #a " == " #b, __FILE__, __LINE__)

using namespace imcodes::qwen3;

void test_feat_to_audio_tokens_len() {
  EXPECT_EQ(feat_to_audio_tokens_len(0, 100), 0);
  EXPECT_EQ(feat_to_audio_tokens_len(1, 100), 1);
  EXPECT_EQ(feat_to_audio_tokens_len(2, 100), 1);
  EXPECT_EQ(feat_to_audio_tokens_len(3, 100), 1);
  EXPECT_EQ(feat_to_audio_tokens_len(9, 100), 2);
  EXPECT_EQ(feat_to_audio_tokens_len(100, 100), 13);
  EXPECT_EQ(feat_to_audio_tokens_len(101, 100), 14);
  EXPECT_EQ(feat_to_audio_tokens_len(200, 100), 26);
  EXPECT_EQ(feat_to_audio_tokens_len(3000, 100), 390);
}

void test_mel_fft_matches_naive_dft_and_extracts_shape() {
  WhisperMelExtractor ext;
  constexpr double kPi = 3.14159265358979323846;

  std::vector<float> frame(kWhisperNfft, 0.0f);
  for (int n = 0; n < kWhisperNfft; ++n) {
    frame[static_cast<size_t>(n)] =
        0.5f * std::sin(2.0f * static_cast<float>(kPi) * 1000.0f * n / kWhisperSampleRate) +
        0.3f * std::cos(2.0f * static_cast<float>(kPi) * 3450.0f * n / kWhisperSampleRate) +
        0.1f * ((n % 7) - 3) / 3.0f;
  }

  float fast_power[kWhisperNumBins];
  ext.compute_frame_power(frame.data(), fast_power);

  double max_rel_err = 0.0;
  for (int k = 0; k < kWhisperNumBins; ++k) {
    double re = 0.0;
    double im = 0.0;
    for (int n = 0; n < kWhisperNfft; ++n) {
      const double w = 0.5 * (1.0 - std::cos(2.0 * kPi * n / kWhisperNfft));
      const double xw = static_cast<double>(frame[static_cast<size_t>(n)]) * w;
      const double angle = 2.0 * kPi * k * n / kWhisperNfft;
      re += xw * std::cos(angle);
      im -= xw * std::sin(angle);
    }
    const double ref_p = re * re + im * im;
    const double denom = std::max(1.0, ref_p);
    const double err = std::fabs(ref_p - static_cast<double>(fast_power[k])) / denom;
    if (err > max_rel_err) max_rel_err = err;
  }
  EXPECT_TRUE(max_rel_err < 1e-4);

  // Empty & single sample edge cases (trimmedFrames = nFrames - 1 matches HuggingFace log_spec[:, :-1])
  EXPECT_EQ(ext.extract({}).num_frames, 0);
  EXPECT_EQ(ext.extract({0.25f}).num_frames, 0);
  EXPECT_EQ(ext.extract(std::vector<float>(160, 0.25f)).num_frames, 1);

  // 1s sine wave -> 100 frames x 128 mels
  std::vector<float> one_sec(16000, 0.0f);
  for (size_t i = 0; i < one_sec.size(); ++i) {
    one_sec[i] = 0.4f * std::sin(2.0f * static_cast<float>(kPi) * 1000.0f * static_cast<float>(i) / 16000.0f);
  }
  MelSpectrogram mel = ext.extract(one_sec);
  EXPECT_EQ(mel.num_frames, 100);
  EXPECT_EQ(mel.num_mels, 128);
  EXPECT_EQ(mel.data.size(), static_cast<size_t>(100 * 128));

  float min_v = 1e9f;
  float max_v = -1e9f;
  for (float v : mel.data) {
    if (v < min_v) min_v = v;
    if (v > max_v) max_v = v;
  }
  // Dynamic range clamp limits spread to <= 2.0 after (x + 4) / 4 normalization
  EXPECT_TRUE(max_v - min_v <= 2.001f);
}

void test_tokenizer_utf8_and_bpe() {
  Qwen3Tokenizer tok;
  // Synthetic vocab with GPT-2 byte-level chars + merged multi-byte Chinese token "中" (E4 B8 AD -> ä¸Ń)
  // Using byte-level encoding via unicode tables:
  // 0xE4 -> U+00E4 (ä), 0xB8 -> U+00B8 (¸), 0xAD -> U+0144 (Ń -> Wait: 0xAD is mapped to extra byte range!)
  // Easier: populate byte tokens dynamically by building a tiny vocab JSON via load_from_memory using encode helpers
  // First verify basic ASCII + special tokens + split multi-byte UTF-8 detection for U+FFFD!
  std::unordered_map<std::string, int64_t> vocab = {
      {"h", 10}, {"e", 11}, {"l", 12}, {"o", 13},
      {"he", 14}, {"ll", 15}, {"hello", 16},
      {"\xC4\xA0w", 17},  // Ġw
      {"or", 18}, {"ld", 19}, {"\xC4\xA0world", 20},
      // UTF-8 of '中' = E4 B8 AD -> 0xE4 (C3 A4), 0xB8 (C2 B8), 0xAD (byte 173 -> U+0123 -> C4 A3? Let's test raw 0xE4 0xB8!)
      // 0xE4 (228) is direct (>=0xAE), 0xB8 (184) is direct (>=0xAE)
      {"\xC3\xA4\xC2\xB8", 21},  // partial 2-byte prefix of '中' (0xE4 0xB8)
      {"\xC4\xA3", 22},          // placeholder byte 3
      {"language", 23},
      {"\xC4\xA0" "Chinese", 24},
      {"\xC4\x8A", 198},
      {"system", 8948},
      {"user", 872},
      {"assistant", 77091},
  };
  std::unordered_map<int64_t, std::string> added = {
      {151643, "<|endoftext|>"},
      {151644, "<|im_start|>"},
      {151645, "<|im_end|>"},
      {151669, "<|audio_start|>"},
      {151670, "<|audio_end|>"},
      {151676, "<|audio_pad|>"},
      {151704, "<asr_text>"},
  };
  std::vector<std::string> merges = {"h e", "l l", "he l", "hel lo"};
  EXPECT_TRUE(tok.load_from_memory(vocab, merges, added));

  auto enc = tok.encode("<|im_start|>hello<|im_end|>");
  EXPECT_EQ(enc.size(), size_t{3});
  EXPECT_EQ(enc[0], 151644);
  EXPECT_EQ(enc[1], 16);
  EXPECT_EQ(enc[2], 151645);
  EXPECT_EQ(tok.decode(enc, true), "hello");

  // Incomplete UTF-8 prefix at end emits U+FFFD (\xEF\xBF\xBD)
  std::string broken = tok.decode({16, 21}, true);
  EXPECT_TRUE(broken.find("\xEF\xBF\xBD") != std::string::npos);

  // Rollback across incomplete UTF-8 boundary + header preservation
  std::vector<int64_t> header_plus_tokens = {23, 24, 151704, 16, 21, 10, 11, 12, 13, 14, 151645};
  // End excludes EOS (151645) -> len 10; minus 5 -> 5 ([23, 24, 151704, 16, 21]); token 21 ends with U+FFFD so backs off to len 4!
  auto rolled = rollback_prefix_tokens(header_plus_tokens, tok, 5, true);
  EXPECT_EQ(rolled, (std::vector<int64_t>{23, 24, 151704, 16}));

  // Too short after header -> returns empty
  auto short_rolled = rollback_prefix_tokens({23, 24, 151704, 16, 20, 151645}, tok, 5, true);
  EXPECT_TRUE(short_rolled.empty());

  // Missing <asr_text> when expect_language_header = true -> returns empty
  auto missing_header = rollback_prefix_tokens({23, 24, 16, 20, 10, 11, 12, 13}, tok, 2, true);
  EXPECT_TRUE(missing_header.empty());
}

void test_guards_and_hotwords() {
  // Energy gate
  std::vector<float> silent(3200, 0.001f);
  EXPECT_TRUE(!has_utterance_speech_energy(silent));
  std::vector<float> peak_only(3200, 0.0f);
  peak_only[100] = 0.02f;
  EXPECT_TRUE(has_utterance_speech_energy(peak_only));
  std::vector<float> rms_voice(1600, 0.006f);
  EXPECT_TRUE(has_utterance_speech_energy(rms_voice));

  // Hotwords merge limits & dedup
  auto merged = merge_session_hotwords_raw({"BaseTerm"}, "IM.codes, im.codes, \x01" "Claude\x02, TypeScript");
  EXPECT_EQ(merged.terms.size(), size_t{4});
  EXPECT_EQ(merged.terms[0], "IM.codes");
  EXPECT_EQ(merged.terms[1], "Claude");
  EXPECT_EQ(merged.terms[2], "TypeScript");
  EXPECT_EQ(merged.terms[3], "BaseTerm");

  std::vector<std::string> many_terms;
  for (int i = 0; i < 80; ++i) {
    many_terms.push_back("Word_" + std::to_string(i));
  }
  auto capped = merge_session_hotwords({}, many_terms);
  EXPECT_EQ(capped.terms.size(), size_t{60});

  // Hallucination filter (multi-term cleared, single guarded by allow_single, real speech preserved)
  std::vector<std::string> hterms = {"IM.codes", "TypeScript", "语音热词"};
  EXPECT_EQ(strip_voice_hotword_hallucination("IM.codes, TypeScript", hterms, false), "");
  EXPECT_EQ(strip_voice_hotword_hallucination("\xEF\xBC\x88ｉｍ．ｃｏｄｅｓ\xE3\x80\x81 ＴｙｐｅＳｃｒｉｐｔ！", hterms, false), "");
  EXPECT_EQ(strip_voice_hotword_hallucination("IM.codes", hterms, false), "IM.codes");
  EXPECT_EQ(strip_voice_hotword_hallucination("IM.codes", hterms, true), "");
  EXPECT_EQ(strip_voice_hotword_hallucination("打开 IM.codes 查看文档", hterms, true), "打开 IM.codes 查看文档");

  // Control tag & transcript extraction
  EXPECT_EQ(strip_asr_control_tags("language Chinese<asr_text>你好世界<|im_end|>"), "你好世界");
  EXPECT_EQ(extract_asr_transcript_after_header("language Chin", true), "");
  EXPECT_EQ(extract_asr_transcript_after_header("language Chinese<asr_text>你好", true), "你好");
  EXPECT_EQ(strip_asr_control_tags("Check the language setting"), "Check the language setting");

  // Join segments
  EXPECT_EQ(join_transcript_segments("hello", "world"), "hello world");
  EXPECT_EQ(join_transcript_segments("你好", "世界"), "你好世界");
  EXPECT_EQ(join_transcript_segments("打开", "IM.codes"), "打开IM.codes");

  // Repetition sanitizer & token repetition
  EXPECT_EQ(sanitize_asr_repetition_loop("你好哈哈哈哈哈哈哈哈哈哈"), "你好");
  EXPECT_EQ(sanitize_asr_repetition_loop("哈啊哈啊哈啊哈啊哈啊"), "");
  std::vector<int64_t> rep_toks(70, 42);
  EXPECT_TRUE(is_degenerate_token_repetition(rep_toks, 64, 3));
  trim_degenerate_token_tail(rep_toks, 64, 3);
  EXPECT_EQ(rep_toks.size(), size_t{6});
}

void test_prompt_clamping_bounds() {
  Qwen3Tokenizer tok;
  std::unordered_map<std::string, int64_t> vocab = {
      {"system", 8948}, {"user", 872}, {"assistant", 77091}, {"\xC4\x8A", 198},
      {"language", 23}, {"\xC4\xA0" "Chinese", 24}, {"a", 30}, {"b", 31},
  };
  std::unordered_map<int64_t, std::string> added = {
      {151643, "<|endoftext|>"}, {151644, "<|im_start|>"}, {151645, "<|im_end|>"},
      {151669, "<|audio_start|>"}, {151670, "<|audio_end|>"}, {151676, "<|audio_pad|>"},
      {151704, "<asr_text>"},
  };
  EXPECT_TRUE(tok.load_from_memory(vocab, {}, added));

  std::vector<int64_t> huge_prefix = {23, 24, 151704};
  for (int i = 0; i < 400; ++i) huge_prefix.push_back(30 + (i % 2));

  std::vector<int64_t> source_ids;
  std::vector<int64_t> eff_prefix;
  int64_t eff_audio = 0;
  // 390 audio tokens + hotwords + huge_prefix > 512 -> must safely shrink prefix_tokens and stay < 512
  Qwen3OnnxEngine::build_bounded_prompt_tokens(
      tok, "a b a b a b", "", 390, huge_prefix, 512, 256,
      source_ids, eff_prefix, eff_audio);
  EXPECT_TRUE(source_ids.size() < 512);
  EXPECT_EQ(eff_audio, 390);
  EXPECT_TRUE(eff_prefix.size() < huge_prefix.size());
  EXPECT_TRUE(eff_prefix.empty() || eff_prefix.size() > 3);  // never split language header
}

void test_streaming_pipeline_30s_and_guards() {
  Qwen3Tokenizer tok;
  std::unordered_map<std::string, int64_t> vocab = {
      {"language", 23}, {"\xC4\xA0" "Chinese", 24},
      {"h0", 100}, {"h1", 101}, {"h2", 102}, {"h3", 103}, {"h4", 104},
      {"h5", 105}, {"h6", 106}, {"h7", 107},
  };
  std::unordered_map<int64_t, std::string> added = {
      {151643, "<|endoftext|>"}, {151645, "<|im_end|>"}, {151704, "<asr_text>"},
  };
  EXPECT_TRUE(tok.load_from_memory(vocab, {}, added));

  // 1. Streaming prefix_tokens + <=30s forced unprefixed full redecode (even across pause split!)
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1600;
    cfg.step_stride_samples = 1600;
    cfg.max_segment_samples = 4000;
    cfg.max_final_redecode_samples = 10000;
    cfg.min_final_samples = 100;
    cfg.rollback_token_count = 2;
    cfg.expect_language_header = true;

    struct CallRecord {
      size_t samples;
      std::vector<int64_t> prefix;
      int max_new_tokens;
    };
    std::vector<CallRecord> calls;
    std::vector<TranscriptUpdate> updates;
    bool ended = false;

    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>& audio, const DecodeOptions& opts) -> DecodeResult {
          calls.push_back({audio.size(), opts.prefix_tokens, opts.max_new_tokens});
          DecodeResult res;
          if (opts.max_new_tokens == cfg.final_max_new_tokens) {
            res.text = "language Chinese<asr_text>full_accurate_final";
            res.raw_tokens = {23, 24, 151704, 100, 101, 102, 103};
          } else {
            // Simulate Qwen3OnnxEngine::decode having already extracted clean text after <asr_text>
            res.text = "partial_seg";
            res.raw_tokens = {23, 24, 151704, 100, 101, 102, 103};
          }
          return res;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); },
        [&]() { ended = true; });

    std::vector<float> voiced(2000, 0.05f);
    pipe.push_samples(voiced);
    pipe.push_samples(voiced);
    pipe.push_samples(voiced);  // total 6000 <= 10000 cap, crosses max_segment_samples=4000
    pipe.request_stop(false, true);
    pipe.run_loop();

    EXPECT_TRUE(ended);
    EXPECT_TRUE(!pipe.exceeded_final_redecode_cap());
    EXPECT_TRUE(calls.size() >= 2);
    // Final pass MUST be full 6000 samples, unprefixed, max_new_tokens=384!
    EXPECT_EQ(calls.back().samples, size_t{6000});
    EXPECT_TRUE(calls.back().prefix.empty());
    EXPECT_EQ(calls.back().max_new_tokens, 384);
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "full_accurate_final");
  }

  // 2. > 30s overflow immediately frees full buffer and falls back to committed + unprefixed active tail
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1000;
    cfg.step_stride_samples = 1000;
    cfg.max_segment_samples = 3000;
    cfg.max_final_redecode_samples = 5000;
    cfg.min_final_samples = 100;
    cfg.rollback_token_count = 2;
    cfg.expect_language_header = true;

    std::vector<size_t> decode_sizes;
    std::vector<std::vector<int64_t>> decode_prefixes;
    std::vector<TranscriptUpdate> updates;

    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>& audio, const DecodeOptions& opts) -> DecodeResult {
          decode_sizes.push_back(audio.size());
          decode_prefixes.push_back(opts.prefix_tokens);
          DecodeResult res;
          if (opts.max_new_tokens == cfg.final_max_new_tokens) {
            res.text = "language Chinese<asr_text>tail_part";
            res.raw_tokens = {23, 24, 151704, 104, 105};
          } else {
            res.text = "language Chinese<asr_text>seg_one";
            res.raw_tokens = {23, 24, 151704, 100, 101, 102, 103};
          }
          return res;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });

    std::vector<float> chunk(3000, 0.05f);
    pipe.push_samples(chunk);
    EXPECT_TRUE(!pipe.exceeded_final_redecode_cap());
    EXPECT_EQ(pipe.full_utterance_buffer_size(), size_t{3000});

    pipe.push_samples(chunk);  // 6000 > 5000 cap -> immediately clears full buffer!
    EXPECT_TRUE(pipe.exceeded_final_redecode_cap());
    EXPECT_EQ(pipe.full_utterance_buffer_size(), size_t{0});

    pipe.request_stop(false, true);
    pipe.run_loop();

    EXPECT_TRUE(!decode_sizes.empty());
    EXPECT_EQ(decode_sizes.back(), size_t{3000});  // tail segment only, NOT 6000!
    EXPECT_TRUE(decode_prefixes.back().empty());   // final tail decode is unprefixed
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "seg_one tail_part");
  }

  // 3. Hotword hallucination silence & single-hotword retraction
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1600;
    cfg.step_stride_samples = 1600;
    cfg.max_segment_samples = 10000;
    cfg.max_final_redecode_samples = 20000;
    cfg.hotword_terms = {"IM.codes", "Claude"};
    cfg.expect_language_header = false;

    int call_count = 0;
    std::vector<TranscriptUpdate> updates;
    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          ++call_count;
          DecodeResult res;
          if (call_count == 1) {
            res.text = "IM.codes";  // tentative single hotword
          } else {
            res.text = "IM.codes, Claude";  // multi-hotword hallucination -> retract!
          }
          return res;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });

    // Pure silence never even calls decode
    std::vector<float> quiet(2000, 0.0005f);
    pipe.push_samples(quiet);
    pipe.request_stop(false, true);
    pipe.run_loop();
    EXPECT_EQ(call_count, 0);

    // Voiced tentative single hotword followed by hallucination retracts cleanly to ""
    updates.clear();
    std::atomic<int> call2{0};
    Qwen3StreamingPipeline pipe2(
        cfg,
        tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          const int c = ++call2;
          DecodeResult res;
          res.text = (c == 1) ? "IM.codes" : "IM.codes, Claude";
          return res;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });
    std::vector<float> voiced(2000, 0.05f);
    std::thread worker([&]() { pipe2.run_loop(); });
    pipe2.push_samples(voiced);
    while (call2.load() < 1) {
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    pipe2.push_samples(voiced);
    pipe2.request_stop(false, true);
    worker.join();
    EXPECT_TRUE(call2.load() >= 2);
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "");
  }
}

void test_real_tokenizer_if_present() {
  const char* env_dir = std::getenv("IMCODES_QWEN3_TEST_MODEL_DIR");
  if (!env_dir || !*env_dir) return;
  const std::filesystem::path tok_dir = std::filesystem::path(env_dir) / "tokenizer";
  if (!std::filesystem::exists(tok_dir / "vocab.json")) return;

  Qwen3Tokenizer tok;
  std::string err;
  EXPECT_TRUE(tok.load(tok_dir, err));
  EXPECT_TRUE(tok.vocab_size() > 150000);
  EXPECT_EQ(tok.eos_token_id(), 151645);
  EXPECT_EQ(tok.pad_token_id(), 151643);
  EXPECT_EQ(tok.audio_pad_token_id(), 151676);
  EXPECT_EQ(tok.asr_text_token_id(), 151704);

  const std::string sample = "IM.codes, 中文语音热词测试, hello world";
  const auto ids = tok.encode(sample, false);
  EXPECT_TRUE(!ids.empty());
  const std::string back = tok.decode(ids, false);
  EXPECT_EQ(back, sample);
}

}  // namespace

int main() {
  test_feat_to_audio_tokens_len();
  test_mel_fft_matches_naive_dft_and_extracts_shape();
  test_tokenizer_utf8_and_bpe();
  test_guards_and_hotwords();
  test_prompt_clamping_bounds();
  test_streaming_pipeline_30s_and_guards();
  test_real_tokenizer_if_present();

  if (g_failures > 0) {
    std::cerr << g_failures << " test check(s) failed\n";
    return 1;
  }
  std::cout << "All qwen3_onnx_tests passed!\n";
  return 0;
}
