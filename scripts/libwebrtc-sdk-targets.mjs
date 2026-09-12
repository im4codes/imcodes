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
  // TODO(macos-sdk-notices): the macOS SDK notices generator belongs here, as
  // the Windows list ends with its own generator. This is the ONLY place it has
  // to be added. Nothing macOS has been published yet, so appending it is still
  // free; once a macos-* release exists, appending changes the fingerprint and
  // forces a full rebuild.
];

const MACOS_REQUIRED_TOP_LEVEL_ENTRIES = [
  'THIRD_PARTY_NOTICES.webrtc.md',
  'gen',
  'include',
  'lib',
  'sdk-build.json',
  'toolchain',
];

const MACOS_REQUIRED_FILES = [
  'lib/libimcodes_macos_libwebrtc_sdk.a',
  'lib/libimcodes_macos_libwebrtc_test_sdk.a',
  // TODO(macos-sdk-layout): the collect section of
  // native/macos-remote-desktop/build-libwebrtc-sdk.sh does not export a
  // toolchain yet. The remaining required files (the pinned clang/libc++ pieces
  // the consumer links against) are added HERE once that section lands.
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
    toolchainKeys: ['xcode', 'macosSdk', 'clang'],
    buildArgs: macosBuildArgs('arm64'),
    noticesFormat: 'macos-inventory',
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
    toolchainKeys: ['xcode', 'macosSdk', 'clang'],
    buildArgs: macosBuildArgs('x64'),
    noticesFormat: 'macos-inventory',
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
