"""First-run configuration is exactly model, account and admin password."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from nerya.api import routes_operator
from nerya.core import yaml_io
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths

pytestmark = pytest.mark.smoke


@pytest.fixture
def configured(tmp_path):
    data = deepcopy(DEFAULT_CONFIG)
    data["llm"] = {
        "default_tier": "medium",
        "tiers": {"medium": {"provider": "ollama", "model": "setup-test-model"}},
    }
    data.setdefault("runtime", {}).setdefault("auth", {})["admin_password_hash"] = "test-only-hash"
    config = Config(paths=WorkspacePaths(root=tmp_path), data=data)
    yaml_io.dump(config.paths.accounts_file, {"accounts": [{
        "id": "paper_setup", "mode": "paper", "venue": "mock", "exchange": "mock",
        "kind": "cex", "status": "active", "provider_spec": "mock",
    }]})
    return SimpleNamespace(config=config)


def test_only_three_saved_items_are_required(configured, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Optional runtime capability must not be checked during setup")

    for name in ("_wallet_providers", "_strategy_package_count", "_trading_strategy_count"):
        monkeypatch.setattr(routes_operator, name, forbidden)
    before = deepcopy(configured.config.data)
    envelope = routes_operator._readiness_handler(configured, {})
    assert envelope["status"] == "ok"
    assert envelope["data"]["blocking"] == []
    assert [row["name"] for row in envelope["data"]["checks"]] == [
        "LLM provider", "Trading account", "Admin password",
    ]
    assert configured.config.data == before
    assert "test-only-hash" not in str(envelope)


@pytest.mark.parametrize("missing", ["llm", "account", "password"])
def test_each_required_item_has_its_own_fix(configured, missing):
    if missing == "llm":
        configured.config.data["llm"]["tiers"] = {}
    elif missing == "account":
        yaml_io.dump(configured.config.paths.accounts_file, {"accounts": []})
    else:
        configured.config.data["runtime"]["auth"]["admin_password_hash"] = ""
    envelope = routes_operator._readiness_handler(configured, {})
    assert envelope["status"] == "blocked"
    assert envelope["data"]["blocking"] == [missing]
    fixes = [row["fix"] for row in envelope["data"]["checks"] if row["status"] != "ok"]
    assert len(fixes) == 1
    assert fixes[0]["href"] == f"/setup?step={missing}"


@pytest.mark.parametrize("provider,model", [("mock", "mock"), ("", "model"), ("ollama", " ")])
def test_placeholder_or_incomplete_main_model_is_not_saved(configured, provider, model):
    configured.config.data["llm"]["tiers"]["medium"] = {"provider": provider, "model": model}
    envelope = routes_operator._readiness_handler(configured, {})
    assert "llm" in envelope["data"]["blocking"]


def test_fallback_does_not_mask_missing_main_model(configured):
    configured.config.data["llm"]["tiers"] = {"fallback": {"provider": "ollama", "model": "fallback-model"}}
    envelope = routes_operator._readiness_handler(configured, {})
    assert "llm" in envelope["data"]["blocking"]


def test_keyless_model_is_configuration_not_a_connectivity_probe(configured):
    envelope = routes_operator._readiness_handler(configured, {})
    assert envelope["data"]["checks"][0]["status"] == "ok"
    assert not configured.config.data["llm"].get("providers")
