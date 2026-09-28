"""Private subprocess protocol for camera face verification; never log biometrics."""

from __future__ import annotations

import base64
import contextlib
import json
import sys


def infer(image_data: str) -> dict:
    import cv2
    import numpy as np
    from uniface import FaceAnalyzer
    from uniface.spoofing import MiniFASNet

    from .face import FaceError, _vector

    if not isinstance(image_data, str) or len(image_data) > 3_000_000:
        raise FaceError("invalid_camera_frame")
    prefix, separator, encoded = image_data.partition(",")
    if not separator or prefix not in {
        "data:image/jpeg;base64",
        "data:image/png;base64",
    }:
        raise FaceError("invalid_camera_frame")
    try:
        data = base64.b64decode(encoded, validate=True)
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception as exc:
        raise FaceError("invalid_camera_frame") from exc
    if image is None or image.shape[0] * image.shape[1] > 4_000_000:
        raise FaceError("invalid_camera_frame")
    faces = FaceAnalyzer().analyze(image)
    if len(faces) != 1:
        raise FaceError("one_face_required")
    face = faces[0]
    if not np.isfinite(face.confidence) or float(face.confidence) < 0.7:
        raise FaceError("face_quality_low")
    live = MiniFASNet(providers=["CPUExecutionProvider"]).predict(image, face.bbox)
    if (
        not live.is_real
        or not np.isfinite(live.confidence)
        or float(live.confidence) < 0.8
    ):
        raise FaceError("liveness_failed")
    return {
        "embedding": _vector(face.embedding),
        "live": True,
        "liveness_mode": "minifasnet_passive",
        "model": "scrfd500m-arcface-mnet-v4",
    }


def main():
    from .face import FaceError

    try:
        request = json.loads(sys.stdin.read(3_000_100))
        with contextlib.redirect_stdout(sys.stderr):
            result = infer(request.get("image"))
        result["ok"] = True
    except FaceError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception:  # noqa: BLE001 - private protocol must never expose biometrics or model traces
        result = {"ok": False, "error": "face_model_unavailable"}
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
