
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

from numba import njit, prange
from numpy.typing import NDArray

from sklearn.svm import SVC
from sklearn.linear_model import LogisticRegression as LR
from sklearn.metrics import roc_auc_score, roc_curve
from sklearn.metrics import adjusted_rand_score as ARI

from scipy.spatial import KDTree
from joblib import Parallel, delayed

import tifffile

from .combineCDF import getDiscreteCombinedCDFofAllFeatures as PCMA

import matplotlib
from matplotlib import cm
from matplotlib.colors import LinearSegmentedColormap
import matplotlib.pyplot as plt
import matplotlib.patheffects as path_effects

def loadAd(spath, L=None, fname='img.data.ctranspath-1.h5ad', suffix=None, verbose=False):

    '''Load or pepare AnnData object and image from the specified path.

    Parameters
    ----------

    spath : str
        Path to the STQ output directory containing the image and AnnData or imaging features file.

    L : int, optional
        Level of the image to load (default is None, which assigns full image path to the output imgage).
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

    imagePath = os.path.join(spath, 'image.ome.tiff')
    if not L is None:
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

    if not suffix is None:
        ad.obs.index = ad.obs.index + suffix

    image = loadAdImage(spath, verbose=verbose)
    ad.uns['spatial'] = image[0]
    ad.obsm['spatial'] = pd.DataFrame(index=image[1], data=image[2]).reindex(ad.obs['original_barcode']).values
    spot_size = ad.uns['spatial']['library_id']['scalefactors']['spot_diameter_fullres']

    if verbose:
        print(spot_size)
        print(ad.shape)

    return ad, img

def loadImFeatures(dpath):
    df_temp = pd.read_csv(dpath, index_col=[0,1], sep=',').xs(1, level='in_tissue')
    df_temp.insert(0, 'original_barcode', df_temp.index.values)
    ad = sc.AnnData(X=df_temp.loc[:, df_temp.columns.str.contains('feat')],
                    obs=df_temp.loc[:, ~df_temp.columns.str.contains('feat')])
    return ad

def loadAdImage(spath, verbose=False):
    thumbnail = plt.imread(f'{spath}/thumbnail.tiff')
    if verbose:
        print(thumbnail.shape)
    with open(f'{spath}/grid/grid.json', 'r') as f:        
        d = json.load(f)
    if verbose:
        print(d)
    # print(img.shape)
    grid = pd.read_csv(f'{spath}/grid/grid.csv', index_col=0, header=None)
    image = {'library_id': {'images': {'lowres': thumbnail,
                                       # 'fullres': img,
                                      },
                                'metadata': {'chemistry_description': None, 'software_version': None},
                                'scalefactors': {'tissue_lowres_scalef': thumbnail.shape[0]/d['y'],
                                                 # 'tissue_fullres_scalef': img.shape[0]/d['y'],
                                                    'spot_diameter_fullres': d['spot_diameter_fullres']}}}, grid.index.values, grid[[5, 4]].values
    return image

def preparePatchesWSI(ad_obs, N=8, spacing=56/0.25, qth=0.05, sample_id=None, verbose=False):

    '''Prepare patches for WSI data.
    Input is a dataframe with columns 'x' and 'y' or 'pxl_col_in_wsi' and 'pxl_row_in_wsi',
    denoting the spatial coordinates of tile centers in the WSI.
    Spacing is in the same units as the coordinates. 'x' and 'y' are in xenium physical space, µm.
    'pxl_col_in_wsi' and 'pxl_row_in_wsi' are in pixels.
    N is the number of patches in one dimension.
    qth is the low quantile threshold for the patch size distribution, i.e. patches with size below this threshold are removed.

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
        df_temp_img_tiles = ad_obs[['pxl_col_in_wsi', 'pxl_row_in_wsi']].copy().rename({'pxl_col_in_wsi': 'x', 'pxl_row_in_wsi': 'y'}, axis=1)
    else:
        df_temp_img_tiles = ad_obs[['x', 'y']].copy()

    # Coordinates are in xenium physical space.
    limx = df_temp_img_tiles['x'].min(), df_temp_img_tiles['x'].max()
    limy = df_temp_img_tiles['y'].min(), df_temp_img_tiles['y'].max()

    # Get grid of patches of size SxS
    S = N * spacing
    gridx = np.append(np.arange(limx[0], limx[1], S), limx[1]+1)
    gridy = np.append(np.arange(limy[0], limy[1], S), limy[1]+1)

    for i in range(len(gridx)-1):
        for j in range(len(gridy)-1):
            x0, x1 = gridx[i], gridx[i+1]
            y0, y1 = gridy[j], gridy[j+1]
            df_temp_img_tiles.loc[(df_temp_img_tiles['x'] >= x0) &\
                                    (df_temp_img_tiles['x'] < x1) &\
                                    (df_temp_img_tiles['y'] >= y0) &\
                                    (df_temp_img_tiles['y'] < y1), 'patch'] = f'patch_{i}_{j}'

    # Add patch size to the dataframe for further filtering of patches
    df_temp_img_tiles['patch_size'] = df_temp_img_tiles['patch'].value_counts().reindex(df_temp_img_tiles['patch'].values).values

    # Filter patches by size
    df_temp_img_tiles = df_temp_img_tiles.loc[df_temp_img_tiles['patch_size'] >= df_temp_img_tiles['patch_size'].quantile(qth)]

    if not sample_id is None:
        df_temp_img_tiles['sample'] = sample_id
        df_temp_img_tiles = df_temp_img_tiles.set_index(['sample'], append=True).reorder_levels(['sample', 'barcode'])

    if verbose:
        print('Prepared patches:', df_temp_img_tiles['patch'].nunique())
    return df_temp_img_tiles

def inferProb(ad, clf, qs, R=2, f=1.1, col='tprob', tsize=224, s=4000, sh=100, Nmax=10**7, parallel=True, verbose=True, avgNegativePatchCDF=None):

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
    df_tiles_trimmed_coords = ad[:Nmax].obs[['pxl_row_in_wsi', 'pxl_col_in_wsi']].copy()
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

    if parallel:
        # Parallelize the computation to get local representation for each tile in the chunk and infer the probability
        sT = time.time()
        results = Parallel(n_jobs=-1, backend='loky')(delayed(runChunk)(*param) for param in params)
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

    return x, y, p

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

    if not sample_id is None:
        df.index = pd.MultiIndex.from_product([[sample_id], df.index], names=['sample', 'patch'])

    return df

def trainClassifier(annotation_results, patchesCDFs, alpha=None, seed=None, augFunc=None,
                    clfParams={'penalty': 'l2', 'C': 10, 'class_weight': 'balanced', 'solver': 'liblinear', 'max_iter': 1000}):

    """
    Train a classifier using augmented data from positive patches and the original data from negative patches.

    Parameters
    ----------
    annotation_results : dict
        Dictionary with keys as patch identifiers and values as 'positive', 'negative', or 'uncertain'.
        This indicates the annotation of each patch.

    patchesCDFs : DataFrame
        DataFrame with the CDFs of the patches, indexed by patch identifiers and columns as features.

    alpha : float, optional
        The weight for the positive patches in the augmented data. Default is 0.5.

    seed : int, optional
        Random seed for reproducibility. Default is None.

    augFunc : function, optional
        Function to augment the data. It should take the index values, positive values, negative values,
        and parameters alpha and beta as input and return the augmented data.

    clfParams : dict, optional
        Parameters for the classifier. Default is a dictionary with parameters for Logistic Regression.

    Returns
    -------
    clf : sklearn.linear_model.LogisticRegression
        The trained classifier.
    """

    getValue = lambda x: pd.MultiIndex.from_tuples([k for k in annotation_results.keys() if annotation_results[k]==x]).sort_values()

    curated_positive = getValue('positive')
    curated_negative = getValue('negative')

    clf = LR(**clfParams)

    if (not alpha is None) and (not augFunc is None):
        dpos = {}
        for s_pos in curated_positive:
            s_neg = np.random.choice(curated_negative)
            df_pos = patchesCDFs.loc[s_pos].unstack()
            df_neg = patchesCDFs.loc[s_neg].unstack()
            assert df_pos.index.equals(df_neg.index)
            acdf = augFunc(df_pos.index.values, df_pos.values, 
                            df_neg.values, alpha=alpha, beta=1.-alpha)
            acdf = pd.DataFrame(index=df_pos.index,
                                columns=df_pos.columns,
                                data=acdf)

            dpos[s_pos] = acdf.T.sort_index().T.stack().rename(s_pos)
        X_train = pd.concat([pd.DataFrame(dpos).T, patchesCDFs.loc[curated_negative]])
        y_train = pd.concat([pd.Series(index=curated_positive, data=1),
                            pd.Series(index=curated_negative, data=0)]).loc[X_train.index]
    else:
        X_train = patchesCDFs.loc[curated_positive.union(curated_negative)]
        y_train = pd.concat([pd.Series(index=curated_positive, data=1),
                            pd.Series(index=curated_negative, data=0)]).loc[X_train.index]
    
    clf.fit(X_train.values, y_train.values)
    clf.feat = X_train.columns.get_level_values(1) + '_' + pd.Index(np.round(X_train.columns.get_level_values(0), 2).astype(str))

    return clf

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
        return xa.astype(int) * f

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
