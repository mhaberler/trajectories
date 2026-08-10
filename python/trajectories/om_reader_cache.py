"""Process-wide keep-open OmFileReader cache with per-path locks + inotify.

Lock ordering (must not invert):
  1. ``self._lock`` (cache map / tickets) — never hold ``entry.lock`` when taking this
  2. ``entry.lock`` — held only around open-reader use and close

Ingest (inotify) may invalidate while trajectories read. Closing a reader without
``entry.lock`` while another thread is inside ``reader[indexer]`` can wedge the
native mmap and block ``systemctl restart``. Always pop under ``_lock``, then
close under ``entry.lock`` after releasing ``_lock``.

Hot path: never call ``Path.resolve()`` / ``realpath`` on every chunk read —
resolve once and cache. Prefer one recursive inotify watch on OM_ROOT so
watchdog does not spawn a thread pair per chunk directory.
"""

from __future__ import annotations

import os
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

# Optional watchdog for inotify; mtime/inode fallback always works.
try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    _HAS_WATCHDOG = True
except ImportError:  # pragma: no cover
    FileSystemEventHandler = object  # type: ignore[misc, assignment]
    Observer = None  # type: ignore[misc, assignment]
    _HAS_WATCHDOG = False

DEFAULT_MAX_READERS = 128
RESOLVE_CACHE_MAX = 4096
# Fallback parent watches when path is outside OM_ROOT (tests / odd layouts).
MAX_FALLBACK_DIR_WATCHES = 8


class SlabStaleError(RuntimeError):
    """A cached .om file changed during an in-flight slab load."""


@dataclass
class _Entry:
    reader: Any
    lock: threading.Lock = field(default_factory=threading.Lock)
    mtime_ns: int = 0
    inode: int = 0


class _DirHandler(FileSystemEventHandler):  # type: ignore[misc]
    """Invalidate only on real content changes — ignore open/close/access."""

    def __init__(self, cache: "OmReaderCache"):
        super().__init__()
        self._cache = cache

    def _bump(self, event):  # noqa: ANN001
        if getattr(event, "is_directory", False):
            return
        for attr in ("src_path", "dest_path"):
            path = getattr(event, attr, None)
            if path:
                self._cache.invalidate(str(path))

    def on_modified(self, event):  # noqa: ANN001
        self._bump(event)

    def on_created(self, event):  # noqa: ANN001
        self._bump(event)

    def on_deleted(self, event):  # noqa: ANN001
        self._bump(event)

    def on_moved(self, event):  # noqa: ANN001
        self._bump(event)


def _om_watch_root() -> str | None:
    """Resolved TRAJECTORIES_OM_ROOT (default ``/open-meteo``) if it exists."""
    raw = os.environ.get("TRAJECTORIES_OM_ROOT", "").strip() or "/open-meteo"
    try:
        root = os.path.realpath(raw)
    except OSError:
        return None
    if os.path.isdir(root):
        return root
    return None


class OmReaderCache:
    """
    LRU of open OmFileReader instances (local mmap paths).

    Thread safety: one reader per path; acquire ``entry.lock`` around reads.
    Parallelism is across different paths. Inotify (watchdog) invalidates
    only paths currently cached; mtime/inode revalidated on every get.
    """

    def __init__(self, *, max_readers: int = DEFAULT_MAX_READERS):
        self._max = max(8, int(max_readers))
        self._lock = threading.RLock()
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._OmFileReader = None
        # path -> set of LoadTicket ids that used it
        self._active_tickets: dict[int, set[str]] = {}
        self._ticket_stale: dict[int, bool] = {}
        self._next_ticket = 1
        # Resolved-path cache (input path / realpath → realpath).
        self._resolve_cache: OrderedDict[str, str] = OrderedDict()
        # Single recursive OM_ROOT watch (preferred).
        self._root_watch: str | None = None
        # Fallback: parent dir -> refcount (paths outside OM_ROOT only).
        self._dir_refs: dict[str, int] = {}
        self._observer = None
        self._handler = None
        if _HAS_WATCHDOG and Observer is not None:
            self._handler = _DirHandler(self)
            self._observer = Observer()
            self._observer.daemon = True
            self._observer.start()

    def _ensure_reader_cls(self):
        if self._OmFileReader is None:
            from omfiles import OmFileReader

            self._OmFileReader = OmFileReader
        return self._OmFileReader

    def _resolve(self, path: str) -> str:
        """``realpath`` once per path string; hot path must not re-walk symlinks."""
        with self._lock:
            hit = self._resolve_cache.get(path)
            if hit is not None:
                self._resolve_cache.move_to_end(path)
                return hit
        try:
            key = os.path.realpath(path)
        except OSError:
            key = os.path.abspath(path)
        with self._lock:
            self._resolve_cache[path] = key
            self._resolve_cache.move_to_end(path)
            if key != path:
                self._resolve_cache[key] = key
                self._resolve_cache.move_to_end(key)
            while len(self._resolve_cache) > RESOLVE_CACHE_MAX:
                self._resolve_cache.popitem(last=False)
        return key

    def begin_ticket(self) -> int:
        with self._lock:
            tid = self._next_ticket
            self._next_ticket += 1
            self._active_tickets[tid] = set()
            self._ticket_stale[tid] = False
            return tid

    def end_ticket(self, tid: int) -> None:
        with self._lock:
            self._active_tickets.pop(tid, None)
            self._ticket_stale.pop(tid, None)

    def ticket_stale(self, tid: int) -> bool:
        with self._lock:
            return bool(self._ticket_stale.get(tid))

    def check_ticket(self, tid: int) -> None:
        if self.ticket_stale(tid):
            raise SlabStaleError("OM file changed during slab load")

    def _stat(self, path: str) -> tuple[int, int]:
        st = os.stat(path)
        return int(st.st_mtime_ns), int(st.st_ino)

    def _ensure_watch(self, resolved_path: str) -> None:
        """Schedule inotify. Prefer one recursive OM_ROOT watch.

        Caller must hold ``_lock``. Paths outside the root get a capped
        non-recursive parent watch; beyond the cap, mtime/inode still works.
        """
        if self._observer is None or self._handler is None:
            return

        root = _om_watch_root()
        if root and (
            resolved_path == root
            or resolved_path.startswith(root + os.sep)
        ):
            if self._root_watch is not None:
                return
            try:
                self._observer.schedule(self._handler, root, recursive=True)
            except Exception:
                return
            self._root_watch = root
            return

        parent = os.path.dirname(resolved_path) or resolved_path
        if parent in self._dir_refs:
            self._dir_refs[parent] += 1
            return
        if len(self._dir_refs) >= MAX_FALLBACK_DIR_WATCHES:
            return
        try:
            self._observer.schedule(self._handler, parent, recursive=False)
        except Exception:
            return
        self._dir_refs[parent] = 1

    def _unwatch_parent(self, resolved_path: str) -> None:
        """Drop fallback parent refcount. No-op under the OM_ROOT recursive watch."""
        if self._root_watch and (
            resolved_path == self._root_watch
            or resolved_path.startswith(self._root_watch + os.sep)
        ):
            return
        parent = os.path.dirname(resolved_path) or resolved_path
        n = self._dir_refs.get(parent, 0) - 1
        if n <= 0:
            self._dir_refs.pop(parent, None)
        else:
            self._dir_refs[parent] = n

    def _close_entry(self, path: str, entry: _Entry) -> None:
        """Close reader under ``entry.lock``. Must NOT hold ``_lock`` while
        waiting on ``entry.lock`` (ingest invalidate uses the same order)."""
        with entry.lock:
            try:
                entry.reader.close()
            except Exception:
                pass
        with self._lock:
            self._unwatch_parent(path)

    def _path_candidates(self, path: str) -> set[str]:
        key = self._resolve(path)
        return {key, str(path), os.path.abspath(path)}

    def invalidate(self, path: str) -> None:
        """Drop cached reader(s) for path; mark in-flight slab tickets stale.

        Safe during ingest: close happens after releasing the cache lock and
        only while holding ``entry.lock``, so active ``read_array`` callers
        finish (or block the close) instead of seeing a yanked mmap.
        """
        try:
            from .om_backend import clear_om_slab_cache

            clear_om_slab_cache()
        except Exception:
            pass
        candidates = self._path_candidates(path)
        to_close: list[tuple[str, _Entry]] = []
        with self._lock:
            for p in list(self._entries):
                if p in candidates or os.path.abspath(p) in candidates:
                    to_close.append((p, self._entries.pop(p)))
            for tid, paths in self._active_tickets.items():
                if paths & candidates or any(
                    os.path.abspath(x) in candidates for x in paths
                ):
                    self._ticket_stale[tid] = True
        for p, entry in to_close:
            self._close_entry(p, entry)

    def _close_orphan_reader(self, entry: _Entry) -> None:
        """Close a reader that was never published (no dir watch to drop)."""
        with entry.lock:
            try:
                entry.reader.close()
            except Exception:
                pass

    def get(self, path: str, *, ticket: int | None = None) -> _Entry:
        """Return cache entry; caller must hold ``entry.lock`` while reading."""
        key = self._resolve(path)
        OmFileReader = self._ensure_reader_cls()
        stale_close: list[tuple[str, _Entry]] = []
        hit: _Entry | None = None

        with self._lock:
            if ticket is not None and ticket in self._active_tickets:
                self._active_tickets[ticket].add(key)
                if self._ticket_stale.get(ticket):
                    raise SlabStaleError("OM file changed during slab load")

            entry = self._entries.get(key)
            if entry is not None:
                try:
                    mtime_ns, inode = self._stat(key)
                except OSError:
                    self._entries.pop(key, None)
                    stale_close.append((key, entry))
                else:
                    if mtime_ns != entry.mtime_ns or inode != entry.inode:
                        self._entries.pop(key)
                        stale_close.append((key, entry))
                    else:
                        self._entries.move_to_end(key)
                        hit = entry

        for p, e in stale_close:
            self._close_entry(p, e)
        if hit is not None:
            return hit

        # Open outside the global lock so ingest invalidates are not blocked
        # on OmFileReader construction.
        mtime_ns, inode = self._stat(key)
        reader = OmFileReader(key)
        new_entry = _Entry(reader=reader, mtime_ns=mtime_ns, inode=inode)

        close_published: list[tuple[str, _Entry]] = []
        discard_orphan = False
        result: _Entry | None = None

        with self._lock:
            if ticket is not None and ticket in self._active_tickets:
                if self._ticket_stale.get(ticket):
                    discard_orphan = True
                else:
                    self._active_tickets[ticket].add(key)

            if not discard_orphan:
                existing = self._entries.get(key)
                if (
                    existing is not None
                    and existing.mtime_ns == mtime_ns
                    and existing.inode == inode
                ):
                    self._entries.move_to_end(key)
                    result = existing
                    discard_orphan = True
                else:
                    if existing is not None:
                        self._entries.pop(key, None)
                        close_published.append((key, existing))
                    self._entries[key] = new_entry
                    self._ensure_watch(key)
                    result = new_entry
                    while len(self._entries) > self._max:
                        old_p, old_e = self._entries.popitem(last=False)
                        close_published.append((old_p, old_e))

        if discard_orphan:
            self._close_orphan_reader(new_entry)
        for p, e in close_published:
            self._close_entry(p, e)

        if result is None:
            raise SlabStaleError("OM file changed during slab load")
        return result

    def read_array(self, path: str, indexer, *, ticket: int | None = None):
        """Thread-safe slice read from a cached reader."""
        key = self._resolve(path)
        entry = self.get(path, ticket=ticket)
        with entry.lock:
            if ticket is not None:
                self.check_ticket(ticket)
            try:
                mtime_ns, inode = self._stat(key)
            except OSError as exc:
                raise SlabStaleError(str(exc)) from exc
            if mtime_ns == entry.mtime_ns and inode == entry.inode:
                return entry.reader[indexer]
        # Never invalidate while holding entry.lock (lock-order inversion).
        self.invalidate(path)
        raise SlabStaleError(f"stale reader: {path}")

    def clear(self) -> None:
        with self._lock:
            items = list(self._entries.items())
            self._entries.clear()
        for p, e in items:
            self._close_entry(p, e)

    def close(self) -> None:
        self.clear()
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=2)
            except Exception:
                pass
            self._observer = None
        with self._lock:
            self._root_watch = None
            self._dir_refs.clear()
            self._resolve_cache.clear()

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._entries)


_CACHE_LOCK = threading.Lock()
_CACHE: OmReaderCache | None = None


def get_om_reader_cache() -> OmReaderCache:
    global _CACHE
    with _CACHE_LOCK:
        if _CACHE is None:
            max_r = int(os.environ.get("TRAJECTORIES_OM_READER_CACHE", DEFAULT_MAX_READERS))
            _CACHE = OmReaderCache(max_readers=max_r)
        return _CACHE


def clear_om_reader_cache() -> None:
    global _CACHE
    with _CACHE_LOCK:
        if _CACHE is not None:
            _CACHE.close()
            _CACHE = None
