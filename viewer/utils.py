# """Author: Sergii Domanskyi
# Organization: The Jackson Laboratory for Genomic Medicine
# Date: 2025-01-06
# """

# import zarr
# import fsspec
# import numpy as np
# import pandas as pd
# from scipy.spatial import KDTree
# from scipy.sparse import csr_matrix

# def square_query(coords, center, half_side):

#     """
#     Perform a square query using KDTree and return points within the square.

#     Parameters:
#     - coords: list or array of (x, y) coordinates
#     - center: tuple (x, y) representing the center of the square
#     - half_side: half the length of the square's side

#     Returns:
#     - idx: points within the square
#     """
#     # Build KDTree and perform ball query
#     tree = KDTree(coords)

#     # Compute radius for ball query (half-diagonal of square)
#     radius = half_side * np.sqrt(2)
#     candidate_indices = np.array(tree.query_ball_point(center, r=radius))

#     if len(candidate_indices) == 0:
#         return np.array([]), np.array([])

#     candidates = coords[candidate_indices]

#     # Filter candidates to retain only those within the square
#     x_min, x_max = center[0] - half_side, center[0] + half_side
#     y_min, y_max = center[1] - half_side, center[1] + half_side
#     mask = (candidates[:, 0] >= x_min) & (candidates[:, 0] <= x_max) & \
#            (candidates[:, 1] >= y_min) & (candidates[:, 1] <= y_max)
#     found_idx = candidate_indices[mask]
#     found_coords = candidates[mask]

#     return found_idx, found_coords

# # def extract_grid_locs(query_point, patch_size, grid_spacing):

# #     """
# #     Extract grid locations based on a query point, patch size, and grid spacing.

# #     Parameters:
# #     - query_point: np.ndarray, the point around which to extract grid locations
# #     - patch_size: float, size of the patch to consider
# #     - grid_spacing: float, spacing between grid points

# #     Returns:
# #     - grid_locs: list of str, formatted grid locations
# #     """

# #     upper_loc = ((query_point + (patch_size / 2.)) // grid_spacing).astype(int)
# #     lower_loc = ((query_point - (patch_size / 2.)) // grid_spacing).astype(int)
# #     i_range = np.arange(lower_loc[0], upper_loc[0] + 1)
# #     j_range = np.arange(lower_loc[1], upper_loc[1] + 1)
# #     ii, jj = np.meshgrid(i_range, j_range)
# #     combinations = np.column_stack((ii.ravel(), jj.ravel()))
# #     grid_locs = [f'{i},{j}' for i, j in combinations]

# #     return grid_locs

# # def extract_data_from_grid_locs(grid, grid_locs, sel_genes=None, gene_to_index_dict=None, number_spatial_dims=2):

# #     """
# #     Extract data from grid locations in a Xenium Zarr store.

# #     Parameters:
# #     - grid: dict, the grid data structure
# #     - grid_locs: list of str, grid locations to extract data from
# #     - sel_genes: list of str, selected genes to filter by (optional)
# #     - gene_to_index_dict: dict, mapping of gene names to indices (optional)
# #     - number_spatial_dims: int, number of spatial dimensions to consider, 2 or 3 (default is 2)

# #     Returns:
# #     - coords: np.ndarray, coordinates of the selected grid locations
# #     - genes: np.ndarray, gene identities corresponding to the coordinates
# #     """

# #     coords = []
# #     genes = []
# #     for loc in grid_locs:
# #         if loc in grid:
# #             if (sel_genes is not None) and (gene_to_index_dict is not None):
# #                 gene_indices = [gene_to_index_dict[gene] for gene in sel_genes if gene in gene_to_index_dict]
# #                 all_gene_identities = grid[loc]['gene_identity'][:][:, 0]
# #                 gene_indices = np.where(np.isin(all_gene_identities, gene_indices))[0]
# #                 coords.append(grid[loc]['location'][gene_indices, :][:, :number_spatial_dims])
# #                 genes.append(grid[loc]['gene_identity'][gene_indices, 0])
# #             else:
# #                 coords.append(grid[loc]['location'][:][:, :number_spatial_dims])
# #                 genes.append(grid[loc]['gene_identity'][:][:, 0])
# #     return np.vstack(coords), np.hstack(genes)

# # def extract_transcripts_from_grid_locs(bundle_path: str, query_point: np.ndarray, patch_size: float = 448., sel_genes: list = None, grid='0'):

# #     """
# #     Extract transcripts from grid locations in a Xenium Zarr store from 0 grid (non-downsampled grid).

# #     Parameters:
# #     - bundle_path: str, path to Xenium bundle containing the Zarr files
# #     - query_point: np.ndarray, the point around which to extract transcripts
# #     - patch_size: float, size of the patch to consider (default is 448.0)
# #     - sel_genes: list, selected genes to filter by (default is None, which means all genes are considered)
    
# #     Returns:
# #     - coords: np.ndarray, coordinates of the extracted transcripts
# #     - gene_names: np.ndarray, names of the genes corresponding to the extracted transcripts
# #     """

# #     zip_fs = fsspec.filesystem('zip', fo=bundle_path + '/transcripts.zarr.zip')
# #     store = zip_fs.get_mapper("")
# #     root = zarr.open(store, mode='r')

# #     gene_to_index_dict = root.attrs['gene_index_map']
# #     gene_to_index_dict_reverse = {v: k for k, v in gene_to_index_dict.items()}
# #     grid_0_spacing = root['grids'].attrs['grid_size'][0]

# #     grid_locs = extract_grid_locs(query_point, patch_size, grid_0_spacing)

# #     coords, gene_idx = extract_data_from_grid_locs(root['grids'][grid], grid_locs,
# #                                                     sel_genes=sel_genes,
# #                                                     gene_to_index_dict=gene_to_index_dict)
    
# #     # Refine found transcripts with square ball query
# #     square_idx, coords = square_query(coords, query_point, half_side=patch_size / 2.)
# #     gene_names = np.array([gene_to_index_dict_reverse[idx] for idx in gene_idx[square_idx]])

# #     return coords, gene_names
 
# def fetch_xenium_zarr_cell_coords(bundle_path: str, query_point: tuple, half_side: float=100.0,
#                                 return_boundaries: bool = False, boundary_id: int = 1) -> tuple:

#     """
#     Fetch cell coordinates from a Xenium Zarr store within a square region.

#     Parameters:
#     - bundle_path: str, path to Xenium bundle containing the Zarr files
#     - query_point: tuple (x, y) representing the center of the square
#     - half_side: float, half the length of the square's side
#     - return_boundaries: bool, whether to return cell boundaries (default is False)
#     - boundary_id: int, 0-nucleus or 1-cell (default is 1 for cell boundaries)

#     Returns:
#     - idx: indices of cells within the square region
#     - coords: coordinates of cells within the square region
#     - boundaries: np.ndarray, boundaries of the cells (if return_boundaries is True)
#     """
    
#     zip_fs = fsspec.filesystem('zip', fo=bundle_path + '/cells.zarr.zip')
#     store = zip_fs.get_mapper("")
#     root = zarr.open(store, mode='r')

#     all_coords = root['cell_summary'][:, :2]

#     idx, coords = square_query(all_coords, query_point, half_side=half_side)

#     if return_boundaries:
#         try:
#             boundaries = root['polygon_vertices'][:, idx, :][boundary_id]
#         except:
#             boundaries = root['polygon_sets'][boundary_id]['vertices'][idx, :]
#         boundaries = boundaries.reshape(boundaries.shape[0], int(boundaries.shape[1]/2), 2)
#         return idx, coords, boundaries
    
#     return idx, coords

# def fetch_cell_by_gene_matrix(bundle_path: str, sel_genes: np.ndarray, cell_idx: np.ndarray, verbose: bool = False) -> csr_matrix:

#     """
#     Fetch the cell-by-gene matrix from a Xenium Zarr store.

#     Parameters:
#     - bundle_path: str, path to Xenium bundle containing the Zarr files
#     - sel_genes: np.ndarray or list, names of selected genes
#     - cell_idx: np.ndarray, indices of selected cells
#     - verbose: bool, whether to print additional information (default is False)
    
#     Returns:
#     - csr_matrix: sparse matrix of cells by genes
#     """
    
#     zip_fs = fsspec.filesystem('zip', fo=bundle_path + '/cell_feature_matrix.zarr.zip')
#     store = zip_fs.get_mapper("")
#     root = zarr.open(store, mode='r')
    
#     cf = root["cell_features"]

#     if sel_genes is None:
#         gene_by_cell = csr_matrix((cf["data"], cf["indices"], cf["indptr"]))[:, cell_idx]
#     else:
#         sel_gene_idx = np.where(np.isin(cf.attrs['feature_keys'], sel_genes))[0]
#         gene_by_cell = csr_matrix((cf["data"], cf["indices"], cf["indptr"]))[:, cell_idx][sel_gene_idx, :]

#     if verbose:
#         print("Shape of gene by cell matrix:", gene_by_cell.shape)
    
#     return gene_by_cell

# if __name__ == "__main__":

#     bundle_path = '/projects/activities/kappsen-tmc/xenium/pancreas/0015907_JDC-WP-008/regions/XE240039/'

#     query_point = np.array([1000., 1500.])
#     patch_size = 448.
#     sel_genes = ['GCG', 'INS', 'PPY', 'SST', 'MUC5B', 'COL1A2']

#     coords, gene_names = extract_transcripts_from_grid_locs(bundle_path, query_point, patch_size, sel_genes)
#     print("Number of extracted transcripts:", coords.shape[0])
