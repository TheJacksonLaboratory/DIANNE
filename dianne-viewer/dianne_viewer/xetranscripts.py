from pathlib import Path

import fsspec
import numpy as np
import zarr


class XeniumTranscripts:
    """
    Read transcript coordinates from a Xenium transcripts.zarr.zip pyramid.

    Transcript grids are addressed by integer index where grid 0 is the finest
    resolution. Requests are served in image-space tile regions so the frontend
    can cache them similarly to image tiles.

    Optional affine transform between H&E pixel space and Xenium transcript
    coordinate space (in µm):
        Forward (H&E px → Xenium µm):  xe = (he @ M.T + Tr) * xenium_mpp
        Inverse (Xenium µm → H&E px):  he = (xe / xenium_mpp - Tr) @ inv(M).T
    """

    def __init__(self, bundle_path, image_metadata, matrix_path=None, xenium_mpp=0.2125, fs=None,
                 _zip_content=None):
        self.bundle_path = Path(bundle_path) if fs is None else bundle_path
        self._fs = fs
        self.image_metadata = image_metadata
        self.tile_size = int(image_metadata['tile_size'])

        # optional affine transform (H&E px ↔ Xenium µm)
        self._M  = None
        self._Tr = None
        self._Mi = None
        self._mpp = float(xenium_mpp)
        if matrix_path is not None:
            import pandas as pd
            mat = pd.read_csv(matrix_path, index_col=None, header=None).values
            self._M  = mat[:2, :2].astype(float)
            self._Tr = mat[:2, -1].astype(float)
            self._Mi = np.linalg.inv(self._M)

        self._root = None
        self.gene_to_index = {}
        self.index_to_gene = {}
        self.gene_names = []
        self.grid_keys = []
        self.grids = {}

        _bp = str(self.bundle_path).rstrip('/')
        transcript_path = _bp + '/transcripts.zarr.zip'
        # Check if file exists
        if _zip_content is not None:
            _exists = True
        else:
            _exists = (self._fs.exists(transcript_path) if self._fs is not None
                       else Path(transcript_path).exists())
        if _exists:
            try:
                # Handle metadata dict (new lazy approach)
                if isinstance(_zip_content, dict) and 'type' in _zip_content:
                    if _zip_content['type'] == 's3':
                        # S3 presigned URL: pass presigned URL to fsspec (auto-detects HTTP)
                        zip_fs = fsspec.filesystem('zip', fo=_zip_content['url'])
                    elif _zip_content['type'] == 'fsspec':
                        # fsspec file: open via the filesystem object and wrap
                        import io
                        _remote_fo = _zip_content['fs'].open(_zip_content['path'], 'rb')
                        zip_fs = fsspec.filesystem('zip', fo=_remote_fo)
                    elif _zip_content['type'] == 'local':
                        # Local file: lazy access via local path string
                        zip_fs = fsspec.filesystem('zip', fo=_zip_content['path'])
                    else:
                        # Fallback: treat as local path string
                        zip_fs = fsspec.filesystem('zip', fo=_zip_content['path'])
                # Legacy: handle pre-fetched BytesIO or Path objects
                elif _zip_content is not None:
                    import io
                    _fo = _zip_content if hasattr(_zip_content, 'read') else open(_zip_content, 'rb')
                    zip_fs = fsspec.filesystem('zip', fo=_fo)
                elif self._fs is not None:
                    import io
                    import warnings
                    with self._fs.open(transcript_path, 'rb') as _remote:
                        _buf = io.BytesIO(_remote.read())
                    zip_fs = fsspec.filesystem('zip', fo=_buf)
                else:
                    zip_fs = fsspec.filesystem('zip', fo=transcript_path)
                store = zip_fs.get_mapper('')
                self._root = zarr.open(store, mode='r')

                raw_gene_map = dict(self._root.attrs['gene_index_map'])
                self.gene_to_index = {str(gene): int(idx) for gene, idx in raw_gene_map.items()}
                self.index_to_gene = {idx: gene for gene, idx in self.gene_to_index.items()}
                self.gene_names = [
                    gene for gene, _ in sorted(self.gene_to_index.items(), key=lambda item: item[1])
                ]

                grids_group = self._root['grids']
                self.grid_keys = sorted(grids_group.keys(), key=lambda key: int(key))
                raw_grid_sizes = list(grids_group.attrs.get('grid_size', []))
                base_spacing = float(raw_grid_sizes[0]) if raw_grid_sizes else 1.0

                for idx, key in enumerate(self.grid_keys):
                    spacing = float(raw_grid_sizes[idx]) if idx < len(raw_grid_sizes) else base_spacing * (2 ** idx)
                    self.grids[idx] = {
                        'key': key,
                        'spacing': spacing,
                        'downsample': spacing / base_spacing,
                    }
            except Exception as _e:
                import warnings
                warnings.warn(f'[DIANNE] Failed to open transcripts.zarr.zip at {transcript_path}: {_e}')
                self._root = None
                self.gene_to_index = {}
                self.index_to_gene = {}
                self.gene_names = []
                self.grid_keys = []
                self.grids = {}
                self.gene_to_index = {}
                self.index_to_gene = {}
                self.gene_names = []
                self.grid_keys = []
                self.grids = {}

    @property
    def metadata(self):
        return {
            'genes': self.gene_names,
            'n_grids': len(self.grids),
            'grids': {
                idx: {
                    'key': meta['key'],
                    'spacing': meta['spacing'],
                    'downsample': meta['downsample'],
                }
                for idx, meta in self.grids.items()
            },
        }

    def get_tile_transcripts(self, grid, level, row, col, genes):
        if not genes or self._root is None:
            return []

        grid = int(grid)
        level = int(level)
        row = int(row)
        col = int(col)

        if grid not in self.grids:
            raise ValueError(f'grid {grid} out of range 0-{len(self.grids) - 1}')
        if level not in self.image_metadata['levels']:
            raise ValueError(f'level {level} out of range')

        gene_indices = np.array(
            [self.gene_to_index[gene] for gene in genes if gene in self.gene_to_index],
            dtype=np.int64,
        )
        if gene_indices.size == 0:
            return []

        # Tile region in H&E level-0 pixel space
        x0_he, y0_he, x1_he, y1_he = self._tile_bounds(level, row, col)

        # Transform the four HE corners → Xenium space to get query bounding box
        he_corners = np.array([
            [x0_he, y0_he], [x1_he, y0_he],
            [x0_he, y1_he], [x1_he, y1_he],
        ])
        xe_corners = self._he_to_xe(he_corners)
        x0_xe, y0_xe = xe_corners.min(axis=0)
        x1_xe, y1_xe = xe_corners.max(axis=0)

        grid_meta = self.grids[grid]
        grid_group = self._root['grids'][grid_meta['key']]

        points = []
        for loc in self._grid_locs_for_box(x0_xe, y0_xe, x1_xe, y1_xe, grid_meta['spacing']):
            if loc not in grid_group:
                continue

            cell = grid_group[loc]
            coords = np.asarray(cell['location'][:])
            if coords.size == 0:
                continue
            coords = coords[:, :2]

            gene_ids = np.asarray(cell['gene_identity'][:]).reshape(-1)
            mask = (
                (coords[:, 0] >= x0_xe) & (coords[:, 0] < x1_xe) &
                (coords[:, 1] >= y0_xe) & (coords[:, 1] < y1_xe) &
                np.isin(gene_ids, gene_indices)
            )
            if not np.any(mask):
                continue

            # Transform XE coords back to H&E pixel space for rendering
            he_coords = self._xe_to_he(coords[mask])
            counts = None
            if grid != 0 and 'cluster_count' in cell:
                counts = np.asarray(cell['cluster_count'][:]).reshape(-1)[mask]
            for i, (he_coord, gene_id) in enumerate(zip(he_coords, gene_ids[mask])):
                pt = {
                    'x': float(he_coord[0]),
                    'y': float(he_coord[1]),
                    'gene': self.index_to_gene[int(gene_id)],
                }
                if counts is not None:
                    pt['count'] = int(counts[i])
                points.append(pt)

        return points

    def _he_to_xe(self, coords):
        """Transform (N, 2) H&E px coords to Xenium µm space."""
        if self._M is None:
            return coords
        return (np.dot(coords, self._M.T) + self._Tr) * self._mpp

    def _xe_to_he(self, coords):
        """Transform (N, 2) Xenium µm coords to H&E px space."""
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

    def _grid_locs_for_box(self, x0, y0, x1, y1, spacing):
        lower = np.floor(np.array([x0, y0]) / spacing).astype(int)
        upper = np.floor(np.array([max(x0, x1 - 1), max(y0, y1 - 1)]) / spacing).astype(int)

        for i in range(lower[0], upper[0] + 1):
            for j in range(lower[1], upper[1] + 1):
                yield f'{i},{j}'

    def get_cell_profile(self, he_x: float, he_y: float, he_radius: float,
                         max_radius: float = 1500.0, top_n: int = 50) -> dict:
        """
        Return gene counts for all transcripts within *he_radius* H&E pixels of
        (he_x, he_y).  Uses grid 0 (finest resolution, individual transcripts).

        Parameters
        ----------
        he_x, he_y   : centre in H&E image-pixel space
        he_radius    : search radius in H&E pixels (clamped to max_radius)
        max_radius   : safety cap so very large contours don't stall the server
        top_n        : return at most this many genes (by count, descending)

        Returns
        -------
        {'genes': {gene_name: count, …}}  — empty dict when no data available
        """
        if self._root is None:
            return {'genes': {}}

        he_radius = min(float(he_radius), float(max_radius))

        # Transform the four corners of the bounding box to Xenium space.
        corners = np.array([
            [he_x - he_radius, he_y - he_radius],
            [he_x + he_radius, he_y - he_radius],
            [he_x - he_radius, he_y + he_radius],
            [he_x + he_radius, he_y + he_radius],
        ])
        xe_corners = self._he_to_xe(corners)
        x0_xe, y0_xe = xe_corners.min(axis=0)
        x1_xe, y1_xe = xe_corners.max(axis=0)

        # Use grid 0 (individual transcripts, not clustered).
        grid_idx = 0
        if grid_idx not in self.grids:
            return {'genes': {}}

        grid_meta  = self.grids[grid_idx]
        grid_group = self._root['grids'][grid_meta['key']]
        gene_counts: dict = {}

        for loc in self._grid_locs_for_box(x0_xe, y0_xe, x1_xe, y1_xe, grid_meta['spacing']):
            if loc not in grid_group:
                continue
            cell = grid_group[loc]
            coords = np.asarray(cell['location'][:])
            if coords.size == 0:
                continue
            coords   = coords[:, :2]
            gene_ids = np.asarray(cell['gene_identity'][:]).reshape(-1)

            mask = (
                (coords[:, 0] >= x0_xe) & (coords[:, 0] < x1_xe) &
                (coords[:, 1] >= y0_xe) & (coords[:, 1] < y1_xe)
            )
            for gid in gene_ids[mask]:
                gene = self.index_to_gene.get(int(gid))
                if gene and not any(pat in gene for pat in ('Control', 'Negative', 'Unassigned', 'Deprecated')):
                    gene_counts[gene] = gene_counts.get(gene, 0) + 1

        # Sort descending, return top_n.
        sorted_genes = dict(
            sorted(gene_counts.items(), key=lambda kv: -kv[1])[:top_n]
        )
        return {'genes': sorted_genes}