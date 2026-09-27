"""Bounded plain-text preview of an uploaded immutable reference artifact."""
from __future__ import annotations

import hashlib
from pathlib import PurePosixPath


def reference_preview(paths, uri: str) -> dict:
    prefix="nerya://artifact/attachments/"
    if not isinstance(uri,str) or not uri.startswith(prefix):
        return {"ok":False,"error":"invalid_reference","_status":400}
    relative=uri[len(prefix):]
    parts=relative.split("/")
    if not relative or any(part in ("",".","..") for part in parts) or "\\" in relative or "\x00" in relative:
        return {"ok":False,"error":"invalid_reference","_status":400}
    root=(paths.artifacts/"attachments").resolve()
    target=root.joinpath(*PurePosixPath(relative).parts)
    if any(root.joinpath(*parts[:index]).is_symlink() for index in range(1,len(parts)+1)):
        return {"ok":False,"error":"invalid_reference","_status":400}
    if not target.resolve().is_relative_to(root):
        return {"ok":False,"error":"invalid_reference","_status":400}
    try:
        with target.open("rb") as stream:
            raw=stream.read(128_001)
        if b"\0" in raw:
            return {"ok":False,"error":"binary_reference","_status":415}
        text=raw[:128_000].decode("utf-8",errors="replace")
        truncated=len(raw)>128_000
        return {"ok":True,"content":text,"truncated":truncated,
                "artifact_sha256":None if truncated else hashlib.sha256(raw).hexdigest()}
    except FileNotFoundError:
        return {"ok":False,"error":"reference_not_found","_status":404}
    except OSError:
        return {"ok":False,"error":"reference_unavailable","_status":503}
