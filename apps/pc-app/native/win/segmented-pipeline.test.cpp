#define IMCODES_SPEECH_WIN_NO_MAIN 1
#include "imcodes-speech-win.cpp"

#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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
  // 1. <=30s multi-segment (250,000 <= kMaxFinalReDecodeSamples) prefilled + immediate normal stop(false):
  // streaming commits 216,000, then final re-decodes FULL 250,000 utterance replacing rolled-over text.
  {
    std::vector<std::string> emitted;
    std::mutex emit_mu;
    std::vector<size_t> decode_sizes;

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) -> std::string {
          decode_sizes.push_back(samples.size());
          if (samples.size() == 250000) return "full-250k-utterance";
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
    assert(decode_sizes[1] == 250000);

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
    assert(final_text == "full-250k-utterance");
    assert(!emitted.empty() && extract_json_string_field(emitted.back(), "type") == "end");
  }

  // 1b. >30s (500,000 > kMaxFinalReDecodeSamples) releases full buffer, commits 216k chunks,
  // and final decodes ONLY trailing active segment (68,000).
  {
    std::vector<std::string> emitted;
    std::mutex emit_mu;
    std::vector<size_t> decode_sizes;
    std::vector<float> long_pcm(500000, 0.2f);
    for (size_t i = kMaxSegmentSamples * 2; i < long_pcm.size(); ++i) {
      long_pcm[i] = 0.8f;
    }

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) -> std::string {
          decode_sizes.push_back(samples.size());
          return decode_by_marker(samples);
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(emit_mu);
          emitted.push_back(line);
        });

    pipeline.preload(long_pcm);
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    assert(decode_sizes.size() == 3);
    assert(decode_sizes[0] == kMaxSegmentSamples);
    assert(decode_sizes[1] == kMaxSegmentSamples);
    assert(decode_sizes[2] == 500000 - (kMaxSegmentSamples * 2));
    for (size_t sz : decode_sizes) assert(sz <= kMaxSegmentSamples);

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
    assert(final_text == "seg-one seg-one seg-two");
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
  // Verify >cap segmented boundary AND <=cap full-utterance inclusion of trailing WASAPI tail.
  {
    std::vector<std::string> emitted;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [](const std::vector<float>& samples) { return decode_by_marker(samples); },
        [&](const std::string& line) { emitted.push_back(line); },
        kMaxSegmentSamples,
        kMaxSegmentSamples + 1000);

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
  {
    std::vector<std::string> emitted;
    std::vector<size_t> decode_sizes;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) {
          decode_sizes.push_back(samples.size());
          return samples.size() == kMaxSegmentSamples + 4000 ? "whole-with-tail" : decode_by_marker(samples);
        },
        [&](const std::string& line) { emitted.push_back(line); });

    pipeline.preload(std::vector<float>(kMaxSegmentSamples, 0.2f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.push(std::vector<float>(4000, 0.8f));
    pipeline.request_stop(false, false);
    pipeline.mark_producer_finished();
    worker.join();

    assert(!decode_sizes.empty() && decode_sizes.back() == kMaxSegmentSamples + 4000);
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_text == "whole-with-tail");
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
        },
        kMaxSegmentSamples,
        240000);

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
    std::mutex sync_mu;
    std::condition_variable sync_cv;
    bool in_first_decode = false;
    bool release_first_decode = false;
    bool first_decode_exited = false;
    int decode_count = 0;

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) {
          int call = 0;
          {
            std::lock_guard<std::mutex> lock(sync_mu);
            call = ++decode_count;
          }
          if (call == 1) {
            {
              std::lock_guard<std::mutex> lock(sync_mu);
              in_first_decode = true;
            }
            sync_cv.notify_all();
            wait_until_or_fail(
                sync_mu,
                sync_cv,
                [&]() { return release_first_decode; },
                "scenario 5 first decode release");
          }
          const std::string out = decode_by_marker(samples);
          if (call == 1) {
            {
              std::lock_guard<std::mutex> lock(sync_mu);
              first_decode_exited = true;
            }
            sync_cv.notify_all();
          }
          return out;
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(sync_mu);
          emitted.push_back(line);
        },
        kMaxSegmentSamples,
        kMaxSegmentSamples + 1000);

    pipeline.preload(std::vector<float>(kMaxSegmentSamples, 0.2f));
    std::thread worker([&]() { pipeline.run_loop(); });
    wait_until_or_fail(
        sync_mu, sync_cv, [&]() { return in_first_decode; }, "scenario 5 first decode entry");
    pipeline.request_stop(false, false);
    {
      std::lock_guard<std::mutex> lock(sync_mu);
      release_first_decode = true;
    }
    sync_cv.notify_all();
    wait_until_or_fail(
        sync_mu, sync_cv, [&]() { return first_decode_exited; }, "scenario 5 first decode exit");
    pipeline.push(std::vector<float>(4000, 0.8f));
    pipeline.mark_producer_finished();
    worker.join();

    assert(decode_count == 2);
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
    std::mutex sync_mu;
    std::condition_variable sync_cv;
    int partial_decode_count = 0;
    int boundary_decode_count = 0;
    int seg2_decode_count = 0;
    bool has_first_partial_emit = false;

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) -> std::string {
          std::lock_guard<std::mutex> lock(sync_mu);
          if (samples.front() >= 0.7f) {
            ++seg2_decode_count;
            sync_cv.notify_all();
            return "second-part";
          }
          if (samples.size() >= kMaxSegmentSamples) {
            ++boundary_decode_count;
            sync_cv.notify_all();
            return "language None<asr_text>";
          }
          ++partial_decode_count;
          sync_cv.notify_all();
          return "first-part";
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(sync_mu);
          emitted.push_back(line);
          if (extract_json_string_field(line, "type") == "result" &&
              extract_json_bool_or_str(line, "isFinal") == "false" &&
              extract_json_string_field(line, "text").value_or("") == "first-part") {
            has_first_partial_emit = true;
            sync_cv.notify_all();
          }
        },
        kMaxSegmentSamples,
        kMaxSegmentSamples + 1000);

    std::thread worker([&]() { pipeline.run_loop(); });
    // Push initial partial threshold and wait until "first-part" is emitted into active_segment_text.
    pipeline.push(std::vector<float>(kInitialPartialSamples, 0.2f));
    wait_until_or_fail(
        sync_mu,
        sync_cv,
        [&]() { return partial_decode_count >= 1 && has_first_partial_emit; },
        "scenario 7 first non-empty partial");
    // Fill remaining samples up to kMaxSegmentSamples and wait for boundary decode to run.
    pipeline.push(std::vector<float>(kMaxSegmentSamples - kInitialPartialSamples, 0.2f));
    wait_until_or_fail(
        sync_mu,
        sync_cv,
        [&]() { return boundary_decode_count >= 1; },
        "scenario 7 boundary decode at kMaxSegmentSamples");
    pipeline.push(std::vector<float>(4000, 0.8f));
    pipeline.request_stop(false, true);
    worker.join();

    assert(partial_decode_count >= 1);
    assert(boundary_decode_count == 1);
    assert(seg2_decode_count == 1);

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
    std::mutex sync_mu;
    std::condition_variable sync_cv;
    int call_count = 0;
    bool has_first_partial_emit = false;

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>&) -> std::string {
          int current_call = 0;
          {
            std::lock_guard<std::mutex> lock(sync_mu);
            current_call = ++call_count;
          }
          sync_cv.notify_all();
          if (current_call == 1) return "language English<asr_text>hello";
          return "language None<asr_text>";
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(sync_mu);
          emitted.push_back(line);
          if (extract_json_string_field(line, "type") == "result" &&
              extract_json_bool_or_str(line, "isFinal") == "false" &&
              extract_json_string_field(line, "text").value_or("") == "hello") {
            has_first_partial_emit = true;
            sync_cv.notify_all();
          }
        });

    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.push(std::vector<float>(kInitialPartialSamples, 0.2f));
    wait_until_or_fail(
        sync_mu,
        sync_cv,
        [&]() { return call_count >= 1 && has_first_partial_emit; },
        "scenario 8 first partial");
    pipeline.push(std::vector<float>(kStepPartialSamples, 0.2f));
    wait_until_or_fail(
        sync_mu, sync_cv, [&]() { return call_count >= 2; }, "scenario 8 second decode");
    pipeline.request_stop(false, true);
    worker.join();

    assert(call_count == 3);
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
        [&](const std::string& line) { emitted.push_back(line); },
        kMaxSegmentSamples,
        210000);

    pipeline.preload(pcm);
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    assert(decode_sizes.size() == 3);
    // Trailing 400ms (6400 samples) pause is trimmed to 250ms (4000 samples) protective pad before decode.
    assert(decode_sizes[0] == kMinPauseSplitSamples + 4000);
    assert(decode_sizes[1] == kMinPauseSplitSamples + 4000);
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

  // 10b. <=30s pause split at 6s+400ms still re-decodes FULL utterance (126,400 samples) on final pass
  // replacing mid-sentence pause-split text with whole-utterance result.
  {
    std::vector<std::string> emitted;
    std::vector<size_t> decode_sizes;
    std::vector<float> pcm;
    pcm.insert(pcm.end(), kMinPauseSplitSamples, 0.2f);
    pcm.insert(pcm.end(), kPauseWindowSamples, 0.0f);
    pcm.insert(pcm.end(), 24000, 0.5f);

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>& samples) -> std::string {
          decode_sizes.push_back(samples.size());
          if (samples.size() == kMinPauseSplitSamples + kPauseWindowSamples + 24000) {
            return "language Chinese<asr_text>第一段，第二段。";
          }
          return "language Chinese<asr_text>第一段。";
        },
        [&](const std::string& line) { emitted.push_back(line); });

    pipeline.preload(pcm);
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    assert(decode_sizes.size() == 2);
    assert(decode_sizes[0] == kMinPauseSplitSamples + 4000);
    assert(decode_sizes[1] == kMinPauseSplitSamples + kPauseWindowSamples + 24000);
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_text == "第一段，第二段。");
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
    std::mutex sync_mu;
    std::condition_variable sync_cv;
    int call_count = 0;

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>&) -> std::string {
          int current_call = 0;
          {
            std::lock_guard<std::mutex> lock(sync_mu);
            current_call = ++call_count;
          }
          sync_cv.notify_all();
          if (current_call == 1) return "language\nNone<asr_text>";
          if (current_call == 2) return "language\r\nNone<asr_text>";
          return "language\nChinese<asr_text>前文";
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(sync_mu);
          emitted.push_back(line);
        });

    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.push(std::vector<float>(kInitialPartialSamples, 0.2f));
    wait_until_or_fail(
        sync_mu, sync_cv, [&]() { return call_count >= 1; }, "scenario 12 LF decode");
    pipeline.push(std::vector<float>(kStepPartialSamples, 0.2f));
    wait_until_or_fail(
        sync_mu, sync_cv, [&]() { return call_count >= 2; }, "scenario 12 CRLF decode");
    pipeline.request_stop(false, true);
    worker.join();

    assert(call_count == 3);
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

  // 13. Counterexample for delayed worker startup / arbitrary scheduling latency:
  // even when worker blocks until after initial push, condvar handshakes still drive all 3 decodes.
  {
    std::vector<std::string> emitted;
    std::mutex sync_mu;
    std::condition_variable sync_cv;
    std::promise<void> worker_release;
    std::shared_future<void> worker_gate = worker_release.get_future().share();
    int call_count = 0;

    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>&) -> std::string {
          int current_call = 0;
          {
            std::lock_guard<std::mutex> lock(sync_mu);
            current_call = ++call_count;
          }
          sync_cv.notify_all();
          if (current_call == 1) return "language\nNone<asr_text>";
          if (current_call == 2) return "language\r\nNone<asr_text>";
          return "language\nChinese<asr_text>前文";
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(sync_mu);
          emitted.push_back(line);
        });

    std::thread worker([&]() {
      worker_gate.wait();
      pipeline.run_loop();
    });
    pipeline.push(std::vector<float>(kInitialPartialSamples, 0.2f));
    worker_release.set_value();
    wait_until_or_fail(
        sync_mu, sync_cv, [&]() { return call_count >= 1; }, "scenario 13 delayed LF decode");
    pipeline.push(std::vector<float>(kStepPartialSamples, 0.2f));
    wait_until_or_fail(
        sync_mu, sync_cv, [&]() { return call_count >= 2; }, "scenario 13 delayed CRLF decode");
    pipeline.request_stop(false, true);
    worker.join();

    assert(call_count == 3);
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_text == "前文");
  }

  // 14. ServeCommandLoop non-blocking stop -> abort during gated final decode emits NO isFinal=true.
  {
    std::vector<std::string> emitted;
    std::mutex gate_mu;
    std::condition_variable gate_cv;
    bool in_final_decode = false;
    bool release_final_decode = false;
    bool loop_finished = false;

    ServeCommandLoop loop(
        nullptr,
        [&]() {
          return std::make_unique<PcmUtteranceDecoder>(
              [&](const std::vector<float>&) -> std::string {
                {
                  std::lock_guard<std::mutex> lock(gate_mu);
                  in_final_decode = true;
                }
                gate_cv.notify_all();
                wait_until_or_fail(
                    gate_mu,
                    gate_cv,
                    [&]() { return release_final_decode; },
                    "scenario 14 final decode gate");
                return "late-final-should-not-emit";
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

    auto encode_pcm16_b64 = [](size_t samples_count, int16_t val) {
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
    };

    assert(loop.handle_line("{\"cmd\":\"start_pcm\"}"));
    assert(loop.handle_line("{\"cmd\":\"pcm\",\"data\":\"" + encode_pcm16_b64(3200, 3000) + "\"}"));
    // Normal stop MUST return immediately without blocking on the gated final decode.
    const auto t0 = std::chrono::steady_clock::now();
    assert(loop.handle_line("{\"cmd\":\"stop\"}"));
    const auto elapsed = std::chrono::steady_clock::now() - t0;
    assert(elapsed < std::chrono::milliseconds(500));

    wait_until_or_fail(
        gate_mu, gate_cv, [&]() { return in_final_decode; }, "scenario 14 enter final decode");

    // Abort MUST also be processed immediately while final decode is blocked inside gate!
    assert(loop.handle_line("{\"cmd\":\"abort\"}"));

    {
      std::lock_guard<std::mutex> lock(gate_mu);
      release_final_decode = true;
    }
    gate_cv.notify_all();
    wait_until_or_fail(
        gate_mu, gate_cv, [&]() { return loop_finished; }, "scenario 14 end event");
    assert(!loop.handle_line("{\"cmd\":\"shutdown\"}"));

    for (const auto& line : emitted) {
      assert(extract_json_bool_or_str(line, "isFinal") != "true");
    }
    assert(!emitted.empty() && extract_json_string_field(emitted.back(), "type") == "end");
  }

  // 15. Edge silence trimming: strips long leading/trailing silence while retaining ~250ms pad (4000 samples @ 16kHz),
  // clamps near boundaries, preserves quiet speech, and returns empty on pure silence/sub-threshold noise.
  {
    assert(trim_silence_edges(std::vector<float>{}).empty());
    assert(trim_silence_edges(std::vector<float>(32000, 0.0f)).empty());
    assert(trim_silence_edges(std::vector<float>(16000, 0.002f)).empty());

    std::vector<float> padded(48000, 0.0f); // 3.0s leading silence
    padded.insert(padded.end(), 16000, 0.05f); // 1.0s speech
    padded.insert(padded.end(), 48000, 0.0f); // 3.0s trailing silence
    const std::vector<float> trimmed = trim_silence_edges(padded);
    assert(trimmed.size() == 4000 + 16000 + 4000);
    assert(trimmed.front() == 0.0f);
    assert(trimmed[4000] == 0.05f);
    assert(trimmed[4000 + 15999] == 0.05f);
    assert(trimmed.back() == 0.0f);

    // Clamping when silence margins are shorter than 250ms:
    std::vector<float> short_margin(1000, 0.0f);
    short_margin.insert(short_margin.end(), 2000, 0.02f);
    short_margin.insert(short_margin.end(), 1000, 0.0f);
    assert(trim_silence_edges(short_margin).size() == 4000);

    // Quiet speech (0.006 RMS < 0.015 peak) still triggers 50ms RMS threshold:
    std::vector<float> quiet_padded(20000, 0.0f);
    quiet_padded.insert(quiet_padded.end(), 3200, 0.006f);
    quiet_padded.insert(quiet_padded.end(), 20000, 0.0f);
    const std::vector<float> quiet_trimmed = trim_silence_edges(quiet_padded);
    assert(!quiet_trimmed.empty() && quiet_trimmed.size() < quiet_padded.size());
  }

  // 16. Pipeline trims leading+trailing silence before decoding AND strips edge hotword hallucinations via ServeCommandLoop.
  {
    std::vector<std::string> emitted;
    std::vector<size_t> decode_sizes;
    ServeCommandLoop loop(nullptr, nullptr);
    loop.set_hotword_factories(
        nullptr,
        [&](std::vector<std::string> req_hotwords) {
          return std::make_unique<PcmUtteranceDecoder>(
              [&](const std::vector<float>& samples) -> std::string {
                decode_sizes.push_back(samples.size());
                return "language Chinese<asr_text>IM.codes，IM.codes。你答的对，就这么来。";
              },
              [&](const std::string& line) { emitted.push_back(line); },
              kMaxSegmentSamples,
              kMaxFinalReDecodeSamples,
              req_hotwords);
        });

    auto encode_pcm16_b64_vals = [](const std::vector<int16_t>& vals) {
      static const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      std::vector<uint8_t> bytes(vals.size() * 2);
      for (size_t i = 0; i < vals.size(); ++i) {
        bytes[i * 2] = static_cast<uint8_t>(vals[i] & 0xff);
        bytes[i * 2 + 1] = static_cast<uint8_t>((vals[i] >> 8) & 0xff);
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
    };

    std::vector<int16_t> audio(24000, 0); // 1.5s leading silence
    audio.insert(audio.end(), 16000, 4000); // 1.0s speech
    audio.insert(audio.end(), 24000, 0); // 1.5s trailing silence

    assert(loop.handle_line("{\"cmd\":\"start_pcm\",\"hotwords\":[\"IM.codes\",\"Claude\"]}"));
    assert(loop.handle_line("{\"cmd\":\"pcm\",\"data\":\"" + encode_pcm16_b64_vals(audio) + "\"}"));
    assert(loop.handle_line("{\"cmd\":\"stop\"}"));
    loop.join_and_reset_active(false);
    assert(!loop.handle_line("{\"cmd\":\"shutdown\"}"));

    assert(!decode_sizes.empty());
    assert(decode_sizes.back() == 4000 + 16000 + 4000);
    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_text == "你答的对，就这么来。");
  }

  // 17. Direct C++ strip_voice_hotword_hallucination coverage: shared cross-platform matrix.
  {
    const std::vector<std::string> terms{"IM.codes", "Claude Code", "Codex", "Claude", "Qwen"};
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。你答的对，就这么来。", terms) ==
           "你答的对，就这么来。");
    assert(strip_voice_hotword_hallucination("我们是桌面端，在乎那几十兆，不在乎的，我要的是速度。IM.codes，IM.codes。", terms) ==
           "我们是桌面端，在乎那几十兆，不在乎的，我要的是速度。");
    assert(strip_voice_hotword_hallucination("我要的是速度 IM.codes IM.codes", terms) == "我要的是速度");
    assert(strip_voice_hotword_hallucination("我要的是速度，IM.codes，IM.codes。", terms) == "我要的是速度");
    assert(strip_voice_hotword_hallucination("ＩＭ．ｃｏｄｅｓ，IM.codes。Café👍🏽，IM.codes，im.codes。", terms) == "Café👍🏽");
    assert(strip_voice_hotword_hallucination("IM.codes, Claude Code, Codex。开始工作", terms) == "开始工作");
    assert(strip_voice_hotword_hallucination("开始工作。IM.codes, Claude Code, Codex。", terms) == "开始工作。");
    // P0 #1 matrix: A/B/A intact, preceding sentence intact, adjacent A/A only
    assert(strip_voice_hotword_hallucination("IM.codes, Codex, IM.codes 都是我在用的工具", terms) ==
           "IM.codes, Codex, IM.codes 都是我在用的工具");
    assert(strip_voice_hotword_hallucination("Codex。IM.codes，IM.codes。你好", terms) ==
           "Codex。IM.codes，IM.codes。你好");
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。Codex。你好", terms) ==
           "Codex。你好");
    assert(strip_voice_hotword_hallucination("打开 Codex，IM.codes，IM.codes。", terms) == "打开 Codex");
    assert(strip_voice_hotword_hallucination("先看。Codex。IM.codes, Claude, Qwen。", terms) == "先看。Codex。");
    // P0 #2 matrix: true NFKC (Hangul Jamo, Latin NFD vs NFC, distinct combining marks kept)
    assert(strip_voice_hotword_hallucination("\xE1\x84\x80\xE1\x85\xA1, \xEA\xB0\x80", std::vector<std::string>{"\xEA\xB0\x80"}).empty());
    assert(strip_voice_hotword_hallucination("\xE1\x84\x80\xE1\x85\xA1, \xEA\xB0\x80\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"\xEA\xB0\x80"}) == "\xE4\xBD\xA0\xE5\xA5\xBD");
    assert(strip_voice_hotword_hallucination("Caf\xC3\xA9, Cafe\xCC\x81\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"Caf\xC3\xA9"}) == "\xE4\xBD\xA0\xE5\xA5\xBD");
    assert(strip_voice_hotword_hallucination("code\xCC\x81, code\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"code"}) == "code\xCC\x81, code\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD");
    assert(strip_voice_hotword_hallucination("cod\xCC\x81, code\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD", std::vector<std::string>{"code"}) == "cod\xCC\x81, code\xE3\x80\x82\xE4\xBD\xA0\xE5\xA5\xBD");
    // Negative cases must stay intact:
    assert(strip_voice_hotword_hallucination("IM.codes is great", terms) == "IM.codes is great");
    assert(strip_voice_hotword_hallucination("Use IM.codes", terms) == "Use IM.codes");
    assert(strip_voice_hotword_hallucination("testcode, code", std::vector<std::string>{"code"}) == "testcode, code");
    assert(strip_voice_hotword_hallucination("code, codeReview", std::vector<std::string>{"code"}) == "code, codeReview");
    assert(strip_voice_hotword_hallucination("你好，你好吗", std::vector<std::string>{"你好"}) == "你好，你好吗");
    assert(strip_voice_hotword_hallucination("请你对比 IM.codes, Claude Code, Codex。", terms) ==
           "请你对比 IM.codes, Claude Code, Codex。");

    // Round 2 cross-sentence Rule A freeze & exact Unicode separator category parity:
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。IM.codes 很好用。", terms) ==
           "IM.codes 很好用。");
    assert(strip_voice_hotword_hallucination("我常用 IM.codes。IM.codes，IM.codes。", terms) ==
           "我常用 IM.codes。");
    assert(strip_voice_hotword_hallucination("IM.codes。IM.codes。你好", terms) == "你好");
    assert(strip_voice_hotword_hallucination("你好。IM.codes。IM.codes。", terms) == "你好。");
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。IM.codes，IM.codes。你好", terms) == "你好");
    assert(strip_voice_hotword_hallucination("你好。IM.codes，IM.codes。IM.codes，IM.codes。", terms) == "你好。");
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。👍🏽可以。", terms) == "👍🏽可以。");
    assert(strip_voice_hotword_hallucination("IM.codes，IM.codes。〇也是一个数字。", terms) == "〇也是一个数字。");
    assert(strip_voice_hotword_hallucination("〇。IM.codes，IM.codes。", terms) == "〇。");

    // Verify injectable NFKC normalizer hook works cleanly at both full-string and cluster level, then restore default.
    set_hotword_nfkc_normalizer_for_testing([](const std::string& s) -> std::string {
      std::string out = s;
      const std::string kelvin = "\xE2\x84\xAA"; // U+212A Kelvin sign
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

  // 18. P0 #3 counterexample: >cap cross-segment real single hotword ("IM.codes") + trailing real text ("保留这一句")
  //     must preserve committed single hotword ("IM.codes保留这一句"), while retracted/noise hotwords never resurrect.
  {
    // 18a: seg 1 (16k) -> "IM.codes", seg 2 (8k, >20k cap) -> "保留这一句" => "IM.codes保留这一句"
    std::vector<std::string> emitted;
    int call = 0;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> pipeline(
        [&](const std::vector<float>&) -> std::string {
          ++call;
          if (call == 1) return "IM.codes";
          return "保留这一句";
        },
        [&](const std::string& line) { emitted.push_back(line); },
        16000,
        20000,
        std::vector<std::string>{"IM.codes"});

    pipeline.preload(std::vector<float>(24000, 0.2f));
    std::thread worker([&]() { pipeline.run_loop(); });
    pipeline.request_stop(false, true);
    worker.join();

    std::string final_text;
    for (const auto& line : emitted) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_text = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_text == "IM.codes保留这一句");

    // 18b: retracted active single hotword in trailing segment after >cap must NOT resurrect while committed real text stays intact
    std::vector<std::string> emitted_retract;
    std::mutex mu_r;
    std::condition_variable cv_r;
    int pass_r = 0;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> retract_pipeline(
        [&](const std::vector<float>&) -> std::string {
          int p = 0;
          {
            std::lock_guard<std::mutex> lock(mu_r);
            p = ++pass_r;
          }
          cv_r.notify_all();
          if (p == 1) return "先看";
          if (p == 2) return "IM.codes";
          if (p == 3) return "IM.codes，IM.codes。";
          return "IM.codes";
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(mu_r);
          emitted_retract.push_back(line);
        },
        32000,
        40000,
        std::vector<std::string>{"IM.codes"});

    std::thread worker_r([&]() { retract_pipeline.run_loop(); });
    retract_pipeline.push(std::vector<float>(32000, 0.2f));
    wait_until_or_fail(mu_r, cv_r, [&]() { return pass_r >= 1; }, "18b seg 1");
    retract_pipeline.push(std::vector<float>(kInitialPartialSamples, 0.2f));
    wait_until_or_fail(mu_r, cv_r, [&]() { return pass_r >= 2; }, "18b seg 2a");
    retract_pipeline.push(std::vector<float>(kStepPartialSamples, 0.2f));
    wait_until_or_fail(mu_r, cv_r, [&]() { return pass_r >= 3; }, "18b seg 2b retract");
    retract_pipeline.request_stop(false, true);
    worker_r.join();

    std::string final_retract;
    for (const auto& line : emitted_retract) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_retract = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_retract == "先看");

    // 18c: pure sub-threshold noise across >cap skips decode_fn_ completely and emits ""
    int noise_calls = 0;
    std::vector<std::string> emitted_noise;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> noise_pipeline(
        [&](const std::vector<float>&) -> std::string {
          ++noise_calls;
          return "IM.codes";
        },
        [&](const std::string& line) { emitted_noise.push_back(line); },
        16000,
        20000,
        std::vector<std::string>{"IM.codes"});

    noise_pipeline.preload(std::vector<float>(24000, 0.002f));
    std::thread worker_n([&]() { noise_pipeline.run_loop(); });
    noise_pipeline.request_stop(false, true);
    worker_n.join();
    assert(noise_calls == 0);
    std::string final_noise;
    for (const auto& line : emitted_noise) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_noise = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_noise.empty());

    // 18d: Round 2 P0 #3 counterexample: >cap cross-segment pure single-hotword repeats
    //      ("IM.codes" in seg 1 + "IM.codes" in seg 2) must sanitize merged text to "".
    std::vector<std::string> emitted_dup;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> dup_pipeline(
        [&](const std::vector<float>&) -> std::string { return "IM.codes"; },
        [&](const std::string& line) { emitted_dup.push_back(line); },
        16000,
        20000,
        std::vector<std::string>{"IM.codes"});
    dup_pipeline.preload(std::vector<float>(24000, 0.2f));
    std::thread worker_d([&]() { dup_pipeline.run_loop(); });
    dup_pipeline.request_stop(false, true);
    worker_d.join();
    std::string final_dup = "UNSET";
    for (const auto& line : emitted_dup) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_dup = extract_json_string_field(line, "text").value_or("UNSET");
      }
    }
    assert(final_dup.empty());

    // 18e: >cap incremental retraction of cross-segment "IM.codes"+"IM.codes" followed by real text
    //      must not resurrect retracted "IM.codes".
    std::vector<std::string> emitted_cross_retract;
    std::mutex mu_cr;
    std::condition_variable cv_cr;
    int pass_cr = 0;
    SegmentedUtterancePipeline<
        std::function<std::string(const std::vector<float>&)>,
        std::function<void(const std::string&)>> cross_retract_pipeline(
        [&](const std::vector<float>&) -> std::string {
          int p = 0;
          {
            std::lock_guard<std::mutex> lock(mu_cr);
            p = ++pass_cr;
          }
          cv_cr.notify_all();
          if (p == 1) return "IM.codes";
          if (p == 2) return "IM.codes";
          return "保留这一句";
        },
        [&](const std::string& line) {
          std::lock_guard<std::mutex> lock(mu_cr);
          emitted_cross_retract.push_back(line);
        },
        32000,
        40000,
        std::vector<std::string>{"IM.codes"});
    std::thread worker_cr([&]() { cross_retract_pipeline.run_loop(); });
    cross_retract_pipeline.push(std::vector<float>(32000, 0.2f));
    wait_until_or_fail(mu_cr, cv_cr, [&]() { return pass_cr >= 1; }, "18e seg 1");
    cross_retract_pipeline.push(std::vector<float>(kInitialPartialSamples, 0.2f));
    wait_until_or_fail(mu_cr, cv_cr, [&]() { return pass_cr >= 2; }, "18e seg 2 retract");
    cross_retract_pipeline.push(std::vector<float>(kStepPartialSamples, 0.2f));
    wait_until_or_fail(mu_cr, cv_cr, [&]() { return pass_cr >= 3; }, "18e seg 2 real");
    cross_retract_pipeline.request_stop(false, true);
    worker_cr.join();
    std::string final_cr;
    for (const auto& line : emitted_cross_retract) {
      if (extract_json_string_field(line, "type") == "result" &&
          extract_json_bool_or_str(line, "isFinal") == "true") {
        final_cr = extract_json_string_field(line, "text").value_or("");
      }
    }
    assert(final_cr == "保留这一句");
  }

  std::printf("segmented-pipeline tests passed\n");
  return 0;
}
