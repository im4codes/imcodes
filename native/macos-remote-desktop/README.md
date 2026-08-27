# macOS remote-desktop build spike

This directory is a compile/link gate, not the production macOS worker. It
proves that the one repository-pinned upstream libwebrtc checkout can be linked
into an Objective-C++ executable that also links ScreenCaptureKit and
VideoToolbox. It does not introduce another WebRTC package, framework or media
transport.

## Supported baseline

- Minimum deployment target: **macOS 12.3** (`MACOSX_DEPLOYMENT_TARGET=12.3`,
  GN `mac_deployment_target="12.3"`, and `mac_min_system_version="12.3"`).
  This is ScreenCaptureKit's actual platform floor and keeps Intel machines on
  Monterey 12.3 or newer eligible without a separate legacy implementation.
- Architectures: separate **arm64** and **x64** compile/link results.
- WebRTC source: exactly the revisions in
  `shared/remote-desktop-native-pins.json`. The script refuses another WebRTC
  or depot_tools commit.

## CI requirements

Run the full probe on native Apple Silicon and Intel machines. The build SDK
must contain every API referenced by the pinned WebRTC revision; the runtime
may remain on macOS 12.3 or newer because availability is enforced by the
deployment target. `IMCODES_MACOS_SDK_PATH` supplies a modern SDK on an older
build host without upgrading that host's OS.

| Runner | `uname -m` | Probe architecture | GN `target_cpu` |
| --- | --- | --- | --- |
| Apple Silicon | `arm64` | `arm64` | `arm64` |
| Intel Mac | `x86_64` | `x64` | `x64` |

Rosetta or an Apple-Silicon cross-link is useful as an SDK smoke check but does
not replace the native Intel job. Each runner needs a synced checkout at the
pinned WebRTC revision and depot_tools at its pinned revision; no runtime SDK,
compiler, codec or WebRTC download is performed by the probe.

```bash
scripts/macos-remote-desktop-build-spike.sh \
  --arch arm64 \
  --webrtc-root /path/to/pinned/src \
  --depot-tools-root /path/to/pinned/depot_tools
```

`--apple-framework-only` is a bounded local diagnostic that compile/links the
same source against ScreenCaptureKit and VideoToolbox without WebRTC. It is not
evidence that the pinned WebRTC link succeeded and cannot satisfy task 1.2 by
itself.
