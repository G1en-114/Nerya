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
NOD_AMPLITUDE = 0.04
MAX_SPAN = 10
RECOVERY_RATIO = 0.35


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


def detect_nod(ratios: list[float]) -> tuple[bool, int, float]:
    """Return (nod, half_cycle_count, amplitude) from a pitch series.

    Real people nod continuously — two or three down-up cycles without
    settling — so the series is mean-centred and split into same-sign runs.
    Each run whose peak reaches NOD_AMPLITUDE counts as a half cycle.
    Accept when:

    - at least two alternating half cycles exist (a full out-and-back cycle
      around the neutral position), and
    - the burst ends back near the neutral position (drift and "moved to a
      new position and stayed" never do).

    A held head produces one run (rejected); monotone drift produces two
    runs but ends far from centre (rejected); micro-jitter never reaches
    the amplitude floor (rejected).
    """
    if len(ratios) < MIN_FRAMES:
        return False, 0, 0.0
    # Windows are 8–25 frames; downsampling here aliases the nod oscillation.
    sampled = ratios
    smoothed = [
        sum(sampled[max(0, i - 1): i + 2]) / len(sampled[max(0, i - 1): i + 2])
        for i in range(len(sampled))
    ]
    reference = sum(smoothed) / len(smoothed)
    deviations = [v - reference for v in smoothed]
    amplitude = max((abs(v) for v in deviations), default=0.0)
    if amplitude < NOD_AMPLITUDE:
        return False, 0, amplitude

    eps = max(0.01, 0.25 * NOD_AMPLITUDE)
    runs = []  # (sign, span, peak)
    current_sign = 0
    span = 0
    peak = 0.0
    for v in deviations:
        sign = 0 if abs(v) < eps else (1 if v > 0 else -1)
        if sign == 0:
            if current_sign:
                runs.append((current_sign, span, peak))
            current_sign, span, peak = 0, 0, 0.0
            continue
        if sign == current_sign:
            span += 1
            peak = max(peak, abs(v))
        else:
            if current_sign:
                runs.append((current_sign, span, peak))
            current_sign, span, peak = sign, 1, abs(v)
    if current_sign:
        runs.append((current_sign, span, peak))

    significant = [r for r in runs if r[2] >= NOD_AMPLITUDE and r[1] <= MAX_SPAN + 2]
    half_cycles = len(significant)
    if half_cycles < 2:
        return False, half_cycles, amplitude
    signs = [r[0] for r in significant]
    alternating = all(signs[i] != signs[i + 1] for i in range(len(signs) - 1))
    ends_near_centre = abs(deviations[-1]) <= max(
        NOD_AMPLITUDE, 0.5 * significant[-1][2]
    )
    return alternating and ends_near_centre, half_cycles, amplitude


def infer(frames) -> dict:
    ratios = _pitch_series(frames)
    nod, excursions, amplitude = detect_nod(ratios)
    return {
        "nod": bool(nod),
        "excursions": int(excursions),
        "amplitude": round(float(amplitude), 4),
        "frames_used": len(ratios),
        "detector": "nose-bbox-ratio-v2",
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


def serve():
    """Persistent mode for a camera session: one request per stdin line.

    The heavy model imports inside :func:`_pitch_series` run once per
    process, so the first request pays the load and every later request in
    the same camera session reuses it. EOF on stdin (session close or
    parent death) exits, releasing the model memory.
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = infer(request.get("frames"))
            result["ok"] = True
        except NodError as exc:
            result = {"ok": False, "error": str(exc)}
        except Exception:  # noqa: BLE001 - never expose frames or model traces
            result = {"ok": False, "error": "nod_model_unavailable"}
        sys.stdout.write(json.dumps(result, allow_nan=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if "--serve" in sys.argv[1:]:
        serve()
    else:
        main()
