"""Fast read-only zarr store over a remote (HTTP/S3) TIFF: small range reads, parallel handles, chunk LRU."""
import queue
import threading
from collections import OrderedDict
from collections.abc import MutableMapping

import fsspec
import tifffile

BLOCK = 256 * 1024  # fsspec default (~5 MB) makes every random tile read pull megabytes


def open_remote(path, **kw):
    """Seekable file with small blocks and a bounded block cache."""
    return fsspec.open(path, 'rb', block_size=BLOCK, cache_type='blockcache',
                       cache_options={'maxblocks': 128}, **kw).open()


class PooledTiffStore(MutableMapping):
    """Read-only zarr v2 store: a pool of independent TiffFile handles (parallel range requests)
    plus a shared byte-budgeted LRU of decoded chunks."""

    def __init__(self, path, pool_size=8, cache_bytes=256 << 20):
        self._path, self._size, self._cmax = path, pool_size, cache_bytes
        self._pool, self._n, self._mk = queue.LifoQueue(), 0, threading.Lock()
        self._cache, self._cbytes, self._cl = OrderedDict(), 0, threading.Lock()
        first = self._make()
        self._n = 1
        self._pool.put(first)
        self._keys = set(first[1])

    def _make(self):
        tif = tifffile.TiffFile(open_remote(self._path))
        return tif, tif.aszarr()  # keep tif referenced alongside its store

    def _acquire(self):
        try:
            return self._pool.get_nowait()
        except queue.Empty:
            pass
        with self._mk:
            if self._n < self._size:
                h = self._make()
                self._n += 1
                return h
        return self._pool.get()

    def __getitem__(self, key):
        with self._cl:
            v = self._cache.get(key)
            if v is not None:
                self._cache.move_to_end(key)
                return v
        if key not in self._keys:
            raise KeyError(key)
        h = self._acquire()
        try:
            v = h[1][key]
        finally:
            self._pool.put(h)
        n = len(v)
        if n <= self._cmax:
            with self._cl:
                if key not in self._cache:
                    self._cache[key] = v
                    self._cbytes += n
                while self._cbytes > self._cmax:
                    _, old = self._cache.popitem(last=False)
                    self._cbytes -= len(old)
        return v

    def __contains__(self, key): return key in self._keys
    def __iter__(self): return iter(self._keys)
    def __len__(self): return len(self._keys)
    def __setitem__(self, k, v): raise PermissionError('read-only store')
    def __delitem__(self, k): raise PermissionError('read-only store')
