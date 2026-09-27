"""Control Nerya browser sessions through the local runtime API.

Standalone CLI usage::

    python -m nerya.skills.builtin.browser.scripts.browser_session \
        --json '{"operation": "open", "url": "https://example.com"}'

The script is intentionally thin: browser state, backend selection,
console/network capture, and cleanup remain inside the API runtime.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


_DEFAULT_API_BASE = "http://127.0.0.1:18317"
def _api_base(value: str | None = None) -> str:
    configured = str(os.environ.get("NERYA_API") or os.environ.get("NERYA_API_BASE") or _DEFAULT_API_BASE).rstrip("/")
    raw = str(value or configured).rstrip("/")
    parts = urlsplit(raw)
    if (parts.scheme not in {"http", "https"} or not parts.hostname or parts.username
            or parts.password or parts.query or parts.fragment or any(c in raw for c in "\r\n\x00")):
        raise ValueError("invalid_configured_api_base")
    _ = parts.port
    if raw != configured:
        raise ValueError("api_base_override_requires_operator_configuration")
    return raw


class _NoApiRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "API redirects are disabled", headers, None)


def _auth_token(value: str | None = None) -> str:
    return str(
        value
        or os.environ.get("NERYA_API_TOKEN")
        or os.environ.get("NERYA_AUTH_TOKEN")
        or ""
    ).strip()


def _request(
    method: str,
    path: str,
    *,
    api_base: str | None = None,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout_s: float = 60.0,
) -> dict[str, Any]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        headers["Content-Type"] = "application/json"
    resolved_token = _auth_token(token)
    if resolved_token:
        bearer = (
            resolved_token
            if resolved_token.lower().startswith("bearer ")
            else f"Bearer {resolved_token}"
        )
        clean_token = (
            resolved_token[7:].strip()
            if resolved_token.lower().startswith("bearer ")
            else resolved_token
        )
        headers["Authorization"] = bearer
        headers["X-Nerya-Token"] = clean_token

    req = Request(
        _api_base(api_base) + path,
        data=body,
        headers=headers,
        method=method.upper(),
    )
    try:
        with build_opener(_NoApiRedirect()).open(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {"ok": True}
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {"body": raw}
        data.update({"ok": False, "status": exc.code, "error": data.get("error") or "http_error"})
        return data
    except URLError as exc:
        return {"ok": False, "error": "url_error", "detail": str(exc)}


def _managed_run(op: str, payload: dict[str, Any], *, api_base, token, timeout_s) -> dict[str, Any]:
    """One request returns the action receipt and fresh observation. No auto retry."""
    nested = payload.get("payload") or {}
    if not isinstance(nested, dict):
        return {"ok":False, "error":"payload_must_be_object", "retryable":False}
    data = {**nested, **payload}
    data.pop("payload", None)
    data.pop("backend", None)
    data.pop("engine", None)
    if op == "action":
        op = str(data.pop("action", ""))
    op = {"type": "fill", "get": "status", "list": "list", "wait": "wait_for",
          "wait_for_selector": "wait_for", "console": "events", "network": "network",
          "api_requests": "network", "go_back": "back", "go_forward": "forward"}.get(op, op)
    if "target" not in data:
        target = {k:data[k] for k in ("ref", "role", "name", "label", "test_id", "selector", "frame_id") if k in data}
        if target:
            data["target"] = target
    request_id = data.setdefault("request_id", uuid.uuid4().hex)
    data.setdefault("profile_id", "work")
    data["operation"] = op
    # Correlation is stamped by the executor, never read from model arguments.
    data.pop('_trace_token', None)
    if os.environ.get('NERYA_BROWSER_TRACE_TOKEN'):
        data['_trace_token'] = os.environ['NERYA_BROWSER_TRACE_TOKEN']
    # Never borrow a different task's most-recent tab/session implicitly.
    if op not in {"open", "list", "status"} and not data.get("session_id"):
        return {"ok":False, "error":"session_id_required_use_open_receipt", "request_id":request_id}
    try:
        result = _request("POST", "/browsers/agent", api_base=api_base, token=token,
                          payload=data, timeout_s=max(40, min(timeout_s, 60)))
        result.setdefault("request_id", request_id)
        if not result.get("ok"):
            result.setdefault("retryable", False)
            result.setdefault("next_action", "inspect_state_or_reuse_exact_request_id")
        return result
    except ValueError:
        return {"ok":False, "error":"invalid_or_unapproved_api_base", "request_id":request_id, "retryable":False}
    except (TimeoutError, OSError):
        return {"ok":False, "error":"transport_outcome_unknown", "request_id":request_id,
                "retryable":False, "next_action":"inspect_state_or_reuse_exact_request_id"}


def run(*, operation: str = 'status', api_base: str | None = None,
        token: str | None = None, timeout_s: float = 60.0, **payload: Any) -> dict[str, Any]:
    """All browser tasks use the same managed Chromium runtime."""
    op = str(operation or 'status').strip().lower()
    if (payload.get('backend', 'managed') != 'managed'
            or payload.get('engine') not in (None, '', 'chromium')
            or str(payload.get('session_id', '')).startswith('bs_')):
        return {'ok':False, 'error':'legacy_browser_removed_use_managed', 'retryable':False}
    if op == 'registry':
        return {'ok':True, 'engine':'chromium', 'managed':True}
    return _managed_run(op, payload, api_base=api_base, token=token, timeout_s=float(timeout_s or 60))


def _load_payload(args: argparse.Namespace) -> dict[str, Any]:
    if args.payload_file:
        with open(args.payload_file, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    if args.payload_json:
        return json.loads(args.payload_json) or {}
    if not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
        return json.loads(raw) if raw else {}
    return {}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", dest="payload_json", default=None)
    parser.add_argument("--payload-file", dest="payload_file", default=None)
    parser.add_argument("--operation", "--op", dest="operation", default=None)
    parser.add_argument("--api-base", dest="api_base", default=None)
    parser.add_argument("--token", dest="token", default=None)
    args = parser.parse_args()

    payload = _load_payload(args)
    operation = args.operation or payload.pop("operation", "status")
    api_base = args.api_base or payload.pop("api_base", None)
    token = args.token or payload.pop("token", None)
    timeout_s = float(payload.pop("timeout_s", 60.0) or 60.0)
    result = run(
        operation=operation,
        api_base=api_base,
        token=token,
        timeout_s=timeout_s,
        **payload,
    )
    sys.stdout.write(json.dumps(result, ensure_ascii=False, default=str, indent=2))
    sys.stdout.write("\n")
    if isinstance(result, dict) and result.get("ok") is False:
        sys.exit(1)


if __name__ == "__main__":
    main()
