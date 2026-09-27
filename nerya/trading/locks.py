"""Serialize a trading operation across request threads and runtime processes."""
from contextlib import contextmanager
from hashlib import sha256
import os


@contextmanager
def trading_lock(paths, key: str):
    path = paths.state / "trading_locks" / sha256(key.encode()).hexdigest()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.write(b"0")
            handle.flush()
            handle.seek(0)
            lock = lambda: msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            unlock = lambda: (handle.seek(0), msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1))
        else:
            import fcntl
            lock = lambda: fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            unlock = lambda: fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        try:
            lock()
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            unlock()
