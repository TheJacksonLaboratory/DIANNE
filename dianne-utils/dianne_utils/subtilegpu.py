import os
import re

import numpy as np
import torch
from skimage.morphology import disk
from tqdm import tqdm


def make_disk_offsets(radius):
    mask = disk(radius).astype(bool)
    di, dj = np.nonzero(mask)
    return di.astype(np.int64), dj.astype(np.int64)


def _free_budget_bytes(device):
    """Bytes available for new tensors without the allocator needing to ask
    the driver for more: what the driver reports free, plus whatever this
    process's caching allocator already holds reserved but isn't currently
    backing a live tensor. torch.cuda.mem_get_info() alone under-reports
    this on repeated calls in the same process -- freed batch/band tensors
    stay reserved in PyTorch's cache rather than going back to the driver,
    so "free" looks smaller and smaller each call even though that memory
    is actually available for reuse. Accounting for it here avoids both
    the under-report and the cost of a torch.cuda.empty_cache() sync."""
    free_driver, _ = torch.cuda.mem_get_info(device.index if device.index is not None else 0)
    reserved = torch.cuda.memory_reserved(device)
    allocated = torch.cuda.memory_allocated(device)
    return free_driver + max(reserved - allocated, 0)


def _choose_band_rows(n_channels, W_pad, max_di, device, target_frac=0.5, min_rows=1):
    """How many grid rows (plus halo) to keep resident on the GPU at once,
    sized from current free VRAM so the resident band never dominates
    memory the way the full dense grid did."""
    budget = _free_budget_bytes(device) * target_frac
    bytes_per_row = n_channels * W_pad * 4
    rows = int(budget // max(bytes_per_row, 1)) - max_di
    return max(min_rows, rows)


def _host_free_budget_bytes():
    """Best-effort free host RAM, for sizing CPU batches the same way
    _free_budget_bytes sizes GPU ones -- without this, a CPU (or
    CUDA-unavailable) run has nothing bounding the per-batch gather/sort
    tensors, and those scale with n_channels * n_local and can blow past
    system RAM long before anything would hit a CUDA OOM retry."""
    try:
        pages = os.sysconf('SC_AVPHYS_PAGES')
        page_size = os.sysconf('SC_PAGE_SIZE')
        return pages * page_size
    except (ValueError, AttributeError):
        return 2 * 1024 ** 3  # conservative fallback where sysconf isn't available


def _pick_batch_size(n_local, n_channels, wsize, n_q, device, target_frac=0.4, min_batch=1024, safety=1.25):
    budget = (_free_budget_bytes(device) if device.type == 'cuda' else _host_free_budget_bytes()) * target_frac
    # float32: gathered + sorted values (wsize each), lo/hi/blend temporaries
    # (n_q each, several intermediates) -- plus torch.sort's int64 indices
    # output (wsize elements @ 8 bytes), which float32-only accounting misses.
    # The classifier matmul/sigmoid on top of that is negligible (O(n_q) extra).
    # This budgeting applies on CPU too now, not just CUDA -- see _host_free_budget_bytes.
    bytes_per_pixel = n_channels * (4 * (2 * wsize + 6 * n_q) + 8 * wsize)
    batch = int(budget // max(int(bytes_per_pixel * safety), 1))
    return int(np.clip(batch, min_batch, n_local))


@torch.no_grad()
def feature_windowed_quantile_probs_gpu(
    padded, qs, offsets_i, offsets_j, valid_i, valid_j, coef, intercept,
    device=None, batch_size=None, show_progress=True,
):
    """GPU (torch) kernel producing per-subtile classifier probabilities
    directly. Same disk window + linear-interpolated quantile computation as
    the numba feature_windowed_quantiles_disk_sparse kernel in subtile.py,
    but the logistic-regression classifier is fused into the same GPU pass
    instead of being applied afterwards on CPU: the (n_valid, n_channels*n_q)
    quantile-feature matrix is exactly the thing that used to dominate both
    CPU RAM and GPU->CPU transfer time, and it's only ever consumed by this
    one matmul+sigmoid, so it never needs to exist off-GPU (or even survive
    past the batch that produced it). Only one float16 probability per valid
    subtile crosses back to the host.

    `padded` is the channel-last dense feature grid, shape
    (H_pad, W_pad, n_channels) -- the same layout `np.pad` produces
    directly, so no whole-grid transpose/copy is needed before this call.
    For a large slide with many channels this grid can be tens of GB, far
    more than should ever be resident on the GPU at once. Instead of
    gathering windows on the CPU (which starves the GPU -- all the
    wall-clock time goes into host-side fancy indexing while the GPU sits
    idle), this processes the grid in row-bands: one contiguous horizontal
    strip (sized from free VRAM) is copied to the GPU at a time, and the
    disk-window gather, sort, quantile blend, and classifier for every valid
    pixel in that band all run on-device. Only band transfers cross the
    PCIe/NVLink bus, not per-pixel gathers, and the only result that comes
    back is the scalar probability per pixel.

    `coef`/`intercept` are the (already feature-order-matched, see
    cleanupClassifier) logistic-regression weights: coef has n_channels*n_q
    entries in the same (channel-major) flattening the quantile features are
    produced in, intercept is a single scalar.
    """
    device = torch.device(device) if device is not None else torch.device(
        'cuda' if torch.cuda.is_available() else 'cpu')

    H_pad, W_pad, n_channels = padded.shape
    n_valid = valid_i.shape[0]
    n_q = qs.shape[0]
    wsize = offsets_i.shape[0]

    out = np.empty(n_valid, dtype=np.float16)
    if n_valid == 0:
        return out

    positions = qs.astype(np.float32) * (wsize - 1)
    lo = positions.astype(np.int64)
    hi = np.minimum(lo + 1, wsize - 1)
    frac = (positions - lo).astype(np.float32)

    lo_t = torch.as_tensor(lo, dtype=torch.long, device=device)
    hi_t = torch.as_tensor(hi, dtype=torch.long, device=device)
    frac_t = torch.as_tensor(frac, dtype=torch.float32, device=device)
    one_minus_frac_t = 1.0 - frac_t
    off_i_t = torch.as_tensor(offsets_i, dtype=torch.long, device=device)
    off_j_t = torch.as_tensor(offsets_j, dtype=torch.long, device=device)
    coef_t = torch.as_tensor(np.asarray(coef, dtype=np.float32).reshape(-1), device=device)
    intercept_t = torch.as_tensor(np.asarray(intercept, dtype=np.float32).reshape(-1)[0], device=device)

    # valid_i is non-decreasing (np.nonzero scans row-major), so contiguous
    # k-ranges correspond to contiguous row bands and `out` order is preserved
    max_di = int(offsets_i.max())
    n_rows_span = int(valid_i[-1]) + 1

    if device.type == 'cuda':
        band_rows = _choose_band_rows(n_channels, W_pad, max_di, device)
    else:
        band_rows = n_rows_span  # single pass, no VRAM pressure to tile for

    pbar = tqdm(total=n_valid, disable=not show_progress, desc='windowed quantile probs (GPU)', unit='px')
    r0 = 0
    while r0 < n_rows_span:
        r1 = min(r0 + band_rows, n_rows_span)
        k0 = int(np.searchsorted(valid_i, r0, side='left'))
        k1 = int(np.searchsorted(valid_i, r1, side='left'))

        if k1 > k0:
            band_src = padded[r0:r1 + max_di]  # contiguous view, no copy
            band_t = torch.as_tensor(band_src, dtype=torch.float32, device=device)
            band_W = band_t.shape[1]
            band_flat = band_t.reshape(-1, n_channels)  # (rows*W_pad, C)

            local_i = torch.as_tensor(valid_i[k0:k1] - r0, dtype=torch.long, device=device)
            local_j = torch.as_tensor(valid_j[k0:k1], dtype=torch.long, device=device)

            n_local = k1 - k0
            cur = batch_size or _pick_batch_size(n_local, n_channels, wsize, n_q, device)
            s = 0
            while s < n_local:
                e = min(s + cur, n_local)
                idx_i = local_i[s:e, None] + off_i_t[None, :]   # (b, wsize)
                idx_j = local_j[s:e, None] + off_j_t[None, :]
                flat_idx = idx_i * band_W + idx_j

                try:
                    gathered_bwc = band_flat[flat_idx]            # (b, wsize, C) — GPU gather
                    gathered = gathered_bwc.permute(2, 0, 1).contiguous()  # (C, b, wsize)
                    sorted_vals, _ = torch.sort(gathered, dim=-1)
                    lo_vals = sorted_vals[..., lo_t]              # (C, b, n_q)
                    hi_vals = sorted_vals[..., hi_t]
                    q_vals = lo_vals * one_minus_frac_t + hi_vals * frac_t
                    b = e - s
                    q_vals = q_vals.permute(1, 0, 2).reshape(b, n_channels * n_q)
                    logits = q_vals @ coef_t + intercept_t
                    probs = torch.sigmoid(logits)
                    out[k0 + s:k0 + e] = probs.to(torch.float16).cpu().numpy()
                except RuntimeError as err:
                    if device.type != 'cuda' or 'out of memory' not in str(err).lower():
                        raise
                    torch.cuda.empty_cache()
                    if cur <= 1:
                        raise
                    cur = max(1, cur // 2)
                    continue  # retry this same `s` with a smaller batch

                pbar.update(e - s)
                s = e

            del band_t, band_flat

        r0 = r1

    pbar.close()
    return out


def build_padded_grid_and_valid(df_features, df_tiles, radius, subgrid, val_range, verbose=False):
    """CPU-side dequantize + sparse-fill + valid-subtile lookup: the part of
    inferSubtileFromFeatures that stays on CPU/numpy and feeds the GPU
    kernel. Split out so it can be timed or swapped independently of the
    GPU kernel (e.g. to profile the GPU kernel alone by precomputing this
    once and looping only feature_windowed_quantile_probs_gpu).
    Returns (padded, valid_i, valid_j) -- padded is channel-last, shape
    (H_pad, W_pad, n_feat).
    """
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

    if val_range is not None:
        if verbose:
            print('Dequantizing...')
        arr = df_features.to_numpy()
        feat_values = arr.astype(np.float32)
        feat_values *= val_range / np.iinfo(arr.dtype).max
    else:
        feat_values = df_features.to_numpy().astype(np.float32)

    # Allocate the padded grid directly instead of building an unpadded grid
    # and then np.pad-ing it -- np.pad on a (fine_rows, fine_cols, n_feat)
    # array is itself a full copy, so filling straight into the padded
    # buffer halves the peak CPU RAM this step needs.
    padded = np.zeros((fine_rows + 2 * radius, fine_cols + 2 * radius, n_feat), dtype=np.float32)
    padded[fine_r + radius, fine_c + radius, :] = feat_values
    del feat_values

    # Every (fine_r, fine_c) pair here is a subtile of a tile present in
    # df_tiles, so that's already exactly the valid set -- no need to
    # rebuild it by dilating a dense occupancy mask. Just sort into the
    # row-major order feature_windowed_quantile_probs_gpu expects.
    order = np.lexsort((fine_c, fine_r))
    valid_i, valid_j = fine_r[order].astype(np.int64), fine_c[order].astype(np.int64)

    if verbose:
        print(f"valid pixels: {len(valid_i)} / {fine_rows*fine_cols} "
              f"({100*len(valid_i)/(fine_rows*fine_cols):.1f}%)")

    return padded, valid_i, valid_j


def cleanupClassifier(clf):
    pattern = re.compile(r'feat_CTransPath_(\d+)_([\d.]+)')
    parsed = [(int(m.group(1)), float(m.group(2))) for c in clf.feat for m in [pattern.match(c)]]
    order = np.lexsort((np.array([p_[1] for p_ in parsed]),
                        np.array([p_[0] for p_ in parsed])))  # last key is primary
    clf.coef_ = clf.coef_[..., order]
    clf.feat = clf.feat[order]
    return clf


def inferSubtileFromFeatures(
    df, df_grid, clf,
    radius=2, qs=np.linspace(0.05, 0.95, 10), subgrid=(7, 7), val_range=2.0,
    device=None, batch_size=None, verbose=True,
):
    """End-to-end: quantized CTransPath features + tile grid + classifier ->
    (y, x, p) for every valid subtile. The quantile-feature matrix and the
    CPU-side classifier pass that used to sit between grid-building and the
    final probabilities are gone -- feature_windowed_quantile_probs_gpu
    computes and applies the classifier per band/batch on GPU, so only the
    padded grid (CPU) and the final probabilities (GPU->CPU) ever move
    through host RAM.
    """
    padded, valid_i, valid_j = build_padded_grid_and_valid(
        df, df_grid, radius, subgrid, val_range, verbose=verbose)

    offsets_i, offsets_j = make_disk_offsets(radius)

    p = feature_windowed_quantile_probs_gpu(
        padded, qs, offsets_i, offsets_j, valid_i, valid_j,
        clf.coef_, clf.intercept_,
        device=device, batch_size=batch_size, show_progress=verbose,
    )
    return valid_i, valid_j, p  # y, x, p — already sparse


if __name__ == '__main__':
    # srun -p gpu_a100 -q gpu_inference --gres=gpu:1 --mem=200G -t 01:00:00 --pty /bin/bash
    # singularity exec --nv /projects/chuang-lab/USERS/domans/containers/mtimm-python.sif python /projects/activities/komp-histopath/USERS/domans/DIANNE/dianne-utils/dianne_utils/subtilegpu.py

    # import pandas as pd
    # import pickle
    # with open(f'/projects/activities/komp-histopath/USERS/domans/DIANNE/scripts/dev/classifiers/amn.pklz', 'rb') as tempfile:
    #     clf = pickle.load(tempfile)['clf']

    df = pd.read_parquet(f'/{dataPath}/{sample}/features/false-1-ctranspath_features.parquet')
    df_grid = pd.read_csv(f'/{dataPath}/{sample}/features/false-1-ctranspath_features.tsv.gz', index_col=0)[['array_row', 'array_col']]
    clf = cleanupClassifier(clf)
    y, x, p = inferSubtileFromFeatures(df, df_grid, clf)
