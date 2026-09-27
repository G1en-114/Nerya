"""Builtin package execution and zero-based file schema regressions; no network."""
from pathlib import Path
from types import SimpleNamespace
import pytest
from nerya.tools.types import ToolCall
from nerya.tools.native import skill
from nerya.mcp.catalog import build_catalog
from nerya.mcp.tools import NeryaTools
pytestmark = pytest.mark.smoke


def test_builtin_script_runs_as_module_and_custom_script_stays_file(tmp_path, monkeypatch):
    package = Path(skill.__file__).resolve().parents[2]
    builtin = package / 'skills/builtin/markets/scripts/get_candles.py'
    custom_root = tmp_path / 'skills/custom'
    (custom_root / 'scripts').mkdir(parents=True)
    (custom_root / 'SKILL.md').write_text('---\nname: custom\ndescription: Script execution fixture\n---\n')
    custom = custom_root / 'scripts/custom.py'
    custom.write_text('print(1)\n')
    index = skill.SkillIndex([package / 'skills/builtin', tmp_path / 'skills'])
    commands = []
    monkeypatch.setattr(skill, 'sandbox_exec', lambda cmd, **kw: commands.append(cmd) or SimpleNamespace(returncode=0, stdout='{}', stderr=''))
    assert builtin.exists()
    result = skill.script_run_handler(ToolCall(name='script_run', arguments={'skill_id':'markets','name':'get_candles.py','args':['--limit','2']}), skill_index=index, cwd=tmp_path)
    assert not result.is_error
    assert commands[-1][1:] == ['-m','nerya.skills.builtin.markets.scripts.get_candles','--limit','2']
    result = skill.script_run_handler(ToolCall(name='script_run', arguments={'skill_id':'custom','name':'custom.py'}), skill_index=index, cwd=tmp_path)
    assert not result.is_error
    assert commands[-1][1:] == [str(custom)]


def test_public_read_file_zero_offset_matches_actual_first_line(tmp_path):
    tools = NeryaTools.boot(tmp_path)
    (tmp_path / 'first-line.txt').write_text('first\nsecond\n')
    catalog = build_catalog(tools)
    result = catalog.call('nerya_native_read_file', {'path':'first-line.txt','offset':0,'limit':1})
    assert result['ok'], result
    value = next(part['data'] for part in result['content'] if part['type'] == 'json')
    text = next(part['text'] for part in result['content'] if part['type'] == 'text')
    assert text.split('\n\n', 1)[1] == 'first' and value['offset'] == 0
