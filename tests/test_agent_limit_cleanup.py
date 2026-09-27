from copy import deepcopy
import pytest

pytestmark = pytest.mark.smoke

from nerya.agent.command_runtime import CommandRuntime
from nerya.agent.loop_contracts import LoopConfig
from nerya.api.routes_agent import _with_turn_limit_overrides
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.harness.cancellation import SteerInbox


def test_long_prompt_and_queue_edit_are_preserved(tmp_path):
    config = Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))
    runtime = CommandRuntime(config, lambda *_: {}, epoch='limits')
    text = '完整用户要求' * 10000
    receipt = runtime.submit({'command_id': 'long-command', 'session_id': 'long-session',
        'request': {'payload': {'text': text}}}, start=False)
    row = receipt['command']
    assert row['input'] == text
    runtime.store.control('long-session', 'edit', cid=row['command_id'],
                          revision=row['revision'], text=text + '追加')
    assert runtime.store.snapshot('long-session')['commands'][0]['input'] == text + '追加'


def test_steering_never_silently_truncates():
    inbox = SteerInbox()
    text = '必须完整保留' * 2000
    assert inbox.push(text)
    assert inbox.drain() == [text]


def test_default_execution_has_no_arbitrary_turn_budget(tmp_path):
    config = Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))
    loop = LoopConfig.from_config(config)
    assert loop.iteration_limit == float('inf')
    assert loop.tool_call_limit is None
    assert not loop.max_wall_seconds


def test_explicit_budgets_are_not_silently_clamped(tmp_path):
    config = Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))
    updated = _with_turn_limit_overrides(config, {'max_iterations': 500,
        'max_total_tool_calls': 2000, 'max_wall_seconds': 14400})
    loop = LoopConfig.from_config(updated)
    assert loop.max_iterations == 500
    assert loop.tool_call_limit == 2000
    assert loop.max_wall_seconds == 14400


def test_zero_request_disables_configured_budgets(tmp_path):
    data = deepcopy(DEFAULT_CONFIG)
    data['agent']['native'].update(max_iterations=120, max_total_tool_calls=400, max_wall_seconds=1800)
    config = Config(paths=WorkspacePaths(root=tmp_path), data=data)
    loop = LoopConfig.from_config(_with_turn_limit_overrides(config,
        {'max_iterations': 0, 'max_total_tool_calls': 0, 'max_wall_seconds': 0}))
    assert loop.iteration_limit == float('inf')
    assert loop.tool_call_limit is None
    assert not loop.max_wall_seconds
