"""Installation and repeated init must never create a strategy or demo route."""
import pytest
from nerya.core import yaml_io
from nerya.workspace.manager import WorkspaceManager
from nerya.trading.strategies import list_strategies

pytestmark = pytest.mark.smoke


def test_initialization_is_empty_and_idempotent(tmp_path):
    for _ in range(2):
        workspace = WorkspaceManager.init(tmp_path)
        assert list(workspace.paths.strategies.iterdir()) == []
        assert list(list_strategies(workspace.paths)) == []
        assert yaml_io.load(workspace.paths.triggers_routes_file)["routes"] == []
        assert yaml_io.load(workspace.paths.triggers_schedules_file)["schedules"] == []


def test_reinitialization_preserves_operator_strategy(tmp_path):
    workspace = WorkspaceManager.init(tmp_path)
    strategy = workspace.paths.strategies / "my_strategy"
    strategy.mkdir()
    content = "id: my_strategy\ntitle: My strategy\nstatus: draft\n"
    (strategy / "strategy.yml").write_text(content)
    WorkspaceManager.init(tmp_path)
    assert [p.name for p in workspace.paths.strategies.iterdir()] == ["my_strategy"]
    assert (strategy / "strategy.yml").read_text() == content
