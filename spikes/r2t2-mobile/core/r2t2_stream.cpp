#include "r2t2_stream.h"

#include "r2t2_text.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace r2t2 {

namespace {

constexpr int kSampleRate = 16000;
const std::string kTag = "<asr_text>";

bool starts_with(const std::string & s, const std::string & prefix) {
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

// Python str.split("<asr_text>")[1] (text between the first and second tag).
std::string between_first_tags(const std::string & s) {
    const size_t a = s.find(kTag);
    if (a == std::string::npos) return {};
    const size_t start = a + kTag.size();
    const size_t b = s.find(kTag, start);
    return s.substr(start, b == std::string::npos ? std::string::npos : b - start);
}

// example.py is_last_token_chinese(total_new_asr_tokens): upstream never
// appends to that list, so it is always called with [] and returns False.
constexpr bool kLastTokenChinese = false;

} // namespace

R2T2Stream::R2T2Stream(Engine & engine, const StreamConfig & cfg)
    : engine_(engine), cfg_(cfg) {
    chunk_size_samples_ = std::max<size_t>(1, static_cast<size_t>(std::lround(cfg.chunk_size_ms / 1000.0 * kSampleRate)));
    prompt_raw_ = build_asr_prompt(cfg.context, cfg.language);
}

std::string R2T2Stream::rollback(const std::string & raw, int k) const {
    const std::vector<int32_t> ids = engine_.tokenize(raw, false, true);
    for (;;) {
        const int end_idx = std::max(0, static_cast<int>(ids.size()) - k);
        const std::string cand = end_idx > 0
            ? engine_.detokenize(std::vector<int32_t>(ids.begin(), ids.begin() + end_idx), true)
            : std::string();
        if (!contains_replacement_char(cand)) return cand;
        if (end_idx == 0) return {};
        ++k;
    }
}

GenerateResult R2T2Stream::run(const std::string & prompt, int max_new_tokens) {
    GenerateResult r = engine_.generate(audio_accum_.data(), audio_accum_.size(), prompt, max_new_tokens);
    static const bool trace = [] {
        const char * v = std::getenv("R2T2_TRACE");
        return v && v[0] == '1';
    }();
    if (trace) {
        // Same shape as upstream r2t2_llama/model.py debug_print in LlamaEngineAdapter.generate
        std::fprintf(stderr, "[llama] audio_samples=%zu max_tokens=%d text=%s prefix=%s | enc=%.1f prefill=%.1f dec=%.1f "
                     "audio_tok=%d gen_tok=%zu\n", audio_accum_.size(), max_new_tokens, sanitize_utf8(r.text).c_str(),
                     prompt.substr(prompt_raw_.size()).c_str(), r.encode_ms, r.prefill_ms, r.decode_ms, r.audio_tokens,
                     r.token_ids.size());
    }
    return r;
}

std::pair<std::string, std::string> R2T2Stream::transcribe(const float * pcm, size_t n, int max_new_tokens,
                                                           std::vector<StepInfo> * steps) {
    if (n > 0) buffer_.insert(buffer_.end(), pcm, pcm + n);
    std::string fixed_text;
    while (buffer_.size() >= chunk_size_samples_) {
        const double t0 = now_ms();
        audio_accum_.insert(audio_accum_.end(), buffer_.begin(), buffer_.begin() + chunk_size_samples_);
        buffer_.erase(buffer_.begin(), buffer_.begin() + chunk_size_samples_);

        std::string prefix;
        if (chunk_id_ >= cfg_.unfixed_chunk_num) {
            raw_decoded_ = split_first(raw_decoded_, '|');
            prefix = rollback(raw_decoded_, cfg_.unfixed_token_num);
        }
        prefix = split_first(prefix, '|');
        const std::string prompt = prompt_raw_ + prefix;

        GenerateResult gen = run(prompt, max_new_tokens);
        const std::string gen_text = remove_replacement_chars(normalize_punct_by_context(gen.text));
        raw_decoded_ = prefix + gen_text;

        std::string lang_probe;
        if (cfg_.language.empty()) lang_probe = parse_asr_output(raw_decoded_, "").first;
        if (cfg_.language == "Chinese" || lang_probe == "Chinese") {
            raw_decoded_ = remove_spaces_between_han(raw_decoded_);
        }
        auto [lang, txt] = parse_asr_output(raw_decoded_, cfg_.language);

        const size_t tag_pos = raw_decoded_.find(kTag);
        if (tag_pos != std::string::npos) {
            raw_decoded_ = raw_decoded_.substr(0, tag_pos) + kTag + txt;
        } else {
            raw_decoded_ = txt;
        }
        raw_decoded_ = split_first(raw_decoded_, '|');

        int k = cfg_.unfixed_token_num;
        const bool has_tag = raw_decoded_.find(kTag) != std::string::npos;
        if (has_tag && between_first_tags(raw_decoded_).empty()) k = 0;
        fixed_text = rollback(raw_decoded_, k);
        const size_t fixed_tag = fixed_text.find(kTag);
        if (fixed_tag != std::string::npos) fixed_text = fixed_text.substr(fixed_tag + kTag.size());
        fixed_text = split_first(fixed_text, '|');

        StepInfo info;
        info.audio_sec = audio_accum_.size() / static_cast<double>(kSampleRate);
        info.max_new_tokens = max_new_tokens;
        info.prefix = prefix;
        info.gen_text = gen_text;
        info.gen = gen;
        info.decoded = true;

        if (!has_tag && cfg_.language.empty()) {
            text_.clear();
            fixed_text.clear();
            info.step_ms = now_ms() - t0;
            if (steps) steps->push_back(std::move(info));
            continue;  // upstream: no chunk_id increment
        }
        language_ = lang;
        text_ = split_first(txt, '|');
        ++chunk_id_;
        info.text = text_;
        info.fixed_text = fixed_text;
        info.step_ms = now_ms() - t0;
        if (steps) steps->push_back(std::move(info));
    }
    return {text_, fixed_text};
}

std::string R2T2Stream::finish(int max_new_tokens, StepInfo * step) {
    if (buffer_.empty()) return text_;
    const double t0 = now_ms();
    audio_accum_.insert(audio_accum_.end(), buffer_.begin(), buffer_.end());
    buffer_.clear();

    std::string prefix;
    if (chunk_id_ >= cfg_.unfixed_chunk_num) {
        // Upstream: end_idx = max(1, len(ids) - unfixed_token_num), no U+FFFD
        // retry, then HF decode (errors="replace").
        const std::vector<int32_t> ids = engine_.tokenize(raw_decoded_, false, true);
        const size_t end_idx = std::min(ids.size(),
            static_cast<size_t>(std::max(1, static_cast<int>(ids.size()) - cfg_.unfixed_token_num)));
        prefix = sanitize_utf8(engine_.detokenize(std::vector<int32_t>(ids.begin(), ids.begin() + end_idx), true));
    }
    prefix = split_first(prefix, '|');
    GenerateResult gen = run(prompt_raw_ + prefix, max_new_tokens);
    const std::string gen_text = remove_replacement_chars(normalize_punct_by_context(gen.text));
    raw_decoded_ = split_first(prefix + gen_text, '|');
    auto [lang, txt] = parse_asr_output(raw_decoded_, cfg_.language);
    language_ = lang;
    text_ = split_first(txt, '|');
    ++chunk_id_;
    if (step) {
        step->audio_sec = audio_accum_.size() / static_cast<double>(kSampleRate);
        step->max_new_tokens = max_new_tokens;
        step->prefix = prefix;
        step->gen_text = gen_text;
        step->gen = gen;
        step->text = text_;
        step->fixed_text = text_;
        step->decoded = true;
        step->step_ms = now_ms() - t0;
    }
    return text_;
}

StreamDriver::StreamDriver(Engine & engine, const StreamConfig & cfg, std::function<void(const CommitEvent &)> on_event)
    : stream_(engine, cfg), cfg_(cfg), on_event_(std::move(on_event)) {
    step_ = static_cast<size_t>(std::lround(cfg.chunk_size_ms / 1000.0 * kSampleRate));
    lookahead_ = static_cast<size_t>(std::lround(cfg.lookahead_ms / 1000.0 * kSampleRate));
    max_new_tokens_ = std::max(1, static_cast<int>((step_ + lookahead_) / 1280));
    first_max_new_tokens_ = max_new_tokens_;
    max_new_tokens_floor_ = std::min(32, std::max(4, 2 * static_cast<int>(step_ / 1280)));
}

void StreamDriver::feed(const float * pcm, size_t n) {
    pending_.insert(pending_.end(), pcm, pcm + n);
    for (;;) {
        const size_t want = is_first_ ? step_ + lookahead_ : step_;
        if (pending_.size() < want) break;
        std::vector<float> seg(pending_.begin(), pending_.begin() + want);
        pending_.erase(pending_.begin(), pending_.begin() + want);
        run_segment(seg.data(), seg.size());
    }
}

void StreamDriver::run_segment(const float * seg, size_t n) {
    stream_.set_chunk_size_samples(is_first_ ? step_ + lookahead_ : step_);
    is_first_ = false;
    ++call_id_;
    std::vector<StepInfo> steps;
    auto [text_unused, fixed] = stream_.transcribe(seg, n, max_new_tokens_, &steps);
    (void)text_unused;
    std::string text = split_first(fixed, '|');

    StepInfo info = steps.empty() ? StepInfo{} : steps.back();
    info.call_index = call_id_;
    info.max_new_tokens = max_new_tokens_;
    info.fixed_text = text;

    if (py_len(text) > py_len(last_text_tmp_)) {
        last_text_tmp_ = text;
        max_new_tokens_ = std::max(1, static_cast<int>(step_ / 1280));
    } else if (!kLastTokenChinese) {
        max_new_tokens_ += 1;
    } else {
        max_new_tokens_ = std::max(1, static_cast<int>(step_ / 1280));
    }
    if (kLastTokenChinese) max_new_tokens_ *= 2;
    max_new_tokens_ = std::min(max_new_tokens_floor_, max_new_tokens_);

    apply_fixed(text, std::move(info));
}

void StreamDriver::apply_fixed(const std::string & fixed, StepInfo && step) {
    CommitEvent ev;
    if (!starts_with(fixed, last_fixed_)) ++regressions_;
    last_fixed_ = fixed;
    if (fixed.size() > committed_.size() && starts_with(fixed, committed_)) {
        ev.delta = fixed.substr(committed_.size());
        committed_ = fixed;
    }
    ev.committed = committed_;
    ev.partial = stream_.text();
    ev.step = std::move(step);
    if (on_event_) on_event_(ev);
}

std::string StreamDriver::finish() {
    // example.py: the last (shorter) segment was handed to
    // streaming_transcribe, which only buffered it; finish flushes the buffer.
    if (!pending_.empty()) {
        stream_.set_chunk_size_samples(is_first_ ? step_ + lookahead_ : step_);
        std::vector<float> tail;
        tail.swap(pending_);
        std::vector<StepInfo> steps;
        stream_.transcribe(tail.data(), tail.size(), max_new_tokens_, &steps);
        ++call_id_;
        // Upstream prints one more `text=` line for this buffered-only call.
        CommitEvent tail_ev;
        tail_ev.committed = committed_;
        tail_ev.partial = stream_.text();
        tail_ev.step.call_index = call_id_;
        tail_ev.step.max_new_tokens = max_new_tokens_;
        tail_ev.step.decoded = false;
        if (on_event_) on_event_(tail_ev);
    }
    StepInfo step;
    step.call_index = -1;  // finish flush
    const std::string final_text = split_first(stream_.finish(first_max_new_tokens_, &step), '|');
    CommitEvent ev;
    if (final_text.size() >= committed_.size() && starts_with(final_text, committed_)) {
        ev.delta = final_text.substr(committed_.size());
        committed_ = final_text;
    } else {
        ++regressions_;
    }
    ev.committed = committed_;
    ev.partial = final_text;
    ev.step = std::move(step);
    if (on_event_) on_event_(ev);
    return final_text;
}

} // namespace r2t2
