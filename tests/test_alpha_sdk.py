from copy import deepcopy
import math
import pytest
from nerya.strategies.indicators import alphatrend

pytestmark = pytest.mark.smoke


def rows(values, volume=True):
    return [{"high":p+1,"low":p-1,"close":p,"volume":1 if volume else None} for p in values]


def test_hand_calculated_alpha_recurrence_and_time_shift():
    data=rows([10,11,12,13,12,10,8,6,4,5,9,13,17])
    out=alphatrend(data,period=2)
    assert out["alpha"] == [None,None,9,10,10,10,10,10,8,8,8,8,11]
    assert out["lagged"][2:] == out["alpha"][:-2]
    assert out["sell"][8] and out["buy"][12]
    assert sum(out["buy"])==sum(out["sell"])==1


@pytest.mark.parametrize("volume", [True,False])
@pytest.mark.parametrize("smoothing", ["sma","rma"])
def test_no_future_lookahead_and_input_is_not_modified(volume,smoothing):
    data=rows([100+10*math.sin(i/5)+i/20 for i in range(100)],volume)
    before=deepcopy(data)
    full=alphatrend(data,atr_smoothing=smoothing)
    for end in (15,30,55,99):
        prefix=alphatrend(data[:end],atr_smoothing=smoothing)
        for key in ("alpha","lagged","atr","momentum","momentum_source","buy","sell"):
            assert prefix[key]==full[key][:end]
    assert data==before
    assert full["momentum_source"][-1] == ("mfi" if volume else "rsi")


def test_flat_market_has_no_crossovers():
    result=alphatrend(rows([100]*60))
    assert not any(result["buy"]) and not any(result["sell"])
    assert result["momentum"][-1]==50


@pytest.mark.parametrize("kwargs", [{"period":0},{"period":True},{"coefficient":float("nan")},{"offset":0},{"momentum":"invalid"}])
def test_invalid_parameters_are_rejected(kwargs):
    with pytest.raises(ValueError): alphatrend(rows([100]*20),**kwargs)


def test_volume_availability_uses_only_the_current_prefix():
    data=rows([100+i for i in range(40)])
    data[30]["volume"]=None
    full=alphatrend(data)
    early=alphatrend(data[:30])
    assert full["alpha"][:30]==early["alpha"]
