#!/usr/bin/env python3

"""Generate fail-closed notices for the fixed Linux libwebrtc SDK.

Structurally the same approach as
native/windows-remote-desktop/generate-libwebrtc-sdk-notices.py: reuse
upstream's own license mapping and renderer (tools_webrtc/libs/
generate_licenses.py, from the SAME pinned checkout this SDK was built from),
but discover the linked third-party trees by reading the two complete-static
archive's own Ninja edge instead of asking GN for every field of every
transitive target (upstream's own helper does that, and a complete-static SDK
has thousands of targets -- enough to exhaust memory on older build hosts).

This file is intentionally its own copy rather than a shared import: the
Windows generator is itself a fingerprint input for an SDK release that has
already been published (see WINDOWS_SOURCE_INPUTS in
scripts/libwebrtc-sdk-targets.mjs) -- editing it to be generic would rotate
that immutable release's identity for no reason a Linux-only change should
ever cause. The one real difference from Windows, beyond target names, is the
archiver: GN's `complete_static_lib` on POSIX emits `lib<edge>.a` (llvm-ar),
not Windows' `<edge>.lib` (lld-link's archiver) -- so the Ninja alink line
this script greps for has a different filename shape.
"""

import argparse
import importlib.util
import os


SDK_TARGETS = {
    "//third_party/imcodes_linux_remote_desktop:imcodes_linux_libwebrtc_sdk": (
        "imcodes_linux_libwebrtc_sdk"
    ),
    "//third_party/imcodes_linux_remote_desktop:imcodes_linux_libwebrtc_test_sdk": (
        "imcodes_linux_libwebrtc_test_sdk"
    ),
}

# These artifacts are redistributed by the SDK even when their license owner
# does not appear as a normal //third_party dependency on the production edge.
# Same pinned checkout and toolchain as Windows/macOS, so the same mapping
# holds; kept as its own copy (see this file's own comment) rather than
# imported from the Windows generator.
EXPLICIT_LICENSES = {
    "googletest": ["third_party/googletest/src/LICENSE"],
    # The pinned upstream mapping currently omits RE2 even though the static
    # production archive links it when linked at all. Keep the mapping local
    # and fail closed if the pinned checkout stops carrying its license.
    "re2": ["third_party/re2/LICENSE"],
    # Clang, lld, and llvm-ar are LLVM-project binaries. The pinned checkout's
    # compiler-rt copy carries the LLVM Apache-2.0-with-exceptions license used
    # by the exported toolchain as well as by the builtins archive.
    "llvm-toolchain": ["third_party/compiler-rt/src/LICENSE.TXT"],
}
REQUIRED_REDISTRIBUTED_LIBRARIES = frozenset(
    {"compiler-rt", "googletest", "libc++", "llvm-toolchain"}
)


def load_upstream_generator(webrtc_root):
    module_path = os.path.join(
        webrtc_root, "tools_webrtc", "libs", "generate_licenses.py"
    )
    spec = importlib.util.spec_from_file_location(
        "imcodes_upstream_generate_licenses", module_path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load pinned WebRTC license generator.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive_edge_path(buildfile_dir, target):
    edge_name = SDK_TARGETS.get(target)
    if edge_name is None:
        raise RuntimeError("Unexpected SDK license target.")
    return (
        os.path.join(
            os.path.abspath(buildfile_dir),
            "obj",
            "third_party",
            "imcodes_linux_remote_desktop",
            edge_name + ".ninja",
        ),
        edge_name,
    )


def collect_linked_trees(buildfile_dir, target):
    edge_path, edge_name = archive_edge_path(buildfile_dir, target)
    # POSIX complete_static_lib archives are named lib<edge>.a (llvm-ar), not
    # Windows' <edge>.lib (lld-link) -- this is the one line that differs from
    # the Windows generator's own expected_prefix.
    expected_prefix = (
        "build obj/third_party/imcodes_linux_remote_desktop/lib"
        + edge_name
        + ".a: alink "
    )
    with open(edge_path, "r", encoding="utf-8") as edge_file:
        archive_edge = next(
            (line for line in edge_file if line.startswith(expected_prefix)), None
        )
    if archive_edge is None:
        raise RuntimeError("SDK complete-static archive edge is missing: " + edge_name)

    linked_trees = set()
    for token in archive_edge.split():
        normalized = token.replace("\\", "/")
        marker = "/third_party/"
        if marker in normalized:
            linked_trees.add(normalized.split(marker, 1)[1].split("/", 1)[0])
        for nested in ("/modules/third_party/", "/common_audio/third_party/"):
            if nested in normalized:
                linked_trees.add(normalized.split(nested, 1)[1].split("/", 1)[0])
        if "/testing/gtest/" in normalized or "/testing/gmock/" in normalized:
            linked_trees.add("googletest")

    linked_trees.discard("imcodes_linux_remote_desktop")
    if "llvm-build" in linked_trees:
        linked_trees.remove("llvm-build")
        linked_trees.add("llvm-toolchain")
    return linked_trees


def require_license_files(webrtc_root, mapping, libraries):
    for library in sorted(libraries):
        license_paths = mapping.get(library)
        if not license_paths:
            raise RuntimeError(
                "Redistributed SDK library has no license files: " + library
            )
        for relative_path in license_paths:
            absolute_path = os.path.join(webrtc_root, relative_path)
            if not os.path.isfile(absolute_path):
                raise RuntimeError(
                    "Redistributed SDK license file is missing: "
                    + library
                    + " -> "
                    + relative_path
                )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--webrtc-root", required=True)
    parser.add_argument("--build-directory", required=True)
    parser.add_argument("--target", action="append", required=True)
    parser.add_argument("--output-directory", required=True)
    args = parser.parse_args()

    if len(args.target) != len(SDK_TARGETS) or set(args.target) != set(SDK_TARGETS):
        raise RuntimeError("Both fixed SDK license targets must be provided exactly once.")

    webrtc_root = os.path.abspath(args.webrtc_root)
    build_directory = os.path.abspath(args.build_directory)
    upstream = load_upstream_generator(webrtc_root)
    license_mapping = dict(upstream.LIB_TO_LICENSES_DICT)
    license_mapping.update(EXPLICIT_LICENSES)

    class StreamingLicenseBuilder(upstream.LicenseBuilder):
        def _get_third_party_libraries(self, buildfile_dir, target):
            linked_trees = collect_linked_trees(buildfile_dir, target)
            unmapped = linked_trees - set(self.lib_to_licenses_dict)
            if unmapped:
                raise RuntimeError(
                    "SDK links third-party trees with no license mapping: "
                    + ", ".join(sorted(unmapped))
                )
            return linked_trees | set(REQUIRED_REDISTRIBUTED_LIBRARIES)

    linked_libraries = set(REQUIRED_REDISTRIBUTED_LIBRARIES)
    for target in args.target:
        linked_libraries.update(collect_linked_trees(build_directory, target))
    require_license_files(webrtc_root, license_mapping, linked_libraries)

    os.makedirs(args.output_directory, exist_ok=True)
    builder = StreamingLicenseBuilder(
        [build_directory], args.target, lib_to_licenses_dict=license_mapping
    )
    builder.generate_license_text(args.output_directory)
    notice_path = os.path.join(args.output_directory, "LICENSE.md")
    if not os.path.isfile(notice_path) or os.path.getsize(notice_path) == 0:
        raise RuntimeError("Pinned WebRTC license generator produced no output.")


if __name__ == "__main__":
    main()
