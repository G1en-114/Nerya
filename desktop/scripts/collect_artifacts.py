#!/usr/bin/env python3
"""Collect only expected installers, never caches, workspaces or loose runtimes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil

from verify_runtime import ROOT, native_target


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release-artifacts")
    args = parser.parse_args()
    system, arch = native_target()
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    label = {"darwin": "macos", "win32": "windows", "linux": "linux"}[system]
    patterns = {"darwin": ("dmg/*.dmg", "pkg/*.pkg"), "win32": ("nsis/*.exe", "msi/*.msi"),
                "linux": ("deb/*.deb", "appimage/*.AppImage")}[system]
    bundle = ROOT / "desktop/src-tauri/target/release/bundle"
    args.output.mkdir(parents=True, exist_ok=True)
    files = []
    for pattern in patterns:
        candidates = list(bundle.glob(pattern))
        if len(candidates) != 1:
            raise ValueError(f"Expected one {pattern}, got {candidates}")
        source = candidates[0]
        if not 0 < source.stat().st_size < 2 * 1024**3:
            raise ValueError(f"Installer empty or exceeds GitHub Release's per-file size limit: {source.name}")
        target = args.output / f"Nerya-{version}-{label}-{arch}{source.suffix}"
        shutil.copy2(source, target)
        files.append({"name": target.name, "sha256": digest(target), "bytes": target.stat().st_size})
    report = {"version": version, "platform": label, "arch": arch, "commit": os.environ.get("GITHUB_SHA", "local"),
              "verification": "native installer payload imports + isolated runtime HTTP/browser smoke",
              "signing": "ad-hoc macOS; unsigned Windows/Linux beta; not notarized", "files": files}
    (args.output / f"build-info-{label}-{arch}.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (args.output / f"SHA256SUMS-{label}-{arch}.txt").write_text("".join(f"{entry['sha256']}  {entry['name']}\n" for entry in files), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
