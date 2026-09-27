#!/usr/bin/env python3
"""Validate an installed/relocated desktop payload, not the developer environment."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def probe_json(argv: list[str], *, cwd: str, env: dict[str, str], timeout: int = 120) -> dict:
    """Preserve the child exception instead of hiding it in CalledProcessError."""
    result = subprocess.run(argv, cwd=cwd, env=env, text=True, encoding="utf-8",
                            errors="replace", capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Packaged runtime probe exited {result.returncode}:\n"
                           f"{result.stderr[-12000:]}\n{result.stdout[-2000:]}")
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError) as exc:
        raise RuntimeError(f"Packaged runtime probe did not return JSON:\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}") from exc


def native_target() -> tuple[str, str]:
    system = {"Darwin": "darwin", "Windows": "win32", "Linux": "linux"}.get(platform.system())
    arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(platform.machine().lower())
    if not system or not arch:
        raise ValueError(f"Unsupported desktop host: {platform.system()} {platform.machine()}")
    return system, arch


def resource_path(resources: Path, value: str) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or ".." in Path(value).parts:
        raise ValueError("Packaged paths must be nonempty, relative and without '..'")
    path = resources / value
    if not path.resolve().is_relative_to(resources.resolve()):
        raise ValueError(f"Resource escapes its installation: {value}")
    if not path.exists():
        raise ValueError(f"Missing packaged resource: {value}")
    return path


def verify(resources: Path) -> dict:
    resources = resources.resolve()
    manifest = json.loads((resources / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("dev") is not False:
        raise ValueError("Development/incomplete runtime cannot be released")
    if (manifest.get("platform"), manifest.get("arch")) != native_target():
        raise ValueError("Runtime OS/architecture does not match the native runner")
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if manifest.get("app_version") != version:
        raise ValueError("Runtime app version does not match VERSION")
    for key, filename in (("node_version", ".node-version"), ("python_version", ".python-version")):
        if manifest.get(key) != (ROOT / filename).read_text(encoding="utf-8").strip():
            raise ValueError(f"Runtime {key} does not match the pinned toolchain")
    for key in ("python", "node", "dashboard", "browser"):
        resource_path(resources, manifest.get(key))
    paths = manifest.get("python_paths")
    if not isinstance(paths, list) or not paths:
        raise ValueError("Missing packaged Python import paths")
    for path in paths:
        resource_path(resources, path)
    resource_path(resources, manifest["dashboard"] + "/server.js")
    for shipped, source in (("LICENSE", ROOT / "LICENSE"), ("requirements.lock", ROOT / "desktop/requirements.lock")):
        if (resources / shipped).read_bytes() != source.read_bytes():
            raise ValueError(f"Missing or stale {shipped} in bundle")
    for path in resources.rglob("*"):
        if path.is_symlink() and (not path.exists() or not path.resolve().is_relative_to(resources)):
            raise ValueError(f"Broken/external bundle symlink: {path.relative_to(resources)}")
        if path.name in {".env", "vault.key", "secrets.enc"}:
            raise ValueError(f"User secret file must not be packaged: {path.relative_to(resources)}")
    with tempfile.TemporaryDirectory(prefix="nerya-payload-check-") as directory:
        env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TMP", "TEMP") if key in os.environ}
        env.update(HOME=directory, USERPROFILE=directory, PYTHONUTF8="1", PYTHONNOUSERSITE="1",
                   PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=os.pathsep.join(str(resources / p) for p in paths))
        env["PATH"] = os.pathsep.join((str((resources / manifest["node"]).parent), str((resources / manifest["python"]).parent),
                                     os.environ.get("SystemRoot", "C:\\Windows") + "\\System32" if os.name == "nt" else "/usr/bin:/bin"))
        code = """
import json, platform, ssl, sys, sysconfig
import nerya, nerya_sdk, numpy, pandas, ccxt, cryptography, mcp, playwright
if sys.platform == 'win32':
    import pywintypes, win32api, win32con, win32job
from nerya.skills.registry import SkillRegistry
skills = {entry.manifest.id for entry in SkillRegistry.load_builtin().list()}
assert {'research', 'strategy_author', 'backtest', 'markets'} <= skills, skills
print(json.dumps({'python': platform.python_version(), 'nerya': nerya.__version__,
                  'machine': platform.machine(), 'platform': sys.platform, 'skills': len(skills),
                  'site_packages': sysconfig.get_path('purelib')}))
"""
        details = probe_json([str(resources / manifest["python"]), "-c", code], cwd=directory, env=env)
        if details["python"] != manifest["python_version"]:
            raise ValueError("Bundled Python executable version mismatch")
        if Path(details["site_packages"]).resolve() not in {(resources / p).resolve() for p in paths}:
            raise ValueError("Dependencies must use the bundled Python's standard site-packages layout")
        actual_arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(details["machine"].lower())
        if (details["platform"], actual_arch) != native_target():
            raise ValueError("Bundled Python executable is for a different target")
        node = probe_json([str(resources / manifest["node"]), "-p",
            "JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})"],
            cwd=directory, env=env, timeout=30)
        if node != {"version": manifest["node_version"], "arch": manifest["arch"], "platform": manifest["platform"]}:
            raise ValueError("Bundled Node executable version/architecture mismatch")
    report = {"version": version, "platform": manifest["platform"], "arch": manifest["arch"],
              "imports": details, "node": node, "dependencies_sha256": hashlib.sha256((resources / "requirements.lock").read_bytes()).hexdigest()}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, default=ROOT / "desktop/runtime")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = verify(args.resources)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
