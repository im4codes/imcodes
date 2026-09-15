#!/usr/bin/env node
/**
 * The single source of truth for every immutable libwebrtc foundation SDK
 * producer target.
 *
 * Each entry carries the whole per-platform contract -- fingerprint inputs,
 * expected staging layout, GN arguments, archive name, release tag shape and
 * repository lock location -- so that the artifact, publish, promote and
 * resolve scripts contain no platform literals of their own. Adding a producer
 * is a new entry here, never a new branch in four scripts.
 *
 * WARNING: `sourceInputs`, and only `sourceInputs`, determines a target's SDK
 * identity. Editing that list for a target whose SDK has already been published
 * invalidates an immutable release and forces a multi-hour rebuild.
 */

const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function escapeForRegExp(value) {
  return value.replace(REGEXP_METACHARACTERS, '\\$&');
}

// The Windows fingerprint input list, byte-for-byte and order-for-order as the
// already-published windows-x64 SDK release was hashed. Do not reorder.
const WINDOWS_SOURCE_INPUTS = [
  'shared/remote-desktop-native-pins.json',
  'native/windows-remote-desktop/sdk.BUILD.gn',
  'native/windows-remote-desktop/libwebrtc-sdk.gni',
  'native/windows-remote-desktop/sdk_anchor.cc',
  'native/windows-remote-desktop/load-native-pins.ps1',
  'native/windows-remote-desktop/initialize-hermetic-windows-git.ps1',
  'native/windows-remote-desktop/invoke-native-logged.ps1',
  'native/windows-remote-desktop/build-libwebrtc-sdk.ps1',
  'native/windows-remote-desktop/generate-libwebrtc-sdk-notices.py',
];

const MACOS_SOURCE_INPUTS = [
  'shared/remote-desktop-native-pins.json',
  'native/macos-remote-desktop/sdk.BUILD.gn',
  'native/macos-remote-desktop/libwebrtc-sdk.gni',
  'native/macos-remote-desktop/sdk_anchor.cc',
  'native/macos-remote-desktop/build-libwebrtc-sdk.sh',
  // The notices the SDK ships are as much part of its identity as its objects:
  // a change to how they are derived must produce a different SDK, exactly as
  // the Windows list ends with its own generator.
  'scripts/generate-macos-libwebrtc-notices.py',
];

/**
 * The GN target inventory the macOS SDK's THIRD_PARTY_NOTICES.webrtc.md must
 * declare, compared byte-for-byte against the generator's own
 * `",".join(sorted(...))`.
 *
 * One label, because the SDK's payload is one artifact: `obj/libwebrtc.a`, the
 * archive `//:webrtc` produces. The producer's overlay target only pulls that
 * label into the graph -- GN does not re-expand a `complete_static_lib`
 * dependency, so the overlay's own archive is an anchor object and nothing
 * else, and describing it would certify an empty closure.
 *
 * Deliberately NOT the four product executable labels: those belong to the
 * product build's notices, and reusing them here would claim the SDK ships
 * IM.codes executables it does not contain.
 *
 * The toolchain the SDK also redistributes -- clang, ld64.lld, llvm-ar,
 * llvm-strip, libclang_rt.osx.a and the bundled libc++ headers -- has no GN
 * edge at all and is covered by the generator's required-redistributed set,
 * not by this list.
 */
const MACOS_SDK_LIBWEBRTC_NOTICE_TARGETS = ['//:webrtc'];

const MACOS_REQUIRED_TOP_LEVEL_ENTRIES = [
  'THIRD_PARTY_NOTICES.webrtc.md',
  'gen',
  'include',
  'lib',
  'sdk-build.json',
  // The exact flags a consumer must compile with. Omitting one does not fail
  // to link -- it segfaults inside a constructor, because the define that was
  // missed changed a struct layout.
  'sdk-compile-flags.json',
  'toolchain',
];

const MACOS_REQUIRED_FILES = [
  // Upstream's own `//:webrtc` archive, not the overlay wrapper's. GN does not
  // re-expand a `complete_static_lib` dependency, so the wrapper archive holds
  // one anchor object and two kilobytes -- it stages and publishes perfectly
  // and links against nothing.
  'lib/libwebrtc.a',
  // libwebrtc.a does not contain the C++ runtime it was compiled against:
  // libc++ is linked at the final link step, never archived, so without this
  // every std::__Cr:: symbol is undefined at a consumer's link. The build's own
  // libc++.a is a thin archive pointing into the build directory, so this one
  // is re-archived from the objects.
  'lib/libimcodes_macos_libcxx_runtime_sdk.a',
  // Linked by the components through //native/remote-desktop-common and
  // contained in neither libwebrtc.a nor the runtime archive, because
  // `//:webrtc` does not depend on it.
  'lib/libjsoncpp.a',
  'lib/libimcodes_macos_libwebrtc_test_sdk.a',
  // The objects were compiled against Chromium's bundled libc++, which lives in
  // the `std::__Cr` inline namespace. A consumer using Apple clang and the
  // system libc++ mangles every name differently and matches no symbol in the
  // archive, so the compiler and its headers travel with the objects.
  // One real binary per name. `clang++` and `lld-link` are only symlinks that
  // change clang's and lld's argv[0]; staging them would duplicate 185MB into
  // an archive CI downloads on every cache miss. C++ is driven with
  // `clang --driver-mode=g++`, and `ld64.lld` is lld's Mach-O driver, which
  // must carry that exact name for `-fuse-ld=lld` to find it.
  'toolchain/bin/clang',
  'toolchain/bin/ld64.lld',
  'toolchain/bin/llvm-ar',
  'toolchain/bin/llvm-strip',
  'toolchain/lib/libclang_rt.osx.a',
  'include/buildtools/third_party/libc++/__config_site',
  'include/third_party/libc++/src/include/__config',
];

/**
 * The GN argument string the producer writes verbatim into `sdk-build.json`,
 * compared byte-for-byte at publish time.
 *
 * Quoting differs per producer and is part of the contract, not a style choice.
 * The PowerShell producer's array holds single-quoted `'target_os=\"win\"'`, so
 * the backslashes survive into `sdk-build.json`. The Bash producer builds
 * `GN_ARGS="target_os=\"mac\" ..."`, where the shell consumes the backslashes,
 * so what reaches `gn` -- and `sdk-build.json` -- has PLAIN double quotes.
 *
 * The order and single-space separation below mirror the four `GN_ARGS=`
 * concatenations in native/macos-remote-desktop/build-libwebrtc-sdk.sh.
 *
 * Deliberately absent: `use_system_xcode`. It is not a declared GN arg in the
 * pinned revision -- build_overrides/build.gni derives it from
 * should_use_hermetic_xcode.py -- so passing it makes `gn gen` fail on an
 * unknown argument.
 */
function macosBuildArgs(arch) {
  return [
    'target_os="mac"',
    `target_cpu="${arch}"`,
    'is_debug=false',
    'is_component_build=false',
    'rtc_include_tests=true',
    'rtc_build_examples=false',
    'rtc_enable_protobuf=false',
    'use_rtti=false',
    'mac_deployment_target="12.3"',
  ].join(' ');
}

function defineTarget({
  id,
  os,
  arch,
  archiveFormat,
  lockRelativePath,
  sourceInputs,
  requiredTopLevelEntries,
  requiredFiles,
  toolchainKeys,
  buildArgs,
  noticesFormat,
  noticeTargets = null,
  releaseTitlePrefix,
}) {
  const releaseTagPrefix = `libwebrtc-sdk-${id}`;
  return Object.freeze({
    id,
    os,
    arch,
    // The manifest and `sdk-build.json` describe the platform the SDK targets,
    // which is the platform that produced it. Derived, never restated.
    manifestOs: os,
    manifestArch: arch,
    archiveFormat,
    archiveFilename: `imcodes-libwebrtc-sdk-${id}.${archiveFormat}`,
    releaseTagPrefix,
    // Derived from the prefix so the tag builder and the tag validator can
    // never drift apart.
    releaseTagPattern: new RegExp(`^${escapeForRegExp(releaseTagPrefix)}-[a-f0-9]{16}-[a-f0-9]{16}$`),
    lockRelativePath,
    lockFilename: lockRelativePath.slice(lockRelativePath.lastIndexOf('/') + 1),
    sourceInputs: Object.freeze([...sourceInputs]),
    requiredTopLevelEntries: Object.freeze([...requiredTopLevelEntries]),
    requiredFiles: Object.freeze([...requiredFiles]),
    toolchainKeys: Object.freeze([...toolchainKeys]),
    buildArgs,
    noticesFormat,
    // Only the inventory-header format carries a target list; the Windows
    // notices are plain sections and have none to compare.
    noticeTargets: noticeTargets === null ? null : Object.freeze([...noticeTargets]),
    releaseTag: (sourceSha256, archiveSha256) =>
      `${releaseTagPrefix}-${sourceSha256.slice(0, 16)}-${archiveSha256.slice(0, 16)}`,
    releaseTitle: (sourceSha256) => `${releaseTitlePrefix} ${sourceSha256.slice(0, 16)}`,
  });
}

const TARGETS = Object.freeze({
  'windows-x64': defineTarget({
    id: 'windows-x64',
    os: 'win32',
    arch: 'x64',
    archiveFormat: 'zip',
    lockRelativePath: 'native/windows-remote-desktop/libwebrtc-sdk.lock.json',
    sourceInputs: WINDOWS_SOURCE_INPUTS,
    requiredTopLevelEntries: [
      'THIRD_PARTY_NOTICES.webrtc.md',
      'gen',
      'include',
      'lib',
      'sdk-build.json',
      'toolchain',
    ],
    requiredFiles: [
      'lib/imcodes_libwebrtc_sdk.lib',
      'lib/imcodes_libwebrtc_test_sdk.lib',
      'lib/imcodes_libcxx_runtime_sdk.lib',
      'toolchain/manifest/as_invoker.manifest',
      'toolchain/manifest/common_controls.manifest',
      'toolchain/manifest/compatibility.manifest',
      'toolchain/bin/clang-cl.exe',
      'toolchain/bin/lld-link.exe',
      'toolchain/bin/llvm-ml.exe',
      'toolchain/lib/clang_rt.builtins-x86_64.lib',
    ],
    toolchainKeys: ['msvc', 'windowsSdk', 'clang'],
    buildArgs: 'target_os=\\"win\\" target_cpu=\\"x64\\" is_debug=false is_component_build=false rtc_include_tests=true rtc_build_examples=false rtc_enable_protobuf=false use_rtti=false',
    noticesFormat: 'windows-sections',
    releaseTitlePrefix: 'Pinned Windows libwebrtc SDK',
  }),
  'macos-arm64': defineTarget({
    id: 'macos-arm64',
    os: 'darwin',
    arch: 'arm64',
    archiveFormat: 'tar.gz',
    lockRelativePath: 'native/macos-remote-desktop/libwebrtc-sdk-arm64.lock.json',
    sourceInputs: MACOS_SOURCE_INPUTS,
    requiredTopLevelEntries: MACOS_REQUIRED_TOP_LEVEL_ENTRIES,
    requiredFiles: MACOS_REQUIRED_FILES,
    toolchainKeys: ['xcode', 'macosSdk', 'clang', 'hostArch'],
    buildArgs: macosBuildArgs('arm64'),
    noticesFormat: 'macos-inventory',
    noticeTargets: MACOS_SDK_LIBWEBRTC_NOTICE_TARGETS,
    releaseTitlePrefix: 'Pinned macOS arm64 libwebrtc SDK',
  }),
  'macos-x64': defineTarget({
    id: 'macos-x64',
    os: 'darwin',
    arch: 'x64',
    archiveFormat: 'tar.gz',
    lockRelativePath: 'native/macos-remote-desktop/libwebrtc-sdk-x64.lock.json',
    sourceInputs: MACOS_SOURCE_INPUTS,
    requiredTopLevelEntries: MACOS_REQUIRED_TOP_LEVEL_ENTRIES,
    requiredFiles: MACOS_REQUIRED_FILES,
    toolchainKeys: ['xcode', 'macosSdk', 'clang', 'hostArch'],
    buildArgs: macosBuildArgs('x64'),
    noticesFormat: 'macos-inventory',
    noticeTargets: MACOS_SDK_LIBWEBRTC_NOTICE_TARGETS,
    releaseTitlePrefix: 'Pinned macOS x64 libwebrtc SDK',
  }),
});

/** Every producer target, in a stable order. */
export const LIBWEBRTC_SDK_TARGET_IDS = Object.freeze(Object.keys(TARGETS));

/**
 * The target every existing call site and CLI invocation means when it says
 * nothing. Windows was the first producer and its wiring predates this registry.
 */
export const DEFAULT_LIBWEBRTC_SDK_TARGET_ID = 'windows-x64';

/** Resolve a producer target, refusing anything not in the registry. */
export function libwebrtcSdkTarget(id = DEFAULT_LIBWEBRTC_SDK_TARGET_ID) {
  const target = Object.prototype.hasOwnProperty.call(TARGETS, id) ? TARGETS[id] : undefined;
  if (!target) {
    throw new Error(`unknown libwebrtc SDK target: ${String(id)} (expected one of ${LIBWEBRTC_SDK_TARGET_IDS.join(', ')})`);
  }
  return target;
}
