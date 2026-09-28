"""Read-only UniFace helper; one structured request, one JSON response."""
from __future__ import annotations

import argparse
import contextlib
import json
import sys

from nerya.vision.face import FaceError, FaceService


def execute(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise FaceError("request_must_be_object")
    operation = payload.get("operation", "analyze")
    if operation not in {"analyze", "compare"}:
        raise FaceError("unsupported_operation")
    service = FaceService(detector=payload.get("detector", "scrfd"),
                          recognizer=payload.get("recognizer", "arcface"))
    if operation == "compare":
        return service.compare(payload.get("image_path"), payload.get("reference_path"),
                               threshold=payload.get("threshold", 0.5))
    return service.analyze(payload.get("image_path"))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", required=True, help="Structured analysis or comparison request")
    args = parser.parse_args(argv)
    try:
        # Upstream informational output must not corrupt the JSON protocol.
        with contextlib.redirect_stdout(sys.stderr):
            result = execute(json.loads(args.json))
    except json.JSONDecodeError:
        result = {"ok": False, "error": "invalid_json"}
    except FaceError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception:
        result = {"ok": False, "error": "face_analysis_failed"}
    print(json.dumps(result, allow_nan=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
