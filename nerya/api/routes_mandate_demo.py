"""Authenticated operator demo controls. All mutations are POST-only."""
from ..security import mandate_demo_service as service


def _status(client, payload):
    return service.status(client.config.paths.root, payload.get("job_id"))


def _run(client, payload):
    return service.start(client.config.paths.root, payload.get("request_id"), payload.get("request"))


def routes():
    return [("GET", "/safety/demo/status", _status), ("POST", "/safety/demo/run", _run)]
