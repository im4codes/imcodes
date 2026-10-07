# macOS remote-desktop components

The shipped macOS components — worker, launch agent, disclosure and virtual
display helper — link libwebrtc. Building that from source needs a full pinned
WebRTC checkout: roughly 25GB and half an hour before a single component
compiles, which is not something ordinary CI can do per commit.

So it is done once. The upstream objects are compiled against the pinned
revision, archived, published as an immutable release, and consumed from then
on. That is two scripts.

## Consuming the SDK (this is how the components are built)

```bash
bash native/macos-remote-desktop/build-worker-from-sdk.sh \
  --sdk-root /path/to/installed/sdk \
  --artifact-root dist-node-exe/remote-desktop-worker/darwin-arm64 \
  --target-cpu arm64
```

No checkout, no gn, no ninja. The SDK is installed from its published release:

```bash
lock=native/macos-remote-desktop/libwebrtc-sdk-arm64.lock.json
gh release download "$(node -p "require('./$lock').releaseTag")" \
  --repo im4codes/imcodes \
  --pattern "$(node -p "require('./$lock').assetName")" --dir /tmp/dl
node scripts/install-libwebrtc-sdk.mjs --target macos-arm64 \
  /tmp/dl/imcodes-libwebrtc-sdk-macos-arm64.tar.gz /tmp/sdk
```

`install-libwebrtc-sdk.mjs` verifies the lock against the archive before
extracting anything and against every extracted file's digest afterwards.

**Every compile flag comes from the SDK's own `sdk-compile-flags.json`**, which
records the configuration GN used to build those objects. Do not assemble a
flag set by hand. A hand-assembled one compiles cleanly, links with zero
undefined symbols, and segfaults inside a WebRTC constructor, because one
omitted define changes a struct layout.

The SDK also carries three things `libwebrtc.a` does not contain, each absent
for its own reason:

- `libimcodes_macos_libcxx_runtime_sdk.a` — libc++ is linked at a final link
  step and never archived, and the system libc++ cannot substitute because
  these objects live in Chromium's `std::__Cr` inline namespace.
- `libjsoncpp.a` — upstream declares it `source_set`, so it produces objects
  and never an archive, and `//:webrtc` does not depend on it at all.
- the clang that compiled the objects, because they were built against that
  bundled libc++.

That compiler is a binary for the architecture of the machine that produced the
SDK, not of the target. Both SDKs are cross-compiled on Apple silicon, so the
x64 SDK ships an arm64 clang and cannot be used on an Intel builder. The
consumer checks `toolchain.hostArch` and refuses rather than failing later with
"bad CPU type in executable".

## Producing the SDK

Only needed when `shared/remote-desktop-native-pins.json` moves, or when one of
the fingerprint inputs in `scripts/libwebrtc-sdk-targets.mjs` changes.

```bash
bash native/macos-remote-desktop/build-libwebrtc-sdk.sh \
  --checkout-root /path/for/depot_tools+src \
  --artifact-root /path/for/sdk \
  --target-cpu arm64
```

It needs `HOME` set, a working network path to `chromium.googlesource.com`,
`webrtc.googlesource.com`, `chrome-infra-packages.appspot.com` and
`storage.googleapis.com`, and a host Xcode. One architecture per run: the
components ship thin, because the build plan sets `universalBinary = false`
and the runtime verifier rejects a fat Mach-O.

Publishing is `scripts/publish-libwebrtc-sdk.mjs` followed by
`scripts/promote-libwebrtc-sdk.mjs`, which creates the immutable release and
advances the committed lock.

## Video codec: VP9 on Macs with no hardware H.264 (and its kill switch)

A Mac whose only H.264 encoder is Apple's software one (an Intel Mac Pro, say)
encodes slowly and blurrily. On such a Mac a viewer is sent **VP9** (VP8 if the
browser has no VP9), encoded by the libvpx that ships inside the pinned libwebrtc
SDK, instead. Everything else -- packetization, RTCP, pacing, congestion control --
is libwebrtc's, as for H.264.

A route uses it only when **all** hold:

- the setting below is `auto` (the default);
- VideoToolbox cannot create a hardware H.264 session (a Mac that has one keeps it,
  unchanged);
- the capture honours the encoder's size (CGDisplayStream, macOS < 13). On the
  ScreenCaptureKit path (macOS >= 13, e.g. a VM without a hardware encoder) the
  route stays on H.264 exactly as before, because nothing scales raw frames.

The worker logs one line per route: `macos_remote_desktop_worker_raw_codecs
allowed=<0|1> reason=<allowed|hardware_h264|capture_cannot_scale|disabled_by_setting>`.

### Kill switch

`rawCodecs` is `auto` (default) or `off`; `off` restores the H.264 behaviour
exactly. Read by the worker for every new route, so a change applies to the **next
remote-desktop session** with no restart of the worker or of the OS session. First
statement wins:

1. environment variable `IMCODES_RD_RAW_CODECS=auto|off` of the worker;
2. the line `rawCodecs=off` in `remote-desktop-video.conf` in the state directory of
   the user the worker runs as (`$IMCODES_HOME`, else `$HOME/.imcodes`); blank lines
   and `#` comments are allowed, nothing else in the file is read;
3. the default, `auto`.

An unrecognised value is ignored (and reported on the log line), never treated as
`off`.

### What is actually encoding (worker log and HUD)

The viewer's status bar shows the real encoder, e.g. `Encoder: VP9 (software, libvpx)`,
`Encoder: H.264 (hardware)` or `Encoder: H.264 (software)`, and says so when the kill
switch (or a capture that cannot scale) is why it is H.264. It comes from a message of
its own, `remote_desktop.data.encoder` (codec, implementation, name, threads, the
raw-codec decision), sent when the control channel opens and again once the encoder is
up, only when it changes. It is a separate message rather than extra keys on the quality
message on purpose: every web validates the quality message with an exact key set, so an
extra key would blank the status bar of an older web, whereas an older web silently
ignores a data-message type it does not know. A node that does not send it (older macOS,
Windows, Linux) leaves the old `Encoder: software` text.

The worker's stderr goes to `/dev/null`, so the same facts are appended, one line each, to
`worker-video.log` in the node's per-user runtime directory
(`/private/var/run/imcodes-node/user-sessions/<uid>/remote-desktop/`, mode 0700, owned by
the session's user; the node reads it as root). Lines are `<UTC timestamp> event=<decision|
encoder|encoder_changed> codec= implementation= name= threads= size= raw_codecs=
setting_source= nv12_capture= invalid_value_ignored=`: no secrets, nothing from the screen.
The file is capped at 64 KiB (the previous one is kept as `worker-video.log.1`), opened
`O_NOFOLLOW`, mode 0600.

### NV12 capture (opt-in)

By default the capture stays BGRA for both codecs: VP9 converts BGRA to I420 once
with libyuv (a few milliseconds), and an H.264 fallback is fed the capture directly,
with no conversion back. Asking the capture for NV12 (420v, BT.709) instead saves
capture bandwidth but is unproven against a real capture, so it is opt-in for A/B
measurement: `IMCODES_RD_NV12=on|off`, or `nv12Capture=on` in the same file, resolved
exactly like `rawCodecs` (each key on its own). With it on, an H.264 fallback converts
each frame back to BGRA.

```sh
mkdir -p ~/.imcodes && printf 'rawCodecs=off\n' > ~/.imcodes/remote-desktop-video.conf   # back to H.264
rm ~/.imcodes/remote-desktop-video.conf                                                  # back to auto
```

## Supported baseline

- Minimum deployment target: **macOS 12.3** (`mac_deployment_target="12.3"`).
  This is ScreenCaptureKit's platform floor and keeps Intel machines on
  Monterey 12.3 or newer eligible without a separate legacy implementation.
- Architectures: separate **arm64** and **x64** artifacts, each thin.
- WebRTC source: exactly the revisions in
  `shared/remote-desktop-native-pins.json`. Both scripts refuse any other
  WebRTC or depot_tools commit.
- The host supplies the macOS SDK (system headers and frameworks) through
  `xcrun`. The SDK records the version it was built against; a different minor
  version is normally fine and is reported rather than enforced.

## The build spike

`scripts/macos-remote-desktop-build-spike.sh` predates the SDK and still
requires a synced pinned checkout. It remains useful as a compile/link gate
against the upstream graph itself, but it is not how the shipped components are
built and it is not needed to build them.

The spike enforces its own rule, which the SDK path does not share: a full
probe must run on a runner of the architecture being probed, because it is
proving that this machine's toolchain and SDK can compile and link the pinned
graph natively.

| Runner | `uname -m` | Probe architecture | GN `target_cpu` |
| --- | --- | --- | --- |
| Apple Silicon | `arm64` | `arm64` | `arm64` |
| Intel Mac | `x86_64` | `x64` | `x64` |

Rosetta or an Apple-Silicon cross-link is useful as an SDK smoke check but does
not replace the native Intel job. `IMCODES_MACOS_SDK_PATH` supplies a modern
SDK on an older build host without upgrading that host's OS.

```bash
scripts/macos-remote-desktop-build-spike.sh \
  --arch arm64 \
  --webrtc-root /path/to/pinned/src \
  --depot-tools-root /path/to/pinned/depot_tools
```

`--apple-framework-only` is a bounded local diagnostic that compile/links the
same source against ScreenCaptureKit and VideoToolbox without WebRTC. It is not
evidence that the pinned WebRTC link succeeded.
