from __future__ import annotations

import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from nerya.agent import intent_gate
from nerya.core.config import DEFAULT_CONFIG, Config
from nerya.core.paths import WorkspacePaths
from nerya.llm.model_router import CallResult, ModelRouter

pytestmark = pytest.mark.smoke

def test_allowed_research_and_market_analysis_contract():
    for intent in ("research", "market_analysis"):
        ok, code = intent_gate._valid_decision({"intent_class": intent, "is_research": True, "risk_level": "low", "allowed": True, "reason": "clear"})
        assert (ok, code) == (True, "ok")

def test_trade_and_unrelated_contract_are_denied():
    for intent in ("portfolio_or_trading", "unrelated"):
        ok, code = intent_gate._valid_decision({"intent_class": intent, "is_research": False, "risk_level": "high", "allowed": False, "reason": "denied"})
        assert (ok, code) == (True, "ok")

def test_contradictory_decision_is_invalid():
    ok, code = intent_gate._valid_decision({"intent_class": "research", "is_research": False, "risk_level": "low", "allowed": True, "reason": "x"})
    assert (ok, code) == (False, "contradictory_decision")

def test_missing_text_isolated(tmp_path):
    client = SimpleNamespace(config=Config(paths=WorkspacePaths(root=tmp_path), data=DEFAULT_CONFIG.copy()))
    result = intent_gate.classify_request(client, text="")
    assert result["allowed"] is False and result["reason_code"] == "missing_text"

def test_classifier_exception_isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(intent_gate.LLMGateway, "call", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("offline")))
    client = SimpleNamespace(config=Config(paths=WorkspacePaths(root=tmp_path), data=DEFAULT_CONFIG.copy()))
    result = intent_gate.classify_request(client, text="分析 BTC 市场结构")
    assert result["status"] == "isolated" and result["reason_code"] == "classifier_unavailable"


def test_intent_classifier_is_not_blocked_by_its_own_firewall_terms(monkeypatch, tmp_path):
    data = deepcopy(DEFAULT_CONFIG)
    data["runtime"]["mock_mode"] = True
    data["llm"]["intent_tier"] = "light"
    data["llm"]["tiers"]["light"] = {
        "provider": "mock",
        "model": "intent-fixture",
        "allowed_tasks": ["intent_classification"],
        "allowed_classes": ["classification"],
    }
    cfg = Config(paths=WorkspacePaths(root=tmp_path), data=data)

    def dispatch(_self, **_kwargs):
        return CallResult(
            text=json.dumps({
                "intent_class": "market_analysis",
                "is_research": True,
                "risk_level": "low",
                "allowed": True,
                "reason": "strategy research request",
            }),
            tokens=1,
            usd_cost=0.0,
            provider="mock",
            model="intent-fixture",
            mode="mock",
        )

    monkeypatch.setattr(ModelRouter, "dispatch", dispatch)
    result = intent_gate.classify_request(
        SimpleNamespace(config=cfg),
        text="创建市值前十加密货币的趋势策略",
        source="test",
    )
    assert result["status"] == "allowed"
    assert result["reason_code"] == "semantic_allow"
