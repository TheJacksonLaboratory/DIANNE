"""
monochannel.py
==============

Wraps a single-channel zarr pyramid with shape (1, H, W) or (H, W) per level.
Serves uint8 grayscale PNG tiles for client-side colourmap / palette rendering.

Pixel value **0** is always transparent on the client:
  - Integer (mask / label) images: raw label values clamped to 0–255 are served
    as-is.  Label 0 = background = transparent; labels 1–255 = class indices.
  - Float (heatmap) images: zero pixels stay 0 (transparent); non-zero pixels
    are normalised from [p1, p99] → [1, 254] so the client can reconstruct which
    portion of the dynamic range each pixel represents.

The client fetches a 256-entry RGBA look-up table (LUT) via ``/mono_lut`` and
applies it to the raw grey tiles to produce the final coloured RGBA image with
transparency at index 0.

Edit the module-level constants below to change the viewer start-up defaults.
"""

import io
import os
import threading

import numpy as np
import tifffile
import zarr
from PIL import Image

# ── Configurable defaults — edit here to change viewer start-up state ─────────

#: Initial rendering mode: ``'palette'`` for discrete label colours, ``'cmap'`` for
#: a continuous colourmap applied to intensity values.
MONO_DEFAULT_MODE = 'palette'

#: Matplotlib colourmap used as the source of discrete palette colours.
#: Any matplotlib colourmap name is valid; qualitative maps (tab10, tab20, …)
#: give the most distinct colours for category labels.
MONO_DEFAULT_PALETTE = 'tab20'

#: Matplotlib colourmap used when mode is ``'cmap'``.
MONO_DEFAULT_CMAP = 'viridis'

#: Order in which palette colours are assigned to label values.
#: ``'sequential'`` assigns colours in cmap order; ``'random'`` shuffles them.
MONO_DEFAULT_COLORS = 'random'

#: Lower display bound for cmap mode.  ``None`` → use the data p1 percentile.
MONO_DEFAULT_VMIN = None

#: Upper display bound for cmap mode.  ``None`` → use the data p99 percentile.
MONO_DEFAULT_VMAX = None

# ── Colourmap lists surfaced in the UI pickers ─────────────────────────────────

#: All matplotlib colourmap names shown in the cmap dropdown.
MONO_ALL_CMAPS = [
    # Perceptually uniform sequential
    'viridis', 'plasma', 'inferno', 'magma', 'cividis', 'turbo',
    # Classic / legacy
    'jet', 'rainbow', 'hot', 'cool', 'bone', 'copper',
    # Diverging
    'coolwarm', 'RdBu', 'bwr', 'seismic',
    # Single-hue sequential
    'Blues', 'Reds', 'Greens', 'Oranges', 'Purples', 'Greys',
    'YlOrRd', 'YlGnBu', 'BuGn', 'GnBu', 'PuBu', 'PuRd',
    # Miscellaneous
    'terrain', 'ocean', 'gist_earth', 'cubehelix', 'gnuplot',
    'afmhot', 'pink', 'spring', 'summer', 'autumn', 'winter',
]

#: All matplotlib colourmap names shown in the palette dropdown (qualitative preferred).
MONO_ALL_PALETTES = [
    # Qualitative — best for discrete labels
    'tab10', 'tab20', 'tab20b', 'tab20c',
    'Set1', 'Set2', 'Set3', 'Pastel1', 'Pastel2',
    'Paired', 'Accent', 'Dark2',
    # Anything from MONO_ALL_CMAPS can also be used as a palette source
    'viridis', 'plasma', 'inferno', 'magma', 'turbo',
    'jet', 'rainbow', 'hot', 'cool', 'bone', 'copper',
    'spring', 'summer', 'autumn', 'winter',
    'Blues', 'Reds', 'Greens', 'Oranges', 'Purples',
]


# ── MonochannelImage ───────────────────────────────────────────────────────────

class MonochannelImage:
    """
    Wraps an OME-TIFF / zarr pyramid with a single data channel.

    Serves uint8 greyscale PNG tiles via :meth:`get_tile` for client-side LUT
    rendering, and 256-entry RGBA LUT bytes via :meth:`get_lut`.
    """

    TILE = 512  # must match zarr chunk size

    def __init__(self, path, _zarr_store=None):
        self.path = str(path)
        store = _zarr_store if _zarr_store is not None else tifffile.imread(self.path, aszarr=True)
        self._z = zarr.open(store, mode='r')

        arr = self._z['0'] if isinstance(self._z, zarr.Group) else self._z
        proper_tile = max(arr.chunks[-2], arr.chunks[-1])
        if proper_tile != self.TILE:
            self.TILE = proper_tile

        self.n_levels = len(self._z)
        self.levels = {}
        for i in range(self.n_levels):
            a = self._z[str(i)]
            # Accept (1, H, W) or (H, W)
            if a.ndim == 3:
                _, h, w = a.shape
            else:
                h, w = a.shape
            self.levels[i] = dict(
                shape=(h, w),
                n_tiles_y=(h + self.TILE - 1) // self.TILE,
                n_tiles_x=(w + self.TILE - 1) // self.TILE,
            )

        h0, w0 = self.levels[0]['shape']
        for i, meta in self.levels.items():
            h, w = meta['shape']
            meta['downsample'] = h0 / h

        # Compute statistics from the coarsest level (fast)
        _coarse = self._z[str(self.n_levels - 1)]
        _data = np.asarray(_coarse[0] if _coarse.ndim == 3 else _coarse).astype(np.float64)
        self.dtype_kind = np.dtype(_coarse.dtype).kind  # 'i', 'u', or 'f'
        _nz = _data[_data != 0]
        if len(_nz) > 0:
            self.p1 = float(np.percentile(_nz, 1))
            self.p99 = float(np.percentile(_nz, 99))
            self.data_min = float(_nz.min())
            self.data_max = float(_nz.max())
        else:
            self.p1 = self.data_min = 0.0
            self.p99 = self.data_max = 1.0

        # Pre-load thumbnail
        self._thumb_ready = threading.Event()
        base = os.path.splitext(self.path)[0]
        self.thumb: bytes | None = None
        for _ext in ('thumbnail.jpeg', 'thumbnail.tiff'):
            _tp = base + _ext
            if os.path.isfile(_tp):
                with open(_tp, 'rb') as _f:
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
            threading.Thread(
                target=_build_thumb, daemon=True,
                name=f'mono-thumb-{os.path.basename(self.path)}',
            ).start()

    # ── public API ─────────────────────────────────────────────────────────────

    @property
    def metadata(self):
        """Serialisable dict sent to JS on viewer init."""
        return dict(
            n_levels=self.n_levels,
            tile_size=self.TILE,
            dtype_kind=self.dtype_kind,
            data_min=self.data_min,
            data_max=self.data_max,
            p1=self.p1,
            p99=self.p99,
            # Default display settings (from module constants)
            default_mode=MONO_DEFAULT_MODE,
            default_palette=MONO_DEFAULT_PALETTE,
            default_cmap=MONO_DEFAULT_CMAP,
            default_colors=MONO_DEFAULT_COLORS,
            default_vmin=MONO_DEFAULT_VMIN if MONO_DEFAULT_VMIN is not None else self.p1,
            default_vmax=MONO_DEFAULT_VMAX if MONO_DEFAULT_VMAX is not None else self.p99,
            all_cmaps=MONO_ALL_CMAPS,
            all_palettes=MONO_ALL_PALETTES,
            levels={
                i: dict(
                    width=meta['shape'][1],
                    height=meta['shape'][0],
                    n_tiles_x=meta['n_tiles_x'],
                    n_tiles_y=meta['n_tiles_y'],
                    downsample=meta['downsample'],
                )
                for i, meta in self.levels.items()
            },
        )

    def get_tile(self, level: int, row: int, col: int) -> bytes:
        """
        Return uint8 greyscale PNG tile.

        Encoding:
          - pixel value 0 → transparent (zero in original, or background label)
          - Integer data: raw label values clamped to [0, 255]
          - Float data: non-zero values normalised from [p1, p99] → [1, 254]
        """
        if level not in self.levels:
            raise ValueError(f'level {level} out of range 0–{self.n_levels - 1}')

        meta = self.levels[level]
        h, w = meta['shape']
        T = self.TILE
        a = self._z[str(level)]

        y0 = row * T;  y1 = min(y0 + T, h)
        x0 = col * T;  x1 = min(x0 + T, w)

        if y0 >= h or x0 >= w:
            return self._blank_tile()

        raw = np.asarray(a[0, y0:y1, x0:x1] if a.ndim == 3 else a[y0:y1, x0:x1])
        th, tw = raw.shape

        canvas = np.zeros((T, T), dtype=np.uint8)
        if self.dtype_kind == 'f':
            # Float: normalise non-zero values to [1, 254]; zero → 0 (transparent)
            out = np.zeros(raw.shape, dtype=np.float32)
            mask = raw != 0
            span = max(self.p99 - self.p1, 1e-9)
            out[mask] = 1.0 + (
                np.clip(raw[mask].astype(np.float32) - self.p1, 0.0, span) / span * 253.0
            )
            canvas[:th, :tw] = out.clip(0, 255).astype(np.uint8)
        else:
            # Integer / unsigned integer: raw label, clamp to [0, 255]
            canvas[:th, :tw] = np.clip(raw.astype(np.int64), 0, 255).astype(np.uint8)

        return self._to_png(canvas)

    def get_lut(self, cmap_name: str) -> list:
        """
        Return a 256-entry RGBA look-up table for the given matplotlib colourmap
        as a list of [R, G, B, A] lists (ints 0–255).

        Index 0 is forced to fully transparent (alpha = 0) so that zero-valued
        pixels are invisible regardless of the colourmap.
        """
        import matplotlib.cm as cm
        try:
            cmap = cm.get_cmap(cmap_name, 256)
        except (ValueError, KeyError):
            cmap = cm.get_cmap('viridis', 256)
        rgba = (cmap(np.linspace(0, 1, 256)) * 255).astype(np.uint8)
        rgba[0, 3] = 0  # index 0 → always transparent
        return rgba.tolist()

    def get_level_thumbnail(self, level: int, size: int = 256, quality: int = 85) -> bytes:
        """Render the entire pyramid level into a greyscale JPEG thumbnail."""
        a = self._z[str(level)]
        raw = np.asarray(a[0] if a.ndim == 3 else a)
        h, w = raw.shape
        if raw.dtype.kind == 'f':
            span = max(self.p99 - self.p1, 1e-9)
            out = np.clip((raw.astype(np.float32) - self.p1) / span * 255, 0, 255).astype(np.uint8)
        else:
            out = np.clip(raw.astype(np.int64), 0, 255).astype(np.uint8)
        img = Image.fromarray(out, mode='L')
        scale = min(size / max(w, 1), size / max(h, 1))
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        canvas = Image.new('L', (size, size), 0)
        canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2))
        buf = io.BytesIO()
        canvas.save(buf, format='JPEG', quality=quality)
        return buf.getvalue()

    # ── helpers ────────────────────────────────────────────────────────────────

    def _to_png(self, arr: np.ndarray) -> bytes:
        buf = io.BytesIO()
        Image.fromarray(arr, mode='L').save(buf, format='PNG')
        return buf.getvalue()

    def _blank_tile(self) -> bytes:
        return self._to_png(np.zeros((self.TILE, self.TILE), dtype=np.uint8))
