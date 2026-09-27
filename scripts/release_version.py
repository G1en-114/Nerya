#!/usr/bin/env python3
"""Keep the release version consistent without modifying dependency versions.

VERSION is SemVer; Python uses PEP 440 and Windows Installer needs four numbers.
Run with --write after editing VERSION, then commit the resulting manifest changes.
The default is a read-only check, including the tag in GitHub Actions.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]


def expected_files(root: Path = ROOT) -> dict[Path, str]:
    version = (root / "VERSION").read_text(encoding="utf-8").strip()
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?", version)
    if not match:
        raise ValueError("VERSION must be x.y.z or x.y.z-(alpha|beta|rc).N")
    major, minor, patch, channel, build = match.groups()
    base = f"{major}.{minor}.{patch}"
    suffix = {"alpha": "a", "beta": "b", "rc": "rc"}.get(channel, "")
    python_version = f"{base}{suffix}{build}" if channel else base
    installer_version = f"{base}.{build or '0'}"
    mac_version = f"{base}{ {'alpha': 'a', 'beta': 'b', 'rc': 'fc'}[channel]}{build}" if channel else base
    results: dict[Path, str] = {}

    for name in ("package.json", "dashboard/package.json", "sdk/typescript/package.json", "desktop/package.json"):
        path = root / name
        data = json.loads(path.read_text(encoding="utf-8"))
        data["version"] = version
        results[path] = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    for name in ("package-lock.json", "desktop/package-lock.json"):
        path = root / name
        data = json.loads(path.read_text(encoding="utf-8"))
        data["version"] = version
        for key in ("", "dashboard", "sdk/typescript"):
            if key in data.get("packages", {}):
                data["packages"][key]["version"] = version
        results[path] = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    config_path = root / "desktop/src-tauri/tauri.conf.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["version"] = version
    config["bundle"]["macOS"]["bundleVersion"] = mac_version
    config["bundle"]["windows"].setdefault("wix", {})["version"] = installer_version
    results[config_path] = json.dumps(config, indent=2, ensure_ascii=False) + "\n"
    for name, pattern, value in (
        ("pyproject.toml", r'(?ms)(^\[project\]\n.*?^version\s*=\s*)"[^"]+"', python_version),
        ("desktop/src-tauri/Cargo.toml", r'(?ms)(^\[package\]\n.*?^version\s*=\s*)"[^"]+"', version),
        ("desktop/src-tauri/Cargo.lock", r'(?m)(^name = "nerya-desktop"\nversion = )"[^"]+"', version),
        ("nerya/__init__.py", r'(?m)(^__version__\s*=\s*)"[^"]+"', python_version),
    ):
        path = root / name
        text, count = re.subn(pattern, lambda m: m[1] + json.dumps(value), path.read_text(encoding="utf-8"), count=1)
        if count != 1:
            raise ValueError(f"Could not locate the package version in {name}")
        results[path] = text
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    differences = []
    for path, expected in expected_files().items():
        if path.read_text(encoding="utf-8") != expected:
            differences.append(str(path.relative_to(ROOT)))
            if args.write:
                path.write_text(expected, encoding="utf-8")
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if os.environ.get("GITHUB_REF_TYPE") == "tag" and os.environ.get("GITHUB_REF_NAME") != f"v{version}":
        raise ValueError("Git tag does not match VERSION")
    if differences and not args.write:
        print("Version drift: " + ", ".join(differences), file=sys.stderr)
        return 1
    print(f"Release version {version}: {'updated ' + ', '.join(differences) if differences else 'all manifests agree'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
