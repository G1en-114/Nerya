"""Publish sourced research visuals through the existing chart_blocks protocol.

No market fetches, model calls, strategy mutations or execution-loop changes.
Usage: python -m nerya.skills.builtin.research.scripts.publish_visuals --input research.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from nerya.charting.composer import BulkContext, build_chart_block, load_chart_artifact, persist_chart_artifact
from nerya.core.paths import WorkspacePaths
from nerya.workspace.artifact_store import ArtifactStore


def _text(value: Any, label: str, limit: int = 240) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{label} must be a nonempty string of at most {limit} characters")
    return value.strip()


def _url(value: Any) -> str:
    value = _text(value, "source URL", 2048)
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("source URL must be HTTP(S), without credentials")
    return value


def _date(value: Any) -> str:
    stamp = datetime.fromisoformat(_text(value, "as-of date", 80).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("dates must include their timezone")
    return stamp.astimezone(timezone.utc).isoformat()


def _instrument(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("news", []), list):
        raise ValueError("instrument must be an object with a news array")
    market = _text(raw.get("market"), "market", 160)
    venue = str(raw.get("venue") or "").strip().lower()
    prefix, separator, tail = market.partition(":")
    if not venue and separator and re.fullmatch(r"[A-Za-z0-9_-]+", prefix):
        venue = prefix.lower()
    if venue and not re.fullmatch(r"[a-z0-9_-]+", venue):
        raise ValueError("venue must be a provider identifier")
    if any(c in market for c in "\r\n<>"):
        raise ValueError("invalid market identifier")
    if venue and not market.lower().startswith(venue + ":"):
        market = venue.upper() + ":" + market
    news = []
    for row in raw.get("news", [])[:12]:
        news.append({"title": _text(row.get("title"), "news title"),
                     "url": _url(row.get("url") or row.get("link")),
                     "source": _text(row.get("source"), "news source"),
                     "published_at": _date(row["published_at"]) if row.get("published_at") else "",
                     **({"summary": _text(row["summary"], "news summary", 600)} if row.get("summary") else {})})
    status = raw.get("news_status") or ("ok" if news else "not_requested")
    if status not in ("ok", "empty", "unavailable", "not_requested"):
        raise ValueError("invalid news_status")
    interval = raw.get("interval") or "1h"
    if not re.fullmatch(r"[1-9][0-9]*[mhdwM]", interval):
        raise ValueError("invalid candle interval")
    return {"market": market, "venue": venue, "name": raw.get("name") or market,
            "interval": interval, "news": news, "news_status": status,
            "news_as_of": _date(raw["news_as_of"]) if raw.get("news_as_of") else ""}


def _series(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 32:
        raise ValueError("charts require 1 to 32 series")
    names: set[str] = set()
    for series in raw:
        if not isinstance(series, dict):
            raise ValueError("series must be an object")
        name = _text(series.get("name"), "series name", 160)
        if name in names:
            raise ValueError("series names must be unique")
        names.add(name)
        rows = series.get("data")
        if not isinstance(rows, list) or not 1 <= len(rows) <= 50000:
            raise ValueError("series require 1 to 50000 observed points; do not fill missing data with zero")
        previous = -math.inf
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("each point must be an object")
            ts = row.get("time")
            if isinstance(ts, bool) or not isinstance(ts, (int, float)) or not math.isfinite(ts) or not previous < ts < 1e11 or ts < 0:
                raise ValueError("point times must be ascending unique Unix seconds, not milliseconds")
            previous = ts
            fields = ["open", "high", "low", "close"] if series.get("type") in ("candlestick", "bar") else ["value"]
            for key in fields + (["volume"] if "volume" in row else []):
                value = row.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError("chart values must be finite numbers")
            if "open" in fields and (row["high"] < max(row["open"], row["close"]) or row["low"] > min(row["open"], row["close"]) or row["low"] > row["high"]):
                raise ValueError("invalid OHLC range")
    return raw


def publish_visuals(payload: dict[str, Any], workspace: str | Path | None = None) -> dict[str, Any]:
    """Validate the complete batch before writing artifacts; print its returned JSON intact."""
    payload = deepcopy(payload)
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    # Reject nonfinite values even in optional metadata and limit envelope amplification.
    if len(json.dumps(payload, allow_nan=False).encode()) > 6 * 1024 * 1024:
        raise ValueError("research payload exceeds 6 MiB")
    raw_instruments = payload.get("instruments", [])
    raw_charts = payload.get("charts", []) + payload.get("chart_blocks", [])
    if not isinstance(raw_instruments, list) or len(raw_instruments) > 40 or len(raw_charts) > 16:
        raise ValueError("publish at most 40 instruments and 16 charts in one batch")
    instruments = [_instrument(row) for row in raw_instruments]
    store = ArtifactStore(WorkspacePaths(root=Path(workspace).resolve())) if workspace else None
    prepared = []
    for raw in raw_charts:
        if not isinstance(raw, dict):
            raise ValueError("each chart must be an object")
        source = dict(raw.get("source") or {})
        source["as_of"] = _date(source.get("as_of"))
        source["skill"] = _text(source.get("skill"), "source skill")
        source["action"] = _text(source.get("action"), "source action")
        if source.get("cite_url"):
            source["cite_url"] = _url(source["cite_url"])
        elif not source.get("artifact_path") and source["skill"] != "markets":
            raise ValueError("analysis charts require a source URL or source artifact_path")
        if raw.get("path") == "bulk" and any(row.get("data") is None for row in raw.get("series", [])):
            if store is None:
                raise ValueError("existing bulk charts require their workspace")
            artifact = load_chart_artifact(store, _text(raw.get("chart_id"), "chart ID"))
            if not artifact:
                raise ValueError("referenced chart artifact is missing")
            data = {row["name"]: row.get("data") for row in artifact.get("series", [])}
            for row in raw["series"]:
                row["data"] = data.get(row["name"])
                row.pop("data_uri", None)
        series = _series(raw.get("series"))
        kwargs = {key: raw[key] for key in ("subtitle", "caption", "insights", "overlays", "panes", "default_range", "ui") if raw.get(key) not in (None, [], {}, "")}
        kwargs.update(title=_text(raw.get("title"), "chart title"), chart_kind=raw.get("chart_kind", "multi"), series=series, source=source)
        fingerprint = json.dumps(kwargs, sort_keys=True, ensure_ascii=False, allow_nan=False)
        kwargs["chart_id"] = "research-" + hashlib.sha256(fingerprint.encode()).hexdigest()[:24]
        # Validate the full descriptor before any artifact write. Point validity
        # was checked above; one point per series avoids inline-size promotion.
        validation = {**kwargs, "series": [{**row, "data": row["data"][:1]} for row in series]}
        build_chart_block(**validation)
        instrument = _instrument(raw["instrument"]) if raw.get("instrument") else None
        if instrument:
            if not any(row.get("type") == "candlestick" for row in series):
                raise ValueError("instrument detail charts must contain candlesticks; comparison charts belong on the left")
            instruments.append(instrument)
        prepared.append((kwargs, instrument, raw.get("warnings", [])))
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for item in instruments:
        key = (item["venue"], item["market"].upper())
        prior = merged.get(key)
        if prior:
            item = {**item, "name": prior["name"], "news": prior["news"] or item["news"],
                    "news_status": prior["news_status"] if prior["news"] else item["news_status"],
                    "news_as_of": prior["news_as_of"] or item["news_as_of"]}
        merged[key] = item
    if not merged and not prepared:
        raise ValueError("nothing to publish")
    context = {"version": 1, "instruments": list(merged.values())}
    blocks = []
    for kwargs, instrument, warnings in prepared:
        block = build_chart_block(**kwargs, path="bulk" if store else "inline", ctx=BulkContext(store) if store else None).as_dict()
        block["research_context"] = context
        if instrument:
            block["instrument"] = instrument
            block.update(market=instrument["market"], venue=instrument["venue"], interval=instrument["interval"])
        block["warnings"] = list(block.get("warnings") or []) + [str(w)[:600] for w in warnings[:8]]
        if store:
            artifact = load_chart_artifact(store, block["chart_id"])
            if artifact is None:
                raise ValueError("chart artifact readback failed")
            # Existing marker consumers reconstruct the title, kind and source
            # from this payload. Keep the full research evidence in stdout_json.
            artifact.update(chart_kind=block["chart_kind"], source=block["source"])
            persist_chart_artifact(store, block["chart_id"], artifact)
            if load_chart_artifact(store, block["chart_id"]) != artifact:
                raise ValueError("chart metadata readback failed")
        blocks.append(block)
    receipt = {"chart_ids": [block["chart_id"] for block in blocks], "instruments": len(merged), "bulk_verified": bool(store and blocks)}
    announcement = " ".join("@@nerya:chart@@ " + block["chart_id"] for block in blocks) if store else ""
    # The existing script compactor preserves notes. These publication notes
    # contain bounded descriptors, citations and artifact references, never
    # the workspace-backed point arrays. Keep the runtime/Loop unchanged.
    notes = {"research_context": context, "chart_blocks": blocks, "receipt": receipt, "announcement": announcement}
    if len(json.dumps(notes, ensure_ascii=False, allow_nan=False).encode()) > 48 * 1024:
        raise ValueError("publication receipt exceeds 48 KiB; split the research into smaller batches")
    return {"ok": True, "research_context": context, "chart_blocks": blocks, "receipt": receipt, "notes": notes,
            # Keep markers LAST so the native runner's text tail retains them.
            "announcement": announcement}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", "--payload-file", dest="input", required=True)
    parser.add_argument("--workspace", default=os.environ.get("NERYA_WORKSPACE"))
    args = parser.parse_args()
    try:
        path = Path(args.input)
        if path.stat().st_size > 6 * 1024 * 1024:
            raise ValueError("input exceeds 6 MiB")
        result = publish_visuals(json.loads(path.read_text(encoding="utf-8")), args.workspace)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": "Research publication failed; validate dates, data, sources and artifact availability.", "hint": "Use the actual workspace for bulk points. Split large publication batches into smaller groups."}))
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
