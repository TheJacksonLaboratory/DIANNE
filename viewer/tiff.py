import io
import numpy as np
import tifffile
import zarr
from PIL import Image


class PyramidImage:
    """
    Wraps an OME-TIFF zarr pyramid with shape (C, H, W) per level.
    Serves JPEG tile bytes for a given pyramid level / tile coordinate.
    Tile size aligns to zarr chunk size (512) for efficient reads.
    """

    TILE = 512  # must match zarr chunk size

    def __init__(self, path):
        self.path  = str(path)
        store      = tifffile.imread(self.path, aszarr=True)
        self._z    = zarr.open(store, mode='r')

        self.n_levels = len(self._z)
        self.levels   = {}          # level_idx → {shape, n_tiles_x, n_tiles_y}
        for i in range(self.n_levels):
            arr = self._z[str(i)]
            _, h, w = arr.shape
            self.levels[i] = dict(
                shape      = (h, w),
                n_tiles_y  = (h + self.TILE - 1) // self.TILE,
                n_tiles_x  = (w + self.TILE - 1) // self.TILE,
            )

        # downsample factor of each level relative to level 0
        h0, w0 = self.levels[0]['shape']
        for i, meta in self.levels.items():
            h, w = meta['shape']
            meta['downsample'] = h0 / h   # ~= 2**i for power-of-2 pyramids

    # ── public API ────────────────────────────────────────────────────────────

    @property
    def metadata(self):
        """Serialisable dict sent to JS on viewer init."""
        return dict(
            n_levels  = self.n_levels,
            tile_size = self.TILE,
            levels    = {
                i: dict(
                    width      = meta['shape'][1],
                    height     = meta['shape'][0],
                    n_tiles_x  = meta['n_tiles_x'],
                    n_tiles_y  = meta['n_tiles_y'],
                    downsample = meta['downsample'],
                )
                for i, meta in self.levels.items()
            }
        )

    def get_tile(self, level: int, row: int, col: int) -> bytes:
        """
        Return JPEG bytes for the tile at (row, col) in the given pyramid level.
        Clamps at image edges so partial border tiles work correctly.
        """
        if level not in self.levels:
            raise ValueError(f"level {level} out of range 0–{self.n_levels-1}")

        meta   = self.levels[level]
        h, w   = meta['shape']
        T      = self.TILE
        arr    = self._z[str(level)]   # shape (C, H, W)

        y0 = row * T;  y1 = min(y0 + T, h)
        x0 = col * T;  x1 = min(x0 + T, w)

        if y0 >= h or x0 >= w:
            return self._blank_tile(y1-y0, x1-x0)

        # read (C, th, tw) — three channel reads, each hits 1 chunk column
        data = arr[:, y0:y1, x0:x1]       # numpy (3, th, tw) uint8

        # → (th, tw, 3) for PIL
        rgb  = np.moveaxis(data, 0, -1)

        # pad to full TILE if border tile (keeps tile size uniform for JS)
        th, tw = rgb.shape[:2]
        if th < T or tw < T:
            canvas      = np.zeros((T, T, 3), dtype=np.uint8)
            canvas[:th, :tw] = rgb
            rgb         = canvas

        return self._to_jpeg(rgb)

    # ── helpers ───────────────────────────────────────────────────────────────

    def _to_jpeg(self, rgb: np.ndarray, quality: int = 85) -> bytes:
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, format='JPEG', quality=quality)
        return buf.getvalue()

    def _blank_tile(self, h: int = TILE, w: int = TILE) -> bytes:
        return self._to_jpeg(np.zeros((h or self.TILE, w or self.TILE, 3), dtype=np.uint8))
