"""Core of DIANNE.

Author: Sergii Domanskyi
Organization: The Jackson Laboratory for Genomic Medicine

This module consolidates the primary classifier training, data loading, 
preparation, and inference functions used across the DIANNE package.

Non-default dependencies include:
- tqdm
- multiprocessing
- joblib
- tifffile
- scanpy
- pandas
- numpy
- scikit-learn
- scipy
"""

import os
import time
import json
import tifffile
import numpy as np
import pandas as pd
import scanpy as sc
from tqdm import tqdm
from multiprocessing import shared_memory
from sklearn.linear_model import LogisticRegression as LR
from scipy.ndimage import generic_filter
from scipy.spatial import KDTree
from joblib import Parallel, delayed


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def loadImFeatures(dpath):
    df_temp = pd.read_csv(dpath, index_col=[0, 1], sep=',').xs(1, level='in_tissue')
    df_temp.insert(0, 'original_barcode', df_temp.index.values)
    ad = sc.AnnData(X=df_temp.loc[:, df_temp.columns.str.contains('feat')],
                    obs=df_temp.loc[:, ~df_temp.columns.str.contains('feat')])
    return ad

def loadAdImage(spath, verbose=False):
    if os.path.isfile(f'{spath}/thumbnail.tiff'):
        thumbnail = tifffile.imread(f'{spath}/thumbnail.tiff')
    elif os.path.isfile(f'{spath}/thumbnail.jpeg'):
        thumbnail = tifffile.imread(f'{spath}/thumbnail.jpeg')
    else:
        raise FileNotFoundError(f"Thumbnail image not found in {spath}. Please check the path.")
    if verbose:
        print(thumbnail.shape)
    with open(f'{spath}/grid/grid.json', 'r') as f:
        d = json.load(f)
    if verbose:
        print(d)
    grid = pd.read_csv(f'{spath}/grid/grid.csv', index_col=0, header=None)
    image = {'library_id': {'images': {'lowres': thumbnail},
                            'metadata': {'chemistry_description': None, 'software_version': None},
                            'scalefactors': {'tissue_lowres_scalef': thumbnail.shape[0] / d['y'],
                                             'spot_diameter_fullres': d['spot_diameter_fullres']}}}, grid.index.values, grid[[5, 4]].values
    return image

def loadAd(spath, L=None, fname='img.data.ctranspath-1.h5ad', suffix=None, verbose=False, useInputImagePath=False):
    '''Load or prepare AnnData object and image from the specified path.

    Parameters
    ----------
    spath : str
        Path to the STQ output directory containing the image and AnnData or imaging features file.
    L : int, optional
        Level of the image to load (default is None, which assigns full image path to the output image).
        Value of 0 loads the full resolution image.
    fname : str, optional
        Name of the AnnData file (default is 'img.data.ctranspath-1.h5ad').
        Alternatively, it can be alike 'features/false-1-ctranspath_features.tsv.gz'.
    suffix : str, optional
        Suffix to append to the index of the AnnData object (default is None).
    verbose : bool, optional
        If True, print additional information about the image and AnnData object (default is False).

    Returns
    -------
    ad : AnnData
        The loaded AnnData object.
    img : NDArray
        The loaded image as a NumPy array (if L is specified), or the path to the image file (if L is None).
    '''

    if useInputImagePath:
        infoPath = imagePath = os.path.join(spath, 'info.json')
        with open(infoPath, 'r') as f:
            imagePath = json.load(f)['image']
    else:
        imagePath = os.path.join(spath, 'image.ome.tiff')
    if L is not None:
        img = tifffile.imread(imagePath, level=L)
        img = np.moveaxis(np.moveaxis(img, 0, 1), 1, 2)
        if verbose:
            print(img.shape)
    else:
        img = imagePath

    if fname.endswith('.h5ad'):
        ad = sc.read_h5ad(spath + fname)
    elif fname.endswith('.gz'):
        ad = loadImFeatures(spath + fname)
    else:
        raise ValueError(f"Unknown file format for {fname}.")

    if suffix is not None:
        ad.obs.index = ad.obs.index + suffix

    image = loadAdImage(spath, verbose=verbose)
    ad.uns['spatial'] = image[0]
    df_temp = pd.DataFrame(index=image[1], data=image[2])
    if 'original_barcode' in ad.obs.columns:
        df_temp = df_temp.reindex(ad.obs['original_barcode'])
    else:
        df_temp = df_temp.reindex(ad.obs.index)
    ad.obsm['spatial'] = df_temp.values
    spot_size = ad.uns['spatial']['library_id']['scalefactors']['spot_diameter_fullres']

    if verbose:
        print(spot_size)
        print(ad.shape)

    return ad, img

def preparePatchesWSI(ad_obs, N=8, spacing=56 / 0.25, qth=0.05, sample_id=None, verbose=False):
    '''Prepare patches for WSI data.

    Input is a dataframe with columns 'x' and 'y' or 'pxl_col_in_wsi' and 'pxl_row_in_wsi',
    denoting the spatial coordinates of tile centers in the WSI.
    Spacing is in the same units as the coordinates. 'x' and 'y' are in xenium physical space, µm.
    'pxl_col_in_wsi' and 'pxl_row_in_wsi' are in pixels.
    N is the number of patches in one dimension.
    qth is the low quantile threshold for the patch size distribution, i.e. patches with size
    below this threshold are removed.

    Parameters
    ----------
    ad_obs : DataFrame
        Data with spatial information.
    N : int
        Number of patches in one dimension.
    spacing : float
        Spacing between patches.
    qth : float
        Low quantile threshold for the patch size distribution.
    '''

    if (not 'x' in ad_obs.columns) | (not 'y' in ad_obs.columns):
        try:
            df_temp_img_tiles = ad_obs[['pxl_col_in_wsi', 'pxl_row_in_wsi']].copy().rename(
                {'pxl_col_in_wsi': 'x', 'pxl_row_in_wsi': 'y'}, axis=1)
        except Exception:
            df_temp_img_tiles = ad_obs[['pxl_col_in_fullres', 'pxl_row_in_fullres']].copy().rename(
                {'pxl_col_in_fullres': 'x', 'pxl_row_in_fullres': 'y'}, axis=1)
    else:
        df_temp_img_tiles = ad_obs[['x', 'y']].copy()

    limx = df_temp_img_tiles['x'].min(), df_temp_img_tiles['x'].max()
    limy = df_temp_img_tiles['y'].min(), df_temp_img_tiles['y'].max()

    S = N * spacing
    gridx = np.append(np.arange(limx[0], limx[1], S), limx[1] + 1)
    gridy = np.append(np.arange(limy[0], limy[1], S), limy[1] + 1)

    for i in range(len(gridx) - 1):
        for j in range(len(gridy) - 1):
            x0, x1 = gridx[i], gridx[i + 1]
            y0, y1 = gridy[j], gridy[j + 1]
            df_temp_img_tiles.loc[
                (df_temp_img_tiles['x'] >= x0) &
                (df_temp_img_tiles['x'] < x1) &
                (df_temp_img_tiles['y'] >= y0) &
                (df_temp_img_tiles['y'] < y1), 'patch'] = f'patch_{i}_{j}'

    df_temp_img_tiles['patch_size'] = (df_temp_img_tiles['patch'].value_counts()
                                       .reindex(df_temp_img_tiles['patch'].values).values)
    df_temp_img_tiles = df_temp_img_tiles.loc[
        df_temp_img_tiles['patch_size'] >= df_temp_img_tiles['patch_size'].quantile(qth)]

    if sample_id is not None:
        df_temp_img_tiles['sample'] = sample_id
        df_temp_img_tiles = df_temp_img_tiles.set_index(['sample'], append=True).reorder_levels(['sample', 'barcode'])

    if verbose:
        print('Prepared patches:', df_temp_img_tiles['patch'].nunique())
    return df_temp_img_tiles

def getPatchRepresentation(ad, df_temp_img_tiles, qs, sample_id=None):
    """Get the patch SAMPLER representation for each tile in the image.

    Parameters
    ----------
    ad : AnnData
        AnnData object containing the imaging features.
    df_temp_img_tiles : DataFrame
        DataFrame with the spatial coordinates of the tiles and their corresponding patch identifiers.
    qs : list
        List of quantiles to compute for each patch.
    sample_id : str, optional
        Sample identifier to prepend to the patch identifiers (default is None).

    Returns
    -------
    df : DataFrame
        DataFrame with the patch representation, indexed by patch identifiers and columns as features.
    """

    df = ad.to_df().loc[df_temp_img_tiles.index]
    df.index = df_temp_img_tiles['patch']
    df = df.groupby(level=0).quantile(qs).unstack()
    df = df.reorder_levels([1, 0], axis=1)
    df = df.T.sort_index().T

    if sample_id is not None:
        df.index = pd.MultiIndex.from_product([[sample_id], df.index], names=['sample', 'patch'])

    return df

def loadDataAndPreparePatches(samples, outsSTQpath, fname, L=None, ts=112, mpp=0.25, N=4):
    """Load the STQ data for each sample, prepare patch coordinates and get patch SAMPLER representations.

    Parameters
    ----------
    samples : list
        List of sample identifiers to load and process.
    outsSTQpath : str
        Path to the directory containing the STQ data for each sample.
    fname : str
        Filename of the STQ data to load for each sample.
    L : int, optional
        Level of the WSI to load (if None, lazy loading with Zarr will be used).
    ts : float
        Center-to-center distance between tiles.
    mpp : float
        Image pixel size in microns per pixel.
    N : int
        Patch size in terms of number of tiles (e.g., 4 means 4×4 tiles).

    Returns
    -------
    ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L, N
    """

    ads = {}
    imgs = {}
    for sample in tqdm(samples):
        ads[sample], imgs[sample] = loadAd(f'{outsSTQpath}{sample}/', fname=fname, L=L)

    patchCoordinates = pd.concat(
        [preparePatchesWSI(ads[sample].obs, N=N, spacing=ts / mpp, sample_id=sample) for sample in tqdm(samples)],
        axis=0)

    qs = np.linspace(0.05, 0.95, 10, endpoint=True)
    patchesCDFs = pd.concat(
        [getPatchRepresentation(ads[sample],
                                patchCoordinates.xs(sample, level='sample', axis=0),
                                qs, sample_id=sample) for sample in tqdm(samples)],
        axis=0)

    return ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L, N


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def trainClassifier(annotation_results, patchesCDFs, alpha=None, seed=None, augFunc=None, repeats=1,
                    clfParams={'penalty': 'l2', 'C': 10, 'class_weight': 'balanced',
                               'solver': 'liblinear', 'max_iter': 1000}):
    """Train a classifier using augmented data from positive patches and the original data from negative patches.
    Use getDiscreteCombinedCDFofAllFeatures (PCMA) as the default augmentation function.

    Parameters
    ----------
    annotation_results : dict
        Dictionary with keys as patch identifiers and values as 'positive', 'negative', or 'uncertain'.
    patchesCDFs : DataFrame
        DataFrame with the CDFs of the patches, indexed by patch identifiers and columns as features.
    alpha : float, optional
        The weight for the positive patches in the augmented data. Default is 0.5.
    seed : int, optional
        Random seed for reproducibility. Default is None.
    augFunc : function, optional
        Function to augment the data.
    clfParams : dict, optional
        Parameters for the classifier.

    Returns
    -------
    clf : sklearn.linear_model.LogisticRegression
        The trained classifier.
    """

    getValue = lambda x: pd.MultiIndex.from_tuples([k for k in annotation_results.keys() if annotation_results[k] == x]).sort_values()

    curated_positive = getValue('positive')
    curated_negative = getValue('negative')

    clf = LR(**clfParams)

    if (alpha is not None) and (augFunc is not None):
        dpos_v = []
        for s_pos in curated_positive:
            for i in range(repeats):
                s_neg = np.random.choice(curated_negative)
                df_pos = patchesCDFs.loc[s_pos].unstack()
                df_neg = patchesCDFs.loc[s_neg].unstack()
                assert df_pos.index.equals(df_neg.index)
                acdf = augFunc(df_pos.index.values, df_pos.values,
                               df_neg.values, alpha=alpha, beta=1. - alpha)
                acdf = pd.DataFrame(index=df_pos.index, columns=df_pos.columns, data=acdf)
                dpos_v.append(acdf.T.sort_index().T.stack().rename(s_pos))
        dpos = pd.concat(dpos_v, axis=1).T

        X_train = pd.concat([dpos, patchesCDFs.loc[curated_negative]], sort=False)
        y_train = pd.concat([pd.Series(index=dpos.index, data=1),
                             pd.Series(index=curated_negative, data=0)])
    else:
        X_train = patchesCDFs.loc[curated_positive.union(curated_negative)]
        y_train = pd.concat([pd.Series(index=curated_positive, data=1),
                             pd.Series(index=curated_negative, data=0)]).loc[X_train.index]

    clf.fit(X_train.values, y_train.values)
    clf.feat = X_train.columns.get_level_values(1) + '_' + pd.Index(np.round(X_train.columns.get_level_values(0), 2).astype(str))

    return clf


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def inferProbFast(ad, clf, qs, R=2, f=1.1, col='tprob', tsize=224, s=4000, sh=100,
                  Nmax=10**7, parallel=True, n_jobs=-1, verbose=True,
                  avgNegativePatchCDF=None, erode=True):

    def runChunk(i, j, feat_shape, feat_dtype, coords_shape, coords_dtype,
                 shm_feat_name, shm_coords_name, chunk_mask, neighbor_mask, feat_idx, qs, clf):
        shm_f = shared_memory.SharedMemory(name=shm_feat_name)
        shm_c = shared_memory.SharedMemory(name=shm_coords_name)
        feat_np   = np.ndarray(feat_shape,   dtype=feat_dtype,   buffer=shm_f.buf)
        coords_np = np.ndarray(coords_shape, dtype=coords_dtype, buffer=shm_c.buf)

        sub_feat     = feat_np[neighbor_mask]
        sub_coords   = coords_np[neighbor_mask]
        chunk_coords = coords_np[chunk_mask]

        tree = KDTree(sub_coords)
        all_neighbors = tree.query_ball_point(chunk_coords, f * R * tsize)

        X = np.stack([
            np.quantile(sub_feat[nbrs], qs, axis=0).flatten()[feat_idx]
            for nbrs in all_neighbors
        ])
        probs = clf.predict_proba(X)[:, 1]

        shm_f.close(); shm_c.close()
        return {(i, j): {'x': chunk_coords[:, 0].tolist(),
                         'y': chunk_coords[:, 1].tolist(),
                         'p': probs.tolist()}}

    def _prep(ad, clf, qs, Nmax):
        '''Shared prep between inferProb and inferProbPreview.'''
        ad = ad[:Nmax]
        df_feat = ad.to_df()
        feat_np = np.ascontiguousarray(df_feat.values.astype(float))
        try:
            coords_df = ad.obs[['pxl_row_in_wsi', 'pxl_col_in_wsi']]
        except KeyError:
            coords_df = ad.obs[['pxl_row_in_fullres', 'pxl_col_in_fullres']]
        coords_np = np.ascontiguousarray(coords_df.values[:, [1, 0]].astype(float))
        stacked_index = pd.Index([f"{c}_{np.round(q, 2)}" for q in qs for c in df_feat.columns])
        feat_idx = stacked_index.get_indexer(clf.feat)
        if (feat_idx == -1).any():
            raise ValueError(f"clf.feat entries missing: {np.array(clf.feat)[feat_idx == -1][:5]}")
        return feat_np, coords_np, feat_idx

    feat_np, coords_np, feat_idx = _prep(ad, clf, qs, Nmax)

    shm_feat   = shared_memory.SharedMemory(create=True, size=feat_np.nbytes)
    shm_coords = shared_memory.SharedMemory(create=True, size=coords_np.nbytes)
    np.copyto(np.ndarray(feat_np.shape,   dtype=feat_np.dtype,   buffer=shm_feat.buf),   feat_np)
    np.copyto(np.ndarray(coords_np.shape, dtype=coords_np.dtype, buffer=shm_coords.buf), coords_np)

    limx = coords_np[:, 0].min(), coords_np[:, 0].max()
    limy = coords_np[:, 1].min(), coords_np[:, 1].max()
    gridx = np.append(np.arange(limx[0], limx[1], s), limx[1] + 1)
    gridy = np.append(np.arange(limy[0], limy[1], s), limy[1] + 1)
    sh_val = 1.25 * f * R * tsize

    chunks = [(i, j) for i in range(len(gridx) - 1) for j in range(len(gridy) - 1)]
    params = []
    for i, j in tqdm(chunks, desc='Preparing chunks', disable=not verbose):
        x0, x1 = gridx[i], gridx[i + 1]
        y0, y1 = gridy[j], gridy[j + 1]
        chunk_mask    = ((coords_np[:, 0] >= x0)          & (coords_np[:, 0] < x1) &
                         (coords_np[:, 1] >= y0)          & (coords_np[:, 1] < y1))
        neighbor_mask = ((coords_np[:, 0] >= x0 - sh_val) & (coords_np[:, 0] < x1 + sh_val) &
                         (coords_np[:, 1] >= y0 - sh_val) & (coords_np[:, 1] < y1 + sh_val))
        if chunk_mask.sum() == 0:
            continue
        params.append((i, j, feat_np.shape, feat_np.dtype, coords_np.shape, coords_np.dtype,
                        shm_feat.name, shm_coords.name, chunk_mask, neighbor_mask, feat_idx, qs, clf))

    if verbose:
        print(f"Prepared {len(params)} chunks for inference.")

    try:
        sT = time.time()
        run = delayed(runChunk)
        results_list = (Parallel(n_jobs=n_jobs, backend='loky')(run(*p) for p in params)
                        if parallel else [runChunk(*p) for p in params])
        if verbose:
            print(f"Computed chunks in: {time.time() - sT:.2f}s")
    finally:
        shm_feat.unlink(); shm_feat.close()
        shm_coords.unlink(); shm_coords.close()

    results = {k: v for d in results_list for k, v in d.items()}
    x, y, p = [], [], []
    for i, j in chunks:
        if (i, j) not in results:
            continue
        x.extend(results[(i, j)]['x'])
        y.extend(results[(i, j)]['y'])
        p.extend(results[(i, j)]['p'])

    if erode:
        p = erodePointProbs(x, y, p, R=R)

    return x, y, p

def erodePointProbs(x, y, p, R=2):

    def soft_erode_circle(prob_mask, radius=3):

        def circular_footprint(radius):
            y, x = np.ogrid[-radius:radius+1, -radius:radius+1]
            mask = x**2 + y**2 <= radius**2
            return mask

        footprint = circular_footprint(radius)
        eroded = generic_filter(prob_mask, np.nanmin, footprint=footprint)
        return eroded

    tspx = int(np.round(np.median(np.diff(np.unique(np.sort(x))))))

    col = np.floor(np.array(x) / tspx).astype(int)
    row = np.floor(np.array(y) / tspx).astype(int)
    arr = np.zeros((int(max(row)) + 1, int(max(col)) + 1), dtype=np.float32) * np.nan

    raw_prob = np.array(p)
    for i in range(len(raw_prob)):
        arr[row[i], col[i]] = raw_prob[i]
    earr = soft_erode_circle(arr, radius=R - 1)

    ep = np.zeros_like(p)
    for i in range(len(raw_prob)):
        ep[i] = earr[row[i], col[i]]

    return ep
