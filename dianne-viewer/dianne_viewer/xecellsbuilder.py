"""
build_cells_fast.py
-------------------
Convert a Xenium cells.zarr.zip into a spatially-indexed cells_fast.zarr.zip
that supports O(1) tile lookups without a global KDTree or full boundary loads.

Layout of the output store
---------------------------
cells_fast.zarr.zip
├── .zattrs               metadata (grid_spacing_xe, n_cells, boundary_ids, …)
├── cell_summary          (N, K) float32  – all centroid rows, unchanged
└── grids/
    └── {i},{j}/          one group per non-empty grid cell
        ├── .zattrs       {"count": int}
        ├── cell_ids      (M,)      int64  – original cell IDs for this tile
        ├── centroids     (M, 2)    float32 – Xenium-space [x, y]
        └── boundaries/   one sub-group per boundary type present in the source
            └── {bid}/
                └── vertices  (M, P, 2)  float32 – NaN-padded polygon vertices

Grid spacing
------------
Default is 1000 µm in Xenium space (roughly 1 mm per grid cell), matching
the transcript pyramid's base grid_size.  Tune with `grid_spacing_xe`.

Usage
-----
python build_cells_fast.py \\
    --bundle_path /path/to/xenium_bundle \\
    --output_path /path/to/cells_fast.zarr.zip \\
    [--grid_spacing_xe 1000] \\
    [--boundary_ids 1] \\
    [--chunk_size 512]

Or call `build_cells_fast_zarr(...)` from Python.
"""

from __future__ import annotations

import argparse
import time
from collections import defaultdict
from pathlib import Path
from typing import Sequence

import fsspec
import numpy as np
import zarr

def build_cells_fast_zarr(
    bundle_path: str | Path,
    output_path: str | Path,
    grid_spacing_xe: float = 1000.0,
    boundary_ids: Sequence[int] = (1,),
    chunk_size: int = 512,
    xenium_mpp: float = 0.2125,
    verbose: bool = True,
) -> None:
    """
    Read cells.zarr.zip from *bundle_path* and write cells_fast.zarr.zip to
    *output_path* with per-grid-cell spatial indexing.

    Parameters
    ----------
    bundle_path:
        Directory that contains cells.zarr.zip (the standard Xenium output
        bundle folder, *not* the zip file itself).
    output_path:
        Destination path for the new cells_fast.zarr.zip file.
    grid_spacing_xe:
        Side length (in Xenium µm) of each spatial grid cell.  1000 µm (1 mm)
        works well for most tissue sections.
    boundary_ids:
        Which boundary types to include.  Xenium typically stores nucleus (0)
        and cell (1) boundaries.  Pass an empty sequence to skip boundaries.
    chunk_size:
        Zarr chunk length along the cell axis.  512 is a good default; reduce
        for very small grid cells, increase for coarse grids.
    verbose:
        Print progress messages.
    """
    bundle_path = Path(bundle_path)
    output_path = Path(output_path)
    boundary_ids = list(boundary_ids)

    t0 = time.perf_counter()

    # ------------------------------------------------------------------
    # 1. Open source store
    # ------------------------------------------------------------------
    if verbose:
        print("Opening source cells.zarr.zip …")

    src_fs = fsspec.filesystem("zip", fo=str(bundle_path / "cells.zarr.zip"))
    src_store = src_fs.get_mapper("")
    src = zarr.open(src_store, mode="r")

    cell_summary = np.asarray(src["cell_summary"][:], dtype=np.float32)
    n_cells = cell_summary.shape[0]
    centroids_xe = cell_summary[:, :2]          # (N, 2) – x, y in Xenium µm

    if verbose:
        print(f"  {n_cells:,} cells  |  centroid range x=[{centroids_xe[:,0].min():.0f}, "
              f"{centroids_xe[:,0].max():.0f}]  y=[{centroids_xe[:,1].min():.0f}, "
              f"{centroids_xe[:,1].max():.0f}]")

    # Detect which boundary arrays are present and what shape they carry
    has_polygon_vertices = "polygon_vertices" in src
    polygon_sets = src["polygon_sets"] if "polygon_sets" in src else None

    def _src_boundary_array(bid: int):
        """Return the source boundary array for boundary id *bid*, or None."""
        if has_polygon_vertices:
            try:
                return src["polygon_vertices"][bid]          # (N, P)  (x0,y0,x1,y1,…)
            except (IndexError, KeyError):
                return None
        if polygon_sets is not None:
            key = str(bid) if str(bid) in polygon_sets else bid
            if key in polygon_sets:
                return polygon_sets[key]["vertices"]         # (N, P)
        return None

    # Determine max polygon length per boundary id (needed for NaN-padding)
    bid_arrays: dict[int, zarr.Array] = {}
    bid_n_points: dict[int, int] = {}
    for bid in boundary_ids:
        arr = _src_boundary_array(bid)
        if arr is None:
            if verbose:
                print(f"  boundary_id={bid} not found, skipping")
            continue
        bid_arrays[bid] = arr
        raw_cols = arr.shape[-1]       # flat: x0,y0,x1,y1,…  ⟹  P = cols//2
        bid_n_points[bid] = raw_cols // 2
        if verbose:
            print(f"  boundary_id={bid}  shape={arr.shape}  max_points={bid_n_points[bid]}")

    # ------------------------------------------------------------------
    # 2. Assign each cell to its grid cell
    # ------------------------------------------------------------------
    if verbose:
        print("Assigning cells to grid …")

    gi = np.floor(centroids_xe[:, 0] / grid_spacing_xe).astype(np.int64)
    gj = np.floor(centroids_xe[:, 1] / grid_spacing_xe).astype(np.int64)

    # Map (i, j) → list of original cell indices (0-based)
    grid_buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for cell_idx in range(n_cells):
        grid_buckets[(int(gi[cell_idx]), int(gj[cell_idx]))].append(cell_idx)

    n_grid_cells = len(grid_buckets)
    if verbose:
        sizes = [len(v) for v in grid_buckets.values()]
        print(f"  {n_grid_cells} non-empty grid cells  |  "
              f"cells/tile: min={min(sizes)} mean={np.mean(sizes):.0f} max={max(sizes)}")

    # ------------------------------------------------------------------
    # 3. Write output store
    # ------------------------------------------------------------------
    if verbose:
        print(f"Writing {output_path} …")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    dst_store = zarr.ZipStore(str(output_path), mode="w")
    dst = zarr.open_group(dst_store, mode="w")

    # Root metadata
    dst.attrs.update(
        dict(
            grid_spacing_xe=grid_spacing_xe,
            xenium_mpp=xenium_mpp,
            n_cells=int(n_cells),
            boundary_ids=[bid for bid in bid_arrays],
            cell_summary_shape=list(cell_summary.shape),
            source_has_polygon_vertices=has_polygon_vertices,
        )
    )

    # Copy cell_summary verbatim (small; useful for compatibility)
    dst.array(
        "cell_summary",
        cell_summary,
        chunks=(min(chunk_size * 4, n_cells), cell_summary.shape[1]),
        dtype=np.float32,
    )

    grids_group = dst.require_group("grids")

    # ------------------------------------------------------------------
    # 4. Fill grid groups
    # ------------------------------------------------------------------
    # Pre-read boundary rows in large batches to avoid per-cell zarr reads.
    # We sort the cell indices per grid bucket and issue contiguous slices
    # wherever possible; scattered indices fall back to fancy indexing.

    completed = 0
    for (gi_val, gj_val), cell_indices in sorted(grid_buckets.items()):
        cell_indices_arr = np.array(cell_indices, dtype=np.int64)
        m = len(cell_indices_arr)

        grid_key = f"{gi_val},{gj_val}"
        tile_group = grids_group.require_group(grid_key)
        tile_group.attrs["count"] = m

        # Centroids (Xenium µm)
        tile_group.array(
            "cell_ids",
            cell_indices_arr,
            chunks=(min(chunk_size, m),),
            dtype=np.int64,
        )
        tile_group.array(
            "centroids",
            centroids_xe[cell_indices_arr],
            chunks=(min(chunk_size, m), 2),
            dtype=np.float32,
        )

        # Boundaries
        if bid_arrays:
            boundaries_group = tile_group.require_group("boundaries")
            for bid, src_arr in bid_arrays.items():
                n_pts = bid_n_points[bid]
                # Fancy-index the source array for these cell ids.
                # For large tiles this is a single vectorised read.
                raw = np.asarray(src_arr[cell_indices_arr, :], dtype=np.float32)
                # raw shape: (M, P*2)  →  (M, P, 2)
                verts = raw.reshape(m, n_pts, 2)
                # NaN-pad is already in source (Xenium convention); preserve it.
                bid_group = boundaries_group.require_group(str(bid))
                bid_group.array(
                    "vertices",
                    verts,
                    chunks=(min(chunk_size, m), n_pts, 2),
                    dtype=np.float32,
                )

        completed += 1
        if verbose and completed % max(1, n_grid_cells // 20) == 0:
            pct = 100 * completed / n_grid_cells
            elapsed = time.perf_counter() - t0
            print(f"  {pct:5.1f}%  ({completed}/{n_grid_cells} tiles)  "
                  f"elapsed={elapsed:.1f}s")

    dst_store.close()

    elapsed = time.perf_counter() - t0
    if verbose:
        size_mb = output_path.stat().st_size / 1e6
        print(f"Done in {elapsed:.1f}s  →  {output_path}  ({size_mb:.1f} MB)")

def _parse_args():
    p = argparse.ArgumentParser(
        description="Convert cells.zarr.zip to spatially-indexed cells_fast.zarr.zip"
    )
    p.add_argument("--bundle_path",      required=True,  help="Xenium bundle directory")
    p.add_argument("--output_path",      required=True,  help="Output .zarr.zip path")
    p.add_argument("--grid_spacing_xe",  type=float, default=110.0,
                   help="Grid tile size in Xenium µm (default 110)")
    p.add_argument("--boundary_ids",     type=int, nargs="+", default=[1],
                   help="Boundary IDs to include (default: 1)")
    p.add_argument("--chunk_size",       type=int, default=64,
                   help="Zarr chunk length (default 64)")
    return p.parse_args()

if __name__ == "__main__":
    args = _parse_args()
    build_cells_fast_zarr(
        bundle_path=args.bundle_path,
        output_path=args.output_path,
        grid_spacing_xe=args.grid_spacing_xe,
        boundary_ids=args.boundary_ids,
        chunk_size=args.chunk_size,
        verbose=True,
    )
