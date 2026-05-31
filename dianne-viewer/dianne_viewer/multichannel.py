import io
import os
import threading
import numpy as np
import tifffile
import zarr
from PIL import Image
import xml.etree.ElementTree as ET
import re

def get_channel_names(path: str, clean: bool = True) -> list[str]:
    is_url = path.startswith('http://') or path.startswith('https://')
    if is_url:
        import fsspec
        fh = fsspec.open(path, 'rb').open()
        tif_ctx = tifffile.TiffFile(fh)
    else:
        tif_ctx = tifffile.TiffFile(path)
    with tif_ctx as tif:
        if not tif.ome_metadata:
            return []
        root = ET.fromstring(tif.ome_metadata)

    channels = root.findall('.//{*}Channel')
    names = [ch.get('Name', f'Channel {i}') for i, ch in enumerate(channels)]

    if clean:
        names = [re.sub(r'\s*\(color=[^)]*\)', '', n).strip() for n in names]

    return names

class MultichannelImage:
    """
    Wraps an OME-TIFF zarr pyramid whose first axis is C > 3 (multichannel / multiplex IF).
    Serves PNG grayscale tile bytes per channel for client-side additive compositing.

    The server-side normalization range (p1–p99 of non-zero pixels) is computed once
    from the coarsest pyramid level at construction time so each tile is mapped
    consistently to [0, 255] regardless of which tile is requested.
    """

    TILE = 512  # must match zarr chunk size

    def __init__(self, path, _zarr_store=None):
        self.path   = str(path)
        store       = _zarr_store if _zarr_store is not None else tifffile.imread(self.path, aszarr=True)
        self._z     = zarr.open(store, mode='r')

        arr = self._z["0"] if isinstance(self._z, zarr.Group) else self._z
        proper_tile = max(arr.chunks[-2], arr.chunks[-1])
        if proper_tile != self.TILE:
            if getattr(self, 'verbose', False):
                print(f"Warning: zarr chunk size {arr.chunks} does not match expected tile size {self.TILE}. "
                    f"Using tile size {proper_tile} based on zarr chunk size.")
            self.TILE = proper_tile

        self.n_levels = len(self._z)
        self.levels   = {}
        for i in range(self.n_levels):
            arr       = self._z[str(i)]
            c, h, w   = arr.shape
            self.levels[i] = dict(
                shape     = (h, w),
                n_tiles_y = (h + self.TILE - 1) // self.TILE,
                n_tiles_x = (w + self.TILE - 1) // self.TILE,
            )

        self.n_channels = self._z['0'].shape[0]
        self._channel_names = get_channel_names(self.path)

        h0, _ = self.levels[0]['shape']
        for i, meta in self.levels.items():
            h, _ = meta['shape']
            meta['downsample'] = h0 / h

        self._channel_ranges = self._compute_channel_ranges()

        # Pre-load thumbnail from sidecar file if present; otherwise compute in background
        self._thumb_ready = threading.Event()
        base = os.path.splitext(self.path)[0]
        self.thumb: bytes | None = None
        for _ext in ('thumbnail.jpeg', 'thumbnail.tiff'):
            _thumb_path = base + _ext
            if os.path.isfile(_thumb_path):
                with open(_thumb_path, 'rb') as _f:
                    _raw = _f.read()
                img = Image.open(io.BytesIO(_raw))
                img.thumbnail((256, 256), resample=Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format='JPEG', quality=85)
                self.thumb = buf.getvalue()
                break

        if self.thumb is not None:
            self._thumb_ready.set()
        else:
            def _build_thumb(self=self):
                try:
                    self.thumb = self.get_level_thumbnail(self.n_levels - 1)
                finally:
                    self._thumb_ready.set()
            threading.Thread(target=_build_thumb, daemon=True, name=f'thumb-{os.path.basename(self.path)}').start()

    # ── internal helpers ───────────────────────────────────────────────────────

    def _compute_channel_ranges(self):
        """Compute per-channel (p1, p99) defaults and (raw_min, raw_max) full range
        from non-zero pixels at the coarsest pyramid level."""
        lowest = self.n_levels - 1
        arr    = self._z[str(lowest)]
        ranges      = []
        full_ranges = []
        for c in range(self.n_channels):
            data    = arr[c][()].astype(np.float32)
            nonzero = data[data > 0]
            if nonzero.size > 0:
                p1, p99   = float(np.percentile(nonzero, 1)), float(np.percentile(nonzero, 99))
                raw_min   = float(data.min())
                raw_max   = float(data.max())
            else:
                p1, p99   = 0.0, 1.0
                raw_min   = 0.0
                raw_max   = 1.0
            # Guard against degenerate p1 == p99
            if p99 <= p1:
                p99 = p1 + 1.0
            if raw_max <= raw_min:
                raw_max = raw_min + 1.0
            ranges.append((p1, p99))
            full_ranges.append((raw_min, raw_max))
        self._channel_full_ranges = full_ranges
        return ranges

    def _to_png(self, gray: np.ndarray) -> bytes:
        buf = io.BytesIO()
        Image.fromarray(gray, mode='L').save(buf, format='PNG', compress_level=1)
        return buf.getvalue()

    def _blank_tile(self) -> bytes:
        return self._to_png(np.zeros((self.TILE, self.TILE), dtype=np.uint8))

    # ── public API ─────────────────────────────────────────────────────────────

    @property
    def metadata(self):
        """Serialisable dict sent to JS on viewer init."""
        return dict(
            n_levels           = self.n_levels,
            tile_size          = self.TILE,
            n_channels         = self.n_channels,
            channel_names = self._channel_names if self._channel_names else [f'Channel {i}' for i in range(self.n_channels)],
            channel_ranges     = self._channel_ranges,
            channel_full_ranges = self._channel_full_ranges,
            levels = {
                i: dict(
                    width      = meta['shape'][1],
                    height     = meta['shape'][0],
                    n_tiles_x  = meta['n_tiles_x'],
                    n_tiles_y  = meta['n_tiles_y'],
                    downsample = meta['downsample'],
                )
                for i, meta in self.levels.items()
            },
        )

    def get_channel_tile(self, channel: int, level: int, row: int, col: int) -> bytes:
        """
        Return PNG bytes for a single channel tile normalised to uint8.
        The grayscale value 0 maps to p1, 255 maps to p99 of the channel's
        level-0-derived intensity range.
        """
        if level not in self.levels:
            raise ValueError(f'level {level} out of range 0–{self.n_levels - 1}')
        if not (0 <= channel < self.n_channels):
            raise ValueError(f'channel {channel} out of range 0–{self.n_channels - 1}')

        meta = self.levels[level]
        h, w = meta['shape']
        T    = self.TILE
        arr  = self._z[str(level)]

        y0 = row * T;  y1 = min(y0 + T, h)
        x0 = col * T;  x1 = min(x0 + T, w)

        if y0 >= h or x0 >= w:
            return self._blank_tile()

        data = arr[channel, y0:y1, x0:x1].astype(np.float32)
        lo, hi = self._channel_ranges[channel]
        data   = np.clip((data - lo) / (hi - lo), 0.0, 1.0)
        data   = (data * 255).astype(np.uint8)

        # Pad border tiles to full TILE×TILE so the JS always receives a square
        th, tw = data.shape
        if th < T or tw < T:
            canvas         = np.zeros((T, T), dtype=np.uint8)
            canvas[:th, :tw] = data
            data           = canvas

        return self._to_png(data)

    def get_rgb_tile(self, level: int, row: int, col: int, quality: int = 85) -> bytes:
        """
        Composite all channels to an RGB JPEG tile using default IF colours.
        Used by the server when serving secondary (background) image tiles.
        """
        if level not in self.levels:
            raise ValueError(f'level {level} out of range 0–{self.n_levels - 1}')
        meta = self.levels[level]
        h, w = meta['shape']
        T    = self.TILE
        arr  = self._z[str(level)]

        y0 = row * T;  y1 = min(y0 + T, h)
        x0 = col * T;  x1 = min(x0 + T, w)

        if y0 >= h or x0 >= w:
            buf = io.BytesIO()
            Image.fromarray(np.zeros((T, T, 3), dtype=np.uint8)).save(buf, format='JPEG', quality=quality)
            return buf.getvalue()

        default_colors = np.array([
            [ 68, 136, 255], [  0, 255,  68], [255,  34,  34], [255, 255,   0],
            [  0, 255, 255], [255,   0, 255], [255, 136,   0], [255,   0, 136],
        ], dtype=np.float32) / 255.0

        rgb = np.zeros((T, T, 3), dtype=np.float32)
        for c in range(self.n_channels):
            data   = arr[c, y0:y1, x0:x1].astype(np.float32)
            lo, hi = self._channel_ranges[c]
            data   = np.clip((data - lo) / (hi - lo), 0.0, 1.0)
            color  = default_colors[c % len(default_colors)]
            th, tw = data.shape
            rgb[:th, :tw] += data[:, :, np.newaxis] * color

        rgb = np.clip(rgb * 255, 0, 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format='JPEG', quality=quality)
        return buf.getvalue()

    def get_level_thumbnail(self, level: int = None, size: int = 256,
                            background=(15, 15, 15), quality: int = 85) -> bytes:
        """
        Composite up to four channels with default IF colours into a JPEG thumbnail.
        """
        if level is None:
            level = self.n_levels - 1
        if level not in self.levels:
            raise ValueError(f'level {level} out of range')

        arr     = self._z[str(level)]   # (C, H, W)
        _, h, w = arr.shape

        default_colors = [
            (68,  136, 255),   # blue  — DAPI / nuclear stain
            (0,   255,  68),   # green
            (255,  34,  34),   # red
        ]

        rgb = np.zeros((h, w, 3), dtype=np.float32)
        for c in range(min(self.n_channels, len(default_colors))):
            data  = arr[c][()].astype(np.float32)
            lo, hi = self._channel_ranges[c]
            data  = np.clip((data - lo) / (hi - lo), 0.0, 1.0)
            color = np.array(default_colors[c], dtype=np.float32) / 255.0
            rgb  += data[:, :, np.newaxis] * color

        rgb = np.clip(rgb * 255, 0, 255).astype(np.uint8)
        img = Image.fromarray(rgb)

        scale = min(size / float(w), size / float(h)) if (w and h) else 1.0
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        resized = img.resize((new_w, new_h), resample=Image.LANCZOS)

        canvas  = Image.new('RGB', (size, size), color=background)
        off_x   = (size - new_w) // 2
        off_y   = (size - new_h) // 2
        canvas.paste(resized, (off_x, off_y))

        buf = io.BytesIO()
        canvas.save(buf, format='JPEG', quality=quality)
        return buf.getvalue()
