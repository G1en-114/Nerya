"""Isolated UI-regression server. Synthetic data; never a user workspace."""
from __future__ import annotations

import argparse
import math
import signal
import tempfile
from pathlib import Path

from nerya.api.local_server import build_server
from nerya.data.history_store import HistoryStore
from nerya.workspace.manager import WorkspaceManager


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18329)
    parser.add_argument("--root", default="test-results")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if root.name != "test-results":
        raise SystemExit("Fixture workspaces must live under a test-results directory")
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="factor-ui-", dir=root) as path:
        config = WorkspaceManager.init(path).config
        bars = [{"ts":1704067200+i*3600,"open":100+i*.03+math.sin(i/9)*3,
                 "close":100.15+i*.03+math.sin(i/9)*3,"high":104+i*.03+math.sin(i/9)*3,
                 "low":96+i*.03+math.sin(i/9)*3,"volume":1000+(i%17)*15} for i in range(480)]
        # This fixture is generated only in this disposable test workspace.
        # Production history downloaders reject mock/synthetic source envelopes.
        HistoryStore(config.paths.artifacts / "backtest_cache").put("BINANCE:TESTUSDT", "1h", bars, source="isolated-ui-regression-fixture")
        server = build_server(config, host="127.0.0.1", port=args.port, start_cron=False, start_continuous=False)
        def stop(*_args):
            raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, stop)
        try:
            print(f"ISOLATED SYNTHETIC FACTOR TEST SERVER: {path}", flush=True)
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
