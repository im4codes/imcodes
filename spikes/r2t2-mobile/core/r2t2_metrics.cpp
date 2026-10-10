#include "r2t2_metrics.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <vector>

#if defined(__APPLE__)
#include <mach/mach.h>
#endif

namespace r2t2 {

#if defined(__APPLE__)
namespace {
bool vm_info(task_vm_info_data_t * info) {
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    return task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(info), &count) == KERN_SUCCESS;
}
} // namespace

uint64_t current_memory_bytes() {
    task_vm_info_data_t info{};
    return vm_info(&info) ? info.phys_footprint : 0;
}

uint64_t peak_memory_bytes() {
    task_vm_info_data_t info{};
    return vm_info(&info) ? info.ledger_phys_footprint_peak : 0;
}

std::string memory_source() { return "phys_footprint"; }
#else
namespace {
uint64_t status_kb(const char * key) {
    FILE * f = std::fopen("/proc/self/status", "r");
    if (!f) return 0;
    char line[256];
    uint64_t value = 0;
    const size_t klen = std::strlen(key);
    while (std::fgets(line, sizeof(line), f)) {
        if (std::strncmp(line, key, klen) == 0) {
            unsigned long long v = 0;
            if (std::sscanf(line + klen, " %llu", &v) == 1) value = v;
            break;
        }
    }
    std::fclose(f);
    return value * 1024ULL;
}
} // namespace

uint64_t current_memory_bytes() { return status_kb("VmRSS:"); }
uint64_t peak_memory_bytes() { return status_kb("VmHWM:"); }
std::string memory_source() { return "VmRSS/VmHWM"; }
#endif

PeakSampler::PeakSampler(int interval_ms) {
    peak_ = current_memory_bytes();
    thread_ = std::thread([this, interval_ms] {
        while (!stop_.load()) {
            const uint64_t cur = current_memory_bytes();
            uint64_t prev = peak_.load();
            while (cur > prev && !peak_.compare_exchange_weak(prev, cur)) {}
            std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
        }
    });
}

PeakSampler::~PeakSampler() {
    stop_ = true;
    if (thread_.joinable()) thread_.join();
}

void PeakSampler::reset() { peak_ = current_memory_bytes(); }

namespace {

uint32_t le32(const uint8_t * p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24); }
uint16_t le16(const uint8_t * p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }

std::vector<float> resample_to_16k(const std::vector<float> & wav, int sr) {
    if (sr == 16000) return wav;
    const double dur = wav.size() / static_cast<double>(sr);
    const size_t n16 = static_cast<size_t>(std::llround(dur * 16000.0));
    std::vector<float> out(n16);
    // np.interp over x_old = linspace(0, dur, len, endpoint=False)
    for (size_t i = 0; i < n16; ++i) {
        const double t = i / 16000.0;
        const double pos = t * sr;
        const size_t i0 = static_cast<size_t>(pos);
        if (i0 + 1 >= wav.size()) { out[i] = wav.empty() ? 0.f : wav.back(); continue; }
        const double frac = pos - i0;
        out[i] = static_cast<float>(wav[i0] * (1.0 - frac) + wav[i0 + 1] * frac);
    }
    return out;
}

} // namespace

std::vector<float> read_wav_16k_mono_from_memory(const uint8_t * d, size_t size, int * original_rate) {
    if (size < 12 || std::memcmp(d, "RIFF", 4) != 0 || std::memcmp(d + 8, "WAVE", 4) != 0) {
        throw std::runtime_error("not a RIFF/WAVE file");
    }
    uint16_t fmt = 0, channels = 0, bits = 0;
    uint32_t rate = 0;
    const uint8_t * data = nullptr;
    size_t data_size = 0;
    size_t pos = 12;
    while (pos + 8 <= size) {
        const uint32_t sz = le32(d + pos + 4);
        const uint8_t * body = d + pos + 8;
        if (pos + 8 + sz > size) break;
        if (std::memcmp(d + pos, "fmt ", 4) == 0 && sz >= 16) {
            fmt = le16(body);
            channels = le16(body + 2);
            rate = le32(body + 4);
            bits = le16(body + 14);
            if (fmt == 0xFFFE && sz >= 40) fmt = le16(body + 24);  // WAVE_FORMAT_EXTENSIBLE subformat
        } else if (std::memcmp(d + pos, "data", 4) == 0) {
            data = body;
            data_size = sz;
        }
        pos += 8 + sz + (sz & 1);
    }
    if (!data || channels == 0 || rate == 0) throw std::runtime_error("missing fmt/data chunk");
    const size_t bytes_per_sample = bits / 8;
    const size_t frames = data_size / (bytes_per_sample * channels);
    std::vector<float> mono(frames);
    for (size_t f = 0; f < frames; ++f) {
        double acc = 0;
        for (size_t c = 0; c < channels; ++c) {
            const uint8_t * s = data + (f * channels + c) * bytes_per_sample;
            if (fmt == 1 && bits == 16) acc += static_cast<int16_t>(le16(s)) / 32768.0;
            else if (fmt == 1 && bits == 32) acc += static_cast<int32_t>(le32(s)) / 2147483648.0;
            else if (fmt == 3 && bits == 32) { float v; std::memcpy(&v, s, 4); acc += v; }
            else throw std::runtime_error("unsupported WAV sample format");
        }
        mono[f] = static_cast<float>(acc / channels);
    }
    if (original_rate) *original_rate = static_cast<int>(rate);
    return resample_to_16k(mono, static_cast<int>(rate));
}

std::vector<float> read_wav_16k_mono(const std::string & path, int * original_rate) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("cannot open " + path);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    return read_wav_16k_mono_from_memory(bytes.data(), bytes.size(), original_rate);
}

} // namespace r2t2
