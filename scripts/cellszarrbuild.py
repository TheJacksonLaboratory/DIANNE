import sys
sys.path.append('../viewer/')
from parquetcellsbuilder import parquet_to_cells_zarr

if __name__ == "__main__":

    parquet_to_cells_zarr(
        parquet_path  = "/projects/varn-lab/USERS/domans/PvR_TME/results-miq-all-v6/CD25018/cell_boundaries.parquet",
        output_path   = "/projects/varn-lab/USERS/domans/PvR_TME/results-miq-all-v6/CD25018/cells.zarr.zip",
        boundary_set  = 1,
        scalefactor   = 0.3250,  # scaling applied to vertex coordinates (match Xenium mpp), or 0.3250 for Cell DIVE
    )
