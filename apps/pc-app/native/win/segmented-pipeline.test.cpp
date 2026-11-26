#define IMCODES_SPEECH_WIN_NO_MAIN 1
#include "imcodes-speech-win.cpp"

#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

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

std::vector<float> make_marked_pcm(size_t total_samples, float seg1_val, float seg2_val) {
  std::vector<float> pcm(total_samples, seg1_val);
  for (size_t i = kMaxSegmentSamples; i < total_samples; ++i) {
    pcm[i] = seg2_val;
  }
  return pcm;
}

std::string decode_by_marker(const std::vector<float>& samples) {
  if (samples.empty()) return "";
  // Distinguish segments unambiguously by first sample marker in each 13.5s chunk.
  const float marker = samples.front();
  if (marker < 0.35f) return "seg-one";
  return "seg-two";
}

}  // namespace

int main() {
  // 1. P0-4 counterexample: >216,000 samples (250,000 samples) prefilled + immediate normal stop(false)
  // Must decode both segments (216,000 + 34,000) and emit ONE isFinal=true containing both.
  {
    std::vector<std::string> emitted;
    std::mutex emit_mu;
    std::vector<size_t> decode_sizes;

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) {
          decode_sizes.push_back(samples.size());
          return decode_by_marker(samples);
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(emit_mu);
          emitted.push_back(line);
        });

    pipeline.preload(make_marked_pcm(250000, 0.2f, 0.8f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    assert(decode_sizes.size() == 2);
    assert(decode_sizes[0] == kMaxSegmentSamples);
    assert(decode_sizes[1] == 250000 - kMaxSegmentSamples);

    int final_count = 0;
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        ++final_count;
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_count == 1);
    assert(final_text == "seg-one seg-two");
    assert(!emitted.empty() && extract_json_string_field(emitted.back(), "type") == "end");
  }

  // 2. Exact kMaxSegmentSamples (216,000) + immediate normal stop(false) must emit ONE isFinal=true cleanly.
  {
    std::vector<std::string> emitted;
    std::vector<size_t> decode_sizes;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) {
          decode_sizes.push_back(samples.size());
          return decode_by_marker(samples);
        },
        [&](const std::string& line) { emitted.push_back(line); });

    pipeline.preload(make_marked_pcm(kMaxSegmentSamples, 0.2f, 0.8f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    assert(decode_sizes.size() == 1);
    assert(decode_sizes[0] == kMaxSegmentSamples);
    int final_count = 0;
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        ++final_count;
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_count == 1);
    assert(final_text == "seg-one");
  }

  // 3. Producer stays active (WASAPI mode) while prefill decodes, then pushes live tail and stops.
  {
    std::vector<std::string> emitted;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [](const std::vector<float>& samples) { return decode_by_marker(samples); },
        [&](const std::string& line) { emitted.push_back(line); });

    pipeline.preload(std::vector<float>(kMaxSegmentSamples, 0.2f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.push(std::vector<float>(4000, 0.8f));
    pipeline.request_stop(false, false);
    // Live producer finishes last drain after stop was requested.
    pipeline.mark_producer_finished();
    worker.join();

    int final_count = 0;
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        ++final_count;
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_count == 1);
    assert(final_text == "seg-one seg-two");
  }

  // 4. P0-2 counterexample A: request_stop(false, false) happens before prefill/start finishes;
  // prefill must STILL be accepted and decoded completely once producer finishes.
  {
    std::vector<std::string> emitted;
    std::mutex emit_mu;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [](const std::vector<float>& samples) { return decode_by_marker(samples); },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(emit_mu);
          emitted.push_back(line);
        });

    pipeline.request_stop(false, false);
    pipeline.preload(make_marked_pcm(250000, 0.2f, 0.8f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.mark_producer_finished();
    worker.join();

    int final_count = 0;
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        ++final_count;
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_count == 1);
    assert(final_text == "seg-one seg-two");
  }

  // 5. P0-2 counterexample B: request_stop(false, false) fires while decode loop runs,
  // THEN trailing WASAPI packets are pushed BEFORE mark_producer_finished(); trailing samples
  // must STILL be accepted and appear in the single final result.
  {
    std::vector<std::string> emitted;
    std::mutex emit_mu;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [](const std::vector<float>& samples) { return decode_by_marker(samples); },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(emit_mu);
          emitted.push_back(line);
        });

    pipeline.preload(std::vector<float>(kMaxSegmentSamples, 0.2f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, false);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    pipeline.push(std::vector<float>(4000, 0.8f));
    pipeline.mark_producer_finished();
    worker.join();

    int final_count = 0;
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        ++final_count;
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_count == 1);
    assert(final_text == "seg-one seg-two");
  }

  // 6. Abort never emits isFinal=true even with >216,000 samples queued.
  {
    std::vector<std::string> emitted;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [](const std::vector<float>& samples) { return decode_by_marker(samples); },
        [&](const std::string& line) { emitted.push_back(line); });

    pipeline.preload(make_marked_pcm(250000, 0.2f, 0.8f));
    pipeline.request_stop(true, true);
    pipeline.run_loop();

    for (const auto& line : emitted) {
      assert(extract_json_bool_or_str(line, "isFinal") != "true");
    }
    assert(!emitted.empty() && extract_json_string_field(emitted.back(), "type") == "end");
  }

  // 7. Boundary decode at kMaxSegmentSamples returns empty or `language None<asr_text>` after
  // earlier partial produced "first-part": must preserve "first-part" into segment 2 and final.
  {
    std::vector<std::string> emitted;
    std::mutex emit_mu;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [](const std::vector<float>& samples) -> std::string {
          if (samples.front() >= 0.7f) return "second-part";
          if (samples.size() >= kMaxSegmentSamples) return "language None<asr_text>";
          return "first-part";
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(emit_mu);
          emitted.push_back(line);
        });

    std::thread worker([&]() { pipeline.run_loop(); });
    // Push in partial steps so active_segment_text captures "first-part" before hitting 216k.
    for (size_t pushed = 0; pushed < kMaxSegmentSamples; pushed += 16000) {
      const size_t chunk = std::min<size_t>(16000, kMaxSegmentSamples - pushed);
      pipeline.push(std::vector<float>(chunk, 0.2f));
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    pipeline.push(std::vector<float>(16000, 0.8f));
    pipeline.request_stop(false, true);
    worker.join();

    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_text == "first-part second-part");
  }

  // 8. Mid-segment partial returns empty / `language None<asr_text>` after earlier partial "hello":
  // must NOT overwrite screen with empty text, and stop with short/empty tail preserves "hello".
  {
    std::vector<std::string> emitted;
    std::mutex emit_mu;
    int call_count = 0;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>&) -> std::string {
          ++call_count;
          if (call_count == 1) return "language English<asr_text>hello";
          return "language None<asr_text>";
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(emit_mu);
          emitted.push_back(line);
        });

    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.push(std::vector<float>(kInitialPartialSamples, 0.2f));
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
    pipeline.push(std::vector<float>(kStepPartialSamples, 0.2f));
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
    pipeline.request_stop(false, true);
    worker.join();

    std::vector<std::string> partial_texts;
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") != "result") continue;
      const auto txt = extract_json_string_field(line, "text").value_or("");
      if (extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = txt;
      } else {
        partial_texts.push_back(txt);
      }
    }
    assert(!partial_texts.empty());
    for (const auto& p : partial_texts) {
      assert(!p.empty());
      assert(p == "hello");
    }
    assert(final_text == "hello");
  }

  // 9. Control-tag stripping and CJK vs ASCII segment joining.
  {
    assert(strip_asr_control_tags("language None<asr_text>").empty());
    assert(strip_asr_control_tags("language\nNone<asr_text>").empty());
    assert(strip_asr_control_tags("language\r\nNone<asr_text>").empty());
    assert(strip_asr_control_tags("language\t\n  None\r\n<asr_text>").empty());
    assert(strip_asr_control_tags("language Chinese<asr_text>第一段检查。") == "第一段检查。");
    assert(strip_asr_control_tags("language\nChinese<asr_text>前文") == "前文");
    assert(strip_asr_control_tags("language\r\nChinese<asr_text>前文") == "前文");
    assert(strip_asr_control_tags("Whiskey 五百五十。 language None<asr_text>十五x ray") ==
           "Whiskey 五百五十。 十五x ray");
    assert(strip_asr_control_tags("<|endoftext|>hello<asr_text><|zh|>") == "hello");
    assert(strip_asr_control_tags("the language model is fast") == "the language model is fast");
    assert(strip_asr_control_tags("the language\nmodel is fast") == "the language\nmodel is fast");
    assert(strip_asr_control_tags("language None is just words") == "language None is just words");
    assert(sanitize_asr_repetition_loop("language None<asr_text>").empty());
    assert(sanitize_asr_repetition_loop("language\nNone<asr_text>").empty());
    assert(sanitize_asr_repetition_loop("language\r\nNone<asr_text>").empty());

    assert(join_transcript_segments("第一段。", "第二段。") == "第一段。第二段。");
    assert(join_transcript_segments("第一段", "第二段") == "第一段第二段");
    assert(join_transcript_segments("seg-one", "seg-two") == "seg-one seg-two");
  }

  // 10. Natural pause-split (>= 6.0s speech + >= 400ms silence) splits before 13.5s,
  // joins 3+ segments monotonically without bogus spaces between Chinese segments, and ignores pure silence.
  {
    std::vector<std::string> emitted;
    std::vector<size_t> decode_sizes;
    std::vector<float> pcm;
    // Seg 1: 6.0s speech (0.2f) + 400ms silence (0.0f) -> 102,400 samples (< 216,000)
    pcm.insert(pcm.end(), kMinPauseSplitSamples, 0.2f);
    pcm.insert(pcm.end(), kPauseWindowSamples, 0.0f);
    // Seg 2: 6.0s speech (0.5f) + 400ms silence (0.0f) -> 102,400 samples
    pcm.insert(pcm.end(), kMinPauseSplitSamples, 0.5f);
    pcm.insert(pcm.end(), kPauseWindowSamples, 0.0f);
    // Seg 3: 1.5s speech (0.8f) -> 24,000 samples
    pcm.insert(pcm.end(), 24000, 0.8f);

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) -> std::string {
          decode_sizes.push_back(samples.size());
          const float first = samples.front();
          if (first < 0.35f) return "language Chinese<asr_text>第一段。";
          if (first < 0.65f) return "language Chinese<asr_text>第二段。";
          return "language Chinese<asr_text>第三段。";
        },
        [&](const std::string& line) { emitted.push_back(line); });

    pipeline.preload(pcm);
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    assert(decode_sizes.size() == 3);
    assert(decode_sizes[0] == kMinPauseSplitSamples + kPauseWindowSamples);
    assert(decode_sizes[1] == kMinPauseSplitSamples + kPauseWindowSamples);
    assert(decode_sizes[2] == 24000);

    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_text == "第一段。第二段。第三段。");
  }

  // 11. Pure silence (>= 6s of 0.0f) emits zero non-empty results and leaves final_text empty.
  {
    std::vector<std::string> emitted;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [](const std::vector<float>&) -> std::string { return ""; },
        [&](const std::string& line) { emitted.push_back(line); });

    pipeline.preload(std::vector<float>(kMinPauseSplitSamples + kPauseWindowSamples, 0.0f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") != "result") continue;
      assert(extract_json_string_field(line, "text").value_or("").empty());
      assert(extract_json_bool_or_str(line, "isFinal") == "true");
    }
  }

  // 12. Pipeline with newline/CRLF-separated `language\nNone<asr_text>` / `language\r\nNone<asr_text>`
  // must NOT retain `"language\nNone"` as active_segment_text.
  {
    std::vector<std::string> emitted;
    int call_count = 0;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>&) -> std::string {
          ++call_count;
          if (call_count == 1) return "language\nNone<asr_text>";
          if (call_count == 2) return "language\r\nNone<asr_text>";
          return "language\nChinese<asr_text>前文";
        },
        [&](const std::string& line) { emitted.push_back(line); });

    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.push(std::vector<float>(kInitialPartialSamples, 0.2f));
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
    pipeline.push(std::vector<float>(kStepPartialSamples, 0.2f));
    std::this_thread::sleep_for(std::chrono::milliseconds(15));
    pipeline.request_stop(false, true);
    worker.join();

    std::vector<std::string> partial_texts;
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") != "result") continue;
      const auto txt = extract_json_string_field(line, "text").value_or("");
      if (extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = txt;
      } else {
        partial_texts.push_back(txt);
      }
    }
    assert(partial_texts.empty());
    assert(final_text == "前文");
  }

  std::printf("segmented-pipeline tests passed\n");
  return 0;
}
