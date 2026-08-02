"""Unit tests for OmReaderCache tickets / invalidation."""

from __future__ import annotations

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
    cache = OmReaderCache(max_readers=2)
    readers = []

    def make_reader(_p):
        r = MagicMock()
        r.close = MagicMock()
        r.shape = (10, 10, 5)
        readers.append(r)
        return r

    cache._OmFileReader = make_reader
    paths = []
    for i in range(3):
        p = tmp_path / f"c{i}.om"
        p.write_bytes(b"x")
        paths.append(p)
        cache.get(str(p))
    assert cache.size == 2
    cache.close()
