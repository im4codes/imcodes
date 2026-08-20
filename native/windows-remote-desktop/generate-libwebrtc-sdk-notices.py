#!/usr/bin/env python3

"""Generate fail-closed notices for the fixed Windows libwebrtc SDK.

WebRTC's upstream helper asks GN for every field of every transitive target and
then parses that JSON in memory. A complete static SDK has thousands of targets,
so that representation can exhaust memory on older build hosts. This adapter
reuses upstream's mapping and renderer, but reads the two complete-static Ninja
archive edges instead. It also accounts explicitly for redistributed files that
do not belong to either GN archive edge (the LLVM toolchain, compiler runtime,
and the separately assembled libc++ archive).
"""

import argparse
import importlib.util
import os


SDK_TARGETS = {
    "//third_party/imcodes_remote_desktop:imcodes_libwebrtc_sdk": (
        "imcodes_libwebrtc_sdk"
    ),
    "//third_party/imcodes_remote_desktop:imcodes_libwebrtc_test_sdk": (
        "imcodes_libwebrtc_test_sdk"
    ),
}

# These artifacts are redistributed by the SDK even when their license owner
# does not appear as a normal //third_party dependency on the production edge.
EXPLICIT_LICENSES = {
    "googletest": ["third_party/googletest/src/LICENSE"],
    # The pinned upstream mapping currently omits RE2 even though the static
    # production archive links it. Keep the mapping local and fail closed if
    # the pinned checkout stops carrying its license.
    "re2": ["third_party/re2/LICENSE"],
    # Clang, lld, and llvm-ml are LLVM-project binaries. The pinned checkout's
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
            "imcodes_remote_desktop",
            edge_name + ".ninja",
        ),
        edge_name,
    )


def collect_linked_trees(buildfile_dir, target):
    edge_path, edge_name = archive_edge_path(buildfile_dir, target)
    expected_prefix = (
        "build obj/third_party/imcodes_remote_desktop/"
        + edge_name
        + ".lib: alink "
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

    linked_trees.discard("imcodes_remote_desktop")
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
