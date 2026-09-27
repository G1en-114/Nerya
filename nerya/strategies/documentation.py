"""Static checks for opt-in, author-facing @nerya.version 1 documentation."""
from __future__ import annotations

import io
import re
import tokenize


def documentation_errors(source: str) -> list[str]:
    """Legacy unversioned scripts remain valid. Never import strategy code."""
    tags: list[tuple[str, str]] = []
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type != tokenize.COMMENT or token.line[:token.start[1]].strip():
                continue
            match = re.match(r"#\s*@nerya\.(\w+)(?:\s*:\s*|\s+)?(.*)$", token.string)
            if match:
                tags.append((match[1], (match[2] or "").strip()))
    except (tokenize.TokenError, IndentationError):
        return []  # The existing syntax validator owns invalid Python.
    if not any(tag == "version" for tag, _ in tags):
        return []
    required = {"version", "title", "description", "logic", "rationale", "scope", "input", "output", "risk", "validation", "step"}
    errors = [f"Missing @nerya.{tag}" for tag in sorted(required - {tag for tag, value in tags if value})]
    steps: set[str] = set()
    targets: list[str] = []
    current_step = False
    for tag, value in tags:
        if tag not in required | {"next", "change"}:
            errors.append(f"Unknown annotation: @nerya.{tag}")
        if not value or len(value) > 2000:
            errors.append(f"@nerya.{tag} must contain 1-2000 characters")
        if tag == "version" and value != "1":
            errors.append("Only @nerya.version 1 is supported")
        parts = [part.strip() for part in value.split("|")]
        if tag == "step":
            current_step = bool(re.fullmatch(r"[a-zA-Z][\w-]{0,63}", parts[0]) and len(parts) >= 2 and parts[1] and parts[0] not in steps)
            if not current_step:
                errors.append("@nerya.step requires a unique ASCII ID followed by | title | explanation; e.g. # @nerya.step execute | Execute strategy | Route closed candles through the SDK. IDs cannot start with a digit.")
            else:
                steps.add(parts[0])
        if tag == "next":
            if not current_step:
                errors.append("@nerya.next must follow a valid step")
            targets.append(parts[0])
        if tag == "change" and (len(parts) < 4 or not all(parts[:4])):
            errors.append("@nerya.change requires target | before | after | reason")
    errors.extend(f"Unknown @nerya.next target: {target}" for target in targets if target not in steps)
    if len(steps) > 100 or len(source) > 200_000:
        errors.append("Documentation exceeds the 100-step / 200000-character display limit")
    return errors
