"""Lazy UniFace adapter for local detection, landmarks and image comparison.

No images or embeddings are persisted. A similarity decision is advisory;
it is never an authentication, liveness or trading-approval assertion.
"""
from __future__ import annotations

import importlib
import math
from pathlib import Path
from typing import Any

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
DETECTORS = ("scrfd", "retinaface", "yolov8face")
RECOGNIZERS = ("arcface", "adaface")


class FaceError(ValueError):
    """Stable, public error without image contents or local paths."""


def _module(name: str):
    try:
        return importlib.import_module(name)
    except ImportError as exc:
        raise FaceError("face_dependency_missing: install nerya[face] or nerya[face-gpu]") from exc


def _vector(value: Any) -> list[float]:
    if value is None:
        raise FaceError("embedding_unavailable")
    try:
        values = [float(x) for x in value]
    except (TypeError, ValueError) as exc:
        raise FaceError("invalid_embedding") from exc
    if not values or not all(math.isfinite(x) for x in values):
        raise FaceError("invalid_embedding")
    norm = math.hypot(*values)
    if not math.isfinite(norm) or norm == 0:
        raise FaceError("invalid_embedding")
    return [x / norm for x in values]


def cosine_similarity(left: Any, right: Any) -> float:
    a, b = _vector(left), _vector(right)
    if len(a) != len(b):
        raise FaceError("embedding_dimension_mismatch")
    return max(-1.0, min(1.0, math.fsum(x * y for x, y in zip(a, b))))


def _numbers(value: Any) -> Any:
    """Convert numpy results without making numpy a module import requirement."""
    if value is None:
        return None
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        return [_numbers(item) for item in value]
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise FaceError("invalid_model_output") from exc
    if not math.isfinite(number):
        raise FaceError("invalid_model_output")
    return number


class FaceService:
    def __init__(self, *, detector: str = "scrfd", recognizer: str = "arcface", analyzer=None):
        if detector not in DETECTORS or recognizer not in RECOGNIZERS:
            raise FaceError("unsupported_face_model")
        self.detector = detector
        self.recognizer = recognizer
        self._analyzer = analyzer

    def _load(self):
        if self._analyzer is None:
            uniface = _module("uniface")
            detection = _module("uniface.detection")
            recognition = _module("uniface.recognition")
            detectors = {"scrfd": "SCRFD", "retinaface": "RetinaFace", "yolov8face": "YOLOv8Face"}
            recognizers = {"arcface": "ArcFace", "adaface": "AdaFace"}
            try:
                self._analyzer = uniface.FaceAnalyzer(
                    detector=getattr(detection, detectors[self.detector])(),
                    recognizer=getattr(recognition, recognizers[self.recognizer])(),
                )
            except Exception as exc:
                raise FaceError("face_model_initialization_failed") from exc
        return self._analyzer

    def _image(self, path: str):
        if not isinstance(path, str) or not path:
            raise FaceError("image_path_required")
        try:
            source = Path(path)
            if not source.is_file():
                raise FaceError("image_not_found")
            with source.open("rb") as stream:
                data = stream.read(MAX_IMAGE_BYTES + 1)
        except OSError as exc:
            raise FaceError("image_unreadable") from exc
        if len(data) > MAX_IMAGE_BYTES:
            raise FaceError("image_too_large")
        cv2 = _module("cv2")
        np = _module("numpy")
        try:
            image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        except Exception as exc:
            raise FaceError("invalid_image") from exc
        if image is None:
            raise FaceError("invalid_image")
        if image.shape[0] * image.shape[1] > MAX_IMAGE_PIXELS:
            raise FaceError("image_too_large")
        return image

    def _faces(self, image):
        analyzer = self._load()
        try:
            return analyzer.analyze(image)
        except Exception as exc:
            raise FaceError("face_analysis_failed") from exc

    def analyze(self, image_path: str) -> dict[str, Any]:
        faces = self._faces(self._image(image_path))
        return {
            "ok": True, "backend": "uniface", "detector": self.detector,
            "recognizer": self.recognizer, "face_count": len(faces),
            "faces": [{"bbox": _numbers(face.bbox),
                       "confidence": _numbers(face.confidence),
                       "landmarks": _numbers(face.landmarks),
                       "embedding_available": getattr(face, "embedding", None) is not None}
                      for face in faces],
        }

    def compare(self, image_path: str, reference_path: str, *, threshold: float = 0.5) -> dict[str, Any]:
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
            raise FaceError("invalid_threshold")
        if not math.isfinite(threshold) or not 0 <= threshold <= 1:
            raise FaceError("invalid_threshold")
        # Decode both before initializing/downloading models.
        image, reference = self._image(image_path), self._image(reference_path)
        left, right = self._faces(image), self._faces(reference)
        if len(left) != 1 or len(right) != 1:
            raise FaceError("comparison_requires_one_face_per_image")
        score = cosine_similarity(getattr(left[0], "embedding", None),
                                  getattr(right[0], "embedding", None))
        return {"ok": True, "backend": "uniface", "detector": self.detector,
                "recognizer": self.recognizer, "similarity": score,
                "threshold": threshold, "match": score >= threshold,
                "authentication": False, "liveness_checked": False}
