"""Operator-reviewed image fields and immutable research citations.

Images and text are untrusted research data, never instructions or permissions.
All v1 extraction is explicitly manual; a hash verifies bytes, not factual truth.
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import math
import os
import re
import secrets
import threading
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

from ..core.atomic_write import atomic_write_text
from ..workspace.artifact_store import ArtifactStore
from .schemas import now_iso
from .store import EvidenceStore

_LOCK = threading.RLock()
_ID = re.compile(r"ve_[a-f0-9]{24}")
FLAGS = {"blurred", "cropped", "unit_ambiguous", "low_resolution"}
STATUSES = {"pending_review", "reviewed", "corrected", "insufficient_information"}
MAX_BYTES = 4_000_000


class VisualError(ValueError):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.status = status


def text(value, limit=1000):
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise VisualError("invalid_text")
    return value.strip()


def _date(value):
    from datetime import datetime
    value = text(value or "", 64)
    if value:
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise VisualError("invalid_date") from exc
    return value or None


def _image(data):
    try:
        from PIL import Image
    except ImportError as exc:
        raise VisualError("visual_dependency_missing", 503) from exc
    if not isinstance(data, str) or len(data) > 5_400_000:
        raise VisualError("image_too_large", 413)
    prefix, _, content = data.partition(",")
    if prefix not in {"data:image/png;base64", "data:image/jpeg;base64"}:
        raise VisualError("png_or_jpeg_required")
    try:
        raw = base64.b64decode(content, validate=True)
        if not raw or len(raw) > MAX_BYTES:
            raise VisualError("image_too_large", 413)
        with Image.open(io.BytesIO(raw)) as image:
            w, h = image.size
            if image.format not in {"PNG", "JPEG"} or getattr(image, "n_frames", 1) != 1:
                raise VisualError("png_or_jpeg_required")
            if w * h > 8_000_000 or w < 20 or h < 20:
                raise VisualError("unsupported_image_dimensions")
            image.load()
            if image.getexif().get(274, 1) != 1:
                raise VisualError("export_upright_image")
            mime = "image/png" if image.format == "PNG" else "image/jpeg"
    except VisualError:
        raise
    except (binascii.Error, ValueError, OSError, Image.DecompressionBombError) as exc:
        raise VisualError("invalid_image") from exc
    return raw, w, h, mime


def _field(body):
    bbox = body.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise VisualError("invalid_bbox")
    if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in bbox):
        raise VisualError("invalid_bbox")
    x, y, w, h = bbox
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1.0000001 or y + h > 1.0000001:
        raise VisualError("invalid_bbox")
    flags = body.get("quality_flags", [])
    if not isinstance(flags, list) or any(flag not in FLAGS for flag in flags):
        raise VisualError("invalid_quality_flags")
    status = body.get("review_status", "pending_review")
    if status not in STATUSES:
        raise VisualError("invalid_review_status")
    value = text(body.get("normalized_value") or "", 100)
    if value:
        try:
            if not Decimal(value).is_finite():
                raise InvalidOperation()
        except InvalidOperation as exc:
            raise VisualError("invalid_numeric_value") from exc
    result = {"label": text(body.get("label", ""), 200), "raw_text": text(body.get("raw_text", "")),
              "normalized_value": value or None, "unit": text(body.get("unit", ""), 100),
              "period": text(body.get("period", ""), 100), "bbox": bbox, "page": 1,
              "quality_flags": sorted(set(flags)), "review_status": status,
              "extractor_version": "manual-v1", "extraction_mode": "manual"}
    if not result["label"] or not result["raw_text"]:
        raise VisualError("label_and_raw_text_required")
    if status in {"reviewed", "corrected"} and (not value or not result["unit"] or not result["period"]):
        raise VisualError("value_unit_period_required")
    return result


class VisualStore:
    def __init__(self, config):
        self.config = config
        self.root = config.paths.artifacts / "visual-evidence"
        self.artifacts = ArtifactStore(config.paths)
        self.evidence = EvidenceStore(config.paths.root)

    def _path(self, artifact_id, suffix="json"):
        if not isinstance(artifact_id, str) or not _ID.fullmatch(artifact_id):
            raise VisualError("invalid_artifact_id")
        path = self.root / f"{artifact_id}.{suffix}"
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise VisualError("invalid_artifact_path")
        return path

    @contextmanager
    def _locked(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with _LOCK, (self.root / ".lock").open("a+b") as handle:
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _load(self, artifact_id):
        path = self._path(artifact_id)
        if not path.is_file():
            raise VisualError("artifact_not_found", 404)
        return json.loads(path.read_text(encoding="utf-8"))

    def _save(self, doc):
        atomic_write_text(self._path(doc["artifact_id"]), json.dumps(doc, ensure_ascii=False, allow_nan=False))

    def upload(self, body, actor):
        raw, w, h, mime = _image(body.get("image"))
        source = text(body.get("source_url") or "", 2000)
        if source and (urlsplit(source).scheme not in {"http", "https"} or not urlsplit(source).netloc
                       or urlsplit(source).username or urlsplit(source).password):
            raise VisualError("invalid_source_url")
        doc = {"artifact_id": "ve_" + secrets.token_hex(12), "file_sha256": self.artifacts.content_hash(raw),
               "original_version": 1, "filename": text(body.get("filename") or "image", 200),
               "source_url": source or None, "published_at": _date(body.get("published_at")),
               "captured_at": now_iso(), "uploaded_by": actor, "width": w, "height": h,
               "mime": mime, "page": 1, "coordinate_convention": "normalized_xywh_top_left",
               "source_verification": "unverified", "extraction_mode": "manual", "revision": 1,
               "quality_flags": ["low_resolution"] if w < 400 or h < 200 else [],
               "fields": [], "claims": []}
        with self._locked():
            self.artifacts.put_bytes("visual-evidence", f'{doc["artifact_id"]}.image', raw)
            self._save(doc)
        return doc

    def get(self, artifact_id):
        return self._load(artifact_id)

    def list(self):
        if not self.root.exists():
            return []
        docs = [json.loads(p.read_text(encoding="utf-8")) for p in self.root.glob("ve_*.json")]
        return [{k: v for k, v in doc.items() if k not in {"fields", "claims"}}
                for doc in sorted(docs, key=lambda d: d["captured_at"], reverse=True)[:100]]

    def image(self, artifact_id):
        doc = self._load(artifact_id)
        raw = self._path(artifact_id, "image").read_bytes()
        if self.artifacts.content_hash(raw) != doc["file_sha256"]:
            raise VisualError("artifact_hash_mismatch", 409)
        return raw, doc["mime"]

    def revise_field(self, artifact_id, body, actor):
        revision = _field(body)
        with self._locked():
            doc = self._load(artifact_id)
            if body.get("expected_revision") != doc["revision"]:
                raise VisualError("revision_conflict", 409)
            field_id = body.get("field_id")
            field = next((f for f in doc["fields"] if f["field_id"] == field_id), None)
            if field_id and not field:
                raise VisualError("field_not_found", 404)
            if field is None:
                if len(doc["fields"]) >= 100:
                    raise VisualError("field_limit_reached")
                field = {"field_id": "vf_" + secrets.token_hex(8), "versions": []}
                doc["fields"].append(field)
            revision.update(revision=len(field["versions"]) + 1, reviewer_id=actor, reviewed_at=now_iso())
            field["versions"].append(revision)
            for claim in doc["claims"]:
                if any(ref["field_id"] == field["field_id"] for ref in claim["field_refs"]):
                    claim["status"] = "needs_review"
            doc["revision"] += 1
            self._save(doc)
        return doc

    def cite(self, artifact_id, body, actor):
        title = text(body.get("title", ""), 200)
        claim_text = text(body.get("claim", ""), 4000)
        refs = body.get("field_refs")
        if not title or not claim_text or not isinstance(refs, list) or not 1 <= len(refs) <= 20:
            raise VisualError("claim_and_field_refs_required")
        with self._locked():
            doc = self._load(artifact_id)
            if body.get("expected_revision") != doc["revision"]:
                raise VisualError("revision_conflict", 409)
            if len(doc["claims"]) >= 100:
                raise VisualError("claim_limit_reached")
            citations, snapshots, links = [], [], []
            for ref in refs:
                if not isinstance(ref, dict):
                    raise VisualError("invalid_field_reference")
                field = next((f for f in doc["fields"] if f["field_id"] == ref.get("field_id")), None)
                if not field or field["versions"][-1]["revision"] != ref.get("revision"):
                    raise VisualError("field_revision_conflict", 409)
                version = field["versions"][-1]
                if version["review_status"] not in {"reviewed", "corrected"}:
                    raise VisualError("field_review_required", 409)
                locator = f'visual:{artifact_id}:{field["field_id"]}:{version["revision"]}'
                href = f'/visual-evidence?artifact={artifact_id}&field={field["field_id"]}&revision={version["revision"]}'
                citations.append(locator)
                snapshots.append({"field_id": field["field_id"], "revision": version["revision"]})
                links.append({"href": href, "label": version["label"], "snapshot": version})
            claim_id = "vc_" + secrets.token_hex(8)
            report = {"claim_id": claim_id, "claim": claim_text, "field_refs": snapshots,
                      "source_verification": "unverified", "research_status": "unvalidated_hypothesis",
                      "citations": links}
            evidence = self.evidence.ingest(source_type="research", source_id=claim_id, title=title,
                summary=claim_text, body=json.dumps(report, ensure_ascii=False, indent=2),
                tags=["visual-evidence", "manual-review", "unvalidated-hypothesis"],
                route="POST /evidence/visual/cite", created_by=actor, artifact_refs=citations)
            doc["claims"].append({"claim_id": claim_id, "title": title, "claim": claim_text,
                "field_refs": snapshots, "evidence_id": evidence.evidence_id,
                "status": "unvalidated_hypothesis", "created_by": actor, "created_at": now_iso()})
            doc["revision"] += 1
            self._save(doc)
        return doc

    def decorate_evidence(self, record):
        """Resolve live dependency state without overwriting immutable report content."""
        links = []
        for locator in record.get("provenance", {}).get("artifact_refs", []):
            if not isinstance(locator, str) or not locator.startswith("visual:"):
                continue
            stale = True
            try:
                _, aid, fid, rev = locator.split(":")
                doc = self._load(aid)
                field = next(f for f in doc["fields"] if f["field_id"] == fid)
                version = next(v for v in field["versions"] if str(v["revision"]) == rev)
                stale = str(field["versions"][-1]["revision"]) != rev
                links.append({"label": version["label"], "revision": int(rev), "needs_review": stale,
                              "href": f"/visual-evidence?artifact={aid}&field={fid}&revision={rev}"})
            except (VisualError, ValueError, StopIteration, OSError, KeyError):
                links.append({"label": "Unavailable visual reference", "needs_review": True})
        if links:
            return {**record, "visual_citations": links, "research_status":
                    "needs_review" if any(link["needs_review"] for link in links) else "unvalidated_hypothesis",
                    "source_verification": "unverified"}
        return record
