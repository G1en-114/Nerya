"""Request-local vault references for read-only, unsaved connection probes.

Never weaken the connector's plaintext guard or write test credentials to disk.
ContextVar isolates concurrent requests; references expire on leaving the probe.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from uuid import uuid4

_values: ContextVar[dict[str, tuple[str, str, str]]] = ContextVar("credential_probe", default={})


@contextmanager
def credential_probe(workspace: Path, credentials: dict[str, str], scopes: dict[str, str] | None = None):
    entries = dict(_values.get())
    refs = {}
    root = str(workspace.resolve())
    for name, value in credentials.items():
        if value.startswith("vault://"):
            refs[name] = value
            continue
        ref = f"vault://probe_{uuid4().hex}"
        entries[ref] = (root, (scopes or {}).get(name, "exchange"), value)
        refs[name] = ref
    token = _values.set(entries)
    try:
        yield refs
    finally:
        _values.reset(token)


def resolve_probe(ref: str, workspace: Path, scope: str) -> str | None:
    entry = _values.get().get(ref)
    if entry and entry[:2] == (str(workspace.resolve()), scope):
        return entry[2]
    return None


def redact_probe_text(text: str) -> str:
    for _, _, value in _values.get().values():
        if value:
            text = text.replace(value, "[redacted]")
    return text
