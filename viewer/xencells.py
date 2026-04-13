from collections import OrderedDict
from pathlib import Path

import fsspec
import numpy as np
import pandas as pd
import zarr
from scipy.spatial import KDTree

class XeniumCells:
    """
    Read cell coordinates and boundaries from a Xenium cells.zarr.zip bundle.

    The zip store and spatial index are initialized once and reused for all tile
    requests. Boundaries are only loaded when the tile has a manageable number
    of visible cells.
    """

    def __init__(self, bundle_path, image_metadata, matrix_path=None, xenium_mpp=0.2125,
                 cell_id_to_category=None, category_colors=None, max_cells=2000):
        self.bundle_path = Path(bundle_path)
        self.image_metadata = image_metadata
        self.tile_size = int(image_metadata['tile_size'])
        self.max_cells = int(max_cells)
        self._tile_cache = OrderedDict()
        self._tile_cache_limit = 256

        self._M = None
        self._Tr = None
        self._Mi = None
        self._mpp = float(xenium_mpp)
        if matrix_path is not None:
            import pandas as pd
            mat = pd.read_csv(matrix_path, index_col=None, header=None).values
            self._M = mat[:2, :2].astype(float)
            self._Tr = mat[:2, -1].astype(float)
            self._Mi = np.linalg.inv(self._M)

        if cell_id_to_category is None:
            self.cell_id_to_category = {}
        elif hasattr(cell_id_to_category, 'to_dict'):
            # Supports pandas Series/DataFrame-like mappings passed from notebooks.
            self.cell_id_to_category = dict(cell_id_to_category.to_dict())
        elif isinstance(cell_id_to_category, pd.Categorical):
            # Use as is
            pass
        else:
            self.cell_id_to_category = dict(cell_id_to_category)

        if category_colors is None:
            self.category_colors = {}
        elif hasattr(category_colors, 'to_dict'):
            self.category_colors = dict(category_colors.to_dict())
        else:
            self.category_colors = dict(category_colors)

        zip_fs = fsspec.filesystem('zip', fo=str(self.bundle_path / 'cells.zarr.zip'))
        store = zip_fs.get_mapper('')
        self._root = zarr.open(store, mode='r')
        self._coords_xe = np.asarray(self._root['cell_summary'][:, :2], dtype=float)
        self._tree = KDTree(self._coords_xe)
        self._has_polygon_vertices = 'polygon_vertices' in self._root
        self._polygon_sets = self._root['polygon_sets'] if 'polygon_sets' in self._root else None

    @property
    def metadata(self):
        return {
            'max_cells': self.max_cells,
            'has_categories': bool(self.cell_id_to_category),
            'category_colors': self.category_colors,
        }

    def get_tile_cells(self, level, row, col):
        cache_key = (int(level), int(row), int(col))
        cached = self._tile_cache.get(cache_key)
        if cached is not None:
            self._tile_cache.move_to_end(cache_key)
            return cached

        level = int(level)
        row = int(row)
        col = int(col)

        if level not in self.image_metadata['levels']:
            raise ValueError(f'level {level} out of range')

        x0_he, y0_he, x1_he, y1_he = self._tile_bounds(level, row, col)
        he_corners = np.array([
            [x0_he, y0_he], [x1_he, y0_he],
            [x0_he, y1_he], [x1_he, y1_he],
        ])
        xe_corners = self._he_to_xe(he_corners)
        x0_xe, y0_xe = xe_corners.min(axis=0)
        x1_xe, y1_xe = xe_corners.max(axis=0)

        indices, coords = self._query_box(x0_xe, y0_xe, x1_xe, y1_xe)
        if indices.size == 0:
            return self._remember(cache_key, [])

        use_dots = indices.size > self.max_cells
        boundaries = None
        if use_dots:
            seed = int((level * 1000000 + row * 1000 + col) % (2 ** 31))
            rng = np.random.RandomState(seed)
            keep = np.sort(rng.choice(indices.size, self.max_cells, replace=False))
            indices = indices[keep]
            coords = coords[keep]
        else:
            boundaries = self._get_boundaries(indices)

        he_coords = self._xe_to_he(coords)
        points = []
        for point_index, (cell_id, he_coord) in enumerate(zip(indices, he_coords)):
            cell_id_int = int(cell_id)
            if isinstance(self.cell_id_to_category, pd.Categorical):
                category = self.cell_id_to_category[cell_id_int]
            else:
                category = self.cell_id_to_category.get(cell_id_int)

            # print(self.cell_id_to_category, cell_id_int, category)
            # break

            boundary = None
            if boundaries is not None and point_index < len(boundaries):
                boundary_xe = np.asarray(boundaries[point_index]).reshape(-1, 2)
                boundary_xe = boundary_xe[np.isfinite(boundary_xe).all(axis=1)]
                if boundary_xe.size:
                    boundary_he = self._xe_to_he(boundary_xe)
                    boundary = [
                        [float(point[0]), float(point[1])]
                        for point in boundary_he
                    ]

            points.append({
                'x': float(he_coord[0]),
                'y': float(he_coord[1]),
                'cell_id': cell_id_int,
                'category': category,
                'boundary': boundary,
                'is_dot': use_dots,
            })

        return self._remember(cache_key, points)

    def _remember(self, cache_key, payload):
        self._tile_cache[cache_key] = payload
        self._tile_cache.move_to_end(cache_key)
        while len(self._tile_cache) > self._tile_cache_limit:
            self._tile_cache.popitem(last=False)
        return payload

    def _query_box(self, x0, y0, x1, y1):
        center = ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
        half_side = max(x1 - x0, y1 - y0) / 2.0
        radius = half_side * np.sqrt(2.0)
        candidate_indices = np.asarray(self._tree.query_ball_point(center, r=radius), dtype=np.int64)
        if candidate_indices.size == 0:
            return np.empty((0,), dtype=np.int64), np.empty((0, 2), dtype=float)

        candidates = self._coords_xe[candidate_indices]
        mask = (
            (candidates[:, 0] >= x0) & (candidates[:, 0] < x1) &
            (candidates[:, 1] >= y0) & (candidates[:, 1] < y1)
        )
        return candidate_indices[mask], candidates[mask]

    def _get_boundaries(self, indices, boundary_id=1):
        if indices.size == 0:
            return []

        try:
            if self._has_polygon_vertices:
                raw = np.asarray(self._root['polygon_vertices'][boundary_id, indices, :])
            elif self._polygon_sets is not None:
                key = str(boundary_id) if str(boundary_id) in self._polygon_sets else boundary_id
                raw = np.asarray(self._polygon_sets[key]['vertices'][indices, :])
            else:
                return None
        except Exception:
            return None

        if raw.ndim == 2:
            raw = raw.reshape(raw.shape[0], raw.shape[1] // 2, 2)
        return raw

    def _he_to_xe(self, coords):
        if self._M is None:
            return coords
        return (np.dot(coords, self._M.T) + self._Tr) * self._mpp

    def _xe_to_he(self, coords):
        if self._M is None:
            return coords
        return np.dot(coords / self._mpp - self._Tr, self._Mi.T)

    def _tile_bounds(self, level, row, col):
        level_meta = self.image_metadata['levels'][level]
        downsample = float(level_meta['downsample'])
        width = float(level_meta['width'])
        height = float(level_meta['height'])

        x0 = col * self.tile_size * downsample
        y0 = row * self.tile_size * downsample
        x1 = min(width * downsample, x0 + self.tile_size * downsample)
        y1 = min(height * downsample, y0 + self.tile_size * downsample)
        return x0, y0, x1, y1

class XeniumCellsFast:
    """
    Tile-optimised cell reader backed by cells_fast.zarr.zip.

    Compared to XeniumCells:
      - No global KDTree (grid lookup is O(1))
      - Boundaries are read only for the relevant grid cells
      - No full boundary array in RAM; reads are spatially contiguous

    Parameters mirror XeniumCells; drop it in as a replacement.
    """

    def __init__(
        self,
        fast_path: str | Path,
        image_metadata: dict,
        matrix_path=None,
        xenium_mpp: float = 0.2125,
        cell_id_to_category=None,
        category_colors=None,
        max_cells: int = 2000,
    ):
        from collections import OrderedDict

        self.fast_path = Path(fast_path)
        self.image_metadata = image_metadata
        self.tile_size = int(image_metadata["tile_size"])
        self.max_cells = int(max_cells)
        self._tile_cache: OrderedDict = OrderedDict()
        self._tile_cache_limit = 256

        # Affine transform (H&E px ↔ Xenium µm)
        self._M = self._Tr = self._Mi = None
        self._mpp = float(xenium_mpp)
        if matrix_path is not None:
            import pandas as pd
            mat = pd.read_csv(matrix_path, index_col=None, header=None).values
            self._M  = mat[:2, :2].astype(float)
            self._Tr = mat[:2, -1].astype(float)
            self._Mi = np.linalg.inv(self._M)

        # Category mappings
        def _to_dict(x):
            if x is None:
                return {}
            return dict(x.to_dict()) if hasattr(x, "to_dict") else dict(x)

        self.cell_id_to_category = _to_dict(cell_id_to_category)
        self.category_colors      = _to_dict(category_colors)

        # Open fast store
        zip_fs   = fsspec.filesystem("zip", fo=str(self.fast_path))
        store    = zip_fs.get_mapper("")
        self._root = zarr.open(store, mode="r")

        root_attrs = dict(self._root.attrs)
        self._grid_spacing_xe = float(root_attrs["grid_spacing_xe"])
        self._grids_group     = self._root["grids"]

        stored_mpp = float(root_attrs.get("xenium_mpp", 0.2125))
        if abs(stored_mpp - self._mpp) > 1e-6:
            import warnings
            warnings.warn(
                f"xenium_mpp mismatch: file has {stored_mpp}, caller passed {self._mpp}"
            )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def metadata(self) -> dict:
        return {
            "max_cells": self.max_cells,
            "has_categories": bool(self.cell_id_to_category),
            "category_colors": self.category_colors,
            "grid_spacing_xe": self._grid_spacing_xe,
        }

    def get_tile_cells(self, level: int, row: int, col: int) -> list[dict]:
        cache_key = (int(level), int(row), int(col))
        if (cached := self._tile_cache.get(cache_key)) is not None:
            self._tile_cache.move_to_end(cache_key)
            return cached

        level, row, col = int(level), int(row), int(col)
        if level not in self.image_metadata["levels"]:
            raise ValueError(f"level {level} out of range")

        x0_he, y0_he, x1_he, y1_he = self._tile_bounds(level, row, col)
        he_corners = np.array(
            [[x0_he, y0_he], [x1_he, y0_he], [x0_he, y1_he], [x1_he, y1_he]]
        )
        xe_corners = self._he_to_xe(he_corners)
        x0_xe, y0_xe = xe_corners.min(axis=0)
        x1_xe, y1_xe = xe_corners.max(axis=0)

        # Collect cells from all overlapping grid tiles (O(1) lookup each)
        all_ids: list[int] = []
        all_centroids: list[np.ndarray] = []
        all_boundaries: list[np.ndarray | None] = []

        for grid_key, tile_group in self._grid_tiles_for_box(x0_xe, y0_xe, x1_xe, y1_xe):
            cell_ids  = np.asarray(tile_group["cell_ids"][:], dtype=np.int64)
            centroids = np.asarray(tile_group["centroids"][:], dtype=float)

            mask = (
                (centroids[:, 0] >= x0_xe) & (centroids[:, 0] < x1_xe) &
                (centroids[:, 1] >= y0_xe) & (centroids[:, 1] < y1_xe)
            )
            if not np.any(mask):
                continue

            all_ids.append(cell_ids[mask])
            all_centroids.append(centroids[mask])

            if "boundaries" in tile_group:
                bids = list(tile_group["boundaries"].keys())
                if bids:
                    bid = bids[0]           # use first available boundary type
                    verts = np.asarray(
                        tile_group["boundaries"][bid]["vertices"][mask, :, :],
                        dtype=float,
                    )
                    all_boundaries.extend(verts)
                else:
                    all_boundaries.extend([None] * int(mask.sum()))
            else:
                all_boundaries.extend([None] * int(mask.sum()))

        if not all_ids:
            return self._remember(cache_key, [])

        cell_ids_np  = np.concatenate(all_ids)
        centroids_np = np.concatenate(all_centroids, axis=0)

        use_dots = len(cell_ids_np) > self.max_cells
        if use_dots:
            seed = int((level * 1_000_000 + row * 1_000 + col) % (2 ** 31))
            rng  = np.random.RandomState(seed)
            keep = np.sort(rng.choice(len(cell_ids_np), self.max_cells, replace=False))
            cell_ids_np  = cell_ids_np[keep]
            centroids_np = centroids_np[keep]
            all_boundaries = [all_boundaries[k] for k in keep]

        he_coords = self._xe_to_he(centroids_np)
        points = []
        for idx, (cid, hc) in enumerate(zip(cell_ids_np, he_coords)):
            cid_int = int(cid)
            category = self.cell_id_to_category.get(cid_int)

            boundary = None
            if not use_dots and all_boundaries[idx] is not None:
                bxy = np.asarray(all_boundaries[idx]).reshape(-1, 2)
                bxy = bxy[np.isfinite(bxy).all(axis=1)]
                if bxy.size:
                    bhe = self._xe_to_he(bxy)
                    boundary = [[float(p[0]), float(p[1])] for p in bhe]

            points.append(
                dict(
                    x=float(hc[0]),
                    y=float(hc[1]),
                    cell_id=cid_int,
                    category=category,
                    boundary=boundary,
                    is_dot=use_dots,
                )
            )

        return self._remember(cache_key, points)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _grid_tiles_for_box(self, x0, y0, x1, y1):
        """Yield (grid_key, tile_group) for every grid cell overlapping the box."""
        spacing = self._grid_spacing_xe
        i0 = int(np.floor(x0 / spacing))
        i1 = int(np.floor(max(x0, x1 - 1e-9) / spacing))
        j0 = int(np.floor(y0 / spacing))
        j1 = int(np.floor(max(y0, y1 - 1e-9) / spacing))
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                key = f"{i},{j}"
                if key in self._grids_group:
                    yield key, self._grids_group[key]

    def _remember(self, cache_key, payload):
        self._tile_cache[cache_key] = payload
        self._tile_cache.move_to_end(cache_key)
        while len(self._tile_cache) > self._tile_cache_limit:
            self._tile_cache.popitem(last=False)
        return payload

    def _he_to_xe(self, coords: np.ndarray) -> np.ndarray:
        if self._M is None:
            return coords
        return (np.dot(coords, self._M.T) + self._Tr) * self._mpp

    def _xe_to_he(self, coords: np.ndarray) -> np.ndarray:
        if self._M is None:
            return coords
        return np.dot(coords / self._mpp - self._Tr, self._Mi.T)

    def _tile_bounds(self, level: int, row: int, col: int) -> tuple[float, float, float, float]:
        lm = self.image_metadata["levels"][level]
        ds = float(lm["downsample"])
        w  = float(lm["width"])
        h  = float(lm["height"])
        x0 = col * self.tile_size * ds
        y0 = row * self.tile_size * ds
        x1 = min(w * ds, x0 + self.tile_size * ds)
        y1 = min(h * ds, y0 + self.tile_size * ds)
        return x0, y0, x1, y1
