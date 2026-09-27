from argparse import Namespace

import pytest

from nerya.cli.commands.core import cmd_service_install
from nerya.core.paths import resolve_workspace
from nerya.install import service


@pytest.mark.parametrize("explicit,profile,env_profile", [(False, "research", "other"), (True, "research", "other"), (False, None, "other"), (False, None, None)])
def test_service_install_uses_cli_workspace_identity(tmp_path, monkeypatch, explicit, profile, env_profile):
    monkeypatch.setenv("NERYA_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("NERYA_WORKSPACE", str(tmp_path / "legacy"))
    if env_profile:
        monkeypatch.setenv("NERYA_PROFILE", env_profile)
    else:
        monkeypatch.delenv("NERYA_PROFILE", raising=False)
    workspace = str(tmp_path / "explicit") if explicit else None
    calls = []
    monkeypatch.setattr(service, "install", lambda **kwargs: calls.append(kwargs) or 0)
    assert cmd_service_install(Namespace(workspace=workspace, profile=profile, port=19001, force=False)) == 0
    assert calls == [{"workspace": str(resolve_workspace(workspace, profile=profile).root), "port": 19001, "force": False}]
    assert not (tmp_path / "home").exists()
