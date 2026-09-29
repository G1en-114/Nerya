"""Offline checks: public projection and tampered evidence rejection."""
import json

import pytest

pytest.importorskip("web3")
pytestmark = pytest.mark.smoke

from scripts.gwdc_deploy import canonical, public_evidence, sha
from scripts.gwdc_verify import verify


def test_public_record_excludes_workspace_and_raw_result(tmp_path):
    source = tmp_path / "source.json"
    source.write_text(json.dumps({
        "settings": {"rpc_url": "https://private.invalid/credential"},
        "cases": [{"case": "fees", "status": "rejected", "new_executors": 0,
                   "result": {"private": "do-not-export"}}],
    }))
    result = public_evidence(source)
    assert result["cases"] == [{"case": "fees", "status": "rejected", "new_executors": 0}]
    assert result["source_sha256"] == sha(source.read_bytes())
    assert "private" not in json.dumps(result)
    assert result["public_testnet_execution"] is False


def test_tampered_bundle_fails_before_rpc(tmp_path, monkeypatch):
    original = {"cases": [{"status": "rejected"}]}
    metadata = {"name": "strategy"}
    state = {"evidence_sha256": sha(canonical(original)), "metadata_sha256": sha(canonical(metadata))}
    for name, value in [("deployment", state), ("strategy", metadata), ("record", {"cases": [{"status": "executed"}]})]:
        (tmp_path / f"{name}.json").write_text(json.dumps(value))
    def no_network(*args, **kwargs):
        pytest.fail("Tampered evidence must be rejected without network access")
    monkeypatch.setattr("scripts.gwdc_verify.Web3.HTTPProvider", no_network)
    with pytest.raises(ValueError, match="hash mismatch"):
        verify(tmp_path, "https://test.invalid")
