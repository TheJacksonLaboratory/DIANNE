
import os
import json
import psutil
import tifffile
import numpy as np
import pandas as pd
import cv2
from tqdm import tqdm
from IPython.display import display, HTML
import pickle

from .stqutils import loadAd, preparePatchesWSI, getPatchRepresentation, trainClassifier

import numpy as np
import cv2
import pandas as pd
from matplotlib import pyplot as plt
from matplotlib.patches import Rectangle
from matplotlib.collections import PatchCollection
from collections import defaultdict

def loadSTQParams(path, F):
    with open(path + '/grid/grid.json', 'r') as tempFile:
        info = json.loads(tempFile.read())
    ts = info['spot_horizontal_spacing'] # tile spacing (center-to-center tile distance) in um
    d = info['spot_diamter'] if 'spot_diamter' in info else info['spot_diameter'] # spot diameter in um
    mpp = d / info['spot_diameter_fullres'] # pixel size in um
    tile_size = int(F * info['spot_diameter_fullres']) # tile size in pixels (e.g. 224 means 224x224 pixel tiles)
    print(f'Loaded tile spacing: {ts}, tile size: {tile_size}, mpp: {mpp}.')
    return ts, mpp, tile_size

def reshape_strokes(strokes):
    result = {}
    
    for c in ['positive', 'negative']:
        grouped = defaultdict(list)   # group_id -> [points1, points2, ...]
        ungrouped = []                # each becomes a single-element list
        
        for d in strokes[f'strokes_{c}']:
            points = d['points']
            if 'group_id' in d:
                grouped[d['group_id']].append(np.array([[p['x'], p['y']] for p in points]))
            else:
                ungrouped.append([np.array([[p['x'], p['y']] for p in points])])  # wrap in list -> [[points]]
        
        # Combine: ungrouped entries + grouped entries (each as [p1, p2, ...])
        result[c] = ungrouped + list(grouped.values())
    
    return result

def getTilesInContour(contours, df_grid, tile_size=224, body_overlap=0.25, debug=False, patch_size=8):
    """Get a dict mapping patch index to a list of tile_ids from df_grid whose corresponding
    tiles overlap with the contour by at least body_overlap fraction.
    Tiles are grouped into spatially contiguous patches of patch_size**2 tiles arranged in a
    patch_size x patch_size grid. Only complete patches (all patch_size**2 tiles present) are returned.

    Parameters:
    contours:     List of Nx2 arrays of (x, y) points. First contour is the outer boundary;
                  subsequent contours are holes (Swiss-cheese style, even-odd fill rule).
    df_grid:      DataFrame with columns 'x' and 'y' for tile center coordinates, indexed by tile_id.
    tile_size:    Size of the square tile in pixels (default 224).
    body_overlap: Minimum fraction of tile area covered by contour to include a tile (default 0.25).
    patch_size:   Side length of each patch in tiles; each patch contains patch_size**2 tiles (default 8).

    Returns:
    dict: { patch_index (int): [tile_id, ...] } where each list has exactly patch_size**2 tile_ids,
          arranged in row-major order (top-left to bottom-right within the patch).
          Returns {} on failure.
    """
    try:
        cs = [np.asarray(c, dtype=np.int32) for c in (contours if isinstance(contours, list) else [contours])]
        all_pts = np.concatenate(cs)
        (x_min, y_min), (x_max, y_max) = all_pts.min(axis=0), all_pts.max(axis=0)

        mask = np.zeros((y_max - y_min, x_max - x_min), dtype=np.uint8)
        for i, c in enumerate(cs):
            cv2.fillPoly(mask, [c - [x_min, y_min]], color=(i % 2) ^ 1)  # even-odd: fill then punch holes

        integral = cv2.integral(mask)
        half = tile_size // 2

        df_sel = df_grid[
            (df_grid['x'] + half > x_min) & (df_grid['x'] - half < x_max) &
            (df_grid['y'] + half > y_min) & (df_grid['y'] - half < y_max)
        ]
        xs, ys = df_sel['x'].values, df_sel['y'].values

        cx0 = np.clip(xs - half - x_min, 0, mask.shape[1])
        cx1 = np.clip(xs + half - x_min, 0, mask.shape[1])
        cy0 = np.clip(ys - half - y_min, 0, mask.shape[0])
        cy1 = np.clip(ys + half - y_min, 0, mask.shape[0])
        valid = (cx1 > cx0) & (cy1 > cy0)

        sums = integral[cy1, cx1] - integral[cy0, cx1] - integral[cy1, cx0] + integral[cy0, cx0]
        mask_hits = valid & (sums > body_overlap * tile_size ** 2)

        df_hits = df_sel[mask_hits].copy()
        if df_hits.empty:
            return {}

        T = patch_size ** 2
        xs_h, ys_h = df_hits['x'].values, df_hits['y'].values
        span_x = max(xs_h.max() - xs_h.min() + tile_size, tile_size)
        span_y = max(ys_h.max() - ys_h.min() + tile_size, tile_size)
        n = max(1, round(len(df_hits) / T))
        asp = span_x / span_y
        ncols = max(1, round((n * asp) ** 0.5))
        nrows = max(1, round(n / ncols))

        df_hits['_r'] = np.clip(((ys_h - ys_h.min()) / span_y * nrows).astype(int), 0, nrows - 1)
        df_hits['_c'] = np.clip(((xs_h - xs_h.min()) / span_x * ncols).astype(int), 0, ncols - 1)

        cells = {k: g.sort_values(['y','x']).index.tolist()
                 for k, g in df_hits.groupby(['_r','_c'])}

        def adjacent(k, cells, diag=False):
            r, c = k
            cands = [(r-1,c),(r+1,c),(r,c-1),(r,c+1)] + ([(r-1,c-1),(r-1,c+1),(r+1,c-1),(r+1,c+1)] if diag else [])
            return min((n for n in cands if n in cells and n != k), key=lambda n: len(cells[n]), default=None)

        while True:
            small = [k for k, v in cells.items() if len(v) < T]
            if not small: break
            if len(small) == len(cells):
                cells = {(0,0): [t for v in cells.values() for t in v]}; break
            merged_any = False
            for sk in sorted(small, key=lambda k: len(cells[k])):
                if sk not in cells: continue
                best = adjacent(sk, cells) or adjacent(sk, cells, diag=True)
                if best is None: continue
                cells[best].extend(cells.pop(sk)); merged_any = True
            if not merged_any: break

        return {i: df_hits.loc[ids, ['x','y']].sort_values(['y','x']).index.tolist()
                for i, (_, ids) in enumerate(sorted(cells.items()))}

    except Exception as e:
        if debug:
            print(f"Error in getTilesInContour: {e}")
        return {}

def preparePatchesFromStrokes(strokes, df_grid, tile_size=224, body_overlap=0.25, patch_size=8, debug=False):

    """Prepare patches from strokes.

    Args:
        strokes (dict): Dictionary containing positive and negative strokes.
        df_grid (DataFrame): DataFrame containing grid information.
        tile_size (int): Size of each tile.
        body_overlap (float): Overlap threshold for body.
        patch_size (int): Size of each patch.

    Returns:
        dict: Dictionary containing patches for positive and negative strokes.
    """

    if debug:
        for c in ['positive', 'negative']:
            for d in strokes[f'strokes_{c}']:
                print(f"Class: {c}, annotation ID: {d['group_id'] if 'group_id' in d.keys() else 'NA'}, contour ID: {d['id']}, number of points: {len(d['points'])}")

    contours = reshape_strokes(strokes)

    data = {}
    for cl in ['positive', 'negative']:
        data[cl] = {}
        for i, c in enumerate(contours[cl]):
            # Pass a list of 1 or more contours
            if debug:
                print(len(c), "contours in this annotation")
            indices = getTilesInContour(c, df_grid, tile_size, body_overlap, patch_size=patch_size, debug=debug)
            if debug:
                print(f"Number of patches in {cl} contour {i}: {len(indices)}")
            data[cl].update({f"A-{cl[0]}-{i}-P{patch_idx}": tile_ids for patch_idx, tile_ids in indices.items()})

    return data

def visualizePatches(dataPS, df_grid, tile_size, figsize=(5, 5), lw=0.1, alpha=0.9,
                    edgecolors={'positive': 'red', 'negative': 'blue'}, verbose=False, fontsize=6):
    fig, ax = plt.subplots(figsize=figsize)
    x_min, y_min = df_grid[['x', 'y']].min().values - tile_size
    x_max, y_max = df_grid[['x', 'y']].max().values + tile_size
    ax.set_xlim(x_min, x_max)
    ax.set_ylim(y_min, y_max)
    ax.set_aspect('equal')
    ax.invert_yaxis()
    for cl in ['positive', 'negative']:
        for patch_id in dataPS[cl].keys():
            indices = dataPS[cl][patch_id]
            if verbose:
                print(f"Number of tiles in {cl} patch {patch_id}: {len(indices)}")
            patches = []
            patch_color = np.random.rand(3,)
            for tile_id in indices:
                row = df_grid.loc[tile_id]
                rect = Rectangle((row['x'] - tile_size // 2, row['y'] - tile_size // 2),
                                tile_size, tile_size, edgecolor=edgecolors[cl],
                                facecolor=patch_color, lw=lw, alpha=alpha)
                patches.append(rect)
            patch_center = df_grid.loc[indices][['x', 'y']].mean().values
            ax.text(patch_center[0], patch_center[1], str(patch_id), color='white', fontsize=fontsize, ha='center', va='center')
            ax.add_collection(PatchCollection(patches, match_original=True))
    plt.show()
    return

def getClassifierForFromStrokes(strokes_by_sample, patchCoordinates, tile_size, body_overlap, patch_size, ads, samples, qs, augFunc=None, alpha=0.8, seed=0, showPatches=False):

    # Identify samples that carry at least one annotation
    active_samples = [
        s for s in samples
        if s in strokes_by_sample and (
            len(strokes_by_sample[s].get('strokes_positive', [])) > 0 or
            len(strokes_by_sample[s].get('strokes_negative', [])) > 0
        )
    ]

    if not active_samples:
        print("No annotations provided for any sample.")
        return None, None, None

    has_any_pos = any(len(strokes_by_sample[s].get('strokes_positive', [])) > 0 for s in active_samples)
    has_any_neg = any(len(strokes_by_sample[s].get('strokes_negative', [])) > 0 for s in active_samples)

    if not has_any_pos:
        print("No positive annotations available across any sample.")
        return None, None, None
    if not has_any_neg:
        print("No negative annotations available across any sample.")
        return None, None, None

    all_patchesCDFsMod = []
    all_annotations = {}

    for sample in active_samples:
        strokes = strokes_by_sample[sample]
        sample_coords = patchCoordinates[['x', 'y']].xs(sample, level='sample', axis=0, drop_level=False)

        dataPS = preparePatchesFromStrokes(strokes, sample_coords, tile_size=tile_size,
                                           body_overlap=body_overlap, patch_size=patch_size, debug=False)

        if showPatches:
            visualizePatches(dataPS, sample_coords, tile_size=tile_size, fontsize=6)

        # Build tile→patch mapping and retrieve coordinates for annotated patches
        se = pd.concat([
            pd.Series({tile: patch for patch, tiles in dataPS[cl].items() for tile in tiles})
            for cl in ['positive', 'negative']
        ])
        if not isinstance(se.index, pd.MultiIndex):
            assert len(se.index[0])==2, "Expected tile index to be a tuple of (sample, barcode)"
            # Convert to multiindex with 'sample' and 'barcode' levels
            se.index = pd.MultiIndex.from_tuples(se.index, names=['sample', 'barcode'])
        else:
            se.index.names = ['sample', 'barcode']

        patchCoordinatesMod = patchCoordinates[['x', 'y']].loc[se.index].copy()
        patchCoordinatesMod['patch'] = se.values

        patchesCDFs_sample = getPatchRepresentation(
            ads[sample], patchCoordinatesMod.xs(sample, level='sample', axis=0), qs, sample_id=sample
        )
        all_patchesCDFsMod.append(patchesCDFs_sample)

        # Accumulate annotations for this sample
        sample_annotations = {(v[0][0], k): 'positive' for k, v in dataPS['positive'].items()}
        sample_annotations.update({(v[0][0], k): 'negative' for k, v in dataPS['negative'].items()})
        all_annotations.update(sample_annotations)

    if not all_patchesCDFsMod:
        print("No patch representations could be built.")
        return None, None, None

    patchesCDFsMod = pd.concat(all_patchesCDFsMod)
    annotations = all_annotations

    try:
        clf = trainClassifier(annotations, patchesCDFsMod, alpha=alpha, seed=seed, augFunc=augFunc)
    except Exception as e:
        print(f"Error training classifier: {e}")
        clf = None

    return clf, patchesCDFsMod, annotations

def setNotebookWidth(widthPercent=100):
    """Set the notebook container width in a Jupyter environment."""
    display(HTML(f"""<style>:root {{ --jp-notebook-max-width: {widthPercent}%; }}
body .container, div.container {{ width: {widthPercent}% !important; }}</style>"""))
    return

def findMyJupyterServer():

    """Finds the Jupyter server running on the host"""
    
    ip, port, addresses = None, None, []
    username = psutil.Process().username()
    attributes = ['pid', 'name', 'cmdline', 'username']
    processes = [p for p in psutil.process_iter(attributes) if p.info['username']==username]
    for proc in processes:
        if 'jupyter-note' in proc.info['name']:
            cmdline = proc.info['cmdline']
            for arg in cmdline:
                if arg.startswith('--ip='):
                    ip = arg.split('=')[1]
                if arg.startswith('--port='):
                    port = arg.split('=')[1]
            if ip and port:
                addresses.append(f"http://{ip}:{port}")
            ip, port = None, None

    assert len(set(addresses))<=1, 'More than one jupyter server running ion the host.'
    return addresses[0]

def saveMaskOMETIFF(oimg, pyramidScale=2, tileSise=512, saveName=None, compression='deflate', newSize=None):

    """Save a mask image as an OME-TIFF file with pyramid levels, compatible with Vitessce.

    Parameters
    ----------
    oimg : np.ndarray
        The input image to be saved.

    pyramidScale : int, optional
        The scale factor for pyramid levels, by default 2.

    tileSise : int, optional
        The size of the tiles, by default 512.

    saveName : str, optional
        The name of the output file, by default None.

    compression : str, optional
        The compression method, by default 'deflate'.

    newSize : tuple, optional
        The new size of the image, by default None.
    """

    if not newSize is None:
        foimg = cv2.resize(oimg, (newSize[1], newSize[0]), interpolation=cv2.INTER_NEAREST)
    else:
        foimg = oimg.copy()

    levels = [foimg]
    while min(levels[-1].shape) > tileSise:
        levels.append(np.array(levels[-1][::pyramidScale, ::pyramidScale]))
    
    shape = levels[0].shape
    
    params = dict(tile=(tileSise, tileSise), photometric='minisblack', planarconfig='separate', compression=compression)

    # TODO: Generate OME XML from ome_types, which is err
    ome_xml = f"""<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.openmicroscopy.org/Schemas/OME/2016-06 http://www.openmicroscopy.org/Schemas/OME/2016-06/ome.xsd">
      <Image ID="Image:0" Name="mock-annotation">
        <Pixels ID="Pixels:1" DimensionOrder="XYCZT" Type="uint8" PhysicalSizeX="0.25" PhysicalSizeXUnit="µm" PhysicalSizeY="0.25" PhysicalSizeYUnit="µm" SizeX="{shape[1]}" SizeY="{shape[0]}" SizeZ="1" SizeC="1" SizeT="1">
          <Channel ID="Channel:0:0" SamplesPerPixel="1"/>
        </Pixels>
      </Image>
    </OME>
    """

    with tifffile.TiffWriter(saveName, byteorder='>', ome=True, bigtiff=True) as tif:
        tif.write(levels[0], subifds=len(levels)-1, description=ome_xml, **params)
        for level in levels[1:]:
            tif.write(level, subfiletype=1, **params)
    
        return

def getImageShape(img):

    """Get the shape of the image.

    Parameters
    ----------
    img : str or np.ndarray
        The input image, either as a file path or a numpy array.
    
    Returns
    --------
    tuple
        The shape of the image.
    """

    if type(img) == str:
        with tifffile.TiffFile(img) as tif:
            shape = tif.pages[0].shape[1:]
    elif type(img) == np.ndarray:
        shape = img.shape[1:]
    else:
        raise ValueError("Unsupported image type. Must be either a path or a numpy array.")
        
    return shape

def maskeMockGrid(inshape, downsampleFactor=4):

    """Generate a mock grid for the image.

    Parameters
    ----------
    inshape : tuple
        The shape of the input image.

    downsampleFactor : int, optional
        The factor by which to downsample the image, by default 4.

    Returns
    --------
    np.ndarray
        The mock grid image.
    """

    shape = np.array(inshape)

    if not downsampleFactor is None:
        shape //= downsampleFactor

    oimg = np.zeros(shape, dtype=np.uint8)
    
    spacing = 400
    w = 10
    for i in range(0, oimg.shape[0], spacing):
        oimg[i:i+w, :] = 255
    
    for j in range(0, oimg.shape[1], spacing):
        oimg[:, j:j+w] = 255
    
    # Add text to the image at each patch
    for i, ip in enumerate(range(0, oimg.shape[0], spacing)):
        for j, jp in enumerate(range(0, oimg.shape[1], spacing)):
                text = f'({i},{j})'
                position = (ip + int(spacing/2), jp + int(spacing/2))
                font = cv2.FONT_HERSHEY_SIMPLEX
                font_scale = 1
                color = 255
                thickness = 2
    
                cv2.putText(oimg, text, position, font, font_scale, color, thickness)

    return oimg

def maskPatchGrid(inshape, samplePatchCoordinates, downsampleFactor=4, ts=None, mpp=0.25):

    """Generate a mask for the patch grid.

    Parameters
    ----------
    inshape : tuple
        The shape of the input image.

    samplePatchCoordinates : pd.DataFrame
        The coordinates of the sample patches.

    downsampleFactor : int, optional
        The factor by which to downsample the image, by default 4.

    ts : int, optional
        The size of the tile, by default None.

    mpp : float, optional
        The microns per pixel, by default 0.25.

    Returns
    --------
    np.ndarray
        The mask image.
    """

    gb = samplePatchCoordinates[['x', 'y', 'patch']].groupby('patch')
    df_temp = pd.concat([gb.min(), gb.max()], keys=['min', 'max'], axis=1)
    tshape = np.array(inshape)
    sh = int((ts/2)/mpp)

    if not downsampleFactor is None:
        df_temp //= downsampleFactor
        tshape //= downsampleFactor
        sh //= downsampleFactor

    oimg = np.zeros(tshape, dtype=np.uint8)

    for i, p in enumerate(df_temp.index):
        min_x, min_y, max_x, max_y = df_temp.iloc[i]

        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 1
        thickness = 2
        text_size = cv2.getTextSize(p, font, font_scale, thickness)[0]
        mid_x, mid_y = int((min_x+max_x)/2), int((min_y+max_y)/2)
        text_x = mid_x - text_size[0] // 2
        text_y = mid_y - text_size[1] // 2
        cv2.putText(oimg, p, (text_x, text_y),
                    font, font_scale, 255, thickness)

        cv2.rectangle(oimg, (min_x-sh, min_y-sh), (max_x+sh, max_y+sh), 255, thickness)

    return oimg

def setupClassifierPaths(basePath='classifiers/'):

    """Set up classifier paths."""

    classifierPaths = basePath
    if not os.path.exists(classifierPaths):
        os.makedirs(classifierPaths)

    return

def saveClassifier(clf, classifierPaths, clfname, outsSTQpath, samples, patchesCDFs, L, ts, mpp, N, fname, qs, startParams, plog, bp, ext='pklz'):

    """Save the classifier and its associated information to a file."""

    clf.update({'outsSTQpath': outsSTQpath, 'samples': samples, 'patches': patchesCDFs.index,
                'L': L, 'ts': ts, 'mpp': mpp, 'N': N, 'fname': fname, 'qs': qs,
                'startParams': startParams, 'plog': plog, 'bp': bp,
                'uncurated': len(patchesCDFs) - len(bp), 'total': len(patchesCDFs)})
    clf.update({cat: len([v for k, v in bp.items() if v==cat]) for cat in ['positive', 'negative', 'uncertain']})
    clf.update({'distribution-' + cat: dict(zip(*np.unique([k[0] for k, v in bp.items() if v == cat], return_counts=True))) for cat in ['positive', 'negative', 'uncertain']})
    clf.update({'distribution-' + 'all': dict(zip(*np.unique([k for k in patchesCDFs.index.get_level_values(0)], return_counts=True)))})

    with open(f'{classifierPaths}/{clfname}.{ext}', 'wb') as tempfile:
        pickle.dump(clf, tempfile)

    return

def loadClassifier(classifierPaths, clfname, ext='pklz'):

    """Load a classifier and its associated information from a file."""

    try:
        with open(f'{classifierPaths}/{clfname}.{ext}', 'rb') as tempfile:
            clf = pickle.load(tempfile)
        bp = clf.pop('bp', {})
        plog = clf.pop('plog', [])
        startParams = clf.pop('startParams', {})
    except FileNotFoundError:
        print(f"Classifier file '{clfname}' not found in '{classifierPaths}'. Returning an empty classifier.")
        clf = {}
        bp = {}
        plog = []
        startParams = {}

    return clf, bp, plog, startParams

def saveGUIClassifier(clf, classifierPaths, clfname, samples, ts, mpp, patch_size, tile_size, body_overlap, qs, patchesCDFsMod, annotationsMod, drawings, ext='pklz'):

    """Save the classifier and its associated information to a file."""

    data = {}
    data.update({'clf': clf, 'samples': samples, 'patches': patchesCDFsMod.index,
                'ts': ts, 'mpp': mpp, 'N': patch_size,'qs': qs, 'tile_size': tile_size, 'drawings': drawings,
                'body_overlap': body_overlap, 'annotations': annotationsMod})

    with open(f'{classifierPaths}/{clfname}.{ext}', 'wb') as tempfile:
        pickle.dump(data, tempfile)

    return

def loadGUIClassifier(classifierPaths, clfname, ext='pklz'):

    """Load a classifier and its associated information from a file."""

    try:
        with open(f'{classifierPaths}/{clfname}.{ext}', 'rb') as tempfile:
            data = pickle.load(tempfile)
    except FileNotFoundError:
        print(f"Classifier file '{clfname}' not found in '{classifierPaths}'. Returning an empty classifier.")
        data = {}

    clf = data.get('clf', {})

    return clf


def makeRunFn(patchCoordinates, ads, samples, qs, ts, mpp, PCMA_alpha=0.8, n_jobs=16, R=2,
              tile_size=448, patch_size=8, body_overlap=0.25, multiplier=4, alpha_img=0.5):
    """Return a run_inference_fn compatible with viewer.create_viewer().

    All dataset-level variables are captured once at call time; only the
    viewer-supplied strokes and active_sample change per invocation.

    Parameters
    ----------
    patchCoordinates : DataFrame
    ads : dict[sample -> AnnData]
    samples : list[str]
    qs : quantiles array
    ts : float  tile spacing in µm
    mpp : float microns per pixel
    tile_size : int   tile size in image pixels
    patch_size : int  patch side length in tiles
    body_overlap : float
    multiplier : int  interpolation multiplier for the heatmap

    Returns
    -------
    Callable suitable for ``run_inference_fn=`` in ``viewer.create_viewer()``.
    """
    from .combineCDF import getDiscreteCombinedCDFofAllFeatures as PCMA
    from .stqutils import inferProbFast
    from .interpolation import interpolate_points as interpolatePoints

    def _runfn(*, strokes_by_sample, active_sample):
        clf, _, _ = getClassifierForFromStrokes(
            strokes_by_sample, patchCoordinates, tile_size, body_overlap, patch_size,
            ads, samples, qs, augFunc=PCMA, alpha=PCMA_alpha, seed=0)
        if clf is None:
            return
        x, y, p = inferProbFast(ads[active_sample], clf, qs,
                                 tsize=ts / mpp, R=R, erode=False, n_jobs=n_jobs, verbose=False)
        xi, yi, pi = interpolatePoints(x, y, p, multiplier=multiplier)
        return dict(sample=active_sample, xi=xi, yi=yi, pi=pi,
                    delta=(ts / mpp) / multiplier, alpha=alpha_img,
                    color_low='#FFA500', color_high='#0000FF')

    return _runfn

def loadDataAndPreparePatches(samples, outsSTQpath, fname, L=None, ts=112, mpp=0.25, N=4):

    """Load the STQ data for each sample, prepare the patch coordinates and get the patch SAMPLER representations for each sample.
    The patch coordinates and representations are concatenated into single DataFrames for all samples.
    The function returns the loaded AnnData objects, images, patch coordinates, patch representations, 
    quantiles used for the representations, tile spacing and microns per pixel.
    
    Parameters:
    - samples: list of sample identifiers to load and process
    - outsSTQpath: path to the directory containing the STQ data for each sample
    - fname: filename of the STQ data to load for each sample, e.g. 'features/false-1-ctranspath_features.tsv.gz'
    - L: level of the WSI to load (if None, lazy loading with Zarr will be used)
    - ts: center-to-center distance between tiles (not size of a tile)
    - mpp: image pixel size in microns per pixel
    - N: patch size in terms of number of tiles (e.g., 4 means
        patches will be 4 by 4 tiles)

    Returns:
    - ads: dictionary of AnnData objects for each sample
    - imgs: dictionary of images for each sample
    - patchCoordinates: DataFrame containing the coordinates of the patches for all samples
    - patchesCDFs: DataFrame containing the SAMPLER representations of the patches for all samples
    - qs: quantiles used for the SAMPLER representations
    - ts: tile spacing used for preparing the patches
    - mpp: microns per pixel used for preparing the patches
    """

    # Load the STQ data for each sample
    ads = {}
    imgs = {}
    for sample in tqdm(samples):
        ads[sample], imgs[sample] = loadAd(f'{outsSTQpath}{sample}/', fname=fname, L=L)

    # Prepare the patches coordinates for each sample and concatenate them into a single DataFrame
    patchCoordinates = pd.concat([preparePatchesWSI(ads[sample].obs, N=N, spacing=ts/mpp, sample_id=sample) for sample in tqdm(samples)], axis=0)

    # Get the patch SAMPLER representations for each sample and combine them into a single DataFrame
    qs = np.linspace(0.05, 0.95, 10, endpoint=True)
    patchesCDFs = pd.concat([getPatchRepresentation(ads[sample], patchCoordinates.xs(sample, level='sample', axis=0), 
                                                           qs, sample_id=sample) for sample in tqdm(samples)], axis=0)

    return ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L, N

def loadDataAndPreparePatchesStatic(samples, outsSTQpath, fname='img.data.ctranspath-1.h5ad', samplesToSTQnames=None, L=None, ts=56, mpp=0.25, N=8):

    if samplesToSTQnames is None:
        samplesToSTQnames = {sample: sample for sample in samples}

    # Load the STQ data for each sample
    ads = {}
    imgs = {}
    for sample in tqdm(samples):
        ads[sample], imgs[sample] = loadAd(outsSTQpath + samplesToSTQnames[sample] + '/', fname=fname, L=L)

    # Prepare the patches coordinates for each sample and concatenate them into a single DataFrame
    patchCoordinates = pd.concat([preparePatchesWSI(ads[sample].obs, N=N, spacing=ts/mpp, sample_id=sample) for sample in tqdm(samples)], axis=0)

    # Get the patch SAMPLER representations for each sample and combine them into a single DataFrame
    qs = np.linspace(0.05, 0.95, 10, endpoint=True)
    patchesCDFs = pd.concat([getPatchRepresentation(ads[sample], patchCoordinates.xs(sample, level='sample', axis=0), qs, sample_id=sample) for sample in tqdm(samples)], axis=0)

    return ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L, N

def showGroundTruth2(id, ct, df_ct_tile, patchCoordinates, vmax=10):
    se_color = df_ct_tile.xs(id, level='sample')[ct].droplevel('patch')
    if se_color.ndim == 2:
        se_color = se_color.sum(axis=1)
    se_coor = patchCoordinates.xs(id, level='sample')[['x', 'y']]
    ind = se_color.index.intersection(se_coor.index)
    se_color = se_color.loc[ind]
    se_coor = se_coor.loc[ind]
    x, y, c = se_coor['x'].values, se_coor['y'].values, se_color.values
    return x, y, c, vmax, pd.Series(index=ind, data=c)

def showGroundTruth(id, ct, df_tile, patchCoordinates, vmax=10):
    se_color = df_tile.xs(id, level='sample')[ct].droplevel('patch')
    se_coor = patchCoordinates.xs(id, level='sample')[['x', 'y']]
    ind = se_color.index.intersection(se_coor.index)
    se_color = se_color.loc[ind]
    se_coor = se_coor.loc[ind]
    x, y, c = se_coor['x'].values, se_coor['y'].values, se_color.values
    return x, y, c, vmax, pd.Series(index=ind, data=c)

# def saveHEOMETIFF(foimg, pyramidScale=2, tileSise=512, saveName=None, compression='deflate'):
#
#     levels = [foimg]
#     while min(levels[-1].shape) > tileSise:
#         levels.append(np.array(levels[-1][::pyramidScale, ::pyramidScale]))
#
#     shape = levels[0].shape
#   
#     params = dict(tile=(tileSise, tileSise), planarconfig='separate', compression=compression)
#
#     with tifffile.TiffWriter(saveName, byteorder='>', ome=True, bigtiff=True) as tif:
#         tif.write(levels[0], subifds=len(levels)-1, **params)
#         for level in levels[1:]:
#             tif.write(level, subfiletype=1, **params)
#
#         return
#
# f1conv = '/projects/activities/kappsen-tmc/USERS/domans/differential-annotator-dev/JAX_002_KD_C_conv.ome.tif'
# # saveHEOMETIFF(img2, saveName=f1conv)
