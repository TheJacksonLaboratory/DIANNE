
import warnings
from numba.core.errors import NumbaDeprecationWarning, NumbaPendingDeprecationWarning
warnings.simplefilter('ignore', category=NumbaDeprecationWarning)
warnings.simplefilter('ignore', category=NumbaPendingDeprecationWarning)

import time
from datetime import datetime
import os
import json
import pickle
import numpy as np
import pandas as pd
import scanpy as sc
from tqdm import tqdm
import scipy

from numba import njit, prange
from numpy.typing import NDArray

from sklearn.svm import SVC
from sklearn.linear_model import LogisticRegression as LR
from sklearn.metrics import roc_auc_score, roc_curve
from sklearn.metrics import adjusted_rand_score as ARI

from scipy.spatial import KDTree
from scipy.ndimage import generic_filter
from joblib import Parallel, delayed

import cv2
import tifffile

from .combineCDF import getDiscreteCombinedCDFofAllFeatures as PCMA
from .interpolation import interpolate_points

import matplotlib
from matplotlib import cm
from matplotlib.colors import LinearSegmentedColormap
import matplotlib.pyplot as plt
import matplotlib.patheffects as path_effects

from .core import (
    erodePointProbs,
    loadAd,
    loadImFeatures,
    loadAdImage,
    preparePatchesWSI,
    inferProbFast,
    getPatchRepresentation,
    trainClassifier,
)



def inferProbPreview(ad, clf, qs, R=2, f=1.1, col='tprob', tsize=224, s=4000, sh=100, Nmax=10**7, parallel=True, n_jobs=-1, verbose=True, avgNegativePatchCDF=None, erode=True, step=20):
    from scipy.interpolate import RegularGridInterpolator

    # --- prep full coords ---
    ad = ad[:Nmax]
    df_feat = ad.to_df()
    feat_np = df_feat.values.astype(float)
    try:
        coords_df = ad.obs[['pxl_row_in_wsi', 'pxl_col_in_wsi']]
    except KeyError:
        coords_df = ad.obs[['pxl_row_in_fullres', 'pxl_col_in_fullres']]
    coords_np = coords_df.values[:, [1, 0]].astype(float)  # (x, y)

    stacked_index = pd.Index([f"{c}_{np.round(q, 2)}" for q in qs for c in df_feat.columns])
    feat_idx = stacked_index.get_indexer(clf.feat)
    if (feat_idx == -1).any():
        raise ValueError(f"clf.feat entries missing: {np.array(clf.feat)[feat_idx==-1][:5]}")

    # --- subsample on regular grid ---
    uxs = np.sort(np.unique(coords_np[:, 0]))
    uys = np.sort(np.unique(coords_np[:, 1]))
    sample_xs = uxs[::step]
    sample_ys = uys[::step]
    sample_set_x = set(sample_xs)
    sample_set_y = set(sample_ys)
    sample_mask = np.array([x in sample_set_x and y in sample_set_y
                            for x, y in coords_np])

    sample_coords = coords_np[sample_mask]
    sample_feat   = feat_np[sample_mask]

    if verbose:
        print(f"Preview: {sample_mask.sum()} sampled tiles from {len(coords_np)} total.")

    # --- infer on sample (serial, 1 CPU, no loky overhead) ---
    tree = KDTree(sample_coords)
    # use full coords for neighbor lookup so edge tiles get proper context
    full_tree = KDTree(coords_np)
    all_neighbors = full_tree.query_ball_point(sample_coords, f * R * tsize)

    sT = time.time()
    X = np.stack([
        np.quantile(feat_np[nbrs], qs, axis=0).flatten()[feat_idx]
        for nbrs in all_neighbors
    ])
    probs_sample = clf.predict_proba(X)[:, 1]
    if verbose:
        print(f"Preview inference in: {time.time()-sT:.2f}s")

    # --- interpolate to full grid ---
    # build a value grid over (sample_xs, sample_ys), fill missing with nearest
    prob_grid = np.full((len(sample_xs), len(sample_ys)), np.nan)
    xi = np.searchsorted(sample_xs, sample_coords[:, 0])
    yi = np.searchsorted(sample_ys, sample_coords[:, 1])
    prob_grid[xi, yi] = probs_sample

    # fill any missing grid points (sparse corners) with nearest neighbor
    from scipy.ndimage import generic_filter
    nan_mask = np.isnan(prob_grid)
    if nan_mask.any():
        prob_grid[nan_mask] = generic_filter(prob_grid, lambda v: v[~np.isnan(v)].mean() if (~np.isnan(v)).any() else 0., size=3)[nan_mask]

    interp = RegularGridInterpolator(
        (sample_xs, sample_ys), prob_grid,
        method='linear', bounds_error=False, fill_value=None  # extrapolate at edges
    )
    p = interp(coords_np).tolist()
    x = coords_np[:, 0].tolist()
    y = coords_np[:, 1].tolist()

    if erode:
        p = erodePointProbs(x, y, p, R=R)

    return x, y, p

def inferProb(ad, clf, qs, R=2, f=1.1, col='tprob', tsize=224, s=4000, sh=100, Nmax=10**7, parallel=True, n_jobs=-1, verbose=True, avgNegativePatchCDF=None, erode=True):

    '''Infer the probability of each tile in the image using a trained classifier.

    The function computes the local representation of each tile using the specified quantiles and radius,
    and then predicts the probability using the pre-trained classifier. The results are returned as lists of
    x-coordinates, y-coordinates, and predicted probabilities.

    This function processes the tiles in chunks to optimize memory usage and speed.
    It uses joblib "loky"-backed parallel processing to compute the local representation and predict probabilities for each tile.
    For each chunk of tiles, it computes the local tile SAMPLER representation using a KDTree for efficient querying of neighboring tiles.

    Parameters
    ----------

    ad : AnnData
        AnnData object containing the imaging features.

    clf : sklearn.linear_model.LogisticRegression
        Trained classifier for predicting the probability of each tile.

    qs : list
        List of quantiles to compute for each tile.

    R : float, optional
        Radius for local representation (default is 2).

    f : float, optional
        Factor to scale the radius (default is 1.1).

    col : str, optional
        Column name for the probability values in the output (default is 'tprob').

    tsize : int, optional
        Size of the tiles in pixels (default is 56).

    s : int, optional
        Size of the chunks for processing (default is 4000).

    sh : int, optional
        Size of the overlap between chunks (default is 100).

    Nmax : int, optional
        Maximum number of tiles to process (default is 10^7).

    parallel : bool, optional
        If True, use parallel processing (default is True).

    verbose : bool, optional
        If True, print progress information (default is True).

    avgNegativePatchCDF : DataFrame, optional
        Average CDF of negative patches for adjustment (default is None).

    erode : bool, optional
        If True, apply erosion to the predicted probabilities (default is True).

    Returns
    -------
    x : list
        List of x-coordinates of the tiles.

    y : list
        List of y-coordinates of the tiles.

    p : list
        List of predicted probabilities for each tile.
    '''


    def getLocalRep(i, j, R, df_feat, df_xy, qs, index=False, tree=None):

        if tree is None:
            wh = np.sqrt((df_xy['x']-i).abs().values**2 + (df_xy['y']-j).abs().values**2)<=R
            se = df_feat[wh].quantile(qs).stack()
        else:
            iwh = tree.query_ball_point([i, j], R)
            # print(len(iwh))
            se = df_feat.iloc[iwh].quantile(qs).stack()

        if not index:
            return se.values
        else:
            se.index = se.index.get_level_values(1).values + '_' + np.round(se.index.get_level_values(0), 2).astype(str).values

            return se

    def runChunk(i, j, df_tiles_trimmed_wh, df_tiles_trimmed_coords_wh, index_wh, f, R, size, qs, index, avgNegativePatchCDF):

        tree = KDTree(df_tiles_trimmed_coords_wh[['x', 'y']].values)

        if not avgNegativePatchCDF is None and len(index_wh)>0:
            tile = index_wh[0]
            tx, ty = df_tiles_trimmed_coords_wh.loc[tile, ['x', 'y']]
            ifull = getLocalRep(tx, ty, f*R*tsize,
                            df_tiles_trimmed_wh,
                            df_tiles_trimmed_coords_wh, qs, tree=tree, index=True).index
            tempNegCDF = avgNegativePatchCDF.copy()
            tempNegCDF.index = tempNegCDF.index.get_level_values(1).values + '_' + np.round(tempNegCDF.index.get_level_values(0), 2).astype(str).values
            avgNegativePatchCDF = avgNegativePatchCDF.iloc[tempNegCDF.index.reindex(ifull)[1]]

        alpha = 0.5

        x_ = []
        y_ = []
        p_ = []
        for tile in index_wh:
            tx, ty = df_tiles_trimmed_coords_wh.loc[tile, ['x', 'y']]
            x_.append(tx)
            y_.append(ty)
        
            localRep = getLocalRep(tx, ty, f*R*tsize,
                                    df_tiles_trimmed_wh,
                                    df_tiles_trimmed_coords_wh, qs, tree=tree)[None, index]

            if not avgNegativePatchCDF is None:
                df_neg = avgNegativePatchCDF.unstack()
                df_pos = pd.Series(index=avgNegativePatchCDF.index,data=localRep[0]).unstack()

                acdf = pd.DataFrame(index=df_pos.index,
                                    columns=df_pos.columns,
                                    data=PCMA(df_pos.index.values, df_pos.values, 
                                                df_neg.values, alpha=alpha, beta=1.-alpha)).fillna(0.)

                se = acdf.T.sort_index().T.stack().rename(tile)
                se.index = se.index.get_level_values(1).values + '_' + np.round(se.index.get_level_values(0), 2).astype(str).values

                localRep = se.loc[clf.feat].values[None, :]

            p_.append(clf.predict_proba(localRep)[:, 1][0])

        return {(i, j): {'x': x_, 'y': y_, 'p': p_}}

    df_tiles_trimmed = ad[:Nmax].to_df()
    try:
        df_tiles_trimmed_coords = ad[:Nmax].obs[['pxl_row_in_wsi', 'pxl_col_in_wsi']].copy()
    except:
        df_tiles_trimmed_coords = ad[:Nmax].obs[['pxl_row_in_fullres', 'pxl_col_in_fullres']].copy()
    df_tiles_trimmed_coords.columns = ['y', 'x']
    N = df_tiles_trimmed.shape[0]
    
    tile = df_tiles_trimmed.index[0]
    i, j = df_tiles_trimmed_coords.loc[tile, ['x', 'y']]
    index = getLocalRep(i, j, f*R*tsize, df_tiles_trimmed, df_tiles_trimmed_coords, qs, index=True).index.reindex(clf.feat)[1]

    # Coordinates are in xenium physical space.
    limx = df_tiles_trimmed_coords['x'].min(), df_tiles_trimmed_coords['x'].max()
    limy = df_tiles_trimmed_coords['y'].min(), df_tiles_trimmed_coords['y'].max()

    # Get grid of chunks of size sxs
    gridx = np.append(np.arange(limx[0], limx[1], s), limx[1]+1)
    gridy = np.append(np.arange(limy[0], limy[1], s), limy[1]+1)

    x = []
    y = []
    p = []
    params = []
    chunks = [(i, j) for i in range(len(gridx)-1) for j in range(len(gridy)-1)]
    for i, j in tqdm(chunks, desc='Preparing chunks', disable=not verbose):
        x0, x1 = gridx[i], gridx[i+1]
        y0, y1 = gridy[j], gridy[j+1]
        wh = (df_tiles_trimmed_coords['x'] >= x0) &\
            (df_tiles_trimmed_coords['x'] < x1) &\
            (df_tiles_trimmed_coords['y'] >= y0) &\
            (df_tiles_trimmed_coords['y'] < y1)

        index_wh = df_tiles_trimmed_coords.index[wh].copy()

        sh = 1.25 * f*R*tsize

        wh = (df_tiles_trimmed_coords['x'] >= x0 - sh) &\
            (df_tiles_trimmed_coords['x'] < x1 + sh) &\
            (df_tiles_trimmed_coords['y'] >= y0 - sh) &\
            (df_tiles_trimmed_coords['y'] < y1 + sh)

        df_tiles_trimmed_wh = df_tiles_trimmed.loc[wh].copy()
        df_tiles_trimmed_coords_wh = df_tiles_trimmed_coords.loc[wh].copy()

        params.append((i, j, df_tiles_trimmed_wh, df_tiles_trimmed_coords_wh, index_wh, f, R, tsize, qs, index, avgNegativePatchCDF))

    if verbose:
        print(f"Prepared {len(params)} chunks for inference.")
    if parallel:
        # Parallelize the computation to get local representation for each tile in the chunk and infer the probability
        sT = time.time()
        if n_jobs!=-1:
            print(f"Using {n_jobs} parallel jobs for inference.")
        results = Parallel(n_jobs=n_jobs, backend='loky')(delayed(runChunk)(*param) for param in params)
        if verbose:
            print(f"Computed chunks in: {time.time() - sT:.2f} seconds")
    else:
        results = [runChunk(*param) for param in params]

    # Convert list of dictionaries to a single dictionary
    results = {k: v for d in results for k, v in d.items()}

    # Assemble the results from all chunks in the order
    for i, j in chunks:
        x.extend(results[(i, j)]['x'])
        y.extend(results[(i, j)]['y'])
        p.extend(results[(i, j)]['p'])

    if erode:
        p = erodePointProbs(x, y, p, R=R)

    return x, y, p

def showProb(x, y, p, s=1, figsize=(25, 15), marker='o', colorbar=False, filter=None, vmin=None, vmax=None, title=None, fontsize=16, cmapColors=['red', 'blue']):

    '''Visualize the probability map as a scatter plot.

    Parameters
    ----------

    x : NDArray
        x-coordinates of the points to plot.

    y : NDArray
        y-coordinates of the points to plot.

    p : NDArray
        Probability values associated with each point.

    s : int, optional
        Size of the points in the scatter plot (default is 1).

    figsize : tuple, optional
        Size of the figure (default is (25, 15)).

    marker : str, optional
        Marker style for the scatter plot (default is 'o').

    colorbar : bool, optional
        If True, display a colorbar (default is False).

    filter : float, optional
        If specified, filter out probability values greater than this threshold (default is None).

    vmin : float, optional
        Minimum value for the color scale (default is None, which uses the minimum of p).

    vmax : float, optional
        Maximum value for the color scale (default is None, which uses the maximum of p).

    title : str, optional
        Title for the plot (default is None).
    
    fontsize : int, optional
        Font size for the title (default is 16).
    '''

    pa = np.array(p)
    if not filter is None:
        pa[pa>filter] = 1.

    fig, ax = plt.subplots(figsize=figsize)

    cmap = LinearSegmentedColormap.from_list(None, cmapColors, N=256)
    sco = ax.scatter(x, y, c=pa, cmap=cmap, s=s, marker=marker, vmin=vmin, vmax=vmax)

    ax.set_aspect('equal')
    ax.axis('off')
    ax.invert_yaxis()

    if colorbar:
        plt.colorbar(sco, ax=ax, orientation='vertical', pad=0.01, shrink=0.5)

    if title is not None:
        ax.set_title(title, fontsize=fontsize)

    plt.show()

    return

def showProbImg(x, y, p, f=1, ts=56, mpp=0.25, figsize=(3, 3), colorbar=True, filter=None, vmin=0, vmax=1,
                title=None, fontsize=16, cmapColors=['lightcoral', 'gold', 'blue'],
                ticks=[0, 0.5, 1], shrink=0.35, invert=True, saveName=None, dpi=100):

    '''Show the probability map as an image

    Parameters
    ----------
    x : list
        The x coordinates of the tiles

    y : list
        The y coordinates of the tiles

    p : list
        The probability of the tiles

    f : int
        The factor to scale the image

    ts : int
        The size of the tiles

    mpp : float
        The microns per pixel resolution

    figsize : tuple
        The size of the figure

    colorbar : bool
        Whether to show the colorbar

    filter : float
        The filter value

    vmin : float
        The minimum value of the colorbar

    vmax : float
        The maximum value of the colorbar

    title : str
        The title of the plot

    fontsize : int
        The fontsize of the title

    cmapColors : list
        The colors of the colormap

    ticks : list
        The ticks of the colorbar

    shrink : float
        The shrink of the colorbar
    '''

    def funcScale(x, f):
        xa = (np.array(x) / (ts/mpp))
        xa -= np.min(xa)
        return np.round(xa * float(f)).astype(int)

    xa = funcScale(x, f)
    ya = funcScale(y, f)

    pa = np.array(p)
    if not filter is None:
        pa[pa>filter] = 1.

    img = np.zeros(((max(ya)+1), (max(xa)+1)), dtype=np.float32) * np.nan
    for i in range(len(pa)):
        img[ya[i]:ya[i]+f, xa[i]:xa[i]+f] = pa[i]

    fig, ax = plt.subplots(1, 1, figsize=(figsize[0]*f, figsize[1]*f))

    cmap = LinearSegmentedColormap.from_list(None, cmapColors, N=256)
    imh = ax.imshow(img, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')

    ax.axis('off')

    if colorbar:
        if ticks is None:
            ticks = np.linspace(vmin, vmax, 3)
        plt.colorbar(imh, ticks=ticks, shrink=shrink)

    if not title is None:
        ax.set_title(title, fontsize=fontsize)

    if invert:
        ax.invert_yaxis()

    if not saveName is None:
        plt.savefig(saveName, bbox_inches='tight', dpi=dpi)
        plt.close(fig)
    else:
        plt.show()

    return

def showGridProb(ads, clf, samples, qs, ts=56, mpp=0.25, R=2, dpi=150, size=3., f=1, n_cols=4, verbose=True):
    # To run inference on the entire slides and save the images, and then display them in a grid
    for i in tqdm(range(len(samples)), desc='Inference progress', disable=not verbose):
        infSample  = samples[i]
        x, y, p = inferProb(ads[infSample], clf['clf'], qs, tsize=ts/mpp, R=R, verbose=False)
        x, y, p = interpolate_points(x, y, p, multiplier=8)
        showProbImg(x, y, p, f=f, figsize=(3, 3), ts=ts, mpp=mpp, title=infSample, invert=False,
                    saveName=f'{infSample}.png', dpi=dpi)

    nc = n_cols
    nr = int(np.ceil(len(samples) / nc))
    fig, axs = plt.subplots(nr, nc, figsize=(nc*size, nr*size))
    axs = axs.flatten()
    for i in range(nr*nc):
        ax = axs[i]
        if i < len(samples):
            img = plt.imread(f'{samples[i]}.png')
            ax.imshow(img)
        ax.axis('off')
    fig.tight_layout()
    plt.show()
    return

def showMolecularData(sample, df_coordinates, se_color, figsize=(6, 6), cmap='coolwarm', vmin=0, vmax=15, shrink=0.5):
    
    """Show the molecular data for islets in a scatter plot.

    Parameters:
    ----------
    sample (str):
        The sample identifier.
    
    df_coordinates (DataFrame):
        DataFrame containing the coordinates of tiles in 'x' and 'y' columns.

    se_color (Series):
        Series containing the color values for the patches.

    figsize (tuple):
        Size of the figure.

    cmap (str):
        Colormap to use for the scatter plot.

    vmin (float):
        Minimum value for color scaling.

    vmax (float):
        Maximum value for color scaling.
    """

    se_coor = df_coordinates.xs(sample, level='sample')[['x', 'y']]

    ind = se_color.index.intersection(se_coor.index)
    se_color = se_color.loc[ind]
    se_coor = se_coor.loc[ind]

    fig, ax = plt.subplots(figsize=figsize)

    sca = ax.scatter(se_coor['x'], se_coor['y'], c=se_color, s=1, marker='s', cmap=cmap, vmin=vmin, vmax=vmax)

    ax.set_aspect('equal', adjustable='box')
    ax.invert_yaxis()
    ax.axis('off')

    plt.colorbar(sca, shrink=shrink)
    plt.show()

    return

def getGroupNegativeCDF(annotation_results, patchesCDFs, alpha=0.9, seed=None, augFunc=None):

    if seed is not None:
        np.random.seed(seed)

    getValue = lambda x: pd.MultiIndex.from_tuples([k for k in annotation_results.keys() if annotation_results[k]==x]).sort_values()

    curated_negative = getValue('negative')

    sequence = np.random.choice(curated_negative, len(curated_negative), replace=False)

    df_neg_out = patchesCDFs.loc[sequence[0]].unstack()
    for s_neg in sequence[1:]:
        df_neg = patchesCDFs.loc[s_neg].unstack()
        df_neg_out = pd.DataFrame(index=df_neg_out.index,
                                columns=df_neg_out.columns,
                                data=augFunc(df_neg_out.index.values, df_neg_out.values, 
                                            df_neg.values, alpha=alpha, beta=1.-alpha)).T.sort_index().T

    avgNegativePatchCDF = df_neg_out.stack()
    # avgNegativePatchCDF.index = avgNegativePatchCDF.index.get_level_values(1).values + '_' + np.round(avgNegativePatchCDF.index.get_level_values(0), 2).astype(str).values

    return avgNegativePatchCDF

def makeManualAndAutomatedAnnotationComparison(ad, se_inf, se_anno, case, cmapColors=['lightcoral', 'gold', 'blue'], figsize=(6, 3),
                filter=None, f=1, ts=56, mpp=0.25, vmin=0, vmax=1, verbose=False, threshold_for_metrics=0.5):

    """Compare manual annotations with DIANNE inference results.
    Manual annotations are shown on the left, DIANNE inference results on the right.
    Maunal annoitation are fraction of tumor ixels in a tile, DIANNE inference results are probability of tumor in tile.

    Parameters
    ----------
    ad : AnnData
        Annotated data object containing spatial coordinates and features.

    se_inf : pd.Series
        Series containing DIANNE inference probabilities for each tile.

    se_anno : pd.Series
        Series containing manual annotation values for each tile.

    case : str
        Case identifier for the plot title.

    cmapColors : list, optional
        Colors for the colormap, by default ['lightcoral', 'gold', 'blue'].

    figsize : tuple, optional
        Size of the figure, by default (6, 3).

    filter : float, optional
        Threshold to filter out values in the inference series, by default None.

    f : int, optional
        Factor to scale the image, by default 1.

    ts : int, optional
        Tile size in pixels, by default 56.

    mpp : float, optional
        Microns per pixel, by default 0.25.

    vmin : float, optional
        Minimum value for color scaling, by default 0.

    vmax : float, optional
        Maximum value for color scaling, by default 1.

    verbose : bool, optional
        If True, print accuracy, precision, recall, F1 score, correlation, and AUROC, by default False.

    threshold_for_metrics : float, optional
        Threshold for calculating metrics, by default 0.5.
    """

    def get_image_map(x, y, p):

        def funcScale(x, f):
            xa = (np.array(x) / (ts/mpp))
            xa -= np.min(xa)
            return np.round(xa * float(f)).astype(int)

        xa = funcScale(x, f)
        ya = funcScale(y, f)

        pa = np.array(p)
        if not filter is None:
            pa[pa>filter] = 1.

        img = np.zeros(((max(ya)+1), (max(xa)+1)), dtype=np.float32) * np.nan
        for i in range(len(pa)):
            img[ya[i]:ya[i]+f, xa[i]:xa[i]+f] = pa[i]
        return img

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(figsize[0]*f, figsize[1]*f))

    cmap = LinearSegmentedColormap.from_list(None, cmapColors, N=256)

    img1 = get_image_map(ad.obsm['spatial'][:, 0], ad.obsm['spatial'][:, 1], se_anno.values)
    im1 = ax1.imshow(img1, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
    ax1.set_aspect('equal')
    plt.colorbar(im1, shrink=0.5)
    ax1.set_title('Manual Annotation\nFraction of tumor in tile')
    ax1.invert_yaxis()
    ax1.axis('off')

    se_inf_star = se_inf.reindex(se_anno.index)

    img2 = get_image_map(ad.obsm['spatial'][:, 0], ad.obsm['spatial'][:, 1], se_inf_star.values)
    im2 = ax2.imshow(img2, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
    ax2.set_aspect('equal')
    plt.colorbar(im2, shrink=0.5)
    ax2.set_title('DIANNE Inference\nProbaility of tumor in tile')
    ax2.invert_yaxis()
    ax2.axis('off')

    se_anno.iloc[0] = 0.0  # Set first value to zero

    th = threshold_for_metrics

    accuracy = (se_inf_star.values > th).astype(int) == (se_anno.values > th).astype(int)
    accuracy = np.sum(accuracy) / len(accuracy)
    if verbose:
        print(f'Accuracy: {accuracy:.2f}')

    precision = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values > th).astype(int)) / np.sum(se_inf_star.values > th)
    if verbose:
        print(f'Precision: {precision:.2f}')
    
    recall = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values > th).astype(int)) / np.sum(se_anno.values > th)
    if verbose:
        print(f'Recall: {recall:.2f}')

    f1_score = 2 * (precision * recall) / (precision + recall)
    if verbose:
        print(f'F1 Score: {f1_score:.2f}')

    correlation = pd.concat([se_inf_star, se_anno], axis=1).corr().iloc[0, 1]
    if verbose:
        print(f'Correlation: {correlation:.2f}')

    auroc = roc_auc_score((se_anno.values > th).astype(int), se_inf_star.values)
    if verbose:
        print(f'AUROC: {auroc:.2f}')

    plt.suptitle(f'Case: {case}\nPrecision: {precision:.2f}, recall: {recall:.2f}', fontsize=16)
    plt.tight_layout()
    plt.show()

    return

def makeManualAndAutomatedAnnotationComparison4(ad, se_inf_dianne, se_inf_clam, se_inf_segmenter, se_anno, case, cmapColors=['lightcoral', 'gold', 'blue'], panel_size=2, aspect=1.,
                filter=None, f=1, ts=56, mpp=0.25, vmin=0, vmax=1, verbose=False, threshold_for_metrics=0.5, plot=True, ysup=None, show_segmenter=True, flat=False, dpi=100):

    """Compare manual annotations with DIANNE inference results.
    Manual annotations are shown on the left, DIANNE inference results on the right.
    Maunal annoitation are fraction of tumor ixels in a tile, DIANNE inference results are probability of tumor in tile.

    Parameters
    ----------
    ad : AnnData
        Annotated data object containing spatial coordinates and features.

    se_inf : pd.Series
        Series containing DIANNE inference probabilities for each tile.

    se_anno : pd.Series
        Series containing manual annotation values for each tile.

    case : str
        Case identifier for the plot title.

    cmapColors : list, optional
        Colors for the colormap, by default ['lightcoral', 'gold', 'blue'].

    figsize : tuple, optional
        Size of the figure, by default (6, 3).

    filter : float, optional
        Threshold to filter out values in the inference series, by default None.

    f : int, optional
        Factor to scale the image, by default 1.

    ts : int, optional
        Tile size in pixels, by default 56.

    mpp : float, optional
        Microns per pixel, by default 0.25.

    vmin : float, optional
        Minimum value for color scaling, by default 0.

    vmax : float, optional
        Maximum value for color scaling, by default 1.

    verbose : bool, optional
        If True, print accuracy, precision, recall, F1 score, correlation, and AUROC, by default False.

    threshold_for_metrics : float, optional
        Threshold for calculating metrics, by default 0.5.
    """

    def get_image_map(x, y, p):

        def funcScale(x, f):
            xa = (np.array(x) / (ts/mpp))
            xa -= np.min(xa)
            return np.round(xa * float(f)).astype(int)

        xa = funcScale(x, f)
        ya = funcScale(y, f)

        pa = np.array(p)
        if not filter is None:
            pa[pa>filter] = 1.

        img = np.zeros(((max(ya)+1), (max(xa)+1)), dtype=np.float32) * np.nan
        for i in range(len(pa)):
            img[ya[i]:ya[i]+f, xa[i]:xa[i]+f] = pa[i]
        return img

    def get_metrics(se_inf_star, se_anno, th, prefix='method_name_'):
    
        if se_inf_star.min()==se_inf_star.max():
            se_inf_star.iloc[0] = 0.0

        if (se_anno.values > th).astype(int).sum() == 0:
            precision = np.nan
            recall = np.nan
            f1_score = np.nan
        else:
            precision = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values > th).astype(int)) / np.sum(se_inf_star.values > th)
            recall = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values > th).astype(int)) / np.sum(se_anno.values > th)
            f1_score = 2 * (precision * recall) / (precision + recall)

        accuracy = (se_inf_star.values > th).astype(int) == (se_anno.values > th).astype(int)
        accuracy = np.sum(accuracy) / len(accuracy)

        fpr = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values <= th).astype(int)) / np.sum(se_anno.values <= th)

        if verbose:
            print(f'Precision: {precision:.2f}')
            print(f'Recall: {recall:.2f}')
            print(f'F1 Score: {f1_score:.2f}')
            print(f'FPR: {fpr:.2f}')
            print(f'Accuracy: {accuracy:.2f}')

        return {f'{prefix}precision': precision, f'{prefix}recall': recall, f'{prefix}fpr': fpr, f'{prefix}f1_score': f1_score, f'{prefix}accuracy': accuracy}


    result = {}
    result.update({'manual_annotation': se_anno.mean()})

    se_inf_star = se_inf_dianne.reindex(se_anno.index)
    result.update(get_metrics(se_inf_star, se_anno, threshold_for_metrics, prefix='dianne_'))

    se_inf_star = se_inf_clam.reindex(se_anno.index)
    result.update(get_metrics(se_inf_star, se_anno, threshold_for_metrics, prefix='clam_'))

    if show_segmenter:
        se_inf_star = se_inf_segmenter.reindex(se_anno.index)
        result.update(get_metrics(se_inf_star, se_anno, threshold_for_metrics, prefix='segmenter_'))


    if plot:
        n_panels = 4 if show_segmenter else 3

        if flat:
            fig, axs = plt.subplots(1, n_panels, figsize=(panel_size*f*n_panels*aspect, panel_size*f), dpi=dpi)
        else:
            fig, axs = plt.subplots(2, 2, figsize=(panel_size*f*2*aspect, panel_size*f*2), dpi=dpi)
            axs = axs.flatten()

        cmap = LinearSegmentedColormap.from_list(None, cmapColors, N=256)
    
        ax = axs[0]
        img = get_image_map(ad.obsm['spatial'][:, 0], ad.obsm['spatial'][:, 1], se_anno.values)
        im = ax.imshow(img, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
        ax.set_aspect('equal')
        plt.colorbar(im, shrink=0.5)
        ax.set_title('Manual Annotation\nFraction of tumor in tile')
        ax.invert_yaxis()
        ax.axis('off')

        se_inf_star = se_inf_dianne.reindex(se_anno.index)
        ax = axs[1]
        img = get_image_map(ad.obsm['spatial'][:, 0], ad.obsm['spatial'][:, 1], se_inf_star.values)
        im = ax.imshow(img, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
        ax.set_aspect('equal')
        plt.colorbar(im, shrink=0.5)
        ax.invert_yaxis()
        ax.axis('off')
        prefix = 'dianne_'
        prec, rec, acc, fpr = result[f'{prefix}precision'], result[f'{prefix}recall'], result[f'{prefix}accuracy'], result[f'{prefix}fpr']
        if prec != prec:
            strv = f'Specificity {1-fpr:.2f}'
        else:
            strv = f'Pr. {prec:.2f}, rec. {rec:.2f}, sp. {1-fpr:.2f}'
        ax.set_title(f'DIANNE Inference\nProbaility of tumor in tile\n{strv}')

        se_inf_star = se_inf_clam.reindex(se_anno.index)
        ax = axs[2]
        img = get_image_map(ad.obsm['spatial'][:, 0], ad.obsm['spatial'][:, 1], se_inf_star.values)
        im = ax.imshow(img, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
        ax.set_aspect('equal')
        plt.colorbar(im, shrink=0.5)
        ax.invert_yaxis()
        ax.axis('off')
        prefix = 'clam_'
        prec, rec, acc, fpr = result[f'{prefix}precision'], result[f'{prefix}recall'], result[f'{prefix}accuracy'], result[f'{prefix}fpr']
        if prec != prec:
            strv = f'Specificity {1-fpr:.2f}'
        else:
            strv = f'Pr. {prec:.2f}, rec. {rec:.2f}, sp. {1-fpr:.2f}'
        ax.set_title(f'CLAM Inference\nProbaility of tumor in tile\n{strv}')

        if show_segmenter:
            se_inf_star = se_inf_segmenter.reindex(se_anno.index)
            ax = axs[3]
            img = get_image_map(ad.obsm['spatial'][:, 0], ad.obsm['spatial'][:, 1], se_inf_star.values)
            im = ax.imshow(img, cmap=cmap, vmin=vmin, vmax=vmax, interpolation='nearest')
            ax.set_aspect('equal')
            plt.colorbar(im, shrink=0.5)
            ax.invert_yaxis()
            ax.axis('off')
            prefix = 'segmenter_'
            prec, rec, acc, fpr = result[f'{prefix}precision'], result[f'{prefix}recall'], result[f'{prefix}accuracy'], result[f'{prefix}fpr']
            if prec != prec:
                strv = f'Specificity {1-fpr:.2f}'
            else:
                strv = f'Pr. {prec:.2f}, rec. {rec:.2f}, sp. {1-fpr:.2f}'
            ax.set_title(f'Segmenter Inference\nProbaility of tumor in tile\n{strv}')



        # plt.suptitle(f'Case: {case}', fontsize=16, y=ysup)
        plt.tight_layout()
        plt.show()

    return result

def get_tile_mask_means(mfile, ts, mpp, coords):
    try:
        m = tifffile.imread(mfile)
        means = []
        for i in range(len(coords)):
            x0, y0 = coords[i]
            h = int(0.5 * ts / mpp)
            temp = m[y0-h:y0+h, x0-h:x0+h]
            if temp.shape[0]>0 and temp.shape[1]>0:
                tv = temp.mean() / 255.
            else:
                tv = 0.0
            means.append(tv)
    except Exception as exception:
        print(f'Error in get_tile_mask_means: {exception}')
        means = [np.nan] * len(coords)
    return means

def run_one_normal(case, path, clf, plot=False, ysup=None, F=2, featset='ctranspath', qs=None, f=1):
    try:
        ad = loadAd(path, fname=f'features/false-{F}-{featset}_features.tsv.gz')[0]
        ts = 56 * 2
        mpp = 0.25
        x, y, p = inferProb(ad, clf, qs, tsize=0.5*ts/mpp, R=2, verbose=False)
        search = ad.obs.set_index(['pxl_col_in_wsi', 'pxl_row_in_wsi'])['original_barcode']
        se_inf_dianne = pd.Series(index=search.loc[pd.MultiIndex.from_arrays([x, y], names=['pxl_col_in_wsi', 'pxl_row_in_wsi'])].values, data=p)

        means = []
        for i in range(len(ad)):
            means.append(0.0)
        se_anno = pd.Series(index=ad.obs.index, data=means)

        msegfile = f'/projects/chuang-lab/USERS/domans/containers/local/segmenter/results/{case}-segmenter-mask.tiff'
        means = get_tile_mask_means(msegfile, ts, mpp, ad.obsm['spatial'])
        se_inf_segmenter = pd.Series(index=ad.obs.index, data=means)

        # cfile = f'/projects/chuang-lab/USERS/domans/containers/local/clam/results_PCMA/heatmaps-normal-0.2/{case}_attention_weights.csv'
        cfile = f'/projects/chuang-lab/USERS/domans/containers/local/clam/results/heatmaps-normal-R1/{case}_attention_weights.csv'
        se_inf_clam = pd.read_csv(cfile, index_col=0)['tile_probability']

        temp = makeManualAndAutomatedAnnotationComparison4(ad, se_inf_dianne, se_inf_clam, se_inf_segmenter, se_anno, case, ts=56 * 2, filter=0.5, plot=plot, verbose=False, ysup=ysup, aspect=0.85, f=f)
    except Exception as e:
        temp = None
        print(f'Error processing case {case}: {e}')
    return temp

def run_one_tumor(case, path, clf, plot=False, ysup=None, annotationsPath=None, F=2, featset='ctranspath', qs=None, f=1, dpi=100):
    mfile = annotationsPath + case + '_manual_annotation_tumor_mask.tiff'
    if os.path.isfile(mfile):
        m = tifffile.imread(mfile)

        try:
            ad = loadAd(path, fname=f'features/false-{F}-{featset}_features.tsv.gz')[0]
            ts = 56 * 2
            mpp = 0.25
            x, y, p = inferProb(ad, clf, qs, tsize=0.5*ts/mpp, R=2, verbose=False)
            search = ad.obs.set_index(['pxl_col_in_wsi', 'pxl_row_in_wsi'])['original_barcode']
            se_inf_dianne = pd.Series(index=search.loc[pd.MultiIndex.from_arrays([x, y], names=['pxl_col_in_wsi', 'pxl_row_in_wsi'])].values, data=p)

            means = get_tile_mask_means(mfile, ts, mpp, ad.obsm['spatial'])
            se_anno = pd.Series(index=ad.obs.index, data=means)

            msegfile = f'/projects/chuang-lab/USERS/domans/containers/local/segmenter/results/{case}-segmenter-mask.tiff'
            means = get_tile_mask_means(msegfile, ts, mpp, ad.obsm['spatial'])
            se_inf_segmenter = pd.Series(index=ad.obs.index, data=means)

            # cfile = f'/projects/chuang-lab/USERS/domans/containers/local/clam/results_PCMA/heatmaps-tumor-0.2/{case}_attention_weights.csv'
            cfile = f'/projects/chuang-lab/USERS/domans/containers/local/clam/results/heatmaps-tumor-R1/{case}_attention_weights.csv'
            se_inf_clam = pd.read_csv(cfile, index_col=0)['tile_probability']

            temp = makeManualAndAutomatedAnnotationComparison4(ad, se_inf_dianne, se_inf_clam, se_inf_segmenter, se_anno, case, ts=56 * 2, filter=0.5, plot=plot, verbose=False, ysup=ysup, aspect=1.5, f=f, dpi=dpi)
        except Exception as e:
            temp = None
            print(f'Error processing case {case}: {e}')

    return temp

def checkOneSlide(ad, clf, qs=None, ts=None, mpp=None, mfile=None, annotation_threshold=0.1, threshold_for_metrics=0.5, erode=False):

    def get_tile_mask_means(mfile, ts, mpp, coords):
        try:
            m = tifffile.imread(mfile)
            means = []
            for i in range(len(coords)):
                x0, y0 = coords[i]
                h = int(0.5 * ts / mpp)
                temp = m[y0-h:y0+h, x0-h:x0+h]
                if temp.shape[0]>0 and temp.shape[1]>0:
                    tv = temp.mean() / 255.
                else:
                    tv = 0.0
                means.append(tv)
        except Exception as exception:
            print(f'Error in get_tile_mask_means: {exception}')
            means = [0.0] * len(coords)
        return means

    def get_metrics(se_inf_star, se_anno, th, annotation_threshold, prefix='method_name_', verbose=False):
    
        if se_inf_star.min()==se_inf_star.max():
            se_inf_star.iloc[0] = 0.0

        if (se_anno.values > annotation_threshold).astype(int).sum() == 0:
            precision = np.nan
            recall = np.nan
            f1_score = np.nan
        else:
            precision = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values > annotation_threshold).astype(int)) / np.sum(se_inf_star.values > th)
            recall = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values > annotation_threshold).astype(int)) / np.sum(se_anno.values > annotation_threshold)
            f1_score = 2 * (precision * recall) / (precision + recall)

        accuracy = (se_inf_star.values > th).astype(int) == (se_anno.values > annotation_threshold).astype(int)
        accuracy = np.sum(accuracy) / len(accuracy)

        fpr = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values <= annotation_threshold).astype(int)) / np.sum(se_anno.values <= annotation_threshold)

        if verbose:
            print(f'Precision: {precision:.2f}')
            print(f'Recall: {recall:.2f}')
            print(f'F1 Score: {f1_score:.2f}')
            print(f'FPR: {fpr:.2f}')
            print(f'Accuracy: {accuracy:.2f}')

        return {f'{prefix}precision': precision, f'{prefix}recall': recall, f'{prefix}fpr': fpr, f'{prefix}f1_score': f1_score, f'{prefix}accuracy': accuracy}

    
    if os.path.isfile(mfile):
        m = tifffile.imread(mfile)
    means = get_tile_mask_means(mfile, ts, mpp, ad.obsm['spatial'])
    se_anno = pd.Series(index=ad.obs.index, data=means)
    result = {'manual_annotation': se_anno.mean()}

    x, y, p = inferProb(ad, clf, qs, tsize=ts/mpp, R=2, erode=erode)
    search = ad.obs.set_index(['pxl_col_in_wsi', 'pxl_row_in_wsi'])['original_barcode']
    se_inf_dianne = pd.Series(index=search.loc[pd.MultiIndex.from_arrays([x, y], names=['pxl_col_in_wsi', 'pxl_row_in_wsi'])].values, data=p)

    se_inf_star = se_inf_dianne.reindex(se_anno.index)
    result.update(get_metrics(se_inf_star, se_anno, threshold_for_metrics, annotation_threshold, prefix='dianne_'))

    return result

def get_tile_mask_means3(mfile, ts, mpp, coords, scale=None):
    try:
        m = tifffile.imread(mfile)
        if not scale is None:
            m = cv2.resize(m, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
        m_labeled, num = scipy.ndimage.label(m)
        print(f'Found {num} objects in mask')
        means = []
        objects = []
        for i in range(len(coords)):
            x0, y0 = coords[i]
            h = int(0.5 * ts / mpp)
            temp = m[y0-h:y0+h, x0-h:x0+h]
            if temp.shape[0]>0 and temp.shape[1]>0:
                tv = temp.mean() / 255.
                temp2 = m_labeled[y0-h:y0+h, x0-h:x0+h]
                l, c = np.unique(temp2[temp2!=0], return_counts=True)
                if len(l) > 0:
                    obj = l[np.argmax(c)]
                else:
                    obj = 0
            else:
                tv = 0.0
                obj = 0
            means.append(tv)
            objects.append(obj)
    except Exception as exception:
        print(f'Error in get_tile_mask_means: {exception}')
        means = [0.0] * len(coords)
        m_labeled = None
        objects = [0] * len(coords)
    return m_labeled, means, objects

def get_metrics(se_inf_star, se_anno, th, annotation_threshold, prefix='method_name_', verbose=False):

    if se_inf_star.min()==se_inf_star.max():
        se_inf_star.iloc[0] = 0.0

    if (se_anno.values > annotation_threshold).astype(int).sum() == 0:
        precision = np.nan
        recall = np.nan
        f1_score = np.nan
    else:
        precision = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values > annotation_threshold).astype(int)) / np.sum(se_inf_star.values > th)
        recall = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values > annotation_threshold).astype(int)) / np.sum(se_anno.values > annotation_threshold)
        f1_score = 2 * (precision * recall) / (precision + recall)

    accuracy = (se_inf_star.values > th).astype(int) == (se_anno.values > annotation_threshold).astype(int)
    accuracy = np.sum(accuracy) / len(accuracy)

    fpr = np.sum((se_inf_star.values > th).astype(int) & (se_anno.values <= annotation_threshold).astype(int)) / np.sum(se_anno.values <= annotation_threshold)

    if verbose:
        print(f'Precision: {precision:.2f}')
        print(f'Recall: {recall:.2f}')
        print(f'F1 Score: {f1_score:.2f}')
        print(f'FPR: {fpr:.2f}')
        print(f'Accuracy: {accuracy:.2f}')

    return {f'{prefix}precision': precision, f'{prefix}recall': recall, f'{prefix}fpr': fpr, f'{prefix}f1_score': f1_score, f'{prefix}accuracy': accuracy}
