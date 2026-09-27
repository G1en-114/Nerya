from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from nerya.db.sqlite import _ensure_wal_mode, connect, connect_readonly


pytestmark = pytest.mark.smoke


class _Row:
    def __init__(self, value: str):
        self.value = value

    def fetchone(self):
        return (self.value,)


class _FakeConnection:
    def __init__(self, modes: list[str], *, fail_set: str | None = None):
        self.modes = list(modes)
        self.fail_set = fail_set
        self.calls: list[str] = []

    def execute(self, sql: str):
        self.calls.append(sql)
        if sql == "PRAGMA journal_mode":
            value = self.modes.pop(0) if len(self.modes) > 1 else self.modes[0]
            return _Row(value)
        if sql == "PRAGMA journal_mode=WAL":
            if self.fail_set:
                raise sqlite3.OperationalError(self.fail_set)
            return _Row("wal")
        raise AssertionError(sql)


def test_existing_wal_mode_does_not_repeat_database_level_transition():
    con = _FakeConnection(["wal"])
    _ensure_wal_mode(con)  # type: ignore[arg-type]
    assert con.calls == ["PRAGMA journal_mode"]


def test_concurrent_wal_transition_error_is_accepted_only_after_verified_wal():
    con = _FakeConnection(["delete", "wal"], fail_set="disk I/O error")
    _ensure_wal_mode(con)  # type: ignore[arg-type]
    assert con.calls == [
        "PRAGMA journal_mode",
        "PRAGMA journal_mode=WAL",
        "PRAGMA journal_mode",
    ]


def test_real_disk_error_is_not_hidden_when_mode_did_not_change():
    con = _FakeConnection(["delete"], fail_set="disk I/O error")
    with pytest.raises(sqlite3.OperationalError, match="disk I/O error"):
        _ensure_wal_mode(con)  # type: ignore[arg-type]


def test_concurrent_repository_connections_share_existing_wal_database(tmp_path):
    db = tmp_path / "nerya.db"
    with connect(db) as con:
        con.execute("CREATE TABLE IF NOT EXISTS concurrency_probe (id INTEGER PRIMARY KEY)")

    def open_and_read(_: int) -> str:
        with connect(db) as con:
            return str(con.execute("PRAGMA journal_mode").fetchone()[0]).lower()

    with ThreadPoolExecutor(max_workers=12) as pool:
        modes = list(pool.map(open_and_read, range(48)))
    assert modes == ["wal"] * 48


def test_query_only_reader_works_while_writer_holds_wal_transaction(tmp_path):
    db = tmp_path / "nerya.db"
    with connect(db) as con:
        con.execute("CREATE TABLE probe (value INTEGER)")
        con.execute("INSERT INTO probe VALUES (1)")

    writer = connect(db)
    try:
        writer.execute("BEGIN IMMEDIATE")
        writer.execute("INSERT INTO probe VALUES (2)")
        with connect_readonly(db) as reader:
            assert reader.execute("SELECT sum(value) FROM probe").fetchone()[0] == 1
            assert reader.execute("PRAGMA query_only").fetchone()[0] == 1
            with pytest.raises(sqlite3.OperationalError):
                reader.execute("INSERT INTO probe VALUES (3)")
    finally:
        writer.rollback()
        writer.close()
