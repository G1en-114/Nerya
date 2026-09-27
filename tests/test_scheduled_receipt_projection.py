from types import SimpleNamespace
from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.core import jsonl
from nerya.sdk.trigger_api import TriggerAPI
from nerya.triggers.schedule import ScheduleEntry

def test_latest_run_receipt_accepts_late_terminal_but_not_older_run(tmp_path,monkeypatch):
    cfg=Config(paths=WorkspacePaths(tmp_path))
    entry=ScheduleEntry(id="report",kind="agent.task",session_kind="agent",every_seconds=60)
    monkeypatch.setattr("nerya.sdk.trigger_api.load_schedules",lambda _: [entry])
    log=cfg.paths.journal("scheduled_session")
    def receipt(turn,stamp,state,**extra):
        jsonl.append(log,{"schedule_id":"report","turn_id":turn,"session_id":"session","ts_epoch":stamp,"execution_status":state,**extra})
    receipt("old",10,"running_unconfirmed")
    receipt("new",20,"running_unconfirmed",ttl_exceeded=True)
    receipt("old",10,"completed",late_outcome=True)
    api=TriggerAPI(config=cfg,runtime=SimpleNamespace())
    assert api.schedule_status()["schedules"][0]["latest_execution"]["execution_status"]=="running_unconfirmed"
    receipt("new",20,"completed",late_outcome=True,delivery_status="failed")
    result=api.schedule_status()["schedules"][0]["latest_execution"]
    assert result["execution_status"]=="completed" and result["delivery_status"]=="failed" and result["late_outcome"]
