#include "speech_serve_common.hpp"
using namespace imcodes::speech;

#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <future>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

template <typename Pred>
void wait_until_or_fail(
    std::mutex& mu,
    std::condition_variable& cv,
    Pred&& pred,
    const char* label,
    std::chrono::milliseconds timeout = std::chrono::milliseconds(5000)) {
  std::unique_lock<std::mutex> lock(mu);
  if (!cv.wait_for(lock, timeout, std::forward<Pred>(pred))) {
    std::fprintf(stderr, "timed out waiting for %s\n", label);
    std::abort();
  }
}

std::string extract_json_bool_or_str(const std::string& line, const std::string& key) {
  const auto str_val = extract_json_string_field(line, key);
  if (str_val.has_value()) return *str_val;
  const std::string needle = "\"" + key + "\":";
  const auto pos = line.find(needle);
  if (pos == std::string::npos) return "";
  size_t cur = pos + needle.size();
  while (cur < line.size() && line[cur] == ' ') ++cur;
  size_t end = cur;
  while (end < line.size() && line[end] != ',' && line[end] != '}') ++end;
  return line.substr(cur, end - cur);
}

std::string encode_pcm16_b64(size_t samples_count, int16_t val) {
  static const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<uint8_t> bytes(samples_count * 2);
  for (size_t i = 0; i < samples_count; ++i) {
    bytes[i * 2] = static_cast<uint8_t>(val & 0xff);
    bytes[i * 2 + 1] = static_cast<uint8_t>((val >> 8) & 0xff);
  }
  std::string out;
  for (size_t i = 0; i < bytes.size(); i += 3) {
    uint32_t v = static_cast<uint32_t>(bytes[i]) << 16;
    if (i + 1 < bytes.size()) v |= static_cast<uint32_t>(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size()) v |= static_cast<uint32_t>(bytes[i + 2]);
    out.push_back(kB64[(v >> 18) & 63]);
    out.push_back(kB64[(v >> 12) & 63]);
    out.push_back(i + 1 < bytes.size() ? kB64[(v >> 6) & 63] : '=');
    out.push_back(i + 2 < bytes.size() ? kB64[v & 63] : '=');
  }
  return out;
}

}  // namespace

int main() {
  using imcodes::qwen3::DecodeOptions;
  using imcodes::qwen3::DecodeResult;
  using imcodes::qwen3::Qwen3StreamingPipeline;
  using imcodes::qwen3::Qwen3Tokenizer;
  using imcodes::qwen3::StreamingPipelineConfig;
  using imcodes::speech::extract_json_string_array_field;

  // 1. JSON parsing for dynamic hotwords, escaped strings, and null-safe fields
  {
    const std::string line =
        "{\"cmd\":\"start_pcm\",\"device\":null,\"locale\":\"zh-CN\",\"hotwords\":[\"OpenClaw\",\"Claude Code\",\"A\\\"B\"]}";
    assert(extract_json_string_field(line, "cmd") == "start_pcm");
    assert(!extract_json_string_field(line, "device").has_value());
    assert(extract_json_string_field(line, "locale") == "zh-CN");
    const auto hw = extract_json_string_array_field(line, "hotwords");
    assert(hw.size() == 3);
    assert(hw[0] == "OpenClaw");
    assert(hw[1] == "Claude Code");
    assert(hw[2] == "A\"B");

    const auto cli_json_hw = parse_cli_hotwords_arg("[\"IM.codes\",\"陈伟\",\"Foo, Bar\"]");
    assert(cli_json_hw.size() == 3);
    assert(cli_json_hw[0] == "IM.codes");
    assert(cli_json_hw[1] == "陈伟");
    assert(cli_json_hw[2] == "Foo, Bar");
    const auto cli_csv_hw = parse_cli_hotwords_arg("IM.codes, 陈伟");
    assert(cli_csv_hw.size() == 2);
    assert(cli_csv_hw[0] == "IM.codes");
    assert(cli_csv_hw[1] == "陈伟");
    assert(parse_cli_hotwords_arg("[]").empty());

    ServeStartParams p;
    p.locale = "zh-CN";
    p.hotwords = {"DynamicTerm", "OpenClaw"};
    const auto cfg = make_streaming_pipeline_config({"BaseTerm", "openclaw"}, p);
    assert(cfg.language == "Chinese");
    assert(cfg.expect_language_header == false);
    assert(cfg.hotword_terms.size() == 3);
    assert(cfg.hotword_terms[0] == "DynamicTerm");
    assert(cfg.hotword_terms[1] == "OpenClaw");
    assert(cfg.hotword_terms[2] == "BaseTerm");
  }

  // 2. ServeCommandLoop propagates dynamic hotwords, locale, unprefixed 30s redecode, and abort safety
  {
    std::vector<std::string> emitted;
    std::mutex gate_mu;
    std::condition_variable gate_cv;
    bool in_final_decode = false;
    bool release_final_decode = false;
    bool loop_finished = false;
    std::string captured_hotwords;
    std::string captured_language;
    Qwen3Tokenizer empty_tok;

    ServeCommandLoop loop(
        nullptr,
        [&](ServeStartParams params) {
          auto cfg = make_streaming_pipeline_config({"StaticTerm"}, params);
          return std::make_unique<PcmUtteranceDecoder>(
              cfg,
              empty_tok,
              [&](const std::vector<float>&, const DecodeOptions& opts) -> DecodeResult {
                {
                  std::lock_guard<std::mutex> lock(gate_mu);
                  captured_hotwords = opts.hotwords_context;
                  captured_language = opts.language;
                  in_final_decode = true;
                }
                gate_cv.notify_all();
                wait_until_or_fail(
                    gate_mu,
                    gate_cv,
                    [&]() { return release_final_decode; },
                    "final decode gate");
                DecodeResult res;
                res.text = "late-final-should-not-emit";
                return res;
              },
              [&](const std::string& line) {
                std::lock_guard<std::mutex> lock(gate_mu);
                emitted.push_back(line);
                if (extract_json_string_field(line, "type") == "end") {
                  loop_finished = true;
                  gate_cv.notify_all();
                }
              });
        });

    assert(loop.handle_line("{\"cmd\":\"start_pcm\",\"locale\":\"en-US\",\"hotwords\":[\"DynWin\"]}"));
    assert(loop.handle_line("{\"cmd\":\"pcm\",\"data\":\"" + encode_pcm16_b64(3200, 3000) + "\"}"));
    const auto t0 = std::chrono::steady_clock::now();
    assert(loop.handle_line("{\"cmd\":\"stop\"}"));
    assert((std::chrono::steady_clock::now() - t0) < std::chrono::milliseconds(500));

    wait_until_or_fail(gate_mu, gate_cv, [&]() { return in_final_decode; }, "enter final decode");
    assert(loop.handle_line("{\"cmd\":\"abort\"}"));

    {
      std::lock_guard<std::mutex> lock(gate_mu);
      release_final_decode = true;
    }
    gate_cv.notify_all();
    wait_until_or_fail(gate_mu, gate_cv, [&]() { return loop_finished; }, "end event");
    assert(!loop.handle_line("{\"cmd\":\"shutdown\"}"));

    assert(captured_hotwords == "DynWin, StaticTerm");
    assert(captured_language == "English");
    for (const auto& line : emitted) {
      assert(extract_json_bool_or_str(line, "isFinal") != "true");
    }
    assert(!emitted.empty() && extract_json_string_field(emitted.back(), "type") == "end");
  }

  // 3. <=30s multi-segment full unprefixed final decode replaces streaming segments cleanly
  {
    std::vector<std::string> emitted;
    std::vector<size_t> decode_sizes;
    std::vector<bool> saw_prefix;
    Qwen3Tokenizer empty_tok;
    StreamingPipelineConfig cfg;

    Qwen3StreamingPipeline pipeline(
        cfg,
        empty_tok,
        [&](const std::vector<float>& samples, const DecodeOptions& opts) -> DecodeResult {
          decode_sizes.push_back(samples.size());
          saw_prefix.push_back(!opts.prefix_tokens.empty());
          DecodeResult r;
          r.text = samples.size() == 250000 ? "full-250k-utterance" : "seg-one";
          r.raw_tokens = {1, 2, 3, 4, 5, 6, 7};
          return r;
        },
        [&](const imcodes::qwen3::TranscriptUpdate& upd) {
          emit_transcript_update([&](const std::string& l) { emitted.push_back(l); }, upd);
        },
        [&]() { emitted.push_back("{\"type\":\"end\"}"); });

    pipeline.preload(std::vector<float>(250000, 0.2f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    assert(!decode_sizes.empty() && decode_sizes.back() == 250000);
    assert(!saw_prefix.empty() && saw_prefix.back() == false);
    assert(extract_json_string_field(emitted[emitted.size() - 2], "text") == "full-250k-utterance");
    assert(extract_json_bool_or_str(emitted[emitted.size() - 2], "isFinal") == "true");
    assert(extract_json_string_field(emitted.back(), "type") == "end");
  }

  // 4. Unified Rule A / Rule B hotword hallucination stripping & NFKC matrix
  {
    using imcodes::qwen3::set_hotword_nfkc_normalizer_for_testing;
    using imcodes::qwen3::strip_voice_hotword_hallucination;
    const std::vector<std::string> terms{"IM.codes", "Claude Code", "Codex", "Claude", "Qwen"};
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。你答的对，就这么来。", terms) ==
           "你答的对，就这么来。");
    assert(strip_voice_hotword_hallucination("我们是桌面端，在乎那几十兆，不在乎的，我要的是速度。IM.codes，IM.codes。", terms) ==
           "我们是桌面端，在乎那几十兆，不在乎的，我要的是速度。");
    assert(strip_voice_hotword_hallucination("我要的是速度 IM.codes IM.codes", terms) == "我要的是速度");
    assert(strip_voice_hotword_hallucination("ＩＭ．ｃｏｄｅｓ，IM.codes。Café👍🏽，IM.codes，im.codes。", terms) == "Café👍🏽");
    assert(strip_voice_hotword_hallucination("IM.codes, Claude Code, Codex。开始工作", terms) == "开始工作");
    assert(strip_voice_hotword_hallucination("开始工作。IM.codes, Claude Code, Codex。", terms) == "开始工作。");
    assert(strip_voice_hotword_hallucination("IM.codes, Codex, IM.codes 都是我在用的工具", terms) ==
           "IM.codes, Codex, IM.codes 都是我在用的工具");
    assert(strip_voice_hotword_hallucination("Codex。IM.codes，IM.codes。你好", terms) ==
           "Codex。IM.codes，IM.codes。你好");
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。Codex。你好", terms) ==
           "Codex。你好");
    assert(strip_voice_hotword_hallucination("打开 Codex，IM.codes，IM.codes。", terms) == "打开 Codex");
    assert(strip_voice_hotword_hallucination("先看。Codex。IM.codes, Claude, Qwen。", terms) == "先看。Codex。");
    // Hangul Jamo + Latin NFC/NFD
    assert(strip_voice_hotword_hallucination("\xE1\x84\x80\xE1\x85\xA1, \xEA\xB0\x80", std::vector<std::string>{"\xEA\xB0\x80"}).empty());
    assert(strip_voice_hotword_hallucination("\xE1\x84\x80\xE1\x85\xA1, \xEA\xB0\x80\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"\xEA\xB0\x80"}) == "\xE4\xBD\xA0\xE5\xA5\xBD");
    assert(strip_voice_hotword_hallucination("Caf\xC3\xA9, Cafe\xCC\x81\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"Caf\xC3\xA9"}) == "\xE4\xBD\xA0\xE5\xA5\xBD");
    assert(strip_voice_hotword_hallucination("code\xCC\x81, code\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"code"}) == "code\xCC\x81, code\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD");
    // Cross-sentence Rule A & Unicode separator boundaries
    assert(strip_voice_hotword_hallucination("我常用 IM.codes。IM.codes", terms) == "我常用 IM.codes。IM.codes");
    assert(strip_voice_hotword_hallucination("我常用 IM.codes。IM.codes。", terms) == "我常用 IM.codes。IM.codes。");
    assert(strip_voice_hotword_hallucination("IM.codes。IM.codes 很好用。", terms) == "IM.codes。IM.codes 很好用。");
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。IM.codes 很好用。", terms) == "IM.codes 很好用。");
    assert(strip_voice_hotword_hallucination("我常用 IM.codes。IM.codes，IM.codes。", terms) == "我常用 IM.codes。");
    assert(strip_voice_hotword_hallucination("IM.codes。IM.codes。你好", terms) == "你好");
    assert(strip_voice_hotword_hallucination("你好。IM.codes。IM.codes。", terms) == "你好。");
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。👍🏽可以。", terms) == "👍🏽可以。");
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。〇也是一个数字。", terms) == "〇也是一个数字。");
    assert(strip_voice_hotword_hallucination("〇。IM.codes，IM.codes。", terms) == "〇。");
    // Whole-only guard keeps edges intact when merging committed cross-segment phrases
    assert(strip_voice_hotword_hallucination("我常用 IM.codes。IM.codes，IM.codes。", terms, false, true) ==
           "我常用 IM.codes。IM.codes，IM.codes。");
    assert(strip_voice_hotword_hallucination("IM.codes。IM.codes", terms, false, true).empty());
    // Production NFKC + Unicode lowercase (no normalizer override hook):
    // Kelvin sign U+212A, compatibility ligatures, extended combining marks, circled/fullwidth, Hangul Jamo.
    set_hotword_nfkc_normalizer_for_testing(nullptr);
    assert(strip_voice_hotword_hallucination("\xE2\x84\xAA, \xE2\x84\xAA\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"k"}) ==
           "\xE4\xBD\xA0\xE5\xA5\xBD");
    assert(strip_voice_hotword_hallucination("\xEF\xAC\x81le, file\xE3\x80\x82Hello", std::vector<std::string>{"file", "ff"}) ==
           "Hello");
    assert(strip_voice_hotword_hallucination("\xEF\xAC\x81le, \xEF\xAC\x80, \xEF\xAC\x83" "ce\xE3\x80\x82Hello", std::vector<std::string>{"file", "ff", "ffice"}) ==
           "Hello");
    assert(strip_voice_hotword_hallucination("\xEF\xAC\x81le, \xEF\xAC\x80\xE3\x80\x82Hello", std::vector<std::string>{"file", "ff"}) ==
           "\xEF\xAC\x81le, \xEF\xAC\x80\xE3\x80\x82Hello");
    assert(strip_voice_hotword_hallucination("o\xEF\xAC\x83" "ce, office\xE3\x80\x82\xE5\xBC\x80\xE5\xA7\x8B", std::vector<std::string>{"office"}) ==
           "\xE5\xBC\x80\xE5\xA7\x8B");
    assert(strip_voice_hotword_hallucination("C\xCC\x8C" "at, \xC4\x8D" "at\xE3\x80\x82Next", std::vector<std::string>{"\xC4\x8D" "at"}) ==
           "Next");
    assert(strip_voice_hotword_hallucination("\xE2\x91\xA0, 1\xE3\x80\x82Item", std::vector<std::string>{"1"}) ==
           "Item");
    assert(strip_voice_hotword_hallucination("\xE2\x84\xA6, \xCE\xA9\xE3\x80\x82Value", std::vector<std::string>{"\xCF\x89"}) ==
           "Value");
    // Unicode Final_Sigma contextual lowercasing without normalizer override:
    // U+039F U+03A3 ("ΟΣ") lowercases to U+03BF U+03C2 ("ος") word-finally, matching "ος, ος".
    assert(strip_voice_hotword_hallucination("\xCE\xBF\xCF\x82, \xCE\xBF\xCF\x82", std::vector<std::string>{"\xCE\x9F\xCE\xA3"}).empty());
    assert(strip_voice_hotword_hallucination("\xCE\x9F\xCE\xA3, \xCE\xBF\xCF\x82\xE3\x80\x82\xE5\xBC\x80\xE5\xA7\x8B", std::vector<std::string>{"\xCE\x9F\xCE\xA3"}) ==
           "\xE5\xBC\x80\xE5\xA7\x8B");
    assert(strip_voice_hotword_hallucination("\xCE\x9F\xE2\x80\x99\xCE\xA3, \xCE\xBF\xE2\x80\x99\xCF\x82", std::vector<std::string>{"\xCE\xBF\xE2\x80\x99\xCF\x82"}).empty());
    // Medial sigma ("σα") must still lowercase to medial U+03C3 rather than final U+03C2.
    assert(strip_voice_hotword_hallucination("\xCF\x83\xCE\xB1, \xCF\x83\xCE\xB1", std::vector<std::string>{"\xCE\xA3\xCE\x91"}).empty());
    assert(strip_voice_hotword_hallucination("\xCE\xBF\xCF\x82, \xCE\xBF\xCF\x83", std::vector<std::string>{"\xCE\x9F\xCE\xA3"}) ==
           "\xCE\xBF\xCF\x82, \xCE\xBF\xCF\x83");
    assert(strip_voice_hotword_hallucination("\xCE\xA3, \xCF\x83\xE3\x80\x82Next", std::vector<std::string>{"\xCE\xA3"}) ==
           "Next");
  }

  // 5. Silence-edge trimming & prefix-shift alignment + >30s cross-segment hotword retention/retraction
  {
    // 5a: Leading & trailing silence is trimmed cleanly before decode while keeping 250ms padding
    std::vector<float> padded_audio(48000, 0.0f);  // 3.0s
    for (size_t i = 24000; i < 25600; ++i) padded_audio[i] = 0.25f;  // 100ms speech at 1.5s..1.6s
    size_t trim_start = 999999;
    const auto trimmed = imcodes::qwen3::trim_silence_edges(padded_audio, 16000, 250, &trim_start);
    assert(trim_start == 24000 - 4000);
    assert(trimmed.size() == 1600 + 8000);

    // 5b: >cap cross-segment single hotword + real text -> "IM.codes保留这一句"
    std::vector<std::string> emitted_18a;
    int call_18a = 0;
    StreamingPipelineConfig cfg_18a;
    cfg_18a.max_segment_samples = 16000;
    cfg_18a.max_final_redecode_samples = 20000;
    cfg_18a.hotword_terms = {"IM.codes"};
    cfg_18a.expect_language_header = false;
    Qwen3Tokenizer empty_tok;
    Qwen3StreamingPipeline p18a(
        cfg_18a,
        empty_tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          ++call_18a;
          DecodeResult r;
          r.text = (call_18a == 1) ? "IM.codes" : "保留这一句";
          return r;
        },
        [&](const imcodes::qwen3::TranscriptUpdate& upd) {
          emit_transcript_update([&](const std::string& l) { emitted_18a.push_back(l); }, upd);
        });
    p18a.preload(std::vector<float>(24000, 0.2f));
    std::thread w18a([&]() { p18a.run_loop(); });
    p18a.request_stop(false, true);
    w18a.join();
    std::string final_18a;
    for (const auto& l : emitted_18a) {
      if (extract_json_bool_or_str(l, "isFinal") == "true") {
        final_18a = extract_json_string_field(l, "text").value_or("");
      }
    }
    assert(final_18a == "IM.codes保留这一句");

    // 5c: >cap cross-segment pure single-hotword repeats -> ""
    std::vector<std::string> emitted_18d;
    Qwen3StreamingPipeline p18d(
        cfg_18a,
        empty_tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          DecodeResult r;
          r.text = "IM.codes";
          return r;
        },
        [&](const imcodes::qwen3::TranscriptUpdate& upd) {
          emit_transcript_update([&](const std::string& l) { emitted_18d.push_back(l); }, upd);
        });
    p18d.preload(std::vector<float>(24000, 0.2f));
    std::thread w18d([&]() { p18d.run_loop(); });
    p18d.request_stop(false, true);
    w18d.join();
    std::string final_18d = "UNSET";
    for (const auto& l : emitted_18d) {
      if (extract_json_bool_or_str(l, "isFinal") == "true") {
        final_18d = extract_json_string_field(l, "text").value_or("UNSET");
      }
    }
    assert(final_18d.empty());

    // 5d: >cap real prior sentence ending with single hotword + trailing single hotword stays intact
    std::vector<std::string> emitted_18f;
    int call_18f = 0;
    Qwen3StreamingPipeline p18f(
        cfg_18a,
        empty_tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          ++call_18f;
          DecodeResult r;
          r.text = (call_18f == 1) ? "我常用 IM.codes。" : "IM.codes";
          return r;
        },
        [&](const imcodes::qwen3::TranscriptUpdate& upd) {
          emit_transcript_update([&](const std::string& l) { emitted_18f.push_back(l); }, upd);
        });
    p18f.preload(std::vector<float>(24000, 0.2f));
    std::thread w18f([&]() { p18f.run_loop(); });
    p18f.request_stop(false, true);
    w18f.join();
    std::string final_18f;
    for (const auto& l : emitted_18f) {
      if (extract_json_bool_or_str(l, "isFinal") == "true") {
        final_18f = extract_json_string_field(l, "text").value_or("");
      }
    }
    assert(final_18f == "我常用 IM.codes。IM.codes");

    // 5e: Pure sub-threshold noise across >cap skips decode_fn completely and emits ""
    int noise_calls = 0;
    std::vector<std::string> emitted_18c;
    Qwen3StreamingPipeline p18c(
        cfg_18a,
        empty_tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          ++noise_calls;
          DecodeResult r;
          r.text = "IM.codes";
          return r;
        },
        [&](const imcodes::qwen3::TranscriptUpdate& upd) {
          emit_transcript_update([&](const std::string& l) { emitted_18c.push_back(l); }, upd);
        });
    p18c.preload(std::vector<float>(24000, 0.002f));
    std::thread w18c([&]() { p18c.run_loop(); });
    p18c.request_stop(false, true);
    w18c.join();
    assert(noise_calls == 0);
    std::string final_18c = "UNSET";
    for (const auto& l : emitted_18c) {
      if (extract_json_bool_or_str(l, "isFinal") == "true") {
        final_18c = extract_json_string_field(l, "text").value_or("UNSET");
      }
    }
    assert(final_18c.empty());

    // 5f: >cap incremental retraction across segments never resurrects retracted hotwords
    std::vector<std::string> emitted_18b;
    std::mutex mu_b;
    std::condition_variable cv_b;
    int pass_b = 0;
    StreamingPipelineConfig cfg_18b;
    cfg_18b.initial_stride_samples = 12800;
    cfg_18b.step_stride_samples = 12800;
    cfg_18b.max_segment_samples = 32000;
    cfg_18b.max_final_redecode_samples = 40000;
    cfg_18b.hotword_terms = {"IM.codes"};
    cfg_18b.expect_language_header = false;
    Qwen3StreamingPipeline p18b(
        cfg_18b,
        empty_tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          int p = 0;
          {
            std::lock_guard<std::mutex> lock(mu_b);
            p = ++pass_b;
          }
          cv_b.notify_all();
          DecodeResult r;
          if (p == 1) r.text = "先看";
          else if (p == 2) r.text = "IM.codes";
          else if (p == 3) r.text = "IM.codes，IM.codes。";
          else r.text = "IM.codes";
          return r;
        },
        [&](const imcodes::qwen3::TranscriptUpdate& upd) {
          std::lock_guard<std::mutex> lock(mu_b);
          emit_transcript_update([&](const std::string& l) { emitted_18b.push_back(l); }, upd);
        });
    std::thread w18b([&]() { p18b.run_loop(); });
    p18b.push_samples(std::vector<float>(32000, 0.2f));
    wait_until_or_fail(mu_b, cv_b, [&]() { return pass_b >= 1; }, "18b seg 1");
    p18b.push_samples(std::vector<float>(12800, 0.2f));
    wait_until_or_fail(mu_b, cv_b, [&]() { return pass_b >= 2; }, "18b seg 2a");
    p18b.push_samples(std::vector<float>(12800, 0.2f));
    wait_until_or_fail(mu_b, cv_b, [&]() { return pass_b >= 3; }, "18b seg 2b retract");
    p18b.request_stop(false, true);
    w18b.join();
    std::string final_18b;
    for (const auto& l : emitted_18b) {
      if (extract_json_bool_or_str(l, "isFinal") == "true") {
        final_18b = extract_json_string_field(l, "text").value_or("");
      }
    }
    assert(final_18b == "先看");
  }

  // 6. Fatal producer disconnect finalizes once and emits exactly one end event without external stop
  {
    std::vector<std::string> emitted_disconnect;
    Qwen3Tokenizer empty_tok;
    StreamingPipelineConfig cfg_disc;
    cfg_disc.expect_language_header = false;
    Qwen3StreamingPipeline p_disc(
        cfg_disc,
        empty_tok,
        [&](const std::vector<float>&, const DecodeOptions&) -> DecodeResult {
          DecodeResult r;
          r.text = "disconnected-tail-text";
          r.raw_tokens = {1, 2, 3};
          return r;
        },
        [&](const imcodes::qwen3::TranscriptUpdate& upd) {
          emit_transcript_update([&](const std::string& l) { emitted_disconnect.push_back(l); }, upd);
        },
        [&]() { emitted_disconnect.push_back("{\"type\":\"end\"}"); });

    std::thread w_disc([&]() { p_disc.run_loop(); });
    p_disc.push_samples(std::vector<float>(16000, 0.25f));
    p_disc.request_stop(false, true);
    w_disc.join();

    int final_count = 0;
    int end_count = 0;
    std::string final_text;
    for (const auto& l : emitted_disconnect) {
      if (extract_json_bool_or_str(l, "isFinal") == "true") {
        ++final_count;
        final_text = extract_json_string_field(l, "text").value_or("");
      }
      if (extract_json_string_field(l, "type") == "end") {
        ++end_count;
      }
    }
    assert(final_count == 1);
    assert(final_text == "disconnected-tail-text");
    assert(end_count == 1);
    assert(extract_json_string_field(emitted_disconnect.back(), "type") == "end");
  }

  // 7. Early stop vs abort before/during blocked device open preserves or discards prefill_pcm cleanly
  {
    struct ControlledOpenSession final : public ActiveServeSessionHandle {
      ControlledOpenSession(
          ServeStartParams params,
          const Qwen3Tokenizer& tok,
          std::vector<std::string>& out_events,
          std::mutex& out_mu,
          bool block_open,
          bool& open_called_out,
          size_t& decoded_samples_out)
          : initial_samples_(std::move(params.initial_samples)),
            out_events_(out_events),
            out_mu_(out_mu),
            block_open_(block_open),
            open_called_out_(open_called_out),
            decoded_samples_out_(decoded_samples_out),
            pipeline_(
                []() {
                  StreamingPipelineConfig cfg;
                  cfg.expect_language_header = false;
                  return cfg;
                }(),
                tok,
                [&](const std::vector<float>& samples, const DecodeOptions&) -> DecodeResult {
                  decoded_samples_out_ = samples.size();
                  DecodeResult r;
                  r.text = "prefill-preserved-final";
                  r.raw_tokens = {1, 2};
                  return r;
                },
                [&](const imcodes::qwen3::TranscriptUpdate& upd) {
                  emit_transcript_update(
                      [&](const std::string& l) {
                        std::lock_guard<std::mutex> lock(out_mu_);
                        out_events_.push_back(l);
                      },
                      upd);
                },
                [&]() {
                  std::lock_guard<std::mutex> lock(out_mu_);
                  out_events_.push_back("{\"type\":\"end\"}");
                }) {}

      ~ControlledOpenSession() override {
        request_stop(true);
        wait_for_finish();
      }

      void start() override {
        worker_ = std::thread([this]() {
          auto emit = [&](const std::string& l) {
            std::lock_guard<std::mutex> lock(out_mu_);
            out_events_.push_back(l);
          };
          if (aborted_.load() || stop_requested_.load()) {
            drain_prefill_or_end(aborted_.load(), initial_samples_, pipeline_, emit);
            return;
          }
          open_called_out_ = true;
          if (block_open_) {
            {
              std::lock_guard<std::mutex> lock(open_mu_);
              in_open_ = true;
            }
            open_cv_.notify_all();
            std::unique_lock<std::mutex> lock(open_mu_);
            open_cv_.wait(lock, [&]() { return stop_requested_.load() || aborted_.load(); });
          }
          // Simulated open failure / interruption during open
          if (aborted_.load() || stop_requested_.load()) {
            drain_prefill_or_end(aborted_.load(), initial_samples_, pipeline_, emit);
            return;
          }
          emit("{\"type\":\"error\",\"code\":\"no_input_device\"}");
          emit("{\"type\":\"end\"}");
        });
      }

      void wait_in_open() {
        wait_until_or_fail(open_mu_, open_cv_, [&]() { return in_open_; }, "controlled open entry");
      }

      void request_stop(bool abort_only) override {
        if (abort_only) aborted_.store(true);
        stop_requested_.store(true);
        pipeline_.request_stop(abort_only, false);
        open_cv_.notify_all();
      }

      void wait_for_finish() override {
        if (worker_.joinable()) worker_.join();
      }

      std::vector<float> initial_samples_;
      std::vector<std::string>& out_events_;
      std::mutex& out_mu_;
      bool block_open_;
      bool& open_called_out_;
      size_t& decoded_samples_out_;
      Qwen3StreamingPipeline pipeline_;
      std::atomic<bool> stop_requested_{false};
      std::atomic<bool> aborted_{false};
      std::mutex open_mu_;
      std::condition_variable open_cv_;
      bool in_open_{false};
      std::thread worker_;
    };

    Qwen3Tokenizer empty_tok;
    // Construct 4000-sample (0.25s @ 16kHz) non-zero PCM16 base64 chunk: 8000 bytes -> base64
    const std::string prefill_b64 = std::string(10668, 'A');  // 8001 bytes -> 8000 bytes aligned zero PCM

    // 7a: Blocked open interrupted by normal `stop` preserves prefill_pcm -> start + final + end, no no_input_device
    {
      std::vector<std::string> evs;
      std::mutex ev_mu;
      bool open_called = false;
      size_t decoded_samples = 0;
      ControlledOpenSession* raw_sess = nullptr;
      ServeCommandLoop loop(
          [&](ServeStartParams params) -> std::unique_ptr<ActiveServeSessionHandle> {
            auto s = std::make_unique<ControlledOpenSession>(
                std::move(params), empty_tok, evs, ev_mu, true, open_called, decoded_samples);
            raw_sess = s.get();
            return s;
          },
          {});
      assert(loop.handle_line("{\"cmd\":\"prefill_reset\"}"));
      assert(loop.handle_line("{\"cmd\":\"prefill_pcm\",\"data\":\"" + prefill_b64 + "\"}"));
      assert(loop.handle_line("{\"cmd\":\"start\"}"));
      raw_sess->wait_in_open();
      assert(loop.handle_line("{\"cmd\":\"stop\"}"));
      assert(!loop.handle_line("{\"cmd\":\"shutdown\"}"));
      assert(open_called);
      assert(decoded_samples > 0);
      int start_count = 0, final_count = 0, end_count = 0, err_count = 0;
      std::string final_text;
      for (const auto& l : evs) {
        const auto t = extract_json_string_field(l, "type").value_or("");
        if (t == "start") ++start_count;
        if (t == "error") ++err_count;
        if (t == "end") ++end_count;
        if (extract_json_bool_or_str(l, "isFinal") == "true") {
          ++final_count;
          final_text = extract_json_string_field(l, "text").value_or("");
        }
      }
      assert(err_count == 0);
      assert(start_count == 1);
      assert(final_count == 1);
      assert(final_text == "prefill-preserved-final");
      assert(end_count == 1);
    }

    // 7b: Blocked open interrupted by `abort` discards prefill_pcm -> end only, zero result/error/start
    {
      std::vector<std::string> evs;
      std::mutex ev_mu;
      bool open_called = false;
      size_t decoded_samples = 0;
      ControlledOpenSession* raw_sess = nullptr;
      ServeCommandLoop loop(
          [&](ServeStartParams params) -> std::unique_ptr<ActiveServeSessionHandle> {
            auto s = std::make_unique<ControlledOpenSession>(
                std::move(params), empty_tok, evs, ev_mu, true, open_called, decoded_samples);
            raw_sess = s.get();
            return s;
          },
          {});
      assert(loop.handle_line("{\"cmd\":\"prefill_reset\"}"));
      assert(loop.handle_line("{\"cmd\":\"prefill_pcm\",\"data\":\"" + prefill_b64 + "\"}"));
      assert(loop.handle_line("{\"cmd\":\"start\"}"));
      raw_sess->wait_in_open();
      assert(loop.handle_line("{\"cmd\":\"abort\"}"));
      assert(!loop.handle_line("{\"cmd\":\"shutdown\"}"));
      assert(open_called);
      assert(decoded_samples == 0);
      assert(evs.size() == 1);
      assert(extract_json_string_field(evs[0], "type") == "end");
    }

    // 7c: Pre-open normal stop skips open altogether while still finalizing prefill_pcm
    {
      std::vector<std::string> evs;
      std::mutex ev_mu;
      bool open_called = false;
      size_t decoded_samples = 0;
      ServeStartParams p;
      p.initial_samples = std::vector<float>(4000, 0.25f);
      ControlledOpenSession sess(std::move(p), empty_tok, evs, ev_mu, false, open_called, decoded_samples);
      sess.request_stop(false);
      sess.start();
      sess.wait_for_finish();
      assert(!open_called);
      assert(decoded_samples == 4000);
      assert(extract_json_string_field(evs.back(), "type") == "end");
    }

    // 7d: Pre-open normal stop with empty prefill emits only end and skips open
    {
      std::vector<std::string> evs;
      std::mutex ev_mu;
      bool open_called = false;
      size_t decoded_samples = 0;
      ControlledOpenSession sess(ServeStartParams{}, empty_tok, evs, ev_mu, false, open_called, decoded_samples);
      sess.request_stop(false);
      sess.start();
      sess.wait_for_finish();
      assert(!open_called);
      assert(decoded_samples == 0);
      assert(evs.size() == 1);
      assert(extract_json_string_field(evs[0], "type") == "end");
    }
  }

  std::printf("win speech pipeline tests passed\n");
  return 0;
}
