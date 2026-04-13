"""
build_cells_fast_from_parquet.py
---------------------------------
Convert a parquet file with columns [cell_id, vertex_x, vertex_y] (pixel coords)
into a spatially-indexed cells_fast.zarr.zip with the same layout as the one
produced by build_cells_fast.py (the Xenium cells.zarr.zip converter).

Input parquet schema
---------------------
  cell_id   : str  – unique cell identifier (e.g. "C00000003")
  vertex_x  : float – polygon vertex x in pixels
  vertex_y  : float – polygon vertex y in pixels

  Multiple rows per cell_id define the polygon.  Centroids are computed as the
  mean of all vertices for that cell.

Output files
------------
<output_path>                 – cells_fast.zarr.zip (spatial index)
<output_path>.cell_id_map.tsv – mapping of int index → original string cell_id

cells_fast.zarr.zip layout
---------------------------
cells_fast.zarr.zip
├── .zattrs               metadata (grid_spacing_xe, n_cells, boundary_ids, …)
├── cell_summary          (N, 2) float32  – [x_centroid, y_centroid] in µm
└── grids/
    └── {i},{j}/          one group per non-empty grid cell
        ├── .zattrs       {"count": int}
        ├── cell_ids      (M,)      int64  – 0-based integer indices into cell_id_map
        ├── centroids     (M, 2)    float32 – µm-space [x, y]
        └── boundaries/
            └── 0/
                └── vertices  (M, P, 2)  float32 – NaN-padded polygon vertices in µm

cell_id_map.tsv layout (no header, tab-separated)
--------------------------------------------------
  0 \t C00000001
  1 \t C00000002
  …
  Row number = integer index stored in cell_ids arrays.

Coordinates
-----------
All spatial values written to the store are in Xenium µm:
    µm = pixels × mpp

Grid spacing is specified in µm (default 1000 µm = 1 mm).

Usage
-----
python build_cells_fast_from_parquet.py \\
    --input_parquet /path/to/cells.parquet \\
    --output_path   /path/to/cells_fast.zarr.zip

Produces two files:
    cells_fast.zarr.zip           – spatial index (cell_ids are 0-based ints)
    cells_fast.zarr.zip.cell_id_map.tsv  – <int_index>\\t<original_string_cell_id>
"""

from __future__ import annotations

import argparse
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import zarr


def build_cells_fast_from_parquet(
    input_parquet: str | Path,
    output_path: str | Path,
    mpp: float = 0.2125,
    grid_spacing_xe: float = 1000.0,
    chunk_size: int = 512,
    boundary_id: int = 0,
    verbose: bool = True,
) -> Path:
    """
    Read a parquet file and write a spatially-indexed cells_fast.zarr.zip,
    plus a TSV mapping file that resolves integer cell indices back to the
    original string cell IDs.

    Parameters
    ----------
    input_parquet:
        Path to parquet file with columns [cell_id, vertex_x, vertex_y].
        cell_id is a string (e.g. "C00000003").
        vertex_x / vertex_y are in pixels.  Multiple rows per cell define
        the polygon; centroids are derived as the per-cell mean.
    output_path:
        Destination path for cells_fast.zarr.zip.  The mapping file is
        written alongside it as <output_path>.cell_id_map.tsv.
    mpp:
        Microns per pixel.  All coordinates are multiplied by this before
        writing.  Use 0.2125 for standard 10x Xenium output.
    grid_spacing_xe:
        Spatial grid tile size in µm.  1000 µm (1 mm) is a good default.
    chunk_size:
        Zarr chunk length along the cell axis.
    boundary_id:
        Integer key used for the boundary group inside the output store
        (written to boundaries/{boundary_id}/vertices).  Use 0 for nucleus,
        1 for cell body — mirror whatever convention your downstream reader
        expects.
    verbose:
        Print progress messages.

    Returns
    -------
    Path
        Path to the mapping TSV file.
    """
    input_parquet = Path(input_parquet)
    output_path = Path(output_path)
    mapping_path = Path(str(output_path) + ".cell_id_map.tsv")

    t0 = time.perf_counter()

    # ------------------------------------------------------------------
    # 1. Load parquet
    # ------------------------------------------------------------------
    if verbose:
        print(f"Reading {input_parquet} …")

    df = pd.read_parquet(input_parquet, columns=["cell_id", "vertex_x", "vertex_y"])
    df["cell_id"] = df["cell_id"].astype(str)   # ensure string even if stored as category

    if verbose:
        print(f"  {len(df):,} rows  |  {df['cell_id'].nunique():,} unique cells")

    # Convert pixels → µm
    df["x_um"] = df["vertex_x"].astype(np.float32) * mpp
    df["y_um"] = df["vertex_y"].astype(np.float32) * mpp

    # ------------------------------------------------------------------
    # 2. Compute centroids (mean of all vertices per cell)
    #    Assign a stable 0-based integer index to each unique string cell_id,
    #    sorted lexicographically so the mapping is deterministic.
    # ------------------------------------------------------------------
    if verbose:
        print("Computing centroids …")

    centroids_df = (
        df.groupby("cell_id", sort=True)[["x_um", "y_um"]]
        .mean()
        .reset_index()
    )
    # centroids_df is already sorted by cell_id (sort=True above)
    # Row position == integer index written into the zarr store
    n_cells = len(centroids_df)

    # String cell IDs in index order — this is the authoritative mapping
    cell_id_strings: list[str] = centroids_df["cell_id"].tolist()   # index → str
    cell_id_to_idx: dict[str, int] = {s: i for i, s in enumerate(cell_id_strings)}

    centroids_xe = centroids_df[["x_um", "y_um"]].to_numpy(dtype=np.float32)
    # Integer indices array — used in cell_ids zarr arrays
    int_indices_all = np.arange(n_cells, dtype=np.int64)

    if verbose:
        print(f"  {n_cells:,} cells  |  "
              f"x=[{centroids_xe[:,0].min():.1f}, {centroids_xe[:,0].max():.1f}] µm  "
              f"y=[{centroids_xe[:,1].min():.1f}, {centroids_xe[:,1].max():.1f}] µm")
        print(f"  example cell_ids: {cell_id_strings[:3]} … → int indices 0, 1, 2 …")

    # ------------------------------------------------------------------
    # 3. Build per-cell polygon vertex arrays (NaN-padded to uniform length)
    # ------------------------------------------------------------------
    if verbose:
        print("Building polygon vertex arrays …")

    # Group vertices by cell_id, preserving insertion order within each cell
    # so the polygon winding is kept intact.
    grouped = df.groupby("cell_id", sort=True)

    # Find max polygon length for NaN-padding
    poly_lengths = grouped.size()
    max_pts = int(poly_lengths.max())

    if verbose:
        print(f"  max polygon points: {max_pts}  "
              f"(mean={poly_lengths.mean():.1f}  min={poly_lengths.min()})")

    # Allocate NaN-padded array  (N, P, 2)
    vertices_all = np.full((n_cells, max_pts, 2), np.nan, dtype=np.float32)

    for cell_id, grp in grouped:
        idx = cell_id_to_idx[str(cell_id)]
        pts = grp[["x_um", "y_um"]].to_numpy(dtype=np.float32)
        n_pts = len(pts)
        vertices_all[idx, :n_pts, :] = pts
        # Remaining slots stay NaN (Xenium convention)

    # ------------------------------------------------------------------
    # 4. Assign cells to grid tiles
    # ------------------------------------------------------------------
    if verbose:
        print("Assigning cells to grid …")

    gi = np.floor(centroids_xe[:, 0] / grid_spacing_xe).astype(np.int64)
    gj = np.floor(centroids_xe[:, 1] / grid_spacing_xe).astype(np.int64)

    grid_buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for cell_row in range(n_cells):
        grid_buckets[(int(gi[cell_row]), int(gj[cell_row]))].append(cell_row)

    n_grid_cells = len(grid_buckets)
    if verbose:
        sizes = [len(v) for v in grid_buckets.values()]
        print(f"  {n_grid_cells} non-empty grid tiles  |  "
              f"cells/tile: min={min(sizes)}  mean={np.mean(sizes):.0f}  max={max(sizes)}")

    # ------------------------------------------------------------------
    # 5. Write mapping TSV  (int_index \t string_cell_id, no header)
    # ------------------------------------------------------------------
    if verbose:
        print(f"Writing cell ID mapping → {mapping_path} …")

    with mapping_path.open("w", encoding="utf-8") as fh:
        for idx, sid in enumerate(cell_id_strings):
            fh.write(f"{idx}\t{sid}\n")

    # ------------------------------------------------------------------
    # 6. Write output zarr store
    # ------------------------------------------------------------------
    if verbose:
        print(f"Writing {output_path} …")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    dst_store = zarr.ZipStore(str(output_path), mode="w")
    dst = zarr.open_group(dst_store, mode="w")

    # Root metadata — mirrors the original script's .zattrs
    dst.attrs.update(
        dict(
            grid_spacing_xe=grid_spacing_xe,
            xenium_mpp=mpp,
            n_cells=int(n_cells),
            boundary_ids=[boundary_id],
            cell_summary_shape=[n_cells, 2],
            source="parquet",
            input_parquet=str(input_parquet),
            cell_id_type="string",
            cell_id_map_file=mapping_path.name,  # basename only; sits next to the zip
        )
    )

    # cell_summary: (N, 2) — [x_centroid_um, y_centroid_um]
    # The original script writes all cell_summary columns verbatim; here we
    # write [x, y] centroids in µm to stay compatible with readers that only
    # need the first two columns.
    dst.array(
        "cell_summary",
        centroids_xe,
        chunks=(min(chunk_size * 4, n_cells), 2),
        dtype=np.float32,
    )

    grids_group = dst.require_group("grids")

    # ------------------------------------------------------------------
    # 6. Write per-tile groups
    # ------------------------------------------------------------------
    completed = 0
    report_every = max(1, n_grid_cells // 20)

    for (gi_val, gj_val), cell_rows in sorted(grid_buckets.items()):
        cell_rows_arr = np.array(cell_rows, dtype=np.int64)
        m = len(cell_rows_arr)

        grid_key = f"{gi_val},{gj_val}"
        tile_group = grids_group.require_group(grid_key)
        tile_group.attrs["count"] = m

        # Integer indices (positions in cell_id_map.tsv / cell_summary)
        tile_group.array(
            "cell_ids",
            int_indices_all[cell_rows_arr],
            chunks=(min(chunk_size, m),),
            dtype=np.int64,
        )

        # Centroids in µm
        tile_group.array(
            "centroids",
            centroids_xe[cell_rows_arr],
            chunks=(min(chunk_size, m), 2),
            dtype=np.float32,
        )

        # Boundary vertices: (M, P, 2) NaN-padded, in µm
        boundaries_group = tile_group.require_group("boundaries")
        bid_group = boundaries_group.require_group(str(boundary_id))
        bid_group.array(
            "vertices",
            vertices_all[cell_rows_arr],          # fancy-index: already in memory
            chunks=(min(chunk_size, m), max_pts, 2),
            dtype=np.float32,
        )

        completed += 1
        if verbose and completed % report_every == 0:
            pct = 100 * completed / n_grid_cells
            elapsed = time.perf_counter() - t0
            print(f"  {pct:5.1f}%  ({completed}/{n_grid_cells} tiles)  "
                  f"elapsed={elapsed:.1f}s")

    dst_store.close()

    elapsed = time.perf_counter() - t0
    if verbose:
        size_mb = output_path.stat().st_size / 1e6
        map_kb = mapping_path.stat().st_size / 1e3
        print(f"Done in {elapsed:.1f}s  →  {output_path}  ({size_mb:.1f} MB)")
        print(f"Cell ID mapping  →  {mapping_path}  ({map_kb:.1f} KB)  "
              f"[{n_cells:,} entries, format: <int_index>\\t<string_cell_id>]")

    return mapping_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Convert a parquet [cell_id, vertex_x, vertex_y] file to "
                    "spatially-indexed cells_fast.zarr.zip"
    )
    p.add_argument(
        "--input_parquet", required=True,
        help="Path to input parquet file (columns: cell_id, vertex_x, vertex_y)"
    )
    p.add_argument(
        "--output_path", required=True,
        help="Output path for cells_fast.zarr.zip"
    )
    p.add_argument(
        "--mpp", type=float, default=0.3250,
        help="Microns per pixel (default: 0.3250, standard 10x Xenium)"
    )
    p.add_argument(
        "--grid_spacing_xe", type=float, default=110.0,
        help="Grid tile size in µm (default: 110.0)"
    )
    p.add_argument(
        "--chunk_size", type=int, default=64,
        help="Zarr chunk length along cell axis (default: 64)"
    )
    p.add_argument(
        "--boundary_id", type=int, default=0,
        help="Integer key for the boundary group in the output store (default: 0)"
    )
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    build_cells_fast_from_parquet(
        input_parquet=args.input_parquet,
        output_path=args.output_path,
        mpp=args.mpp,
        grid_spacing_xe=args.grid_spacing_xe,
        chunk_size=args.chunk_size,
        boundary_id=args.boundary_id,
        verbose=True,
    )


