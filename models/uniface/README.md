# UniFace model cache (committed for offline demo machines)

These ONNX weights are seeded into `~/.uniface/models/` by
`python scripts/setup_vision_stack.py` so the nod/face workers never need
to download anything at demo time.

| File | Role | Used by |
| --- | --- | --- |
| `scrfd_500m.onnx` | face detection (login capture) | `nerya/vision/face_worker.py` |
| `scrfd_10g.onnx` | face detection with keypoints (nod tracking) | `nerya/vision/nod_worker.py` |
| `arcface_mnet.onnx` | embedding / reference comparison | `nerya/vision/face_worker.py` |
| `minifasnet_v2.onnx` | passive anti-spoofing (liveness) | `nerya/vision/face_worker.py` |

Provenance: weights ship with the [UniFace](https://github.com/deepinsight/insightface)
toolchain (SCRFD / ArcFace / MiniFASNet, InsightFace research models).
InsightFace models are released for non-commercial research use; this
repository is PolyForm Noncommercial 1.0.0, consistent with that terms set.
They are detection/recognition weights only: they prove nothing about
identity, liveness or authority by themselves, and the nod detector uses
them purely as a motion-signal tracker.
