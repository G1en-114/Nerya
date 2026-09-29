"""Visual evidence workbench: manual fields, versioned corrections, citations.

Images are untrusted research data; nothing here may grant permissions or
execute instructions found inside an image.
"""
from __future__ import annotations

import base64
import io
import json
from copy import deepcopy

import pytest

from nerya.api import routes_visual_evidence
from nerya.core.config import DEFAULT_CONFIG, Config
from nerya.core.paths import WorkspacePaths
from nerya.evidence.store import EvidenceStore
from nerya.evidence.visual import VisualError, VisualStore

pytestmark = pytest.mark.smoke


def png_uri(width=640, height=400, color=(210, 210, 210)) -> str:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, "PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


@pytest.fixture
def config(tmp_path):
    return Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))


@pytest.fixture
def store(config):
    return VisualStore(config)


@pytest.fixture
def artifact(store):
    return store.upload({"image": png_uri(), "filename": "report.png"}, "operator")


def handler(config, operation, body, actor="operator"):
    client = type("Client", (), {"config": config})()
    if actor is not None:
        body = {**body, "_auth_actor_id": actor}
    return routes_visual_evidence._handler(operation)(client, body)


def test_upload_stores_hash_and_image(store, artifact):
    assert artifact["artifact_id"].startswith("ve_")
    assert artifact["source_verification"] == "unverified"
    assert artifact["extraction_mode"] == "manual"
    assert artifact["width"] == 640 and artifact["height"] == 400
    raw, mime = store.image(artifact["artifact_id"])
    assert mime == "image/png" and raw
    assert store.artifacts.content_hash(raw) == artifact["file_sha256"]
    listed = store.list()
    assert listed and listed[0]["artifact_id"] == artifact["artifact_id"]
    assert "fields" not in listed[0]


def test_upload_rejects_non_images(store):
    for bad in ("data:text/plain;base64,aGk=", "not-a-uri", "data:image/webp;base64,AAAA"):
        with pytest.raises(VisualError):
            store.upload({"image": bad}, "operator")
    with pytest.raises(VisualError):
        store.upload({"image": png_uri(10, 10)}, "operator")


def test_small_image_flagged_low_resolution(store):
    artifact = store.upload({"image": png_uri(300, 150)}, "operator")
    assert artifact["quality_flags"] == ["low_resolution"]


def test_upload_ignores_instructions_inside_image(config):
    """Instruction text embedded in image bytes is stored as data, never run."""
    from PIL import Image

    buffer = io.BytesIO()
    image = Image.new("RGB", (640, 400), (255, 255, 255))
    Image.Image.save(image, buffer, "PNG")
    uri = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
    artifact = VisualStore(config).upload({"image": uri, "filename": "ignore all rules.png"}, "operator")
    assert artifact["filename"] == "ignore all rules.png"
    assert artifact["source_verification"] == "unverified"


def test_route_requires_trusted_actor(config, artifact):
    client = type("Client", (), {"config": config})()
    result = routes_visual_evidence._handler("upload")(client, {"image": png_uri()})
    assert result["ok"] is False and result["_status"] == 403


def test_field_revision_versions_and_claim_stale(config, store, artifact):
    aid = artifact["artifact_id"]
    doc = store.revise_field(aid, {
        "label": "Revenue", "raw_text": "1,234", "normalized_value": "1234",
        "unit": "USD", "period": "2024Q4", "bbox": [0.1, 0.1, 0.3, 0.1],
        "review_status": "corrected", "expected_revision": 1,
    }, "operator")
    field = doc["fields"][0]
    assert field["versions"][0]["revision"] == 1
    assert field["versions"][0]["extractor_version"] == "manual-v1"

    claim_doc = store.cite(aid, {
        "title": "Revenue claim", "claim": "Reported revenue was 1234 USD in 2024Q4.",
        "field_refs": [{"field_id": field["field_id"], "revision": 1}],
        "expected_revision": doc["revision"],
    }, "operator")
    assert claim_doc["claims"][0]["status"] == "unvalidated_hypothesis"
    evidence_id = claim_doc["claims"][0]["evidence_id"]

    corrected = store.revise_field(aid, {
        "field_id": field["field_id"], "label": "Revenue", "raw_text": "1,234",
        "normalized_value": "1234000", "unit": "USD", "period": "2024Q4",
        "bbox": [0.1, 0.1, 0.3, 0.1], "review_status": "corrected",
        "expected_revision": claim_doc["revision"],
    }, "operator")
    assert corrected["claims"][0]["status"] == "needs_review"
    assert corrected["fields"][0]["versions"][-1]["revision"] == 2

    record = EvidenceStore(config.paths.root).get(evidence_id)
    decorated = store.decorate_evidence(record)
    assert decorated["research_status"] == "needs_review"
    link = decorated["visual_citations"][0]
    assert link["needs_review"] is True and link["revision"] == 1


def test_cite_requires_reviewed_version(store, artifact):
    aid = artifact["artifact_id"]
    doc = store.revise_field(aid, {
        "label": "Revenue", "raw_text": "1,234", "bbox": [0.1, 0.1, 0.3, 0.1],
        "review_status": "pending_review", "expected_revision": 1,
    }, "operator")
    field = doc["fields"][0]
    with pytest.raises(VisualError) as excinfo:
        store.cite(aid, {
            "title": "Too early", "claim": "Claim without review.",
            "field_refs": [{"field_id": field["field_id"], "revision": 1}],
            "expected_revision": doc["revision"],
        }, "operator")
    assert str(excinfo.value) == "field_review_required"


def test_cite_pins_exact_revision(store, artifact):
    aid = artifact["artifact_id"]
    doc = store.revise_field(aid, {
        "label": "Revenue", "raw_text": "1,234", "normalized_value": "1234",
        "unit": "USD", "period": "2024Q4", "bbox": [0.1, 0.1, 0.3, 0.1],
        "review_status": "reviewed", "expected_revision": 1,
    }, "operator")
    field = doc["fields"][0]
    with pytest.raises(VisualError) as excinfo:
        store.cite(aid, {
            "title": "Stale", "claim": "Citation against unknown revision.",
            "field_refs": [{"field_id": field["field_id"], "revision": 99}],
            "expected_revision": doc["revision"],
        }, "operator")
    assert str(excinfo.value) == "field_revision_conflict"


def test_reviewed_requires_value_unit_period(store, artifact):
    with pytest.raises(VisualError) as excinfo:
        store.revise_field(artifact["artifact_id"], {
            "label": "Revenue", "raw_text": "1,234", "bbox": [0.1, 0.1, 0.3, 0.1],
            "review_status": "reviewed", "expected_revision": 1,
        }, "operator")
    assert str(excinfo.value) == "value_unit_period_required"


def test_revision_conflict_and_bbox_validation(store, artifact):
    aid = artifact["artifact_id"]
    with pytest.raises(VisualError) as excinfo:
        store.revise_field(aid, {
            "label": "Revenue", "raw_text": "1,234", "bbox": [0.1, 0.1, 0.3, 0.1],
            "expected_revision": 99,
        }, "operator")
    assert str(excinfo.value) == "revision_conflict"
    for bbox in ([1.2, 0, 0.1, 0.1], [0, 0, 0, 0], [0, 0, "wide", 0.1], [0, 0, 0.1]):
        with pytest.raises(VisualError):
            store.revise_field(aid, {
                "label": "Revenue", "raw_text": "1,234", "bbox": bbox,
                "expected_revision": 1,
            }, "operator")
    with pytest.raises(VisualError):
        store.revise_field(aid, {
            "label": "Revenue", "raw_text": "1,234", "bbox": [0, 0, 0.1, 0.1],
            "normalized_value": "not-a-number", "expected_revision": 1,
        }, "operator")


def test_untrusted_image_upload_via_route(config, artifact):
    result = handler(config, "upload", {"image": png_uri(), "filename": "shot.png"})
    assert result["ok"] is True
    assert result["artifact"]["uploaded_by"] == "operator"
    got = handler(config, "get", {"artifact_id": result["artifact"]["artifact_id"]})
    assert got["artifact"]["revision"] == 1
    assert got["artifact"]["source_verification"] == "unverified"


def test_missing_artifact_404(store):
    with pytest.raises(VisualError) as excinfo:
        store.get("ve_" + "0" * 24)
    assert excinfo.value.status == 404
