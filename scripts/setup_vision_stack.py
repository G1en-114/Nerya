"""Bootstrap the local vision stack for nod/face features (GWDC demo machines).

What it does, in order:

1. Create ``.venv-face`` next to the repo if missing and install the pinned
   vision dependencies (OpenCV, UniFace, ONNX Runtime, Pillow) into it.
2. Seed the UniFace model cache (``~/.uniface/models``) from the copies
   committed under ``models/uniface/`` so nothing is downloaded at demo
   time — even with no internet.
3. Smoke-test both private workers (nod + face login) with a blank frame:
   the expected ``face_not_tracked`` / ``one_face_required`` responses prove
   the models load and run without any real face in front of the camera.

Usage:
    python scripts/setup_vision_stack.py            # full bootstrap + verify
    python scripts/setup_vision_stack.py --skip-pip # only seed models + verify
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import subprocess
import sys
import venv
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MODELS_SRC = REPO_ROOT / "models" / "uniface"
VENV_DIR = REPO_ROOT / ".venv-face"
PIP_PACKAGES = ["opencv-python", "onnxruntime", "uniface[cpu]", "pillow"]


def _venv_python() -> Path:
    return VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _ensure_venv(skip_pip: bool) -> None:
    if not _venv_python().is_file():
        print(f"[venv] creating {VENV_DIR}")
        venv.create(VENV_DIR, with_pip=True)
    if skip_pip:
        print("[venv] --skip-pip set; not installing packages")
        return
    print("[venv] installing vision dependencies (this can take a few minutes)")
    subprocess.run(
        [str(_venv_python()), "-m", "pip", "install", "--quiet", *PIP_PACKAGES],
        check=True,
    )


def _seed_models() -> None:
    cache = Path.home() / ".uniface" / "models"
    cache.mkdir(parents=True, exist_ok=True)
    seeded = 0
    for src in sorted(MODELS_SRC.glob("*.onnx")):
        dst = cache / src.name
        if dst.is_file() and hashlib.sha256(dst.read_bytes()).hexdigest() == hashlib.sha256(src.read_bytes()).hexdigest():
            print(f"[models] {src.name}: already up to date")
            continue
        dst.write_bytes(src.read_bytes())
        seeded += 1
        print(f"[models] {src.name}: seeded ({src.stat().st_size // 1024} KiB)")
    if seeded == 0:
        print("[models] cache already matches the committed copies")
    else:
        print(f"[models] seeded {seeded} file(s); no network download will be needed")


def _blank_jpeg_uri() -> str:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (320, 240), (240, 240, 240)).save(buffer, "JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def _verify() -> bool:
    root = str(REPO_ROOT)
    env = dict(os.environ, PYTHONPATH=root, OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
    burst = [_blank_jpeg_uri() for _ in range(12)]
    checks = [
        # 12 blank frames run the full inference path; no face in frame is the
        # expected fail-closed answer and proves the model loaded.
        ("nod", ["-m", "nerya.vision.nod_worker"], {"frames": burst}, "face_not_tracked"),
        ("face", ["-m", "nerya.vision.face_worker"], {"image": _blank_jpeg_uri()}, "one_face_required"),
    ]
    ok = True
    for name, module, payload, expected in checks:
        proc = subprocess.run(
            [str(_venv_python()), *module],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=300,
            env=env,
            cwd=root,
        )
        try:
            out = json.loads(proc.stdout)
        except json.JSONDecodeError:
            out = {"error": proc.stderr.strip()[-160:] or "no output"}
        got = str(out.get("error") or "")
        if out.get("ok") is False and got == expected:
            print(f"[verify] {name} worker: model loads, blank frame -> {got} (PASS)")
        else:
            print(f"[verify] {name} worker: UNEXPECTED {out} (FAIL)")
            ok = False
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-pip", action="store_true", help="reuse the existing .venv-face as-is")
    args = parser.parse_args()

    if not MODELS_SRC.is_dir() or not any(MODELS_SRC.glob("*.onnx")):
        print(f"[models] {MODELS_SRC} has no .onnx files; pull the branch that commits them.")
        return 1
    if not args.skip_pip:
        _ensure_venv(skip_pip=False)
    else:
        _ensure_venv(skip_pip=True)
    _seed_models()
    passed = _verify()
    print("[done] vision stack ready" if passed else "[done] verification FAILED — see above")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
