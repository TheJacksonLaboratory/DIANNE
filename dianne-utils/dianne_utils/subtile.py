import numpy as np
import pandas as pd
from numba import njit, prange
from skimage.morphology import disk
from scipy.ndimage import binary_dilation
from tqdm import tqdm
import re

def make_disk_offsets(radius):
    mask = disk(radius).astype(bool)
    di, dj = np.nonzero(mask)
    return di.astype(np.int64), dj.astype(np.int64)

@njit(parallel=True, cache=True, fastmath=True)
def feature_windowed_quantiles_disk_sparse(padded_stack, qs, offsets_i, offsets_j,
                                            valid_i, valid_j, out):
    n_channels = padded_stack.shape[0]
    n_valid = valid_i.shape[0]
    n_q = qs.shape[0]
    wsize = offsets_i.shape[0]
    positions = qs * (wsize - 1)
    for ci in prange(n_channels):
        padded = padded_stack[ci]
        buf = np.empty(wsize, dtype=np.float32)
        for k in range(n_valid):
            i = valid_i[k]
            j = valid_j[k]
            for idx in range(wsize):
                buf[idx] = padded[i + offsets_i[idx], j + offsets_j[idx]]
            buf.sort()
            for qi in range(n_q):
                pos = positions[qi]
                lo = int(pos)
                hi = lo + 1 if lo + 1 < wsize else lo
                frac = pos - lo
                out[k, ci * n_q + qi] = buf[lo] * (1 - frac) + buf[hi] * frac

def blur_quantile_features(
    df_features: pd.DataFrame,
    df_tiles: pd.DataFrame,
    radius: int = 2,
    qs: np.ndarray = np.linspace(0.05, 0.95, 10),
    subgrid: tuple = (7, 7),
    verbose=False,
    val_range=2.0,
):
    n_tiles = len(df_tiles)
    sg_r, sg_c = subgrid
    n_sub = sg_r * sg_c
    n_feat = df_features.shape[1]
    assert df_features.shape[0] == n_tiles * n_sub

    rows = df_tiles['array_row'].to_numpy()
    cols = df_tiles['array_col'].to_numpy()
    row_off, col_off = rows.min(), cols.min()
    n_rows = rows.max() - row_off + 1
    n_cols = cols.max() - col_off + 1
    r_idx = rows - row_off
    c_idx = cols - col_off

    si = np.repeat(np.arange(sg_r), sg_c)
    sj = np.tile(np.arange(sg_c), sg_r)
    fine_r = np.repeat(r_idx, n_sub) * sg_r + np.tile(si, n_tiles)
    fine_c = np.repeat(c_idx, n_sub) * sg_c + np.tile(sj, n_tiles)
    fine_rows, fine_cols = n_rows * sg_r, n_cols * sg_c

    if not val_range is None:
        print('Dequantizing...')
        arr = df_features.to_numpy()
        idx, cols = df_features.index, df_features.columns
        scale = val_range / np.iinfo(arr.dtype).max
        out = arr.astype(np.float32)
        out *= scale
        del df_features
        df_features = pd.DataFrame(out, index=idx, columns=cols, copy=False)  # no extra copy
        del arr, out

    # sparse-fill the fine grid (still cheap: only feature channels, no n_q blowup)
    grid = np.zeros((fine_rows, fine_cols, n_feat), dtype=np.float32)
    grid[fine_r, fine_c, :] = df_features.values
    padded = np.pad(grid, ((radius, radius), (radius, radius), (0, 0)),
                     mode='constant', constant_values=0)
    padded_stack = np.ascontiguousarray(np.moveaxis(padded, -1, 0))

    # positions whose window can possibly see real data
    occupied = np.zeros((fine_rows, fine_cols), dtype=bool)
    occupied[fine_r, fine_c] = True
    valid_mask = binary_dilation(occupied, structure=disk(radius).astype(bool))
    valid_i, valid_j = np.nonzero(valid_mask)
    valid_i, valid_j = valid_i.astype(np.int64), valid_j.astype(np.int64)

    offsets_i, offsets_j = make_disk_offsets(radius)
    if verbose:
        print(f"valid pixels: {len(valid_i)} / {fine_rows*fine_cols} "
              f"({100*len(valid_i)/(fine_rows*fine_cols):.1f}%)")

    out = np.zeros((len(valid_i), n_feat * len(qs)), dtype=np.float32)
    feature_windowed_quantiles_disk_sparse(padded_stack, qs, offsets_i, offsets_j,
                                            valid_i, valid_j, out)
    return valid_i, valid_j, out  # y, x, features — already sparse

def cleanupClassifier(clf):
    pattern = re.compile(r'feat_CTransPath_(\d+)_([\d.]+)')
    parsed = [(int(m.group(1)), float(m.group(2))) for c in clf.feat for m in [pattern.match(c)]]
    order = np.lexsort((np.array([p_[1] for p_ in parsed]),
                        np.array([p_[0] for p_ in parsed])))  # last key is primary
    clf.coef_ = clf.coef_[..., order]
    clf.feat = clf.feat[order]
    return clf

def inferSubtile(feat, clf, step=100000):
    def sigmoid(z):
        return 1 / (1 + np.exp(-z))
    p = np.empty(feat.shape[0], dtype=np.float16)
    for i in tqdm(range(0, feat.shape[0], step)):
        p[i:i+step] = sigmoid(feat[i:i+step] @ clf.coef_.T + clf.intercept_).ravel()
    return p

def make_prob_mask_from_points(xi, yi, pi, full_shape, delta, downfactor=16):
    fshape = (int(full_shape[0]), int(full_shape[1]))
    downsampled_map = np.zeros(
        (max(1, fshape[0] // downfactor), max(1, fshape[1] // downfactor)), dtype=np.uint8)
    halfsize = max(1, int(round(delta / (2 * downfactor))))
    print(halfsize)
    for x, y, p in zip(xi, yi, pi):
        x_ds = int(x // downfactor)
        y_ds = int(y // downfactor)
        x1 = max(0, x_ds - halfsize)
        x2 = min(downsampled_map.shape[1], x_ds + halfsize)
        y1 = max(0, y_ds - halfsize)
        y2 = min(downsampled_map.shape[0], y_ds + halfsize)
        downsampled_map[y1:y2, x1:x2] = int(p * 255)
    return downsampled_map

if __name__ == "__main__":

    df = pd.read_parquet(f'/{dataPath}/{sample}/features/false-1-ctranspath_features.parquet')
    df_grid = pd.read_csv(f'/{dataPath}/{sample}/features/false-1-ctranspath_features.tsv.gz', index_col=0)[['array_row', 'array_col', 'pxl_row_in_wsi', 'pxl_col_in_wsi']]
    y, x, feat = blur_quantile_features(df, df_grid, radius=2, verbose=True, val_range=2.0)
    
    # classifierPaths = 'some/path/to/classifier'
    # clf = dianne.loadGUIClassifier(classifierPaths, 'some-name')
    clf = cleanupClassifier(clf)
    p = inferSubtile(feat, clf)

    import os
    import json
    import tifffile
    fimgp = f'/{dataPath}/{sample}/image.ome.tiff'
    if not os.path.isfile(fimgp):
        with open(f'/{dataPath}/{sample}/info.json', 'r') as tf:
            fimgp = json.loads(tf.read())['image']
    with tifffile.TiffFile(fimgp) as tf:
        fshape = tf.series[0].pages[0].shape

    shy, shx = df_grid[['pxl_row_in_wsi', 'pxl_col_in_wsi']].min(axis=0).values
    downfactor = 4
    downsampled_map = make_prob_mask_from_points(x*32+shx, y*32+shy, p, fshape, 224, downfactor=downfactor)

    # geojson = dianne.extractContoursForQuPath(downsampled_map, fshape, savepath=classifierPaths, prefix='amn',
    #                                         cutoff=0.5, min_area=10**2, downfactor=downfactor, sigma=30)
