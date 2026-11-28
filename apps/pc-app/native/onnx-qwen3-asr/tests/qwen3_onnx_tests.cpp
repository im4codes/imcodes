#include "mel_features.hpp"
#include "qwen3_onnx_engine.hpp"
#include "qwen3_tokenizer.hpp"
#include "streaming_pipeline.hpp"
#include "text_guards.hpp"
#include "tiny_onnx_fixture.hpp"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace {

double process_cpu_ms() {
#ifdef _WIN32
  FILETIME ft_create{}, ft_exit{}, ft_kernel{}, ft_user{};
  if (!GetProcessTimes(GetCurrentProcess(), &ft_create, &ft_exit, &ft_kernel, &ft_user)) {
    return 0.0;
  }
  ULARGE_INTEGER k{}, u{};
  k.LowPart = ft_kernel.dwLowDateTime;
  k.HighPart = ft_kernel.dwHighDateTime;
  u.LowPart = ft_user.dwLowDateTime;
  u.HighPart = ft_user.dwHighDateTime;
  return static_cast<double>(k.QuadPart + u.QuadPart) / 10000.0;
#else
  return 1000.0 * static_cast<double>(std::clock()) / static_cast<double>(CLOCKS_PER_SEC);
#endif
}

std::string get_env_str(const char* name) {
#ifdef _WIN32
  char* buf = nullptr;
  size_t len = 0;
  if (_dupenv_s(&buf, &len, name) != 0 || !buf) {
    return {};
  }
  std::string out(buf);
  std::free(buf);
  return out;
#else
  const char* val = std::getenv(name);
  return val ? std::string(val) : std::string{};
#endif
}

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

  // Incomplete UTF-8 prefix at end emits U+FFFD (\xEF\xBF\xBD) for byte diagnostics,
  // while decode_visible drops uncompletable trailing UTF-8 bytes cleanly.
  std::string broken = tok.decode({16, 21}, true);
  EXPECT_TRUE(broken.find("\xEF\xBF\xBD") != std::string::npos);
  std::string visible = tok.decode_visible({16, 21}, true);
  EXPECT_EQ(visible, "hello");
  std::vector<uint8_t> raw_bytes = tok.decode_bytes({16, 21}, true);
  EXPECT_EQ(raw_bytes.size(), size_t{7});  // "hello" (5) + 0xE4 0xB8 (2)

  // NFC normalization (NFD "fa\u0301cil" -> NFC "fácil", Hangul L+V+T -> composed syllable)
  const std::string nfd_facil = "fa\xCC\x81" "cil";
  const std::string nfc_facil = "f\xC3\xA1" "cil";
  EXPECT_EQ(Qwen3Tokenizer::normalize_nfc(nfd_facil), nfc_facil);
  const std::string nfd_hangul = "\xE1\x84\x92\xE1\x85\xA1\xE1\x86\xAB";  // ㅎ + ㅏ + ㄴ (한)
  const std::string nfc_hangul = "\xED\x95\x9C";                          // 한
  EXPECT_EQ(Qwen3Tokenizer::normalize_nfc(nfd_hangul), nfc_hangul);

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

  // 1. Segmented streaming prefix_tokens + stop decodes ONLY active tail (no full-utterance redecode)
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1600;
    cfg.step_stride_samples = 1600;
    cfg.max_segment_samples = 4000;
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
            res.text = "language Chinese<asr_text>tail_seg";
            res.raw_tokens = {23, 24, 151704, 104, 105};
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
    pipe.push_samples(voiced);  // total 6000 crosses max_segment_samples=4000 -> 4000 committed + 2000 active tail
    pipe.request_stop(false, true);
    pipe.run_loop();

    EXPECT_TRUE(ended);
    EXPECT_EQ(calls.size(), size_t{2});
    EXPECT_EQ(calls[0].samples, size_t{4000});
    // Final pass MUST decode ONLY trailing active_segment_ (2000 samples), NOT full 6000!
    EXPECT_EQ(calls.back().samples, size_t{2000});
    EXPECT_TRUE(calls.back().prefix.empty());  // fresh post-rollover segment starts with empty prefix
    EXPECT_EQ(calls.back().max_new_tokens, 384);
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "partial_seg tail_seg");
  }

  // 2. Stop with new_count == 0 emits finalized text with ZERO extra decode calls (even with confirmed prefix tokens)
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1600;
    cfg.step_stride_samples = 1600;
    cfg.max_segment_samples = 10000;
    cfg.min_final_samples = 100;
    cfg.rollback_token_count = 2;
    cfg.expect_language_header = true;

    std::atomic<int> call_count{0};
    std::vector<TranscriptUpdate> updates;
    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          ++call_count;
          DecodeResult res;
          res.text = "streamed_exact";
          res.raw_tokens = {23, 24, 151704, 100, 101, 102, 103};
          return res;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });

    std::thread worker([&]() { pipe.run_loop(); });
    pipe.push_samples(std::vector<float>(1600, 0.05f));
    while (call_count.load() < 1) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    pipe.request_stop(false, true);  // new_count == 0 -> no extra decode pass!
    worker.join();

    EXPECT_EQ(call_count.load(), 1);
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "streamed_exact");
  }

  // 3. Hotword hallucination silence & single-hotword retraction
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1600;
    cfg.step_stride_samples = 1600;
    cfg.max_segment_samples = 10000;
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

  // 4. Real streaming rollback=5 prefix delivery (preserved on stop with new_count > 0) + error preservation
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1000;
    cfg.step_stride_samples = 1000;
    cfg.max_segment_samples = 10000;
    cfg.min_final_samples = 100;
    cfg.rollback_token_count = 5;
    cfg.expect_language_header = true;

    std::atomic<int> call_num{0};
    std::vector<std::vector<int64_t>> seen_prefixes;
    std::vector<TranscriptUpdate> updates;
    std::vector<float> voiced(1200, 0.05f);

    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>&, const DecodeOptions& opts) -> DecodeResult {
          const int c = ++call_num;
          seen_prefixes.push_back(opts.prefix_tokens);
          DecodeResult res;
          if (c == 1) {
            // 8 content tokens after <asr_text>: rollback=5 preserves 3 content tokens -> 6 total prefix tokens
            res.text = "valid_preview";
            res.raw_tokens = {23, 24, 151704, 100, 101, 102, 103, 104, 105, 106, 107};
          } else if (c == 2) {
            // Transient streaming error must NOT overwrite preview or clear prefix
            res.error = "transient_stream_err";
          } else {
            // Final tail error must retain valid_preview and propagate error
            res.error = "final_decode_failed";
          }
          return res;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });

    std::thread th([&]() { pipe.run_loop(); });
    pipe.push_samples(voiced);
    while (call_num.load() < 1) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    pipe.push_samples(voiced);
    while (call_num.load() < 2) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    pipe.push_samples(std::vector<float>(300, 0.05f));  // new_count > 0 (< step_stride) triggers final tail decode
    pipe.request_stop(false, true);
    th.join();

    EXPECT_TRUE(seen_prefixes.size() >= 3);
    EXPECT_TRUE(seen_prefixes[0].empty());
    EXPECT_EQ(seen_prefixes[1], (std::vector<int64_t>{23, 24, 151704, 100, 101, 102}));
    EXPECT_EQ(seen_prefixes[2], (std::vector<int64_t>{23, 24, 151704, 100, 101, 102}));
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "valid_preview");
    EXPECT_EQ(updates.back().error, "final_decode_failed");
  }

  // 5. Segmented final tail error preserves committed + active preview and wait predicate does not spin
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1000;
    cfg.step_stride_samples = 1000;
    cfg.max_segment_samples = 2000;
    cfg.min_final_samples = 100;
    cfg.rollback_token_count = 2;
    cfg.expect_language_header = true;

    std::atomic<int> decode_cnt{0};
    std::vector<TranscriptUpdate> updates;
    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>&, const DecodeOptions& opts) -> DecodeResult {
          const int c = ++decode_cnt;
          DecodeResult res;
          if (opts.max_new_tokens == cfg.final_max_new_tokens) {
            res.error = "tail_decode_failed";
          } else {
            res.text = (c == 1) ? "committed_chunk" : "tail_preview";
            res.raw_tokens = {23, 24, 151704, 100, 101, 102, 103};
          }
          return res;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });

    std::vector<float> big(3500, 0.05f);  // > 2000 segment cap
    pipe.push_samples(big);
    std::thread th([&]() { pipe.run_loop(); });
    while (decode_cnt.load() < 2) std::this_thread::sleep_for(std::chrono::milliseconds(5));

    // Trailing samples + request_stop(false, false) BEFORE mark_producer_finished(): must sleep cleanly, not spin!
    pipe.push_samples(std::vector<float>(200, 0.05f));
    pipe.request_stop(false, false);
    const double cpu_before = process_cpu_ms();
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    const double cpu_ms = process_cpu_ms() - cpu_before;
    EXPECT_TRUE(cpu_ms < 50.0);

    pipe.mark_producer_finished();
    th.join();
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "committed_chunk tail_preview");
    EXPECT_EQ(updates.back().error, "tail_decode_failed");
  }

  // 6. Reverse arrival order: mark_producer_finished() before request_stop(false, false)
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1000;
    cfg.min_final_samples = 100;
    std::vector<TranscriptUpdate> updates;
    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          DecodeResult r;
          r.text = "language English<asr_text>done";
          return r;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });
    std::thread th([&]() { pipe.run_loop(); });
    pipe.push_samples(std::vector<float>(1200, 0.05f));
    pipe.mark_producer_finished();
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    pipe.request_stop(false, false);
    th.join();
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "done");
  }

  // 7. Short utterance (< initial_stride_samples, >= min_final_samples) decodes active_segment_ once cleanly on stop
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 12800;
    cfg.min_final_samples = 1600;
    cfg.expect_language_header = false;
    std::vector<size_t> sizes;
    std::vector<std::vector<int64_t>> prefixes;
    std::vector<TranscriptUpdate> updates;
    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>& audio, const DecodeOptions& opts) -> DecodeResult {
          sizes.push_back(audio.size());
          prefixes.push_back(opts.prefix_tokens);
          DecodeResult r;
          r.text = "short-ok";
          return r;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });
    pipe.push_samples(std::vector<float>(4000, 0.05f));
    pipe.request_stop(false, true);
    pipe.run_loop();
    EXPECT_EQ(sizes.size(), size_t{1});
    EXPECT_EQ(sizes[0], size_t{4000});
    EXPECT_TRUE(prefixes[0].empty());
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "short-ok");
  }

  // 8. Pause-split rollover before stop leaves active_segment_ empty (new_count == 0): zero extra decode on stop
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 1600;
    cfg.step_stride_samples = 1600;
    cfg.max_segment_samples = 4000;
    cfg.min_final_samples = 100;
    cfg.expect_language_header = false;
    std::atomic<int> decode_calls{0};
    std::vector<TranscriptUpdate> updates;
    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          ++decode_calls;
          DecodeResult r;
          r.text = "first-clause";
          return r;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });

    // Speech >= 0.8s (3200 samples >= 1600) followed by >1.0s pause (16000 zero samples) triggers pause-split rollover
    // when active_text is non-empty!
    std::thread th([&]() { pipe.run_loop(); });
    pipe.push_samples(std::vector<float>(3200, 0.1f));
    while (decode_calls.load() < 1) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    pipe.push_samples(std::vector<float>(20000, 0.0f));
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
    pipe.request_stop(false, true);
    th.join();
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "first-clause");
  }

  // 9. P0 counterexample: trusted active_text + undecoded pure-zero trailing silence (< stride) on stop
  //    MUST skip extra decode and preserve full active_text (even if mock would truncate or blank it),
  //    while non-empty committed_text + empty final result on real new speech preserves both segments.
  {
    StreamingPipelineConfig cfg;
    cfg.initial_stride_samples = 12800;
    cfg.step_stride_samples = 12800;
    cfg.max_segment_samples = 216000;
    cfg.min_final_samples = 1600;
    cfg.expect_language_header = false;

    std::atomic<int> decode_calls{0};
    std::vector<TranscriptUpdate> updates;
    Qwen3StreamingPipeline pipe(
        cfg,
        tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          const int c = ++decode_calls;
          DecodeResult r;
          r.text = (c == 1) ? "keep every word" : "keep";
          r.raw_tokens = {100, 101, 102, 103, 104, 105};
          return r;
        },
        [&](const TranscriptUpdate& u) { updates.push_back(u); });

    std::thread th([&]() { pipe.run_loop(); });
    pipe.push_samples(std::vector<float>(12800, 0.2f));
    while (decode_calls.load() < 1) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    pipe.push_samples(std::vector<float>(3200, 0.0f));  // < step_stride trailing zeros only
    pipe.request_stop(false, true);
    th.join();

    EXPECT_EQ(decode_calls.load(), 1);
    EXPECT_TRUE(!updates.empty() && updates.back().is_final);
    EXPECT_EQ(updates.back().text, "keep every word");

    // 9b: non-empty committed_text + trusted active_text + trailing silence OR empty final result -> both segments kept
    StreamingPipelineConfig cfg_b;
    cfg_b.initial_stride_samples = 2000;
    cfg_b.step_stride_samples = 2000;
    cfg_b.max_segment_samples = 4000;
    cfg_b.min_final_samples = 100;
    cfg_b.expect_language_header = false;
    std::atomic<int> calls_b{0};
    std::vector<TranscriptUpdate> updates_b;
    Qwen3StreamingPipeline pipe_b(
        cfg_b,
        tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          const int c = ++calls_b;
          DecodeResult r;
          if (c == 1) r.text = "first part";
          else if (c == 2) r.text = "keep every word";
          else r.text = "";  // empty final result on real new speech must still keep active_text
          r.raw_tokens = {100, 101, 102, 103, 104, 105};
          return r;
        },
        [&](const TranscriptUpdate& u) { updates_b.push_back(u); });

    std::thread th_b([&]() { pipe_b.run_loop(); });
    pipe_b.push_samples(std::vector<float>(6000, 0.2f));
    while (calls_b.load() < 2) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    pipe_b.push_samples(std::vector<float>(500, 0.2f));  // < step_stride real new speech
    pipe_b.request_stop(false, true);
    th_b.join();

    EXPECT_EQ(calls_b.load(), 3);
    EXPECT_TRUE(!updates_b.empty() && updates_b.back().is_final);
    EXPECT_EQ(updates_b.back().text, "first part keep every word");
  }
}

void test_trim_audio_features_unit() {
  // float32: 2 non-zero frames followed by 3 near-zero frames (<= 1e-6f)
  std::vector<float> f32(5 * 4, 0.0f);
  f32[0 * 4 + 2] = 0.01f;
  f32[1 * 4 + 3] = -2e-6f;
  f32[2 * 4 + 0] = 5e-7f;  // below 1e-6
  EXPECT_EQ(Qwen3OnnxEngine::trim_audio_features_f32(f32.data(), 5, 4, 1e-6f), 2);

  std::vector<float> f32_zero(4 * 4, 5e-7f);
  EXPECT_EQ(Qwen3OnnxEngine::trim_audio_features_f32(f32_zero.data(), 4, 4, 1e-6f), 0);

  // float16: 0x3C00 = 1.0, 0x0000 = 0.0
  std::vector<uint16_t> f16 = {
      0x3C00, 0x0000,
      0x0000, 0x0000,
      0x0000, 0x0000,
  };
  EXPECT_EQ(Qwen3OnnxEngine::trim_audio_features_f16(f16.data(), 3, 2, 1e-6f), 1);
  std::vector<uint16_t> f16_zero(6, 0x0000);
  EXPECT_EQ(Qwen3OnnxEngine::trim_audio_features_f16(f16_zero.data(), 3, 2, 1e-6f), 0);
}

void test_real_ort_engine_fixtures() {
#ifdef IMCODES_HAS_ONNXRUNTIME
  const std::filesystem::path base_tmp =
      std::filesystem::temp_directory_path() / "imcodes_qwen3_onnx_unit_fixture";
  std::error_code ec;
  std::filesystem::remove_all(base_tmp, ec);

  auto make_logits_table = [](int64_t vocab, const std::vector<std::pair<int64_t, int64_t>>& transitions,
                              int64_t default_tok, float default_second_score = 5.0f,
                              int64_t default_second_tok = 12) {
    std::vector<float> tbl(static_cast<size_t>(vocab * vocab), -10.0f);
    for (int64_t row = 0; row < vocab; ++row) {
      tbl[static_cast<size_t>(row * vocab + default_second_tok)] = default_second_score;
      tbl[static_cast<size_t>(row * vocab + default_tok)] = 10.0f;
    }
    for (const auto& kv : transitions) {
      const int64_t from = kv.first;
      const int64_t to = kv.second;
      for (int64_t c = 0; c < vocab; ++c) {
        tbl[static_cast<size_t>(from * vocab + c)] = -10.0f;
      }
      tbl[static_cast<size_t>(from * vocab + default_second_tok)] = default_second_score;
      tbl[static_cast<size_t>(from * vocab + to)] = 10.0f;
    }
    return tbl;
  };

  // Fixture 1: Fixed KV dim1 = 32 with EngineConfig::max_total_len = 24,
  // TrimAudioFeatures (2 active + 4 zero tail frames),
  // incomplete trailing UTF-8 dropped in visible text, and cancellation + next utterance recovery!
  {
    const std::filesystem::path dir = base_tmp / "fixed_kv";
    EXPECT_TRUE(test_onnx::write_minimal_tokenizer_files(dir / "tokenizer"));
    // Non-zero head frames (0,1) + zero tail frames (2,3,4,5) -> TrimAudioFeatures leaves 2 frames!
    std::vector<float> enc_data(6 * 4, 0.0f);
    enc_data[0 * 4 + 0] = 0.5f;
    enc_data[1 * 4 + 1] = 0.5f;
    EXPECT_TRUE(test_onnx::write_const_conv_frontend(dir / "conv_frontend.onnx", 6, 4));
    EXPECT_TRUE(test_onnx::write_const_encoder(dir / "encoder.int8.onnx", enc_data, 6, 4));

    // Vocab=19: 3=EOS, 4=<asr_text>, 12="hello", 15=partial_utf8(0xE4 0xB8), 17="world"
    auto tbl = make_logits_table(
        19,
        {{4, 12}, {12, 15}, {15, 3}, {17, 17}},
        3,
        4.0f,
        17);
    EXPECT_TRUE(test_onnx::write_tiny_decoder(dir / "decoder.int8.onnx", tbl, 19, 4, 2, 4, 32));

    Qwen3OnnxEngine eng;
    EngineConfig cfg;
    cfg.model_dir = dir;
    cfg.requested_provider = "cpu";
    cfg.max_total_len = 24;  // strictly smaller than fixed kv dim1=32!
    std::string err;
    EXPECT_TRUE(eng.init(cfg, err));
    EXPECT_EQ(eng.kv_physical_len(), 32);
    EXPECT_EQ(eng.max_total_len(), 24);

    // Silence PCM short-circuits BEFORE conv/encoder/decoder even with hotwords!
    {
      DecodeOptions silent_opts;
      silent_opts.hotwords_context = "world";
      auto sres = eng.decode(std::vector<float>(3200, 0.0f), silent_opts);
      EXPECT_EQ(sres.prefill_len, 0);
      EXPECT_EQ(sres.generated_steps, 0);
      EXPECT_EQ(sres.text, "");
    }

    // Voiced PCM: TrimAudioFeatures trims 6->2 frames, incomplete UTF-8 (15) dropped from visible text,
    // while raw_tokens & tokenizer.decode() retain diagnostic U+FFFD!
    std::vector<float> voiced(6400, 0.05f);
    int expected_prefill = 0;
    {
      DecodeOptions opts;
      opts.language = "en";  // prompt ends at <asr_text>=4
      auto res = eng.decode(voiced, opts);
      EXPECT_EQ(res.error, "");
      EXPECT_EQ(res.generated_steps, 2);  // token 12 ("hello"), token 15 (partial UTF-8) -> EOS
      EXPECT_EQ(res.text, "hello");
      EXPECT_TRUE(res.text.find("\xEF\xBF\xBD") == std::string::npos);
      EXPECT_EQ(res.raw_tokens, (std::vector<int64_t>{12, 15}));
      EXPECT_TRUE(eng.tokenizer().decode(res.raw_tokens, true).find("\xEF\xBF\xBD") != std::string::npos);
      expected_prefill = res.prefill_len;
      EXPECT_TRUE(expected_prefill > 0 && expected_prefill < 24);
    }

    // Same encoder with TrimAudioFeatures verification against un-trimmed 6 frames:
    // Base prompt (9 before + 9 after) + 2 trimmed audio_pad frames = 20 (< 24 if untrimmed).
    EXPECT_EQ(expected_prefill, 20);

    {
      // Cancel at prefill step -> cancelled=true, generated_steps=0
      DecodeOptions copts;
      copts.language = "en";
      std::atomic<int> cancel_polls{0};
      copts.should_cancel = [&]() {
        return ++cancel_polls >= 4;  // after prefill, before step 1
      };
      auto cres = eng.decode(voiced, copts);
      EXPECT_TRUE(cres.cancelled);
      EXPECT_EQ(cres.generated_steps, 0);

      // Cancel mid-loop after 1 generated step -> cancelled=true, generated_steps=1, no extra step
      DecodeOptions step_copts;
      step_copts.language = "en";
      std::atomic<int> step_polls{0};
      step_copts.should_cancel = [&]() {
        return ++step_polls >= 6;  // 1..4 pass, step 1 generated (=1 step), next iteration cancels
      };
      auto scres = eng.decode(voiced, step_copts);
      EXPECT_TRUE(scres.cancelled);
      EXPECT_EQ(scres.generated_steps, 1);

      // Next decode runs cleanly with no leftover state
      DecodeOptions ok_opts;
      ok_opts.language = "en";
      auto nres = eng.decode(voiced, ok_opts);
      EXPECT_TRUE(!nres.cancelled);
      EXPECT_EQ(nres.text, "hello");
    }
  }

  // Fixture 2: Unconditional EOS logits on prefill (prefix vs empty-prefix fallback) & All-Zero Encoder
  {
    const std::filesystem::path dir = base_tmp / "eos_and_zero_enc";
    EXPECT_TRUE(test_onnx::write_minimal_tokenizer_files(dir / "tokenizer"));
    // First subtest: encoder returns ALL zeros -> decoder must NEVER run (prefill_len == 0)!
    std::vector<float> zero_enc(4 * 4, 0.0f);
    EXPECT_TRUE(test_onnx::write_const_conv_frontend(dir / "conv_frontend.onnx", 4, 4));
    EXPECT_TRUE(test_onnx::write_const_encoder(dir / "encoder.int8.onnx", zero_enc, 4, 4));
    auto eos_tbl = make_logits_table(19, {}, 3, 5.0f, 12);  // argmax=3(EOS), 2nd=12("hello")
    EXPECT_TRUE(test_onnx::write_tiny_decoder(dir / "decoder.int8.onnx", eos_tbl, 19, 4, 2, 4, -1));

    Qwen3OnnxEngine zeng;
    EngineConfig zcfg;
    zcfg.model_dir = dir;
    zcfg.requested_provider = "cpu";
    std::string err;
    EXPECT_TRUE(zeng.init(zcfg, err));
    DecodeOptions opts;
    opts.language = "en";
    opts.hotwords_context = "world";
    auto zres = zeng.decode(std::vector<float>(3200, 0.05f), opts);
    EXPECT_EQ(zres.error, "");
    EXPECT_EQ(zres.prefill_len, 0);
    EXPECT_EQ(zres.generated_steps, 0);
    EXPECT_EQ(zres.text, "");

    // Second subtest: non-zero encoder + unconditional EOS logits (argmax=EOS, 2nd=12="hello"):
    // - With non-empty prefix_tokens -> stops cleanly on prefill EOS (`generated_steps == 0`), preserves prefix text!
    // - With empty prefix_tokens -> fallback selects 2nd best (12="hello") and runs decode loop (`generated_steps >= 1`)!
    std::vector<float> active_enc(4 * 4, 0.25f);
    EXPECT_TRUE(test_onnx::write_const_encoder(dir / "encoder.int8.onnx", active_enc, 4, 4));
    Qwen3OnnxEngine eeng;
    EXPECT_TRUE(eeng.init(zcfg, err));

    std::vector<float> voiced(3200, 0.05f);
    {
      DecodeOptions popts;
      popts.language = "en";
      popts.prefix_tokens = {17};  // "world"
      auto pres = eeng.decode(voiced, popts);
      EXPECT_EQ(pres.error, "");
      EXPECT_EQ(pres.generated_steps, 0);
      EXPECT_EQ(pres.text, "world");
    }
    {
      DecodeOptions eopts;
      eopts.language = "en";
      eopts.max_new_tokens = 2;
      auto eres = eeng.decode(voiced, eopts);
      EXPECT_EQ(eres.error, "");
      EXPECT_EQ(eres.generated_steps, 1);
      EXPECT_EQ(eres.text, "hello");
    }
    // Provider fallback smoke: requesting auto or GPU EPs initializes cleanly (DML/CUDA or CPU fallback)
    {
      for (const std::string& req : {std::string("auto"), std::string("directml"), std::string("cuda")}) {
        Qwen3OnnxEngine peng;
        EngineConfig pcfg;
        pcfg.model_dir = dir;
        pcfg.requested_provider = req;
        std::string perr;
        EXPECT_TRUE(peng.init(pcfg, perr));
        EXPECT_TRUE(!peng.active_provider().empty());
        DecodeOptions dopts;
        dopts.language = "en";
        dopts.max_new_tokens = 2;
        auto dres = peng.decode(voiced, dopts);
        EXPECT_EQ(dres.error, "");
        EXPECT_EQ(dres.text, "hello");
      }
    }
  }

  std::filesystem::remove_all(base_tmp, ec);
#endif
}

void test_real_tokenizer_if_present() {
  const std::string env_dir = get_env_str("IMCODES_QWEN3_TEST_MODEL_DIR");
  if (env_dir.empty()) return;
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

  // Verify exact real Qwen2/Qwen3 token IDs under Unicode \p{L} + NFC rules
  EXPECT_EQ(tok.encode("f\xC3\xA1" "cil", false), (std::vector<int64_t>{69, 55604}));
  EXPECT_EQ(tok.encode("fa\xCC\x81" "cil", false), (std::vector<int64_t>{69, 55604}));

  const std::string sample =
      "IM.codes, f\xC3\xA1" "cil, caf\xC3\xA9, na\xC3\xAFve, 中文语音热词测试, hello world";
  const auto ids = tok.encode(sample, false);
  EXPECT_TRUE(!ids.empty());
  EXPECT_EQ(tok.decode(ids, false), sample);
  EXPECT_EQ(tok.decode_visible(ids, false), sample);
}

}  // namespace

int main() {
  test_feat_to_audio_tokens_len();
  test_mel_fft_matches_naive_dft_and_extracts_shape();
  test_tokenizer_utf8_and_bpe();
  test_guards_and_hotwords();
  test_prompt_clamping_bounds();
  test_streaming_pipeline_30s_and_guards();
  test_trim_audio_features_unit();
  test_real_ort_engine_fixtures();
  test_real_tokenizer_if_present();

  if (g_failures > 0) {
    std::cerr << g_failures << " test check(s) failed\n";
    return 1;
  }
  std::cout << "All qwen3_onnx_tests passed!\n";
  return 0;
}
