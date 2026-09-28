---
name: face-analysis
description: Detect faces and landmarks in local images or compare two supplied face photos with UniFace. Use for explicit image-analysis requests.
license: MIT
---

# Face analysis

Run `script_run` with `skill_id="face-analysis"`, `name="face_analysis.py"`,
and `args=["--json", "<JSON object>"]`. Images are local files; this skill
does not fetch URLs, capture a camera, enroll identities or persist biometrics.

Analyze an image:
`{"operation":"analyze","image_path":"uploads/photo.jpg"}`

Compare two user-supplied photos:
`{"operation":"compare","image_path":"uploads/photo.jpg","reference_path":"uploads/reference.jpg","threshold":0.5}`

Optional `detector`: `scrfd` (default), `retinaface`, `yolov8face`.
Optional `recognizer`: `arcface` (default), `adaface`.
Paths resolve relative to the script runner's working directory.
Output contains bounding boxes, confidence and alignment landmarks for analysis,
or cosine similarity and an advisory `match` for comparison. Raw embeddings and
image data are not returned. Comparison requires exactly one face in each photo;
missing embeddings, invalid images and unavailable models return `ok:false`.

The operator installs `pip install "nerya[face]"` for CPU/Apple Silicon or
`pip install "nerya[face-gpu]"` for NVIDIA CUDA (with compatible CUDA libraries).
Weights download on first explicit analysis; imports and help do not load models.
Review pretrained model licences before commercial deployment.

A match is not proof of identity or liveness and must not approve trades,
unlock wallets or bypass Approval Gate. The default threshold is a starting
point for evaluation, not a calibrated authentication threshold. This version
does not expose age, sex, emotion, anti-spoofing, video or FAISS search.

Upstream API and models: https://yakhyo.github.io/uniface/quickstart/
