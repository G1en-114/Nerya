#!/usr/bin/env python3
"""Smoke-test the payload extracted from the native installer on its target OS.

MSI administrative extraction does not install the app or change user accounts.
Linux verifies both Debian and AppImage payloads. macOS validates the signed app.
All application state and fake credentials are confined to temporary directories.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys
import tempfile

from verify_runtime import ROOT, native_target, verify


def only(paths) -> Path:
    values = list(paths)
    if len(values) != 1:
        raise ValueError(f"Expected exactly one installer/payload; found {values}")
    return values[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-dir", type=Path, default=ROOT / "desktop/src-tauri/target/release/bundle")
    args = parser.parse_args()
    bundle = args.bundle_dir.resolve()
    system, _ = native_target()
    # Keep the Windows extraction root deliberately short. The MSI contains a
    # full portable runtime (Python, Node and browser assets), so both path
    # length and extraction time are materially larger than for a normal app.
    with tempfile.TemporaryDirectory(prefix="nerya-") as directory:
        extracted = Path(directory)
        if system == "darwin":
            app = only((bundle / "macos").glob("*.app"))
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
            resources = app / "Contents/Resources/runtime"
        elif system == "win32":
            installer = only((bundle / "msi").glob("*.msi"))
            log = ROOT / ".tmp/ci/msi-admin-install.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(
                [
                    "msiexec", "/a", str(installer), "/qn", "/norestart",
                    f"TARGETDIR={extracted}", "/L*V", str(log),
                ],
                timeout=1200,
            )
            if result.returncode not in (0, 3010):
                tail = log.read_text(encoding="utf-16", errors="replace")[-12000:] if log.exists() else ""
                raise RuntimeError(f"MSI extraction failed: {result.returncode}\n{tail}")
            resources = only(path.parent for path in extracted.rglob("manifest.json") if path.parent.name == "runtime")
        else:
            installer = only((bundle / "deb").glob("*.deb"))
            subprocess.run(["dpkg-deb", "--extract", str(installer), str(extracted)], check=True, timeout=180)
            resources = only(path.parent for path in extracted.rglob("manifest.json") if path.parent.name == "runtime")
        verify(resources)
        subprocess.run([sys.executable, str(Path(__file__).with_name("smoke.py")),
                        "--resources", str(resources), "--access-port", "0"], check=True, timeout=480)
    if system == "linux":
        # linuxdeploy rewrites ELF dependencies inside AppDir. A working Debian
        # package does not prove the AppImage's relocated Python/browser works.
        image = only((bundle / "appimage").glob("*.AppImage"))
        with tempfile.TemporaryDirectory(prefix="Nerya AppImage installed ") as directory:
            result = subprocess.run([str(image), "--appimage-extract"], cwd=directory,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    text=True, timeout=180)
            if result.returncode:
                raise RuntimeError(f"AppImage extraction failed: {result.stderr[-8000:]}")
            resources = only(path.parent for path in Path(directory).rglob("manifest.json") if path.parent.name == "runtime")
            verify(resources)
            subprocess.run([sys.executable, str(Path(__file__).with_name("smoke.py")),
                            "--resources", str(resources), "--access-port", "0"], check=True, timeout=480)
    print("Native installer payload verification passed.")


if __name__ == "__main__":
    main()
