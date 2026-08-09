"""Unit tests for OmReaderCache tickets / invalidation."""

from __future__ import annotations

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
