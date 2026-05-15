import os
import json
import zarr
import tifffile
import cv2
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from packaging import version
from scipy.ndimage import distance_transform_edt, binary_fill_holes
from scipy.spatial import cKDTree

def makeProbMask(ad, imgpath, x, y, p, ts=56, mpp=0.25, downfactor=16, savepath=None, saveimg=True, prefix='', extension='jpeg', savecsv=False, verbose=False):

    """Create a downsampled probability mask from the inferred probabilities at the patch centers. The mask will have 
    the same dimensions as the downsampled WSI at the specified downfactor. Each pixel in the mask will have a value 
    corresponding to the probability of being positive, scaled to 0-255. The function also saves the mask image and a CSV file 
    with the coordinates and probabilities if specified.

    Parameters:
        ad: AnnData object containing the original_barcode in obs
        imgpath: Path to the original WSI image file
        x, y: Arrays of x and y coordinates of the patch centers in pixel space
        p: Array of probabilities corresponding to each patch center
        ts: Tile spacing in microns (default 56)
        mpp: Microns per pixel (default 0.25)
        downfactor: Factor by which to downsample the original image dimensions (default 16). Set 1 to keep original dimensions.
        savepath: Directory path to save the output image and CSV (default None, no saving)
        saveimg: Whether to save the downsampled probability mask image (default True)
        prefix: Prefix for the saved files (default '')
        extension: File extension for the saved image (default 'png')
        savecsv: Whether to save the CSV file with coordinates and probabilities (default False)
        verbose: Whether to print verbose output (default False)

    Returns:
        downsampled_map: 2D numpy array representing the downsampled probability mask
        fshape: Tuple representing the original image dimensions (height, width)
    """

    names = ['pxl_col_in_wsi', 'pxl_row_in_wsi']
    search = ad.obs.set_index(names)['original_barcode']
    xypix = pd.MultiIndex.from_arrays([x, y], names=names)
    df_prob = pd.Series(index=search.loc[xypix].values, data=p, name='p').to_frame()
    df_prob[['x', 'y']] = xypix.to_frame(index=False).values
    df_prob = df_prob[['x', 'y', 'p']]

    if prefix != '':
        prefix += '-'

    if savecsv and savepath is not None:
        df_prob.to_csv(f'{savepath}/{prefix}map.csv.gz')

    draw_tile_size = int(ts/mpp)
    with tifffile.TiffFile(imgpath) as tempfile:
        fshape = tempfile.pages[0].shape
        if fshape[0] < 100:
            fshape = (fshape[1], fshape[2])
        else:
            fshape = (fshape[0], fshape[1])
    print('Original image shape:', fshape)

    downsampled_map = np.zeros(np.array(fshape)//downfactor, dtype=np.uint8)
    downsampled_halfsize = draw_tile_size // (2 * downfactor)
    downsampled_halfsize += 1 if draw_tile_size % (2 * downfactor) != 0 else 0

    if verbose:
        print('Making mask of shape:', downsampled_map.shape)

    for tile, row in df_prob.iterrows():
        tx, ty, tp = row['x'], row['y'], row['p']
        x_ds = int(tx // downfactor)
        y_ds = int(ty // downfactor)
        x1 = max(0, x_ds - downsampled_halfsize)
        x2 = min(downsampled_map.shape[1], x_ds + downsampled_halfsize)
        y1 = max(0, y_ds - downsampled_halfsize)
        y2 = min(downsampled_map.shape[0], y_ds + downsampled_halfsize)
        downsampled_map[y1:y2, x1:x2] = int(tp * 255)

    if saveimg and savepath is not None:
        kwargs = {'compression': 'jpeg'}
        if version.parse(tifffile.__version__) >= version.parse('2022.2.2'):
            kwargs['compressionargs'] = {'level': 90}
        else:
            kwargs['compression'] = ('jpeg', 90)

        tifffile.imwrite(f'{savepath}/{prefix}map.{extension}', downsampled_map, **kwargs)

    return downsampled_map, fshape

def extractContoursForQuPath(downsampled_map, fshape, cutoff=0.5, min_area=100, scalefactor=1.0, downfactor=16, annotation_name='Region', savepath=None, prefix='', sigma=100):

    """Extract contours from the downsampled probability mask and convert them to original image coordinates.

    Parameters:
        downsampled_map: 2D numpy array representing the downsampled probability mask
        fshape: Tuple representing the original image dimensions (height, width)
        cutoff: Intensity threshold for contour extraction (default 128)
        min_area: Minimum area of contours to keep (default 100)
        downfactor: Factor by which the original image was downsampled (default 16)

    Returns:
        contours: List of contours in geojson format, where each contour is represented 
        as a polygon with coordinates in the original image space.
    """

    blurred = cv2.GaussianBlur(downsampled_map, (0, 0), sigma / downfactor)
    _, binary_mask = cv2.threshold(blurred, int(cutoff * 255), 255, cv2.THRESH_BINARY)

    contours, hier = cv2.findContours(binary_mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None: return {"type": "FeatureCollection", "features": []}
    hier = hier[0]

    def ring(c):
        pts = [[float(p[0][0]) * downfactor * scalefactor, float(p[0][1]) * downfactor * scalefactor] for p in c]
        pts.append(pts[0]); return pts
    def children(i):
        kids, c = [], hier[i][2]
        while c != -1: kids.append(c); c = hier[c][0]
        return kids

    features = []
    def build(i):
        c = contours[i].astype(np.float32) * downfactor * scalefactor
        c[:,:,0] = np.clip(c[:,:,0], 0, fshape[1]-1)
        c[:,:,1] = np.clip(c[:,:,1], 0, fshape[0]-1)
        if cv2.contourArea(c.astype(np.float32)) < min_area: return
        rings = [ring(contours[i])] + [ring(contours[h]) for h in children(i)]
        [build(g) for h in children(i) for g in children(h)]
        features.append({
            "type": "Feature",
            "id": str(len(features)),
            "geometry": {"type": "Polygon", "coordinates": rings},
            "properties": {"objectType": "annotation", "classification": {"name": annotation_name, "colorRGB": -3670016}}
        })

    [build(i) for i, h in enumerate(hier) if h[3] == -1]

    geojson = {"type": "FeatureCollection", "features": features}

    if savepath is not None:
        with open(f'{savepath}/{prefix}.geojson', 'w') as f:
            json.dump(geojson, f)

    return geojson

def viewContoursOnImage(imgpath, geojson, fshape, level=2, contours_color='lime', holes_color='lime', linewidth=2, figsize=(5, 5)):

    """Visualize the extracted contours on the original WSI image at a specified downsampled level.

    Parameters:
        imgpath: Path to the original WSI image file
        geojson: GeoJSON object containing the contours to be visualized
        fshape: Tuple representing the original image dimensions (height, width)
        level: Downsampled level of the image to visualize (default 2)
        contours_color: Color for the main contours (default 'lime')
        holes_color: Color for the holes within contours (default 'lime')
        linewidth: Line width for contour visualization (default 2)
        figsize: Tuple representing the figure size for visualization (default (5, 5))

    Returns:
        None (displays the plot with contours overlaid on the image)
    """

    fig, ax = plt.subplots(figsize=figsize)
    with tifffile.imread(imgpath, aszarr=True) as store:
        with zarr.open(store, mode='r') as zArray:
            img_ = np.moveaxis(zArray[level], 0, -1)
    ax.imshow(img_, extent=(0, fshape[1], fshape[0], 0), interpolation='nearest')
    for feature in geojson["features"]:
        for i, ring in enumerate(feature["geometry"]["coordinates"]):
            ring = np.array(ring)
            ax.plot(ring[:, 0], ring[:, 1], color=contours_color if i == 0 else holes_color, linewidth=linewidth)
    ax.axis('off')
    plt.show()

    return

def readContoursFromGeoJSON(geojson_input, output_shape, scalefactor=1.0, downfactor=16):
    """
    Read contours from a GeoJSON file/dict and reconstruct a downsampled binary map.
    
    Parameters:
        geojson_input:  Path to a .geojson file, or a already-loaded dict.
        output_shape:   Full image shape (height, width).
        scalefactor:    Must match the scalefactor used during export (default 1.0).
        downfactor:     Must match the downfactor used during export (default 16).
    
    Returns:
        binary_map:     2D uint8 numpy array of shape `(output_shape[0] // downfactor, output_shape[1] // downfactor)` with filled
                        polygons drawn as 255, holes as 0.
    """
    import json
    import numpy as np
    import cv2

    # ── load ────────────────────────────────────────────────────────────────────
    if isinstance(geojson_input, (str, bytes, os.PathLike)):
        with open(geojson_input, 'r') as f:
            geojson = json.load(f)
    else:
        geojson = geojson_input

    binary_map = np.zeros((output_shape[0]//downfactor, output_shape[1]//downfactor), dtype=np.uint8)

    combined = downfactor * scalefactor          # same scale applied in export
    inv      = 1.0 / combined                    # invert it

    for feature in geojson.get("features", []):
        geom = feature.get("geometry", {})
        if geom.get("type") != "Polygon":
            continue

        rings = geom.get("coordinates", [])
        if not rings:
            continue

        # ── outer ring → fill white ──────────────────────────────────────────
        outer_pts = _ring_to_cv2(rings[0], inv)
        if outer_pts is not None:
            cv2.fillPoly(binary_map, [outer_pts], 255)

        # ── inner rings (holes) → fill black ────────────────────────────────
        for hole in rings[1:]:
            hole_pts = _ring_to_cv2(hole, inv)
            if hole_pts is not None:
                cv2.fillPoly(binary_map, [hole_pts], 0)

    return binary_map

def _ring_to_cv2(ring, inv_scale):
    """
    Convert a GeoJSON ring (list of [x, y] pairs) to an int32 OpenCV contour.
    The closing duplicate point is dropped; fewer than 3 points returns None.
    """
    import numpy as np
    pts = np.array(ring, dtype=np.float64)
    # drop the closing repeat added in export
    if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    if len(pts) < 3:
        return None
    pts = (pts * inv_scale).round().astype(np.int32)
    return pts.reshape(-1, 1, 2)          # shape OpenCV expects

def analyze_membrane_masks(df, A, B, C):
    """
    Analyze cell positions relative to binary masks A, B, C.

    Parameters:
        df:  DataFrame with columns 'x_centroid' and 'y_centroid'.
             Index is preserved in the output.
        A, B, C: 2D boolean numpy arrays (same shape).

    Returns:
        DataFrame indexed like df with columns:
            in_A, in_B, in_C          – bool
            in_neither                – bool (not in A and not in C)
            dist_to_A                 – float, for 'neither' cells only (else NaN)
            dist_to_C                 – float, for 'neither' cells only (else NaN)
            angle_AC_deg              – float, angle between the two lines (else NaN)
            dist_to_C_border          – float, for cells in C only (else NaN)
    """
    xs = df['x_centroid'].to_numpy()   # col index  → axis-1
    ys = df['y_centroid'].to_numpy()   # row index  → axis-0

    xi = np.clip(np.round(xs).astype(int), 0, A.shape[1] - 1)
    yi = np.clip(np.round(ys).astype(int), 0, A.shape[0] - 1)

    # ── membership ─────────────────────────────────────────────────────────────
    in_A = A[yi, xi].astype(bool)
    in_B = B[yi, xi].astype(bool)
    in_C = C[yi, xi].astype(bool)
    in_neither = ~in_A & ~in_C

    result = pd.DataFrame(
        {"in_A": in_A, "in_B": in_B, "in_C": in_C, "in_neither": in_neither},
        index=df.index,
    )
    result["dist_to_A"]       = np.nan
    result["dist_to_C"]       = np.nan
    result["angle_AC_deg"]    = np.nan
    result["dist_to_C_border"] = np.nan

    # ── 'neither' cells: nearest pixel in A and nearest pixel in C ─────────────
    neither_mask = in_neither
    if neither_mask.any():
        # pixel coordinates of every True pixel in A and C
        A_rows, A_cols = np.where(A)
        C_rows, C_cols = np.where(C)

        if len(A_rows) == 0 or len(C_rows) == 0:
            pass  # masks empty – distances stay NaN
        else:
            cell_xy = np.column_stack([xs[neither_mask], ys[neither_mask]])

            # KDTree queries return the single nearest pixel ──────────────────
            tree_A = cKDTree(np.column_stack([A_cols, A_rows]))   # (x, y)
            tree_C = cKDTree(np.column_stack([C_cols, C_rows]))

            dist_A, idx_A = tree_A.query(cell_xy, workers=-1)
            dist_C, idx_C = tree_C.query(cell_xy, workers=-1)

            # Optimise: for each cell find the pair (pA, pC) that minimises
            # dist(cell→pA) + dist(cell→pC).  The KDTree nearest neighbour
            # already gives the individually optimal pixel; their sum is the
            # correct joint minimum because the two choices are independent.
            nearest_A_xy = np.column_stack([A_cols[idx_A], A_rows[idx_A]])
            nearest_C_xy = np.column_stack([C_cols[idx_C], C_rows[idx_C]])

            # vectors from cell to each nearest pixel
            vec_A = nearest_A_xy - cell_xy   # shape (n, 2)
            vec_C = nearest_C_xy - cell_xy

            # angle between the two vectors
            dot   = (vec_A * vec_C).sum(axis=1)
            norm  = dist_A * dist_C
            # guard against zero-length vectors (cell sitting exactly on pixel)
            cos_a = np.where(norm > 0, np.clip(dot / norm, -1.0, 1.0), 0.0)
            angle = np.degrees(np.arccos(cos_a))

            result.loc[neither_mask, "dist_to_A"]    = dist_A
            result.loc[neither_mask, "dist_to_C"]    = dist_C
            result.loc[neither_mask, "angle_AC_deg"] = angle

    # ── cells in C: distance to nearest outer non-C pixel ──────────────────────
    C_mask = in_C
    if C_mask.any():
        C_filled   = binary_fill_holes(C)        # fill internal holes first
        outside_C  = ~C_filled                   # True = outside solid C region

        # distance_transform_edt on the *inverse* of outside gives, for every
        # pixel inside C_filled, the Euclidean distance to the nearest outside pixel.
        dist_map = distance_transform_edt(C_filled)   # dist from every C pixel to border

        result.loc[C_mask, "dist_to_C_border"] = dist_map[yi[C_mask], xi[C_mask]]

    return result

def showMasksMembr(classifierPaths, fshape=(37807, 44066), donor='11', rotate=True):

    prefix = f'Amnion-{donor}'
    rA = readContoursFromGeoJSON(f'{classifierPaths}/{prefix}.geojson', output_shape=fshape, downfactor=16) / 255.
    prefix = f'Chorion-{donor}'
    rB = readContoursFromGeoJSON(f'{classifierPaths}/{prefix}.geojson', output_shape=fshape, downfactor=16) / 255.
    prefix = f'Decidua-{donor}'
    rC = readContoursFromGeoJSON(f'{classifierPaths}/{prefix}.geojson', output_shape=fshape, downfactor=16) / 255.
    rB[rC>0] = 0. # 0.00023 of area
    prefix = f'Background-{donor}'
    rD = readContoursFromGeoJSON(f'{classifierPaths}/{prefix}.geojson', output_shape=fshape, downfactor=16) / 255.
    rA[(rD>0)] = 0
    rB[(rD>0)] = 0
    rC[(rD>0)] = 0

    if rotate:
        fshape = fshape[1], fshape[0]
    
    exshape = 0.001*fshape[0]*0.25, 0.001*fshape[1]*0.25
    
    r3 = np.dstack([rA]*4)
    r3[..., 0] *= 1
    r3[..., 1] *= 0
    r3[..., 2] *= 0
    r3[..., 3] = r3[..., 3] >0
    if rotate:
        r3 = np.rot90(r3)
    plt.imshow(r3, extent=[0, exshape[1], exshape[0], 0])
    
    r3 = np.dstack([rB]*4)
    r3[..., 0] *= 0.15
    r3[..., 1] *= 0.5
    r3[..., 2] *= 0.5
    r3[..., 3] = r3[..., 3] >0
    if rotate:
        r3 = np.rot90(r3)
    plt.imshow(r3, extent=[0, exshape[1], exshape[0], 0])
    
    r3 = np.dstack([rC]*4)
    r3[..., 0] *= 0.35
    r3[..., 1] *= 0
    r3[..., 2] *= 0.5
    r3[..., 3] = r3[..., 3] >0
    if rotate:
        r3 = np.rot90(r3)
    plt.imshow(r3, extent=[0, exshape[1], exshape[0], 0])
    
    r3 = np.dstack([rD]*4)
    r3[..., 0] *= 0.8
    r3[..., 1] *= 0.8
    r3[..., 2] *= 0.8
    r3[..., 3] = r3[..., 3] >0
    if rotate:
        r3 = np.rot90(r3)
    plt.imshow(r3, extent=[0, exshape[1], exshape[0], 0])
    
    ax = plt.gca()
    ax.set_aspect('equal')
    ax.tick_params(labelsize=16)
    ax.set_xlabel('Coordinate x, mm', fontsize=16)
    ax.set_ylabel('Coordinate y, mm', fontsize=16)

    # Add legend patches
    from matplotlib.patches import Patch
    legend_elements = [
        Patch(facecolor='red', edgecolor='none', label='Amnion'),
        Patch(facecolor='teal', edgecolor='none', label='Chorion'),
        Patch(facecolor='purple', edgecolor='none', label='Decidua'),
        Patch(facecolor='lightgray', edgecolor='none', label='No tissue')
    ]
    ax.legend(handles=legend_elements, loc='upper right', fontsize=16, bbox_to_anchor=(1.65, 1), fancybox=False, frameon=False)
    
    plt.show()
    return

def plotDistanceDeciduaToChorion(df_out, co_he, downfactor=16, m=5000, cmap='viridis_r', rotate=True):
    v = df_out['dist_to_C_border'].copy()
    v *= downfactor
    v[v>m] = m
    wh = ~np.isnan(v)
    f = 0.001 * 0.25
    v *= f

    x, y = co_he[:, 0]*f, co_he[:, 1]*f
    if rotate:
        x, y = y, x
        y = np.max(y) - y

    plt.scatter(x[~wh], y[~wh], s=0.5, c='grey', edgecolor='none')
    plt.scatter(x[wh], y[wh], s=0.5, c=v[wh], edgecolor='none', cmap=cmap)
    ax = plt.gca()
    ax.set_aspect('equal')
    ax.invert_yaxis()
    ax.set_xlabel('Coordiate x, mm', fontsize=16)
    ax.set_ylabel('Coordiate y, mm', fontsize=16)
    ax.tick_params(labelsize=16)
    cbar = plt.colorbar(shrink=0.5)
    cbar.set_label('Distance to chorion, mm', size=14)
    # Increase colorbar font size
    cbar = plt.gcf().axes[-1]
    cbar.tick_params(labelsize=16)

    plt.show()
    return

def plotDistanceDeciduaToAmnion(df_out, co_he, downfactor=16, m=5000, cmap='viridis_r', rotate=True):
    v = df_out['dist_to_A'].copy()
    v *= downfactor
    v[v>m] = np.nan
    wh = ~np.isnan(v)
    f = 0.001 * 0.25
    v *= f

    x, y = co_he[:, 0]*f, co_he[:, 1]*f
    if rotate:
        x, y = y, x
        y = np.max(y) - y

    plt.scatter(x[~wh], y[~wh], s=0.5, c='grey', edgecolor='none')
    plt.scatter(x[wh], y[wh], s=0.5, c=v[wh], edgecolor='none', cmap=cmap)
    ax = plt.gca()
    ax.set_aspect('equal')
    ax.invert_yaxis()
    ax.set_xlabel('Coordiate x, mm', fontsize=16)
    ax.set_ylabel('Coordiate y, mm', fontsize=16)
    ax.tick_params(labelsize=16)
    cbar = plt.colorbar(shrink=0.5)
    cbar.set_label('Distance to amnion, mm', size=14)
    # Increase colorbar font size
    cbar = plt.gcf().axes[-1]
    cbar.tick_params(labelsize=16)

    plt.show()
    return

def plotDistanceChorionToDecidua(df_out, co_he, downfactor=16, m=5000, cmap='viridis_r', rotate=True):
    v = df_out['dist_to_C'].copy()
    v *= downfactor
    v[v>m] = np.nan
    wh = ~np.isnan(v)
    f = 0.001 * 0.25
    v *= f

    x, y = co_he[:, 0]*f, co_he[:, 1]*f
    if rotate:
        x, y = y, x
        y = np.max(y) - y

    plt.scatter(x[~wh], y[~wh], s=0.5, c='grey', edgecolor='none')
    plt.scatter(x[wh], y[wh], s=0.5, c=v[wh], edgecolor='none', cmap=cmap)
    ax = plt.gca()
    ax.set_aspect('equal')
    ax.invert_yaxis()
    ax.set_xlabel('Coordiate x, mm', fontsize=16)
    ax.set_ylabel('Coordiate y, mm', fontsize=16)
    ax.tick_params(labelsize=16)
    cbar = plt.colorbar(shrink=0.5)
    cbar.set_label('Distance to decidua, mm', size=14)
    # Increase colorbar font size
    cbar = plt.gcf().axes[-1]
    cbar.tick_params(labelsize=16)

    plt.show()
    return


if __name__ == "__main__":
    
    # Usage, where x, y, p are the tile-level coordinates and probabilities from the model inference
    downsampled_map, fshape = makeProbMask(ads[sample], imgs[sample], x, y, p, ts=ts, mpp=mpp, downfactor=16,
                                    savepath=classifierPaths, prefix=f'{sample}-purple', verbose=True)

    paramsGeoJSON = dict(cutoff=0.5, min_area=10**6, downfactor=16, sigma=224)
    geojson = extractContoursForQuPath(downsampled_map, fshape, **paramsGeoJSON)
    viewContoursOnImage(imgs[sample], geojson, fshape, level=2, figsize=(5, 5), linewidth=1)

    geojson = extractContoursForQuPath(downsampled_map, fshape, savepath=classifierPaths, prefix=f'{sample}-purple',
                                    scalefactor=0.25/0.2208, **paramsGeoJSON)
