"""Unit tests for OmReaderCache tickets / invalidation."""

from __future__ import annotations

import os
import threading
import time
from unittest.mock import MagicMock

import pytest

from trajectories.om_reader_cache import (
    OmReaderCache,
    SlabStaleError,
    clear_om_reader_cache,
)


def test_ticket_stale_on_invalidate(tmp_path):
    clear_om_reader_cache()
    path = tmp_path / "chunk_0.om"
    path.write_bytes(b"x")

    cache = OmReaderCache(max_readers=8)
    fake_reader = MagicMock()
    fake_reader.__getitem__ = MagicMock(return_value=1.0)
    fake_reader.close = MagicMock()
    cache._OmFileReader = MagicMock(return_value=fake_reader)

    # Bypass real omfiles: inject entry via get after mocking opener
    tid = cache.begin_ticket()
    # Manually register path on ticket then invalidate
    with cache._lock:
        cache._active_tickets[tid].add(str(path.resolve()))
    cache.invalidate(str(path))
    assert cache.ticket_stale(tid)
    with pytest.raises(SlabStaleError):
        cache.check_ticket(tid)
    cache.end_ticket(tid)
    cache.close()


def test_lru_eviction(tmp_path):
    clear_om_reader_cache()
    # OmReaderCache floors max_readers at 8
    cache = OmReaderCache(max_readers=8)
    # Disable inotify so sibling file creates don't race with LRU assertions
    if cache._observer is not None:
        cache._observer.stop()
        cache._observer.join(timeout=2)
        cache._observer = None
        cache._handler = None
    readers = []

    def make_reader(_p):
        r = MagicMock()
        r.close = MagicMock()
        r.shape = (10, 10, 5)
        readers.append(r)
        return r

    cache._OmFileReader = make_reader
    paths = []
    for i in range(9):
        p = tmp_path / f"c{i}.om"
        p.write_bytes(b"x")
        paths.append(p)
        cache.get(str(p))
    assert cache.size == 8
    # paths[0] is LRU and must have been closed/evicted
    assert readers[0].close.called
    for r in readers[1:]:
        assert not r.close.called
    # Re-requesting paths[0] creates a new reader (and evicts paths[1])
    n_before = len(readers)
    cache.get(str(paths[0]))
    assert len(readers) == n_before + 1
    assert readers[1].close.called
    cache.close()


def test_invalidate_waits_for_active_read(tmp_path):
    """Ingest must not close a reader while read_array holds entry.lock."""
    clear_om_reader_cache()
    path = tmp_path / "chunk.om"
    path.write_bytes(b"x")

    cache = OmReaderCache(max_readers=8)
    if cache._observer is not None:
        cache._observer.stop()
        cache._observer.join(timeout=2)
        cache._observer = None
        cache._handler = None

    release_read = threading.Event()
    in_read = threading.Event()
    close_during_read = []

    class FakeReader:
        def __getitem__(self, _indexer):
            in_read.set()
            assert release_read.wait(timeout=2)
            return 1.0

        def close(self):
            # True if close ran while the reader thread was still inside [].
            close_during_read.append(in_read.is_set() and not release_read.is_set())

    cache._OmFileReader = lambda _p: FakeReader()
    errors: list[BaseException] = []

    def reader_thread():
        try:
            cache.read_array(str(path), (0,))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    t = threading.Thread(target=reader_thread)
    t.start()
    assert in_read.wait(timeout=2)
    # Simulate ingest rewrite while the read is in progress.
    inv = threading.Thread(target=lambda: cache.invalidate(str(path)))
    inv.start()
    time.sleep(0.05)  # give invalidate time to reach entry.lock
    assert inv.is_alive(), "invalidate should block until read releases entry.lock"
    release_read.set()
    t.join(timeout=2)
    inv.join(timeout=2)
    assert not t.is_alive() and not inv.is_alive()
    assert not errors
    assert close_during_read == [False]
    assert cache.size == 0
    cache.close()


def test_resolve_cached_across_get_and_read_array(tmp_path, monkeypatch):
    """Hot path must not call realpath on every chunk read."""
    clear_om_reader_cache()
    path = tmp_path / "chunk.om"
    path.write_bytes(b"x")
    path_s = str(path)

    cache = OmReaderCache(max_readers=8)
    if cache._observer is not None:
        cache._observer.stop()
        cache._observer.join(timeout=2)
        cache._observer = None
        cache._handler = None

    real_calls = {"n": 0}
    real_realpath = os.path.realpath

    def counting_realpath(p):
        real_calls["n"] += 1
        return real_realpath(p)

    monkeypatch.setattr(os.path, "realpath", counting_realpath)
    cache._OmFileReader = lambda _p: MagicMock(
        __getitem__=MagicMock(return_value=1.0),
        close=MagicMock(),
    )

    cache.get(path_s)
    n_after_get = real_calls["n"]
    assert n_after_get >= 1
    for _ in range(20):
        cache.read_array(path_s, (0,))
    # Further reads hit the resolve cache (no extra realpath).
    assert real_calls["n"] == n_after_get
    cache.close()


def test_om_root_watch_scheduled_once(tmp_path, monkeypatch):
    """Paths under OM_ROOT share one recursive inotify schedule."""
    clear_om_reader_cache()
    root = tmp_path / "open-meteo"
    ds = root / "dwd_icon" / "wind_u_component" / "chunk_dir"
    ds.mkdir(parents=True)
    files = []
    for i in range(5):
        p = ds / f"c{i}.om"
        p.write_bytes(b"x")
        files.append(p)

    monkeypatch.setenv("TRAJECTORIES_OM_ROOT", str(root))

    cache = OmReaderCache(max_readers=8)
    schedules: list[tuple[str, bool]] = []

    class FakeObserver:
        def schedule(self, _handler, path, recursive=False):
            schedules.append((str(path), bool(recursive)))

        def stop(self):
            pass

        def join(self, timeout=None):
            pass

        def start(self):
            pass

    cache._observer = FakeObserver()
    cache._handler = object()
    cache._OmFileReader = lambda _p: MagicMock(close=MagicMock())

    for p in files:
        cache.get(str(p))

    assert len(schedules) == 1
    assert schedules[0][1] is True
    assert os.path.realpath(schedules[0][0]) == os.path.realpath(str(root))
    assert cache._root_watch is not None
    assert cache._dir_refs == {}
    cache.close()
