# R2T2 on-device feasibility spike (tasks 1.1–1.4, 1.7)

This is throwaway spike code for `openspec/changes/mobile-local-voice-asr-translator`.
It answers one question: can Confucius4-R2T2 (Qwen3-ASR 1.7B fine-tune,
GGUF Q4_K_M + mmproj Q8_0) run the upstream streaming algorithm through
llama.cpp + mtmd on an iPhone and an Android phone?

Nothing here is linked into `web/` or the production mobile projects.
Model weights are never committed (see `.gitignore`).

## Pins (`PINS.env`, read by every script)

| What | Pin |
|---|---|
| llama.cpp | `b10950` = `ad6c66839af3c5646fba8c6c2e2087a1e4e38948` (the build upstream `r2t2_llama` ships) |
| iOS framework | official `llama-b10950-xcframework.zip`, SHA-256 `13bc0b9a…c27c3` (ios-arm64 + macOS, Metal, includes mtmd, **min iOS 16.4**) |
| Upstream R2T2 code | `netease-youdao/Confucius4-R2T2` @ `26d55a54ce5670cff9947a167d8ed95d569fd4d9` (Apache-2.0) |
| Weights | `netease-youdao/Confucius4-R2T2-GGUF` @ `86ff0251…`: `Confucius4-R2T2-Q4_K_M.gguf` (1,107,404,736 B, sha256 `fa3cb46c…6466`), `mmproj-Confucius4-R2T2-Q8_0.gguf` (348,336,544 B, sha256 `8dc2c67e…cb65`). NetEase Youdao Model Use License. |
| Reference-only | HF processor files @ `185ce639…`, `qwen-asr==0.0.6` |
| Android | NDK `27.2.12479018` (r27c), CMake `3.22.1`, `android-28`, arm64-v8a, `armv8.2-a+dotprod+fp16`, KleidiAI `v1.24.0` (pre-fetched, md5 pinned); AGP 8.13.2, Kotlin 2.2.21, Gradle 8.14.3, JDK 17 |

## Layout

```
PINS.env                 all pins
core/                    shared C++ (both apps + CLI)
  r2t2_engine.*          llama.cpp + mtmd one-shot generate (port of upstream native_ext.cpp generate_once)
  r2t2_stream.*          1:1 port of upstream streaming (r2t2_asr.py) + example.py run_streaming schedule
  r2t2_text.*            port of the Python text post-processing (punctuation, CJK spaces, parse_asr_output, repetition fix)
  r2t2_metrics.*         memory (phys_footprint on Apple, VmRSS/VmHWM on Android), WAV reader
  r2t2_harness.*         C API used by Swift/JNI: load / oneshot / stream / live_start|push|stop / cancel, JSON results
cli/r2t2_cli.cpp         host + adb CLI (modes oneshot|stream|both|live)
tests/                   180 text post-processing cases generated from the upstream Python (text_test.cpp)
reference/               runner for the UNMODIFIED upstream stream_llama route + recorded results
ios/                     SwiftUI harness (XcodeGen project.yml; the generated .xcodeproj is gitignored)
android/                 Kotlin harness (plain views), JNI over core/, microphone foreground service
samples/                 zh_upstream_test.wav (upstream resources/test.wav), en_tts.wav, zh_quiet_onset.wav
scripts/                 fetch / build / reference / conformance scripts (all bash, capped -j = ncpu/2)
EVAL-llama-cpp-capacitor.md   task 1.7 evaluation + D1 recommendation
.cache/                  (gitignored) checkouts, weights, venv, build trees
```

## Scripts

Run everything from `spikes/r2t2-mobile/` with `bash` (the scripts are bash, not zsh or fish).

| Script | Does |
|---|---|
| `scripts/fetch-deps.sh` | llama.cpp @ pin, upstream R2T2 @ pin, official xcframework (sha256-verified), KleidiAI tarball (md5-verified) |
| `scripts/fetch-model.sh` | GGUF pair into `.cache/models/gguf/`. Size and sha256 are verified. Reuses `~/.cache/huggingface` if present; `HF_ENDPOINT=https://hf-mirror.com` works as a mirror. |
| `scripts/build-host.sh` | macOS Metal build of `r2t2-cli` + `r2t2-text-test` → `.cache/build-host/` |
| `scripts/setup-reference.sh`, `scripts/run-reference.sh` | Python 3.12 venv and the upstream pybind extension, built against the pinned llama.cpp with Metal. Then runs the upstream route unmodified (a `vllm` shim only supplies `SamplingParams`). |
| `scripts/conformance.sh` | Upstream vs C++ on the clip matrix. Byte-compares transcripts and per-step decode traces; writes `reference/results/`. |
| `scripts/build-ios-xcframework.sh [--from-source --min-ios 15.0]` | Official framework by default. `--from-source` builds a patched copy of upstream `build-xcframework.sh`. |
| `scripts/build-ios-app.sh [--install]` | XcodeGen + `xcodebuild -sdk iphoneos`. `UNSIGNED=1` does a compile/link check only. `--install` targets the connected iPhone/iPad; `DEVICE=` overrides it. |
| `scripts/build-android-libs.sh` | NDK arm64 build of llama.cpp + mtmd + `r2t2-cli` for `adb shell`. Output: `.cache/android-libs/arm64-v8a/`. `VULKAN=1` builds the optional Vulkan variant (see Findings). |
| `scripts/build-android-app.sh [--install]` | Gradle `assembleDebug` → `android/app/build/outputs/apk/debug/app-debug.apk` |

## What was built and run here (macOS host, Apple M2 Pro 16 GB, macOS 26.2, Xcode 26.2)

### Streaming port conformance (task 1.3)

Command: `scripts/conformance.sh`. Both sides use Metal and the same pinned
llama.cpp. For each case the full stdout (every `text=` line,
`finish state.text=`, `final_result=`) and the per-step
`audio_samples / max_tokens / text` decode trace were compared.

| clip.language | result | steps | final |
|---|---|---|---|
| zh_upstream_test.Chinese | IDENTICAL | 42 | 之前有顾客自己带酒水也没加收钱或者不让喝。 |
| zh_upstream_test.auto | IDENTICAL | 42 | same |
| en_tts.English | IDENTICAL | 32 | The quarterly report is due on Friday, so please send me your numbers by Wednesday afternoon. |
| en_tts.auto | IDENTICAL | 32 | same |
| zh_quiet_onset.Chinese | IDENTICAL | 45 | 之前有顾客自己带酒水，也没加收钱或者不让喝。 |

- The upstream reference is deterministic across 3 runs.
- One-shot matches upstream `onetime_llama` exactly for zh and en.
- Text post-processing: 180/180 cases pass (`r2t2-text-test`).
- Note: upstream `example_llama.py` defaults `--language` to **Chinese**, not
  auto. The ports are compared with an explicit language.

### Performance on macOS (`reference/results/perf-macos/`, 4 threads, n_ctx 4096)

| run | load ms | RAM after load MB | one-shot ms (enc/prefill/dec) | decode tok/s | one-shot RTF | stream step p50/p90/max ms @160 ms | stream compute RTF |
|---|---|---|---|---|---|---|---|
| zh Metal | 379 | 884 | 340 (77/82/174) | 97.5 | 0.05 | 169/201/211 | 1.06 |
| en Metal | 396 | 884 | 380 (100/81/192) | 99.2 | 0.07 | 159/194/221 | 1.01 |
| zh CPU | 837 | 1925 | 1219 (421/527/239) | 71.2 | 0.18 | 659/1552/2657 | 4.93 |
| en CPU | 1031 | 1925 | 1300 (498/491/280) | 67.9 | 0.25 | 547/817/914 | 3.48 |

Chunk sweep (`perf-macos/chunk-sweep/`). Settings: real-time pacing, 5× the
zh clip (33.7 s), a new utterance per clip, lookahead 160 ms. Compute RTF is
step compute time divided by audio duration; above 1 means the backlog keeps
growing.

| backend | chunk 160 | 320 | 640 | 1000 ms |
|---|---|---|---|---|
| Metal: compute RTF / max lag | 1.04 / 1.8 s | **0.55 / 0.27 s** | 0.32 / 0.28 s | 0.20 / 0.26 s |
| CPU 4 thr: compute RTF / max lag | 4.12 / 104 s | 2.07 / 36 s | 1.17 / 6.5 s | **0.80 / 1.6 s** |

### Android arm64 (NDK build) on an arm64 Android 15 emulator. Correctness only.

`reference/results/android-emulator/summary.txt`:

- `r2t2-text-test`: 180/180 pass.
- CLI one-shot: output identical to upstream.
- Streaming: final transcripts IDENTICAL for zh and en. Intermediate steps
  differ from the Metal reference at a few near-tie greedy steps (6/32 en,
  2/42 zh). The Mac **CPU** build of the same C++ also differs from Metal (5
  steps each), so this is ggml backend numerics, not the port.
- The APK was installed and driven through its UI on the emulator. The app's
  own `results/runs.jsonl` was pulled to
  `reference/results/android-emulator/app-runs.jsonl`:
  - **Load model**: 6619 ms, app default 2 threads (`max(2, min(cores-2, 6))`
    on the 4-core emulator).
  - **1.2 One-shot** (zh sample) gives the transcript identical to upstream.
  - **1.3 Streaming** at 320 ms, 21 steps, gives the identical final transcript.
- Emulator timings and battery are not device numbers.
- Peak RSS on Android CPU is **2901–3076 MB** in the CLI runs (4 threads) and
  **3072–3215 MB** in the app runs (2 threads). macOS CPU is 1.9–2.1 GB
  (see Findings).

### iOS

- The official b10950 xcframework was fetched and verified.
- `UNSIGNED=1 scripts/build-ios-app.sh` builds `R2T2Harness.app`: arm64,
  8.8 MB, embeds `llama.framework`, bundles the samples, min iOS 16.4.
- `--from-source --min-ios 15.0` also builds (ios-arm64 slice,
  `minos 15.0`).
- Not signed, installed, or run on a phone here. The login keychain was locked
  (signing hung in `GatherProvisioningInputs`), and the paired iPhone 12 Pro
  was unavailable.

## Owner: install and measure on a real iPhone

Prerequisites:
- A Mac with Xcode 26.x.
- `brew install xcodegen`.
- An iPhone on iOS ≥ 16.4 with Developer Mode on (Settings › Privacy &
  Security › Developer Mode).
- Xcode signed in to an Apple ID in team **M675E26Q67**.

1. Fetch dependencies:
   ```bash
   cd spikes/r2t2-mobile
   bash scripts/fetch-deps.sh
   security unlock-keychain ~/Library/Keychains/login.keychain-db   # signing hangs on a locked keychain
   ```
2. Connect the iPhone by USB, unlock it, and tap "Trust". Then:
   ```bash
   bash scripts/build-ios-app.sh --install
   ```
   `--install` picks a reachable, paired iPhone/iPad from
   `xcrun devicectl list devices --json-output`. It skips "unavailable" stale
   pairings, the Apple Watch and other device types, and prefers an active or
   USB connection. It prints every device with the reason it was taken or
   skipped. To choose explicitly:
   `DEVICE=<udid|identifier|name> bash scripts/build-ios-app.sh --install`.
   Alternatively, run `bash scripts/build-ios-app.sh` once to generate the
   project, then `open ios/R2T2Harness.xcodeproj`, pick the iPhone, and press
   ⌘R. If Xcode asks for the iOS platform or device-support component, install
   it from Xcode › Settings › Components.
3. Get the model onto the phone. Either:
   - in the app, pick huggingface.co (or hf-mirror.com) and tap **Download
     pinned model** (1.4 GB; size and SHA-256 verified), or
   - run `bash scripts/fetch-model.sh`, then Finder › iPhone › Files ›
     R2T2Harness, drag both `.gguf` files from `.cache/models/gguf/` in, and
     tap **Rescan Documents**.
4. Turn on **Metal GPU**, then tap **Load model**. Then run:
   - **1.2 One-shot**: 3× on each sample.
   - **1.3 Streaming (fast)**: at chunk 160 and 320.
   - **1.4 Sustained 10 min**: sample loop, real time, 320 ms.
   - **Live**: tap Start live, lock the screen, leave it unplugged 60 min,
     unlock, then tap Stop live. Note the battery % before and after.
5. Copy `results/` (`runs.jsonl` and the `*.csv` battery/thermal logs,
   sampled every 30 s) from Finder › iPhone › Files › R2T2Harness to
   `reference/results/devices/<device>/`.

## Owner: install and measure on a real Android phone

Prerequisites:
- An arm64 phone on Android ≥ 9 with USB debugging on.
- Android SDK at `~/Library/Android/sdk` with `ndk;27.2.12479018`,
  `cmake;3.22.1`, `platform-tools`.
- JDK 17 (`brew install openjdk@17`).

1. Build and install:
   ```bash
   cd spikes/r2t2-mobile
   bash scripts/fetch-deps.sh
   bash scripts/build-android-app.sh --install      # CPU build
   ```
2. Push the model. Either:
   - run `bash scripts/fetch-model.sh`, then
     ```bash
     F=/sdcard/Android/data/com.im.codes.spike.r2t2harness/files
     adb shell mkdir -p $F
     adb push .cache/models/gguf/Confucius4-R2T2-Q4_K_M.gguf .cache/models/gguf/mmproj-Confucius4-R2T2-Q8_0.gguf $F/
     ```
   - or, in the app, tap **Download pinned model**.
3. In the app, tap **Load model**, then run the same **1.2 / 1.3 / 1.4**
   buttons as on iOS. For **Start / stop live**, grant the microphone and
   notification permissions; it runs as a microphone foreground service with a
   partial wake lock, so it keeps running with the screen locked.
4. Pull the results:
   ```bash
   adb pull $F/results reference/results/devices/<device>/
   ```
5. Optional CLI (thread-count sweeps, no app). The app picks
   `max(2, min(cores-2, 6))` threads.
   ```bash
   bash scripts/build-android-libs.sh
   D=/data/local/tmp/r2t2
   adb shell mkdir -p $D
   adb push .cache/android-libs/arm64-v8a/lib .cache/android-libs/arm64-v8a/bin samples $D/
   adb push .cache/models/gguf/*.gguf $D/
   adb shell "cd $D && LD_LIBRARY_PATH=lib bin/r2t2-cli --model Confucius4-R2T2-Q4_K_M.gguf \
     --mmproj mmproj-Confucius4-R2T2-Q8_0.gguf --wav samples/zh_upstream_test.wav --mode both \
     --language Chinese --threads 4 --cpu --chunk-ms 320 --json out.json"
   ```

## Measurement table (tasks 1.2–1.4)

For each device, fill these in from `runs.jsonl`:
- `load_ms`, `mem_peak_mb`
- one-shot `latency_ms` / `tok_per_s`
- stream `step_ms_p50/p90` / `compute_rtf` / `max_lag_ms`
- sustained `max_backlog_sec` / thermal from the CSV
- live battery Δ from the CSV

| device | backend | load ms | peak RAM MB | one-shot latency ms (6.7 s zh) | decode tok/s | stream step p50/p90 ms @160 / @320 | compute RTF @160 / @320 | 10-min sustained: max lag, thermal end | 60-min locked live: battery Δ %, thermal, max backlog s |
|---|---|---|---|---|---|---|---|---|---|
| macOS M2 Pro (reference) | Metal | 379 | 904 | 340 | 97.5 | 162/199 / 183/213 | 1.04 / 0.55 | n/a | n/a |
| macOS M2 Pro (reference) | CPU 4 thr | 837 | 2076 | 1219 | 71.2 | 624/985 / 642/1004 | 4.12 / 2.07 | n/a | n/a |
| Android emulator (correctness only) | CPU 4 thr (CLI) / 2 thr (app) | 4.7–9.2 k | 2901–3076 (CLI) / 3072–3215 (app) | not representative | not representative | not representative | not representative | n/a | n/a |
| iPhone (owner) | Metal | | | | | | | | |
| Android phone (owner) | CPU | | | | | | | | |

Pass/fail criteria are in the design doc. Streaming is usable when the
compute RTF at the chosen chunk size is < 1 with headroom (≤ 0.7) and the
10-min run has no growing backlog.

## Findings

1. **The streaming algorithm ports exactly.** The C++ loop reproduces upstream
   byte-for-byte on the same backend, including all post-processing. It needs
   no Python, torch, or vllm on the device.
2. **160 ms chunks are not real-time even on Apple-Silicon Metal (RTF
   1.04–1.06).** Upstream re-encodes all accumulated audio and re-prefills the
   prompt on every step, so per-step cost grows with the utterance.
   - 320 ms chunks give RTF 0.55 on Metal.
   - CPU needs ≈1000 ms chunks (RTF 0.80 on M2 Pro performance cores).

   Phones will be slower than an M2 Pro. Plan for 320–640 ms on iPhone GPU
   and ≥1 s (or a non-streaming fallback) on Android CPU until measured.
3. **Utterances need hard segmentation.** Re-feeding the whole utterance makes
   step cost linear in its length. With n_ctx 4096 the ceiling is about 5 min.
   The live mode therefore restarts the utterance every 30 s (a VAD/endpointer
   would be better).
4. **"Fixed" text is not strictly append-only.** Upstream's fixed prefix can
   shrink or rewrite: 1–2 regressions per clip, 10 per 33.7 s at 160/320 ms,
   0 at ≥640 ms. The product needs its own committed prefix (the harness
   tracks one, see `fixed_regressions` / `committed`) rather than trusting
   upstream `fixed_text`.
5. **iOS minimum is 16.4 with the official xcframework.** The design says
   15.0. A from-source build with `--min-ios 15.0` compiles; running it on an
   iOS 15 device is untested.
6. **Android CPU peak RSS is 2.9–3.2 GB versus 1.9–2.1 GB on macOS CPU.** The likely
   cause is CPU weight repacking (REPACK/KleidiAI extra buffers) on top of the
   mmapped weights. This is not investigated; try `use_mmap=false` or turning
   off extra buffer types before judging 6 GB phones. On 4 GB phones, one-shot
   / CPU looks infeasible.
7. **Android Vulkan is not built.** `VULKAN=1` needs `glslc` (wired to the NDK
   shader-tools) and `vulkan.hpp`, which the NDK sysroot lacks. The fix is to
   pin Vulkan-Headers (≈1.3.275) and add them to the include path. Left
   undone: it is optional, and Adreno/Mali Vulkan performance for ggml is
   uneven.
8. **Load time is sub-second on Mac** and 4.7–9 s on the emulator (cold page
   cache). The first real-device load after install is expected to be the
   slowest; the app records every load.
9. **`llama-cpp-capacitor` cannot load this model** (no `qwen3a` projector).
   Recommendation: build our own thin plugin; see
   `EVAL-llama-cpp-capacitor.md`.
