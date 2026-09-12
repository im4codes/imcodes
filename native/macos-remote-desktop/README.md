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
