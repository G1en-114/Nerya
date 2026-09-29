"""Private subprocess protocol for camera nod-intent detection; never log frames.

A nod is an interaction signal only: it expresses confirmation intent for one
specific approval request. It proves no identity and grants no permission.
"""
from __future__ import annotations

import base64
import contextlib
import json
import sys

MAX_FRAMES = 24
MIN_FRAMES = 8
MAX_FRAME_BYTES = 1_000_000
NOD_AMPLITUDE = 0.07
MAX_SPAN = 9
RECOVERY_RATIO = 0.45


class NodError(ValueError):
    """Stable error code; never carries frame contents."""


def _analyzer():
    """Build the analyzer from locally cached weights.

    Explicit weights keep the nod worker from requesting the 500m detector,
    which is not always present offline; 10g and arcface_mnet are the pair
    already shipped in the local model cache.
    """
    from uniface import FaceAnalyzer
    from uniface.detection import SCRFD
    from uniface.detection.scrfd import SCRFDWeights
    from uniface.recognition import ArcFace

    return FaceAnalyzer(
        detector=SCRFD(model_name=SCRFDWeights.SCRFD_10G_KPS),
        recognizer=ArcFace(),
    )


def _pitch_series(frames) -> list[float]:
    """Vertical nose-to-bbox ratio per frame; translation-invariant head pitch proxy."""
    import cv2
    import numpy as np

    if not isinstance(frames, list) or not MIN_FRAMES <= len(frames) <= MAX_FRAMES:
        raise NodError("invalid_frame_count")
    analyzer = _analyzer()
    ratios: list[float] = []
    for frame_data in frames:
        if not isinstance(frame_data, str) or len(frame_data) > 1_400_000:
            raise NodError("invalid_camera_frame")
        prefix, separator, encoded = frame_data.partition(",")
        if not separator or prefix not in {
            "data:image/jpeg;base64",
            "data:image/png;base64",
        }:
            raise NodError("invalid_camera_frame")
        try:
            data = base64.b64decode(encoded, validate=True)
            image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        except Exception as exc:
            raise NodError("invalid_camera_frame") from exc
        if image is None or image.shape[0] * image.shape[1] > 4_000_000:
            raise NodError("invalid_camera_frame")
        faces = analyzer.analyze(image)
        if len(faces) > 1:
            raise NodError("one_face_required")
        if len(faces) != 1:
            continue
        face = faces[0]
        if not hasattr(face, "confidence") or float(face.confidence) < 0.5:
            continue
        x1, y1, x2, y2 = (float(v) for v in face.bbox[:4])
        height = y2 - y1
        if height <= 1:
            continue
        nose_y = _nose_y(face, y1, y2)
        if nose_y is None:
            continue
        ratios.append((nose_y - y1) / height)
    if len(ratios) < MIN_FRAMES:
        raise NodError("face_not_tracked")
    return ratios


def _nose_y(face, y1: float, y2: float) -> float | None:
    """Nose-tip y from landmarks; the bbox centre is the last-resort fallback.

    Accepts a 5-point face layout (index 2 is the nose), a 3-point layout
    (index 2), and a single already-cropped nose keypoint. Anything else
    falls back to the bbox centre, which cannot show pitch — callers treat
    that as untrackable rather than as a stable head.
    """
    landmarks = getattr(face, "landmarks", None)
    if landmarks is None:
        return None
    try:
        points = [[float(p[0]), float(p[1])] for p in list(landmarks)]
    except (TypeError, ValueError, IndexError):
        return None
    if len(points) >= 3:
        return points[2][1]
    if len(points) == 1:
        return points[0][1]
    return None


def detect_nod(ratios: list[float]) -> tuple[bool, float]:
    """Return (nod, amplitude) from a pitch series.

    A nod is one clear excursion away from the neutral head position the
    operator started in, followed by a return to it: the deviation from the
    opening position must reach NOD_AMPLITUDE, stay within MAX_SPAN frames,
    and come back to within RECOVERY_RATIO of the amplitude by the end of
    the burst. Drift that never returns, a head held in a new position, and
    repeated excursions all fail this test.
    """
    if len(ratios) < MIN_FRAMES:
        return False, 0.0
    step = max(1, len(ratios) // MIN_FRAMES)
    sampled = ratios[::step]
    smoothed = [
        sum(sampled[max(0, i - 1): i + 2]) / len(sampled[max(0, i - 1): i + 2])
        for i in range(len(sampled))
    ]
    reference = sum(smoothed[:2]) / len(smoothed[:2])
    deviations = [value - reference for value in smoothed]
    extreme = max(range(len(deviations)), key=lambda i: abs(deviations[i]))
    amplitude = abs(deviations[extreme])
    if amplitude < NOD_AMPLITUDE:
        return False, amplitude
    tolerance = 0.3 * amplitude
    start = extreme
    while start > 0 and abs(deviations[start]) > tolerance:
        start -= 1
    end = extreme
    while end < len(deviations) - 1 and abs(deviations[end]) > tolerance:
        end += 1
    if not 2 <= end - start <= MAX_SPAN:
        return False, amplitude
    # The head must be back near its neutral position when the burst ends.
    if abs(deviations[-1]) > RECOVERY_RATIO * amplitude:
        return False, amplitude
    # A second excursion of similar size is not a single nod.
    rest = [abs(value) for i, value in enumerate(deviations) if i < start or i > end]
    if any(value >= amplitude for value in rest):
        return False, amplitude
    return True, amplitude


def infer(frames) -> dict:
    ratios = _pitch_series(frames)
    nod, amplitude = detect_nod(ratios)
    return {
        "nod": bool(nod),
        "amplitude": round(float(amplitude), 4),
        "frames_used": len(ratios),
        "detector": "nose-bbox-ratio-v1",
    }


def main():
    try:
        request = json.loads(sys.stdin.read(40_000_000))
        with contextlib.redirect_stdout(sys.stderr):
            result = infer(request.get("frames"))
        result["ok"] = True
    except NodError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception:  # noqa: BLE001 - private protocol must never expose frames or model traces
        result = {"ok": False, "error": "nod_model_unavailable"}
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
