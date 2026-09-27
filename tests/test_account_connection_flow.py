"""Connection acceptance tests: isolated workspaces, no exchange/network calls."""
from copy import deepcopy
from types import SimpleNamespace
import json

import pytest

from nerya.api import routes_accounts
from nerya.api.account_connection import connect
from nerya.connectors.registry import _resolve_cex_creds, _resolve_ref
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.security.credential_probe import credential_probe
from nerya.security.secrets import SecretVault
from nerya.core.paths import WorkspacePaths
from nerya.trading import accounts, account_snapshots

pytestmark = pytest.mark.smoke


@pytest.fixture
def client(tmp_path):
    return SimpleNamespace(config=Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG)))


@pytest.fixture
def payload():
    return {"id": "new_connection", "request_id": "isolated-request", "venue": "bybit", "kind": "cex",
            "mode": "shadow", "label": "My account", "credentials": {"api_key": "test-key", "api_secret": "test-secret"}}


def install_probe(monkeypatch, *, health="ok", source="shadow", seen=None):
    def capture(config, aid, *, profile, persist=False):
        assert persist is False
        assert profile.mode == "shadow"
        assert profile.permissions.place_order is False
        assert profile.permissions.cancel_order is False
        assert profile.live_trading_enabled is False
        credentials = _resolve_cex_creds(profile.to_connector_account(live=True).connector_cfg(), config.paths.root, None)
        if seen is not None:
            seen.append((credentials.api_key, credentials.api_secret))
        return account_snapshots.AccountSnapshot("test_snapshot", aid, 123.0, source, 0.0,
                                                  health=health, meta={"error": "invalid test-key test-secret"} if health != "ok" else {})
    monkeypatch.setattr(account_snapshots, "capture_snapshot", capture)


def test_real_connect_verifies_then_persists_safe_defaults(client, payload, monkeypatch):
    seen = []
    install_probe(monkeypatch, seen=seen)
    payload.update(live_trading_enabled=True, permissions={"place_order": True, "withdraw": True})
    result = connect(client, payload)
    assert result["ok"] is True
    assert result["verified"] is True
    assert seen == [("test-key", "test-secret")]
    profile = result["account"]["profile"]
    assert profile["mode"] == "shadow"
    assert profile["live_trading_enabled"] is False
    assert profile["permissions"]["place_order"] is False
    assert profile["permissions"]["withdraw"] is False
    assert profile["label"] == "My account"
    assert profile["credentials"]["api_key"].startswith("vault://")
    assert "test-key" not in json.dumps(result)
    assert "test-secret" not in client.config.paths.accounts_file.read_text()


@pytest.mark.parametrize("health,source", [("auth_error", "shadow"), ("degraded", "shadow"), ("rate_limited", "shadow"), ("ok", "mock"), ("ok", "paper")])
def test_unhealthy_or_simulated_balance_is_never_connected(client, payload, monkeypatch, health, source):
    install_probe(monkeypatch, health=health, source=source)
    result = connect(client, payload)
    assert result["ok"] is False
    assert not client.config.paths.accounts_file.exists()
    assert not client.config.paths.vault_enc.exists()
    assert "test-secret" not in json.dumps(result)


def test_legacy_balance_endpoint_uses_temporary_credentials_without_disk_writes(client, payload, monkeypatch):
    seen = []
    install_probe(monkeypatch, seen=seen)
    routes = {(verb, path): fn for verb, path, fn in routes_accounts.routes()}
    result = routes[("POST", "/accounts/test_balance")](client, payload)
    assert result["ok"] is True and result["verified"] is True
    assert seen == [("test-key", "test-secret")]
    assert not client.config.paths.vault_enc.exists()
    assert not client.config.paths.accounts_file.exists()


def test_missing_required_fields_fails_before_probe_or_vault(client, payload, monkeypatch):
    payload["venue"] = "okx"
    monkeypatch.setattr(account_snapshots, "capture_snapshot", lambda *a, **kw: pytest.fail("unexpected probe"))
    result = connect(client, payload)
    assert result == {"ok": False, "error": "missing_fields", "fields": ["api_passphrase"]}
    assert not client.config.paths.vault_enc.exists()


def test_probe_refs_expire_and_enforce_workspace_and_scope(tmp_path):
    with credential_probe(tmp_path, {"api_key": "temporary"}) as refs:
        ref = refs["api_key"]
        assert _resolve_ref(ref, tmp_path, None, scope="exchange") == "temporary"
        assert _resolve_ref(ref, tmp_path, None, scope="wallet") is None
        assert _resolve_ref(ref, tmp_path / "other", None, scope="exchange") is None
    assert _resolve_ref(ref, tmp_path, None, scope="exchange") is None


def test_retry_is_idempotent_and_new_create_cannot_overwrite(client, payload, monkeypatch):
    seen = []
    install_probe(monkeypatch, seen=seen)
    first = connect(client, payload)
    second = connect(client, payload)
    assert first["ok"] and second["ok"] and second["replayed"]
    assert len(seen) == 1
    payload["request_id"] = "different-create"
    assert connect(client, payload)["error"] == "account_exists"


def test_edit_preserves_hidden_configuration_and_security_policy(client, payload, monkeypatch):
    install_probe(monkeypatch)
    connect(client, payload)
    row = accounts.get_account_profile(client.config.paths, payload["id"]).raw
    row.update(status="quarantined", limits={"max_leverage": 3, "max_order_notional_usd": 0},
               provider_config={"options": {"defaultType": "swap"}, "headers": {"X-Example": "vault://header"}})
    stored = accounts.upsert_account(client.config.paths, row)
    update = {**payload, "operation": "update", "expected_revision": accounts.account_revision(stored),
              "request_id": "update-once", "credentials": {}, "label": "Renamed"}
    result = connect(client, update)
    assert result["ok"] is True
    after = accounts.get_account_profile(client.config.paths, payload["id"])
    assert after.status == "quarantined"
    assert after.limits.max_leverage == 3
    assert after.limits.max_order_notional_usd == 0
    assert after.raw["provider_config"] == row["provider_config"]
    assert "headers" not in result["account"]["profile"]["provider_config"]
    update["request_id"] = "stale-edit"
    assert connect(client, update)["error"] == "account_changed"


def test_failed_credential_rotation_keeps_working_secret(client, payload, monkeypatch):
    install_probe(monkeypatch)
    before = connect(client, payload)["account"]["profile"]
    vault_bytes = client.config.paths.vault_enc.read_bytes()
    install_probe(monkeypatch, health="auth_error")
    changed = {**payload, "operation": "update", "expected_revision": before["revision"],
               "request_id": "bad-rotation", "credentials": {"api_key": "bad-key", "api_secret": "bad-secret"}}
    assert connect(client, changed)["ok"] is False
    assert client.config.paths.vault_enc.read_bytes() == vault_bytes
    vault = SecretVault.open(client.config.paths.vault_enc)
    assert vault.resolve(before["credentials"]["api_secret"].removeprefix("vault://"), required_scope="exchange") == "test-secret"


def test_paper_creation_needs_no_connection_and_accepts_zero(client, monkeypatch):
    monkeypatch.setattr(account_snapshots, "capture_snapshot", lambda *a, **kw: pytest.fail("paper must not probe"))
    result = connect(client, {"id": "paper_zero", "venue": "mock", "mode": "paper", "initial_balance_usd": 0, "request_id": "paper-create"})
    assert result["ok"] is True and result["verified"] is False
    assert result["account"]["profile"]["initial_balance_usd"] == 0
    assert not client.config.paths.vault_enc.exists()


def test_public_wallet_address_survives_live_credential_resolution(tmp_path):
    creds = _resolve_cex_creds({"venue": "hyperliquid", "live": True,
                              "provider_config": {"wallet_address": "0xpublic"},
                              "credentials": {"private_key": "must-not-pass"}}, tmp_path, None)
    assert creds.extras["walletAddress"] == "0xpublic"
    assert "privateKey" not in creds.extras


@pytest.mark.parametrize("venue", ["binance", "okx", "hyperliquid"])
def test_real_connector_pipeline_with_offline_exchange_transport(client, monkeypatch, venue):
    """Exercise profile -> registry -> CCXT -> vault -> snapshot, not a stub snapshot."""
    from nerya.connectors import ccxt_adapter

    calls, params_seen = [], []

    class ExchangeTransport:
        def __init__(self, params):
            params_seen.append(params)

        def fetch_balance(self):
            calls.append("balance")
            return {"total": {"USDT": 125}, "free": {"USDT": 123}, "used": {"USDT": 2}}

        def fetch_positions(self, *args):
            calls.append("positions")
            return []

        def fetch_open_orders(self, *args):
            calls.append("open_orders")
            return []

        def create_order(self, *args, **kwargs):
            pytest.fail("binding must never create an order")

        def cancel_order(self, *args, **kwargs):
            pytest.fail("binding must never cancel an order")

    monkeypatch.setattr(ccxt_adapter, "_lazy_ccxt", lambda: SimpleNamespace(**{venue: ExchangeTransport}))
    row = {"id": "transport_test", "request_id": "transport-create", "venue": venue,
           "credentials": {"api_key": "isolated-key", "api_secret": "isolated-secret"}}
    if venue == "okx":
        row["credentials"]["api_passphrase"] = "isolated-passphrase"
    if venue == "hyperliquid":
        row["credentials"] = {"private_key": "isolated-private-key"}
        row["provider_config"] = {"wallet_address": "0x-isolated-public-address"}
    result = connect(client, row)
    assert result["ok"] is True and result["verified"] is True
    assert result["account"]["snapshot"]["total_usd"] == 125
    assert result["account"]["snapshot"]["free_usd"] == 123
    assert calls == ["balance", "positions", "open_orders"]
    if venue == "hyperliquid":
        assert params_seen[0]["walletAddress"] == "0x-isolated-public-address"
        assert params_seen[0]["privateKey"] == "isolated-private-key"
    else:
        assert params_seen[0]["apiKey"] == "isolated-key"
        assert params_seen[0]["secret"] == "isolated-secret"
        if venue == "okx":
            assert params_seen[0]["password"] == "isolated-passphrase"
    # A subsequent normal refresh must resolve persisted references after all
    # request-local probe references have expired.
    refreshed = account_snapshots.capture_snapshot(client.config, row["id"], persist=False)
    assert refreshed.health == "ok" and refreshed.total_usd == 125
    assert params_seen[1] == params_seen[0]


def test_retry_replays_verification_when_optional_snapshot_storage_fails(client, payload, monkeypatch):
    install_probe(monkeypatch)
    def unavailable(*args):
        raise OSError("isolated snapshot storage unavailable")
    monkeypatch.setattr(account_snapshots, "_persist", unavailable)
    first = connect(client, payload)
    second = connect(client, payload)
    assert first["ok"] and second["ok"] and second["replayed"]
    assert second["verified"] is True
    assert second["account"]["snapshot"] == first["account"]["snapshot"]
