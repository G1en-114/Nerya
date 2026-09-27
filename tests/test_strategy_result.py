from nerya.strategies.result import ResultBuilder, StrategyResult, StrategyResultStatus


def test_rejected_trade_retains_risk_gate_explanation():
    result = StrategyResult.from_trade_envelope({"status":"rejected", "risk_decision":{"reasons":["insufficient_paper_cash"]}})
    assert result.reason == "insufficient_paper_cash"


def test_result_builder_skip_is_hold_alias() -> None:
    result = ResultBuilder().skip(
        reason="not enough data",
        metadata={"bars": 12},
    )

    assert result.status is StrategyResultStatus.HOLD
    assert result.reason == "not enough data"
    assert result.metadata == {"bars": 12}
    assert result.asdict()["is_terminal"] is True


def test_strategy_result_skip_is_hold_alias() -> None:
    result = StrategyResult.skip(reason="no setup")

    assert result.status is StrategyResultStatus.HOLD
    assert result.reason == "no setup"
