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

  std::printf("segmented-pipeline tests passed\n");
  return 0;
}
