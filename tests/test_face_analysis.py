from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from nerya.vision import face

pytestmark = pytest.mark.smoke
SCRIPT = Path(__file__).parents[1] / "nerya/skills/builtin/face-analysis/scripts/face_analysis.py"
spec = importlib.util.spec_from_file_location("face_analysis_script", SCRIPT)
script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(script)


def detection(embedding=(1.0, 0.0)):
    return SimpleNamespace(bbox=[0, 0, 10, 10], confidence=0.99,
                           landmarks=[[1, 2], [3, 4]], embedding=embedding)


def service(monkeypatch, responses):
    analyzer = SimpleNamespace(analyze=lambda image: next(responses))
    result = face.FaceService(analyzer=analyzer)
    monkeypatch.setattr(result, "_image", lambda path: path)
    return result


def test_analysis_does_not_return_embeddings(monkeypatch):
    result = service(monkeypatch, iter([[detection()]])).analyze("photo.jpg")
    assert result["face_count"] == 1
    assert result["faces"][0]["landmarks"] == [[1, 2], [3, 4]]
    assert "embedding" not in result["faces"][0]
    json.dumps(result, allow_nan=False)


def test_empty_analysis(monkeypatch):
    assert service(monkeypatch, iter([[]])).analyze("x")["faces"] == []


@pytest.mark.parametrize("embedding,expected", [((2, 0), True), ((0, 1), False)])
def test_compare_decision(monkeypatch, embedding, expected):
    result = service(monkeypatch, iter([[detection()], [detection(embedding)]])).compare("a", "b")
    assert result["match"] is expected
    assert result["authentication"] is False
    assert result["liveness_checked"] is False


@pytest.mark.parametrize("faces", [[], [detection(), detection()]])
def test_compare_rejects_ambiguous_faces(monkeypatch, faces):
    with pytest.raises(face.FaceError, match="one_face"):
        service(monkeypatch, iter([faces, [detection()]])).compare("a", "b")


@pytest.mark.parametrize("embedding", [None, [], [0, 0], [float("nan"), 1], [float("inf"), 1]])
def test_compare_rejects_unusable_embeddings(embedding):
    with pytest.raises(face.FaceError):
        face.cosine_similarity(embedding, [1, 0])


def test_dimension_mismatch():
    with pytest.raises(face.FaceError, match="dimension"):
        face.cosine_similarity([1, 0], [1])


@pytest.mark.parametrize("threshold", [-1, 2, float("nan"), True, "0.5", None])
def test_bad_threshold_does_not_load_models(threshold):
    with pytest.raises(face.FaceError, match="threshold"):
        face.FaceService().compare("a", "b", threshold=threshold)


def test_missing_file_does_not_load_models(tmp_path):
    with pytest.raises(face.FaceError, match="image_not_found"):
        face.FaceService().analyze(str(tmp_path / "missing.jpg"))


def test_oversized_input(tmp_path, monkeypatch):
    monkeypatch.setattr(face, "MAX_IMAGE_BYTES", 3)
    path = tmp_path / "large.jpg"
    path.write_bytes(b"1234")
    with pytest.raises(face.FaceError, match="image_too_large"):
        face.FaceService().analyze(str(path))


def test_invalid_image(tmp_path, monkeypatch):
    path = tmp_path / "bad.jpg"
    path.write_bytes(b"not an image")
    modules = {"cv2": SimpleNamespace(IMREAD_COLOR=1, imdecode=lambda *args: None),
               "numpy": SimpleNamespace(uint8="u8", frombuffer=lambda *args, **kwargs: b"")}
    monkeypatch.setattr(face, "_module", modules.__getitem__)
    with pytest.raises(face.FaceError, match="invalid_image"):
        face.FaceService().analyze(str(path))


def test_model_failure_is_not_a_match(monkeypatch):
    analyzer = SimpleNamespace(analyze=lambda _: (_ for _ in ()).throw(RuntimeError("private path")))
    result = face.FaceService(analyzer=analyzer)
    monkeypatch.setattr(result, "_image", lambda _: None)
    with pytest.raises(face.FaceError, match="^face_analysis_failed$"):
        result.compare("a", "b")


def test_dependency_error_has_install_hint(monkeypatch):
    monkeypatch.setattr(face.importlib, "import_module", lambda _: (_ for _ in ()).throw(ImportError()))
    with pytest.raises(face.FaceError, match="nerya\\[face\\]"):
        face.FaceService()._load()


def test_lazy_model_selection(monkeypatch):
    calls = []
    modules = {
        "uniface": SimpleNamespace(FaceAnalyzer=lambda **kwargs: calls.append(kwargs) or "analyzer"),
        "uniface.detection": SimpleNamespace(RetinaFace=lambda: "detector"),
        "uniface.recognition": SimpleNamespace(AdaFace=lambda: "recognizer"),
    }
    monkeypatch.setattr(face, "_module", modules.__getitem__)
    result = face.FaceService(detector="retinaface", recognizer="adaface")
    assert calls == []
    assert result._load() == "analyzer"
    assert result._load() == "analyzer"
    assert calls == [{"detector": "detector", "recognizer": "recognizer"}]


@pytest.mark.parametrize("payload", [[], {"operation": "enroll"}, {"detector": "unknown"}])
def test_script_invalid_request(payload):
    with pytest.raises(face.FaceError):
        script.execute(payload)


def test_script_json_error(capsys):
    assert script.main(["--json", "{"]) == 1
    assert json.loads(capsys.readouterr().out) == {"ok": False, "error": "invalid_json"}


def test_script_single_json_response(monkeypatch, capsys):
    def execute(payload):
        print("upstream output")
        return {"ok": True, "face_count": 0}
    monkeypatch.setattr(script, "execute", execute)
    assert script.main(["--json", "{}"]) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out)["face_count"] == 0
    assert "upstream output" in captured.err


def test_skill_discovered_without_loading_models():
    from nerya.skills.registry import SkillRegistry
    entry = SkillRegistry.load_builtin().get("face-analysis")
    assert entry.manifest.id == "face-analysis"
    assert (entry.manifest.path / "scripts/face_analysis.py").is_file()
