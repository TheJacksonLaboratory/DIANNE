
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

import tifffile

import matplotlib
from matplotlib import cm
from matplotlib.colors import LinearSegmentedColormap
import matplotlib.pyplot as plt
import matplotlib.patheffects as path_effects


def loadImFeatures(dpath):
    df_temp = pd.read_csv(dpath, index_col=[0,1], sep=',').xs(1, level='in_tissue')
    df_temp.insert(0, 'original_barcode', df_temp.index.values)
    ad = sc.AnnData(X=df_temp.loc[:, df_temp.columns.str.contains('feat')],
                    obs=df_temp.loc[:, ~df_temp.columns.str.contains('feat')])
    return ad

def loadAdImage(spath):
    thumbnail = plt.imread(f'{spath}/thumbnail.tiff')
    print(thumbnail.shape)
    with open(f'{spath}/grid/grid.json', 'r') as f:        
        d = json.load(f)
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

def preparePatchesWSI(ad_obs, N=8, spacing=56/0.25, qth=0.05):

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

    print('Prepared patches:', df_temp_img_tiles['patch'].nunique())
    return df_temp_img_tiles

def inferProb(ad, clf, qs, R=2, f=1.1, col='tprob', tsize=56, s=2000, sh=100, Nmax=10**7):

    def getLocalRep(i, j, R, df_feat, df_xy, qs, index=False):
        wh = np.sqrt((df_xy['x']-i).abs().values**2 + (df_xy['y']-j).abs().values**2)<=R
        se = df_feat[wh].quantile(qs).stack()
        if not index:
            return se.values
        else:
            se.index = se.index.get_level_values(1).values + '_' + np.round(se.index.get_level_values(0), 2).astype(str).values
            return se

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

    # Get grid of chunks of size SxS
    gridx = np.append(np.arange(limx[0], limx[1], s), limx[1]+1)
    gridy = np.append(np.arange(limy[0], limy[1], s), limy[1]+1)

    x = []
    y = []
    p = []
    for i in tqdm(range(len(gridx)-1)):
        for j in range(len(gridy)-1):
            x0, x1 = gridx[i], gridx[i+1]
            y0, y1 = gridy[j], gridy[j+1]
            wh = (df_tiles_trimmed_coords['x'] >= x0) &\
                (df_tiles_trimmed_coords['x'] < x1) &\
                (df_tiles_trimmed_coords['y'] >= y0) &\
                (df_tiles_trimmed_coords['y'] < y1)

            index_wh = df_tiles_trimmed_coords.index[wh].copy()
            
            wh = (df_tiles_trimmed_coords['x'] >= x0 - sh) &\
                (df_tiles_trimmed_coords['x'] < x1 + sh) &\
                (df_tiles_trimmed_coords['y'] >= y0 - sh) &\
                (df_tiles_trimmed_coords['y'] < y1 + sh)

            df_tiles_trimmed_wh = df_tiles_trimmed.loc[wh].copy()
            df_tiles_trimmed_coords_wh = df_tiles_trimmed_coords.loc[wh].copy()
            
            for tile in index_wh:
                tx, ty = df_tiles_trimmed_coords_wh.loc[tile, ['x', 'y']]
                x.append(tx)
                y.append(ty)
            
                localRep = getLocalRep(tx, ty, f*R*tsize,
                                       df_tiles_trimmed_wh,
                                       df_tiles_trimmed_coords_wh, qs)
                p.append(clf.predict_proba(localRep[None, index])[:, 1][0])

    return x, y, p

def inferProbY(ad, clf, qs, R=2, f=1.1, col='tprob', tsize=56, s=4000, sh=100, Nmax=10**7):

    def getLocalRepInd(i, j, R, df_feat, df_xy, qs):
        wh = np.sqrt((df_xy['x']-i).abs().values**2 + (df_xy['y']-j).abs().values**2)<=R
        se = df_feat[wh].quantile(qs).stack()
        se.index = se.index.get_level_values(1).values + '_' + np.round(se.index.get_level_values(0), 2).astype(str).values
        return se

    def getLocalRep(i, j, R, df_feat, df_xy, qs):
        wh = np.sqrt((df_xy['x']-i).abs().values**2 + (df_xy['y']-j).abs().values**2)<=R
        return df_feat[wh].quantile(qs).stack().values

    @njit(parallel=True)
    def getLocalRepNum(i, j, R, ar, x, y, qs):
        wh = np.sqrt(np.abs(x-i)**2 + np.abs(y-j)**2)<=R
        m, n = ar.shape[1], len(qs)
        res = np.zeros((m*n,), dtype=np.float64)
        for i in prange(m):
            res[i*n: i*n+n] = np.quantile(ar[wh, i], qs)
        return res.reshape(m, n).T.flatten()

    df_tiles_trimmed = ad[:Nmax].to_df()
    df_tiles_trimmed_coords = ad[:Nmax].obs[['pxl_row_in_wsi', 'pxl_col_in_wsi']].copy()
    df_tiles_trimmed_coords.columns = ['y', 'x']
    N = df_tiles_trimmed.shape[0]
    
    tile = df_tiles_trimmed.index[0]
    i, j = df_tiles_trimmed_coords.loc[tile, ['x', 'y']]
    index = getLocalRepInd(i, j, f*R*tsize, df_tiles_trimmed, df_tiles_trimmed_coords, qs).index.reindex(clf.feat)[1]

    # Coordinates are in xenium physical space.
    limx = df_tiles_trimmed_coords['x'].min(), df_tiles_trimmed_coords['x'].max()
    limy = df_tiles_trimmed_coords['y'].min(), df_tiles_trimmed_coords['y'].max()

    # Get grid of chunks of size SxS
    gridx = np.append(np.arange(limx[0], limx[1], s), limx[1]+1)
    gridy = np.append(np.arange(limy[0], limy[1], s), limy[1]+1)

    indices = []
    for i in range(len(gridx)-1):
        for j in range(len(gridy)-1):
            indices.append((i, j))
            
    x = []
    y = []
    p = []
    for ichunk in tqdm(range(len(indices))):
        i, j = indices[ichunk]
        x0, x1 = gridx[i], gridx[i+1]
        y0, y1 = gridy[j], gridy[j+1]
        wh = (df_tiles_trimmed_coords['x'] >= x0) &\
            (df_tiles_trimmed_coords['x'] < x1) &\
            (df_tiles_trimmed_coords['y'] >= y0) &\
            (df_tiles_trimmed_coords['y'] < y1)

        index_wh = df_tiles_trimmed_coords.index[wh].copy()
        
        wh = (df_tiles_trimmed_coords['x'] >= x0 - sh) &\
            (df_tiles_trimmed_coords['x'] < x1 + sh) &\
            (df_tiles_trimmed_coords['y'] >= y0 - sh) &\
            (df_tiles_trimmed_coords['y'] < y1 + sh)

        df_tiles_trimmed_wh = df_tiles_trimmed.loc[wh].copy()
        df_tiles_trimmed_coords_wh = df_tiles_trimmed_coords.loc[wh].copy()

        reps = []
        Nt = index_wh.shape[0]
        for itile in prange(Nt):
            tile = index_wh[itile]
            tx, ty = df_tiles_trimmed_coords_wh.loc[tile, ['x', 'y']]
            x.append(tx)
            y.append(ty)

            if True:
                localRep = getLocalRep(tx, ty, f*R*tsize,
                                       df_tiles_trimmed_wh,
                                       df_tiles_trimmed_coords_wh,
                                       qs)
            else:
                localRep = getLocalRepNum(tx, ty, f*R*tsize,
                                       df_tiles_trimmed_wh.values,
                                       df_tiles_trimmed_coords_wh['x'].values,
                                       df_tiles_trimmed_coords_wh['y'].values,
                                       qs)
            reps.append(localRep)
        if len(reps)>0:
            reps = np.vstack(reps)[:, index]
            p.extend(clf.predict_proba(reps)[:, 1].tolist())

    return x, y, p

# x, y, p = inferProbY(ad_w, clf_mixed_aug, qs, Nmax=5*10**5)
# pa = np.array(p)
# # pa[pa>0.1] = 1.
# plt.rcParams['figure.figsize'] = (20, 15)
# plt.scatter(x, y, c=pa, cmap='coolwarm', s=1)
# plt.gca().set_aspect('equal')
# plt.gca().axis('off')
# plt.gca().invert_yaxis()
# # plt.colorbar()
# plt.show()
# plt.rcParams['figure.figsize'] = (5, 5)

def loadAdFromH5(spath, L=1, fname='img.data.ctranspath-1.h5ad', suffix=None):
    p = f'{spath}/image.ome.tiff'
    img = tifffile.imread(p, level=L)
    img = np.moveaxis(np.moveaxis(img, 0, 1), 1, 2)
    print(img.shape)
    
    # Load WSI STQ data    
    ad = sc.read_h5ad(spath + fname)
    if not suffix is None:
        ad.obs.index = ad.obs.index + suffix
    image = loadAdImage(spath)
    ad.uns['spatial'] = image[0]
    ad.obsm['spatial'] = pd.DataFrame(index=image[1], data=image[2]).reindex(ad.obs['original_barcode']).values
    spot_size = ad.uns['spatial']['library_id']['scalefactors']['spot_diameter_fullres']
    print(spot_size)
    print(ad.shape)
    sc.pl.spatial(ad, color=None, img_key='lowres')
    return ad, img

def getPatchRepresentation(ad, df_temp_img_tiles, qs):
    df = ad.to_df().loc[df_temp_img_tiles.index]
    df.index = df_temp_img_tiles['patch']
    df = df.groupby(level=0).quantile(qs).unstack()
    df = df.reorder_levels([1, 0], axis=1)
    df = df.T.sort_index().T
    return df

def trainAugClassifier(button_press_results, alpha=0.5):

    curated_positive_w = pd.Index([k for k in button_press_results.keys() if button_press_results[k]=='yes']).sort_values()
    curated_negative_w = pd.Index([k for k in button_press_results.keys() if button_press_results[k]=='no']).sort_values()
    
    np.random.seed(42)
    curated_positive = curated_positive_w
    curated_negative = curated_negative_w
    
    np.random.seed(0)
    dpos = {}
    for s_pos in curated_positive:
        s_neg = np.random.choice(curated_negative)
        df_pos = patchesCDFs_w.loc[s_pos].unstack()
        df_neg = patchesCDFs_w.loc[s_neg].unstack()
        assert df_pos.index.equals(df_neg.index)
        acdf = getDiscreteCombinedCDFofAllFeatures(df_pos.index.values, df_pos.values, df_neg.values, alpha=alpha, beta=1.-alpha)
        acdf = pd.DataFrame(index=df_pos.index, columns=df_pos.columns, data=acdf).T.sort_index().T.stack().rename(s_pos)
        dpos[s_pos] = acdf
    
    X_train = pd.concat([pd.DataFrame(dpos).T, patchesCDFs_w.loc[curated_negative]])
    y_train = pd.concat([pd.Series(index=curated_positive, data=1), pd.Series(index=curated_negative, data=0)]).loc[X_train.index]
    
    clf_mixed_aug = LR(penalty='l2', C=10, class_weight='balanced', solver='liblinear', max_iter=1000)
    clf_mixed_aug.fit(X_train.values, y_train.values)
    clf_mixed_aug.feat = X_train.columns.get_level_values(1) + '_' + pd.Index(np.round(X_train.columns.get_level_values(0), 2).astype(str))
    return clf_mixed_aug

def showProb(x, y, p, s=1, figsize=(25, 15), marker='o', colorbar=False, filter=None, vmin=None, vmax=None):
    pa = np.array(p)
    if not filter is None:
        pa[pa>filter] = 1.
    plt.rcParams['figure.figsize'] = figsize
    plt.scatter(x, y, c=pa, cmap='coolwarm', s=s, marker=marker, vmin=vmin, vmax=vmax)
    plt.gca().set_aspect('equal')
    plt.gca().axis('off')
    plt.gca().invert_yaxis()
    if colorbar:
        plt.colorbar()
    plt.show()
    return

# ad, img = loadAdFromH5('results-STQ/014-aj-hd/', fname='img.data.ctranspath-1.h5ad')
# df_temp_img_tiles = preparePatchesWSI(ad.obs, N=8, spacing=56/0.25) # hd

