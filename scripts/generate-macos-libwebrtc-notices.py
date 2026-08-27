#!/usr/bin/env python3

"""Generate fail-closed notices for the macOS remote-desktop executables.

The dependency inventory comes from the exact generated GN graph.  License
paths remain owned by the pinned WebRTC generator, so a pin that adds an
unmapped third-party tree fails instead of silently shipping incomplete
notices.
"""

import argparse
import ast
from html import escape
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Dict, List, Optional, Set


NOTICE_VERSION = 1
EXPECTED_TARGETS = frozenset(
    {
        "//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_worker",
        "//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_launch_agent",
        "//third_party/imcodes_macos_remote_desktop:imcodes_remote_desktop_disclosure",
        # The virtual-display helper genuinely carries third-party code: its
        # closure reaches //third_party/jsoncpp through
        # remote-desktop-common:remote_desktop_common, exactly as the disclosure
        # executable does. Omitting it would UNDER-report the notices, which is
        # the opposite failure from the auto-unlock bundle -- that one is
        # excluded because its closure really is project source_sets plus system
        # frameworks only.
        "//third_party/imcodes_macos_remote_desktop:imcodes_virtual_display_helper",
    }
)
PROJECT_OWNED_TREES = frozenset(
    {"imcodes_macos_remote_desktop", "remote-desktop-common"}
)
DEPENDENCY_LABEL = re.compile(r"(//[^\s(]+)")
INVENTORY = re.compile(
    r"\A<!-- imcodes-macos-libwebrtc-notices-v1\n"
    r"libwebrtcRevision=([0-9a-f]{40})\n"
    r"targets=([^\n]+)\n"
    r"libraries=([^\n]+)\n-->\n\n"
)


def read_upstream_mapping(webrtc_root: Path) -> Dict[str, List[str]]:
    generator = webrtc_root / "tools_webrtc" / "libs" / "generate_licenses.py"
    tree = ast.parse(generator.read_text(encoding="utf-8"), filename=str(generator))
    for statement in tree.body:
        if not isinstance(statement, ast.Assign):
            continue
        if any(
            isinstance(target, ast.Name) and target.id == "LIB_TO_LICENSES_DICT"
            for target in statement.targets
        ):
            value = ast.literal_eval(statement.value)
            if not isinstance(value, dict):
                break
            return value
    raise RuntimeError("pinned WebRTC license mapping is missing")


def dependency_labels(gn: Path, build_directory: Path, target: str) -> Set[str]:
    completed = subprocess.run(
        [str(gn), "desc", str(build_directory), target, "deps", "--all"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(build_directory),
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"GN dependency inventory failed for {target}: "
            + (completed.stderr or completed.stdout).strip()
        )
    return set(DEPENDENCY_LABEL.findall(completed.stdout))


def third_party_tree(label: str) -> Optional[str]:
    path = label[2:].split(":", 1)[0]
    segments = path.split("/")
    try:
        marker = segments.index("third_party")
    except ValueError:
        return None
    if marker + 1 >= len(segments):
        return None
    return segments[marker + 1]


def collect_libraries(
    gn: Path, build_directory: Path, targets: List[str]
) -> Set[str]:
    libraries: Set[str] = set()
    for target in targets:
        for label in dependency_labels(gn, build_directory, target):
            library = third_party_tree(label)
            if library is not None and library not in PROJECT_OWNED_TREES:
                libraries.add(library)
    return libraries


def render_notices(
    webrtc_root: Path,
    revision: str,
    targets: List[str],
    mapping: Dict[str, List[str]],
    libraries: Set[str],
) -> str:
    unknown = libraries - set(mapping)
    if unknown:
        raise RuntimeError(
            "macOS targets link third-party trees with no license mapping: "
            + ", ".join(sorted(unknown))
        )

    licensed = sorted(library for library in libraries if mapping[library])
    sections = ["webrtc", *[item for item in licensed if item != "webrtc"]]
    inventory = [
        "<!-- imcodes-macos-libwebrtc-notices-v1",
        f"libwebrtcRevision={revision}",
        "targets=" + ",".join(sorted(targets)),
        "libraries=" + ",".join(sections),
        "-->",
        "",
    ]
    output = ["\n".join(inventory)]
    paths_by_section = {"webrtc": ["LICENSE"]}
    paths_by_section.update({library: mapping[library] for library in licensed})
    for section in sections:
        paths = paths_by_section[section]
        if not paths:
            raise RuntimeError(f"empty license mapping for redistributed tree: {section}")
        texts: List[str] = []
        for relative in paths:
            path = webrtc_root / relative
            if not path.is_file() or path.is_symlink():
                raise RuntimeError(
                    f"license is not a regular file: {section} -> {relative}"
                )
            text = path.read_text(encoding="utf-8")
            if not text.strip():
                raise RuntimeError(f"license is empty: {section} -> {relative}")
            texts.append(escape(text, quote=True).rstrip("\n"))
        output.append(f"# {section}\n```\n" + "\n".join(texts) + "\n```\n")
    return "\n".join(output)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def parse_notices(path: Path) -> tuple:
    text = path.read_text(encoding="utf-8")
    inventory = INVENTORY.match(text)
    if inventory is None:
        raise RuntimeError(f"invalid macOS notice inventory: {path}")
    targets = inventory.group(2).split(",")
    if targets != sorted(EXPECTED_TARGETS):
        raise RuntimeError(f"macOS notice target mismatch: {path}")
    libraries = inventory.group(3).split(",")
    if not libraries or libraries[0] != "webrtc" or len(set(libraries)) != len(libraries):
        raise RuntimeError(f"invalid macOS notice library inventory: {path}")
    sections: Dict[str, str] = {}
    cursor = inventory.end()
    for library in libraries:
        prefix = f"# {library}\n```\n"
        if not text.startswith(prefix, cursor):
            raise RuntimeError(f"macOS notice section mismatch: {path} -> {library}")
        start = cursor + len(prefix)
        end = text.find("\n```\n", start)
        if end == -1 or not text[start:end].strip():
            raise RuntimeError(f"empty macOS notice section: {path} -> {library}")
        sections[library] = text[start:end]
        cursor = end + len("\n```\n")
        if cursor < len(text) and text[cursor] == "\n":
            cursor += 1
    if text[cursor:].strip():
        raise RuntimeError(f"trailing macOS notice content: {path}")
    return inventory.group(1), sections


def merge_notices(inputs: List[Path], output: Path) -> None:
    if len(inputs) < 2:
        raise RuntimeError("at least two architecture notice files are required")
    revision: Optional[str] = None
    merged: Dict[str, str] = {}
    for path in inputs:
        current_revision, sections = parse_notices(path.resolve(strict=True))
        if revision is None:
            revision = current_revision
        elif revision != current_revision:
            raise RuntimeError("cannot merge notices from different libwebrtc revisions")
        for library, body in sections.items():
            existing = merged.get(library)
            if existing is not None and existing != body:
                raise RuntimeError(f"conflicting license text across architectures: {library}")
            merged[library] = body
    libraries = ["webrtc", *sorted(item for item in merged if item != "webrtc")]
    if "webrtc" not in merged or revision is None:
        raise RuntimeError("merged notices are missing WebRTC")
    lines = [
        "<!-- imcodes-macos-libwebrtc-notices-v1",
        f"libwebrtcRevision={revision}",
        "targets=" + ",".join(sorted(EXPECTED_TARGETS)),
        "libraries=" + ",".join(libraries),
        "-->",
        "",
    ]
    for library in libraries:
        lines.extend([f"# {library}", "```", merged[library], "```", ""])
    atomic_write(output, "\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--webrtc-root")
    parser.add_argument("--build-directory")
    parser.add_argument("--gn")
    parser.add_argument("--revision")
    parser.add_argument("--target", action="append")
    parser.add_argument("--merge-input", action="append")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    output = Path(args.output).resolve()
    if args.merge_input:
        if any((args.webrtc_root, args.build_directory, args.gn, args.revision, args.target)):
            raise RuntimeError("merge mode does not accept GN graph arguments")
        merge_notices([Path(path) for path in args.merge_input], output)
        return

    if not all((args.webrtc_root, args.build_directory, args.gn, args.revision, args.target)):
        raise RuntimeError("GN graph mode requires checkout, build, pin, target, and gn")

    targets = args.target
    if len(targets) != len(EXPECTED_TARGETS) or set(targets) != EXPECTED_TARGETS:
        raise RuntimeError("all three fixed macOS executable targets are required once")
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise RuntimeError("invalid libwebrtc revision")

    webrtc_root = Path(args.webrtc_root).resolve(strict=True)
    build_directory = Path(args.build_directory).resolve(strict=True)
    gn = Path(args.gn).resolve(strict=True)
    mapping = read_upstream_mapping(webrtc_root)
    libraries = collect_libraries(gn, build_directory, targets)
    if not libraries:
        raise RuntimeError("macOS target graph contains no third-party libraries")
    atomic_write(
        output,
        render_notices(
            webrtc_root, args.revision, targets, mapping, libraries
        ),
    )


if __name__ == "__main__":
    main()
