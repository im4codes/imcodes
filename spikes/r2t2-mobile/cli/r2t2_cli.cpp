// macOS/Linux host CLI for the shared core.
//
//   r2t2-cli --model M.gguf --mmproj P.gguf --wav clip.wav --mode stream
//
// --mode stream prints exactly the lines upstream example.py prints for
// `--infer_mode stream_llama` ("text=<fixed>" per call, then
// "finish state.text=<text>" and "final_result=<text>"), so the two outputs
// can be diffed line by line. --json writes the full metrics report.
#include "r2t2_harness.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <chrono>
#include <thread>

namespace {

void usage() {
    std::fprintf(stderr,
        "usage: r2t2-cli --model M.gguf --mmproj P.gguf --wav clip.wav\n"
        "                [--mode oneshot|stream|both|live] [--max-utterance-sec 30] [--language Chinese|English|...]\n"
        "                [--threads N] [--ctx N] [--cpu] [--chunk-ms 160] [--lookahead-ms 160]\n"
        "                [--unfixed 1] [--realtime] [--repeat-seconds S] [--json out.json] [--quiet]\n");
}

// Extract a top-level string field from our own flat JSON (no nested quotes issues
// for the keys we read; values are escaped by the writer).
std::string json_string_field(const std::string & json, const std::string & key) {
    const std::string needle = "\"" + key + "\":\"";
    size_t p = json.find(needle);
    if (p == std::string::npos) return {};
    p += needle.size();
    std::string out;
    for (; p < json.size() && json[p] != '"'; ++p) {
        if (json[p] == '\\' && p + 1 < json.size()) {
            const char c = json[++p];
            if (c == 'n') out.push_back('\n');
            else if (c == 't') out.push_back('\t');
            else if (c == 'r') out.push_back('\r');
            else out.push_back(c);
        } else {
            out.push_back(json[p]);
        }
    }
    return out;
}

struct ProgressCtx {
    bool quiet = false;
    bool upstream_format = true;
};

void on_progress(const char * event_json, void * user) {
    auto * ctx = static_cast<ProgressCtx *>(user);
    if (ctx->quiet) return;
    const std::string ev(event_json);
    if (ev.find("\"call\":-1") != std::string::npos) return;  // finish flush is printed below
    std::fprintf(stderr, "[event] %s\n", event_json);
}

} // namespace

int main(int argc, char ** argv) {
    std::string model, mmproj, wav, mode = "stream", language, json_out;
    int threads = 0, ctx = 0, chunk = 160, lookahead = 160, unfixed = 1;
    bool cpu = false, realtime = false, quiet = false;
    double repeat = 0;
    double max_utt = 30;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&](const char * name) -> std::string {
            if (i + 1 >= argc) { std::fprintf(stderr, "missing value for %s\n", name); std::exit(2); }
            return argv[++i];
        };
        if (a == "--model") model = next("--model");
        else if (a == "--mmproj") mmproj = next("--mmproj");
        else if (a == "--wav") wav = next("--wav");
        else if (a == "--mode") mode = next("--mode");
        else if (a == "--language") language = next("--language");
        else if (a == "--threads") threads = std::atoi(next("--threads").c_str());
        else if (a == "--ctx") ctx = std::atoi(next("--ctx").c_str());
        else if (a == "--cpu") cpu = true;
        else if (a == "--chunk-ms") chunk = std::atoi(next("--chunk-ms").c_str());
        else if (a == "--lookahead-ms") lookahead = std::atoi(next("--lookahead-ms").c_str());
        else if (a == "--unfixed") unfixed = std::atoi(next("--unfixed").c_str());
        else if (a == "--realtime") realtime = true;
        else if (a == "--repeat-seconds") repeat = std::atof(next("--repeat-seconds").c_str());
        else if (a == "--json") json_out = next("--json");
        else if (a == "--max-utterance-sec") max_utt = std::atof(next("--max-utterance-sec").c_str());
        else if (a == "--quiet") quiet = true;
        else { usage(); return 2; }
    }
    if (model.empty() || mmproj.empty() || wav.empty()) { usage(); return 2; }

    size_t n = 0;
    char * err = nullptr;
    float * pcm = r2t2_read_wav(wav.c_str(), &n, &err);
    if (!pcm) { std::fprintf(stderr, "%s\n", err); r2t2_free_string(err); return 1; }

    r2t2_harness_params p{};
    p.model_path = model.c_str();
    p.mmproj_path = mmproj.c_str();
    p.n_threads = threads;
    p.n_ctx = ctx;
    p.use_gpu = cpu ? 0 : 1;
    p.n_gpu_layers = cpu ? 0 : -1;
    r2t2_harness * h = nullptr;
    char * load = r2t2_harness_load(&p, &h);
    std::string report = "{\"load\":" + std::string(load);
    std::fprintf(stderr, "[load] %s\n", load);
    r2t2_free_string(load);
    if (!h) { r2t2_free_floats(pcm); return 1; }

    const char * lang = language.empty() ? nullptr : language.c_str();
    if (mode == "oneshot" || mode == "both") {
        char * r = r2t2_harness_oneshot(h, pcm, n, lang, 4096);
        std::printf("oneshot_result=%s\n", json_string_field(r, "text").c_str());
        report += ",\"oneshot\":" + std::string(r);
        std::fprintf(stderr, "[oneshot] %s\n", r);
        r2t2_free_string(r);
    }
    if (mode == "stream" || mode == "both") {
        ProgressCtx pctx;
        pctx.quiet = quiet;
        char * r = r2t2_harness_stream(h, pcm, n, lang, chunk, lookahead, unfixed, realtime ? 1 : 0, repeat,
                                       on_progress, &pctx);
        const std::string rs(r);
        // Upstream-format transcript for diffing against reference/*.txt
        const size_t a = rs.find("\"fixed_lines\":[");
        if (a != std::string::npos) {
            size_t p0 = a + std::strlen("\"fixed_lines\":[");
            while (p0 < rs.size() && rs[p0] == '"') {
                std::string line;
                size_t q = p0 + 1;
                for (; q < rs.size() && rs[q] != '"'; ++q) {
                    if (rs[q] == '\\' && q + 1 < rs.size()) { ++q; line.push_back(rs[q] == 'n' ? '\n' : rs[q]); }
                    else line.push_back(rs[q]);
                }
                std::printf("text=%s\n", line.c_str());
                p0 = q + 1;
                if (p0 < rs.size() && rs[p0] == ',') ++p0;
            }
        }
        const std::string final_text = json_string_field(rs, "final_text");
        std::printf("finish state.text=%s\n", final_text.c_str());
        std::printf("final_result=%s\n", final_text.c_str());
        report += ",\"stream\":" + rs;
        std::fprintf(stderr, "[stream] %s\n", r);
        r2t2_free_string(r);
    }
    if (mode == "live") {
        // Simulated microphone: push 20 ms blocks at wall-clock speed through the
        // live API (worker thread, backlog, utterance restarts).
        ProgressCtx pctx;
        pctx.quiet = quiet;
        r2t2_live * live = r2t2_live_start(h, lang, chunk, lookahead, unfixed, max_utt, on_progress, &pctx);
        const double total = repeat > 0 ? repeat : n / 16000.0;
        const auto t0 = std::chrono::steady_clock::now();
        size_t pushed = 0;
        const size_t block = 320;
        while (pushed / 16000.0 < total) {
            const size_t off = pushed % n;
            const size_t len = std::min(block, n - off);
            r2t2_live_push(live, pcm + off, len);
            pushed += len;
            std::this_thread::sleep_until(t0 + std::chrono::microseconds(static_cast<long long>(pushed / 16.0 * 1000)));
        }
        char * r = r2t2_live_stop(live);
        std::printf("live_transcript=%s\n", json_string_field(r, "transcript").c_str());
        report += ",\"live\":" + std::string(r);
        std::fprintf(stderr, "[live] %s\n", r);
        r2t2_free_string(r);
    }
    report += "}";
    if (!json_out.empty()) {
        std::ofstream(json_out) << report << "\n";
    }
    r2t2_harness_free(h);
    r2t2_free_floats(pcm);
    return 0;
}
