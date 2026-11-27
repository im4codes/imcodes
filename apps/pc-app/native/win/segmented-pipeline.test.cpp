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
    // Injectable NFKC hook
    set_hotword_nfkc_normalizer_for_testing([](const std::string& s) -> std::string {
      std::string out = s;
      const std::string kelvin = "\xE2\x84\xAA";
      size_t pos = 0;
      while ((pos = out.find(kelvin, pos)) != std::string::npos) {
        out.replace(pos, kelvin.size(), "k");
        pos += 1;
      }
      return out;
    });
    assert(strip_voice_hotword_hallucination("\xE2\x84\xAA, \xE2\x84\xAA\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"k"}) ==
           "\xE4\xBD\xA0\xE5\xA5\xBD");
    set_hotword_nfkc_normalizer_for_testing(nullptr);
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

  std::printf("win speech pipeline tests passed\n");
  return 0;
}
