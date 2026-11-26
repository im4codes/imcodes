// Process memory probes shared by the harnesses.
//   Apple (iOS/macOS): TASK_VM_INFO phys_footprint (what jetsam and Xcode's
//                      memory gauge count) and ledger_phys_footprint_peak.
//   Android/Linux:     /proc/self/status VmRSS and VmHWM (peak resident).
// A background sampler also tracks the max current value for platforms where
// the kernel peak is unavailable.
#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>

namespace r2t2 {

uint64_t current_memory_bytes();
uint64_t peak_memory_bytes();       // kernel-reported lifetime peak (0 if unavailable)
std::string memory_source();        // "phys_footprint" | "VmRSS/VmHWM"

class PeakSampler {
public:
    explicit PeakSampler(int interval_ms = 50);
    ~PeakSampler();
    uint64_t peak() const { return peak_.load(); }
    void reset();

private:
    std::atomic<bool> stop_{false};
    std::atomic<uint64_t> peak_{0};
    std::thread thread_;
};

// Minimal WAV reader (PCM16 / PCM32 / float32, any channel count, any rate).
// Mixes to mono and resamples to 16 kHz with linear interpolation (the same
// method as upstream example.py _resample_to_16k). Throws on unsupported input.
std::vector<float> read_wav_16k_mono(const std::string & path, int * original_rate = nullptr);
std::vector<float> read_wav_16k_mono_from_memory(const uint8_t * data, size_t size, int * original_rate = nullptr);

} // namespace r2t2
