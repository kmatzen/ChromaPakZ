#!/usr/bin/env python3
"""Fail unless a release wheelhouse covers every supported binary platform."""

from pathlib import Path
import re
import sys


PYTHONS = ("cp39", "cp310", "cp311", "cp312", "cp313", "cp314")
PLATFORMS = (
    "manylinux_2_28_x86_64",
    "manylinux_2_28_aarch64",
    "musllinux_1_2_x86_64",
    "musllinux_1_2_aarch64",
    "macosx_13_0_arm64",
)


def wheel_key(path: Path) -> tuple[str, str]:
    match = re.search(r"-(cp3\d+)-[^-]+-([^-]+)\.whl$", path.name)
    if not match:
        raise ValueError(f"cannot read wheel tags from {path.name}")
    return match.group(1), match.group(2)


def main() -> int:
    wheelhouse = Path(sys.argv[1] if len(sys.argv) > 1 else "wheelhouse")
    wheels = sorted(wheelhouse.glob("*.whl"))
    found = {wheel_key(path) for path in wheels}
    expected = {(python, platform) for python in PYTHONS for platform in PLATFORMS}
    missing = sorted(expected - found)
    unexpected = sorted(found - expected)
    duplicates = len(wheels) - len(found)

    if missing or unexpected or duplicates:
        if missing:
            print("missing wheels:", *(f"  {py}-{platform}" for py, platform in missing), sep="\n")
        if unexpected:
            print("unexpected wheel tags:", *(f"  {py}-{platform}" for py, platform in unexpected), sep="\n")
        if duplicates:
            print(f"duplicate wheel tag combinations: {duplicates}")
        return 1

    print(f"complete wheel matrix: {len(wheels)} wheels ({len(PYTHONS)} CPython versions x {len(PLATFORMS)} platforms)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
