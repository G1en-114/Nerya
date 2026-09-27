"""Regression tests for the `/setup/readiness` LLM probe.

These pin down a real bug found while walking the new `nerya setup`
wizard in the dashboard: the previous `_llm_tier_summary` read
`provider_key_ref` directly from each tier dict, but the YAML schema
stores credentials on the provider profile (`llm.providers.<name>`)
and tiers only reference the provider by name. As a result, the
readiness card reported "No LLM tier has both a provider and
credentials" even when every dashboard surface and every actual LLM
call was working fine. We assert here that:

1. A tier that points at a provider with a `provider_key_ref` is
   reported as ready.
2. A tier that points at a provider without one (and has no inline
   key on the tier itself) is reported as not-ready.
3. The legacy code path — credentials inlined on the tier — still
   counts as ready (backwards compat).
"""

from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

from nerya.api import routes_operator
from nerya.core.config import DEFAULT_CONFIG, Config
from nerya.core.paths import WorkspacePaths


pytestmark = pytest.mark.smoke


def _client(tmp_path, llm_overlay: dict) -> SimpleNamespace:
    data = deepcopy(DEFAULT_CONFIG)
    data["llm"] = llm_overlay
    cfg = Config(paths=WorkspacePaths(root=tmp_path), data=data)
    return SimpleNamespace(config=cfg)


def test_llm_tier_summary_credits_provider_profile_key(tmp_path) -> None:
    """The standard ``configure provider once, point N tiers at it`` flow.

    With ``llm.providers.cliproxy.provider_key_ref`` set and a tier
    that just declares ``provider: cliproxy``, the readiness probe
    should mark the tier as ready. Pre-fix it incorrectly reported
    ``ready=False`` because it only inspected the tier dict.
    """
    client = _client(
        tmp_path,
        {
            "default_tier": "medium",
            "providers": {
                "cliproxy": {
                    "base_url": "http://example.test/v1",
                    "provider_key_ref": "vault://llm_cliproxy_xyz",
                },
            },
            "tiers": {
                "medium": {"provider": "cliproxy", "model": "test-model"},
            },
        },
    )
    summary = routes_operator._llm_tier_summary(client)
    rows = {r["tier"]: r for r in summary["tiers"]}
    assert rows["medium"]["has_key"] is True
    assert rows["medium"]["ready"] is True


def test_llm_tier_summary_blocks_when_provider_lacks_credentials(tmp_path) -> None:
    """Provider profile exists but has no key — tier must be blocked."""
    client = _client(
        tmp_path,
        {
            "default_tier": "medium",
            "providers": {
                "compat": {"base_url": "http://example.test/v1"},
            },
            "tiers": {
                "medium": {"provider": "compat", "model": "test-model"},
            },
        },
    )
    summary = routes_operator._llm_tier_summary(client)
    rows = {r["tier"]: r for r in summary["tiers"]}
    assert rows["medium"]["has_key"] is False
    assert rows["medium"]["ready"] is False


def test_llm_tier_summary_honors_inline_tier_credentials(tmp_path) -> None:
    """Legacy YAML with the key inlined on the tier must still count."""
    client = _client(
        tmp_path,
        {
            "default_tier": "medium",
            "providers": {},
            "tiers": {
                "medium": {
                    "provider": "openai",
                    "model": "test-model",
                    "provider_key_ref": "vault://legacy_inline",
                },
            },
        },
    )
    summary = routes_operator._llm_tier_summary(client)
    rows = {r["tier"]: r for r in summary["tiers"]}
    assert rows["medium"]["has_key"] is True
    assert rows["medium"]["ready"] is True


def test_readiness_handler_reports_ok_when_tier_credentials_inherited(
    tmp_path,
) -> None:
    """End-to-end check: full readiness envelope must not include `llm` in
    blocking, and the LLM check must report `status=ok`, when credentials
    are inherited from the provider profile.
    """
    client = _client(
        tmp_path,
        {
            "default_tier": "medium",
            "providers": {
                "cliproxy": {
                    "base_url": "http://example.test/v1",
                    "provider_key_ref": "vault://llm_cliproxy_xyz",
                },
            },
            "tiers": {
                "medium": {"provider": "cliproxy", "model": "test-model"},
            },
        },
    )
    envelope = routes_operator._readiness_handler(client, {})
    checks = {c["name"]: c for c in envelope["data"]["checks"]}
    assert checks["LLM provider"]["status"] == "ok"
    assert "llm" not in envelope["data"]["blocking"]


def test_accounts_probe_finds_configured_paper_account(tmp_path) -> None:
    """Trading-account readiness check used ``client.discovery.accounts()``,
    but ``InternalClient`` has no ``.discovery`` attribute. The probe
    swallowed the resulting ``AttributeError`` and reported "no trading
    account" even when ``accounts/accounts.yml`` had a perfectly good
    `paper_main` row. We pin down that the fix reads the same accounts
    YAML the ``/discovery/accounts`` route uses.
    """
    from nerya.core import yaml_io
    data = deepcopy(DEFAULT_CONFIG)
    cfg = Config(paths=WorkspacePaths(root=tmp_path), data=data)
    yaml_io.dump(
        cfg.paths.accounts_file,
        {
            "accounts": [
                {
                    "id": "paper_main",
                    "mode": "paper",
                    "venue": "mock",
                    "exchange": "mock",
                    "kind": "cex",
                    "status": "active",
                    "provider_spec": "mock",
                },
            ],
        },
    )
    client = SimpleNamespace(config=cfg)
    rows = routes_operator._accounts(client)
    assert any(r["id"] == "paper_main" for r in rows), rows
    envelope = routes_operator._readiness_handler(client, {})
    checks = {c["name"]: c for c in envelope["data"]["checks"]}
    assert checks["Trading account"]["status"] == "ok"
    assert "account" not in envelope["data"]["blocking"]


def test_setup_only_requires_three_saved_configurations(tmp_path, monkeypatch) -> None:
    """Setup is not a runtime health check; keyless local models are valid."""
    client = _client(tmp_path, {
        "default_tier": "medium",
        "providers": {},
        "tiers": {"medium": {"provider": "local", "model": "fixture-model"}},
    })
    client.config.data.setdefault("runtime", {}).setdefault("auth", {})["admin_password_hash"] = "fixture-hash"
    monkeypatch.setattr(routes_operator, "_accounts", lambda _: [{"id": "paper-fixture"}])

    def forbidden_probe(*args, **kwargs):
        pytest.fail("Setup must not probe strategies, wallet providers or live connectors")

    for name in ("_strategy_package_count", "_trading_strategy_count", "_wallet_providers"):
        monkeypatch.setattr(routes_operator, name, forbidden_probe, raising=False)
    envelope = routes_operator._readiness_handler(client, {})
    assert envelope["status"] == "ok"
    assert envelope["data"]["blocking"] == []
    assert [check["name"] for check in envelope["data"]["checks"]] == [
        "LLM provider", "Trading account", "Admin password",
    ]


def test_setup_missing_configuration_has_only_three_blockers(tmp_path, monkeypatch) -> None:
    client = _client(tmp_path, {
        "default_tier": "medium", "providers": {},
        "tiers": {"medium": {"provider": "mock", "model": ""}},
    })
    client.config.data.setdefault("runtime", {}).setdefault("auth", {})["admin_password_hash"] = ""
    monkeypatch.setattr(routes_operator, "_accounts", lambda _: [])
    envelope = routes_operator._readiness_handler(client, {})
    assert set(envelope["data"]["blocking"]) == {"llm", "account", "password"}
    assert len(envelope["data"]["checks"]) == 3


def test_setup_checks_selected_primary_tier_not_an_unused_tier(tmp_path, monkeypatch) -> None:
    client = _client(tmp_path, {
        "default_tier": "medium", "providers": {},
        "tiers": {
            "medium": {"provider": "mock", "model": ""},
            "high": {"provider": "local", "model": "fixture-model"},
        },
    })
    monkeypatch.setattr(routes_operator, "_accounts", lambda _: [])
    envelope = routes_operator._readiness_handler(client, {})
    assert "llm" in envelope["data"]["blocking"]

