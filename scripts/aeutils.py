import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from tqdm.auto import tqdm
from scipy.stats import mannwhitneyu, pearsonr

def _build_components(pts, orig_ids, min_dist):
    """Connected components of pts using a KDTree-based radius graph."""
    n = len(pts)
    tree = cKDTree(pts)
    pairs = np.array(list(tree.query_pairs(r=min_dist)), dtype=np.int64)

    if pairs.size:
        row, col = pairs[:, 0], pairs[:, 1]
        adj = coo_matrix((np.ones(len(row), dtype=np.int8), (row, col)), shape=(n, n))
    else:
        adj = coo_matrix((n, n), dtype=np.int8)

    n_comp, labels = connected_components(adj, directed=False)

    components, sizes = {}, {}
    for c in tqdm(range(n_comp), desc=f"Building components (min_dist={min_dist:.3f})", leave=False):
        members = orig_ids[labels == c]
        key = f"C{c}"
        components[key] = members.tolist()
        sizes[key] = len(members)

    return components, sizes, labels


def _median_nn_dist(pts, labels, min_size=5):
    """Median nearest-neighbor distance, restricted to components >= min_size."""
    label_sizes = np.bincount(labels, minlength=labels.max() + 1)
    keep = label_sizes[labels] >= min_size
    if keep.sum() < 2:
        return np.nan
    sub_pts = pts[keep]
    sub_tree = cKDTree(sub_pts)
    d, _ = sub_tree.query(sub_pts, k=2)  # k=1 is self (dist 0)
    return float(np.median(d[:, 1]))



import numpy as np
import heapq
from collections import defaultdict
from scipy.spatial import cKDTree


def prune_close_cells(xy, th_cells=24):
    """
    Greedily prune points so that no two remaining points are within th_cells
    of each other, removing as few points as possible.

    This is a heuristic for minimum vertex deletion / maximum independent set
    on the conflict graph (edges = pairs closer than th_cells), which is
    NP-hard in general. The greedy strategy -- repeatedly drop the point
    currently involved in the most conflicts -- is a standard, effective
    approximation for spatial/geometric graphs like this one.

    Parameters
    ----------
    xy : (N, 2) array
        Cell coordinates.
    th_cells : float
        Minimum allowed distance between any two kept points.

    Returns
    -------
    pruned : (M, 2) array
        Subset of xy with all pairwise distances >= th_cells.
    keep_ids : (M,) array
        Indices into the original xy of the retained points.
    """
    xy = np.asarray(xy, dtype=float)
    n = len(xy)
    if n == 0:
        return xy.copy(), np.array([], dtype=np.int64)

    tree = cKDTree(xy)
    pairs = tree.query_pairs(r=th_cells, output_type='ndarray')

    if pairs.size == 0:
        return xy.copy(), np.arange(n)

    # adjacency as mutable sets so we can update degrees as nodes are removed
    neighbors = defaultdict(set)
    for a, b in pairs:
        neighbors[a].add(b)
        neighbors[b].add(a)

    # max-heap on degree (via negation), with lazy deletion for stale entries
    heap = [(-len(nbrs), node) for node, nbrs in neighbors.items()]
    heapq.heapify(heap)

    removed = set()
    while heap:
        neg_deg, node = heapq.heappop(heap)
        if node in removed:
            continue
        cur_deg = len(neighbors[node])
        if cur_deg != -neg_deg:
            # degree changed since this entry was pushed; requeue if still relevant
            if cur_deg > 0:
                heapq.heappush(heap, (-cur_deg, node))
            continue
        if cur_deg == 0:
            continue  # no conflicts left for this node

        # remove the node currently causing the most conflicts
        removed.add(node)
        for nb in neighbors[node]:
            neighbors[nb].discard(node)
            heapq.heappush(heap, (-len(neighbors[nb]), nb))
        neighbors[node].clear()

    keep_mask = np.ones(n, dtype=bool)
    if removed:
        keep_mask[list(removed)] = False
    keep_ids = np.nonzero(keep_mask)[0]
    pruned = xy[keep_ids]
    return pruned, keep_ids

def group_cells_into_components(xy, mask, min_dist=2.5, min_size=5,
                                 th_cells=None, downsample_factor=16):
    """
    Group cells into spatially connected components using a KDTree,
    with an adaptive two-pass distance threshold. Optionally prunes
    overly-close cells first.

    All returned ids (component members) are indices into the ORIGINAL
    `xy` array passed in, regardless of any pruning/downsampling done
    internally.

    Parameters
    ----------
    xy : (N, 2) array
        Cell coordinates, columns = (row, col) matching mask indexing,
        in original (full-resolution) units.
    mask : 2D boolean array
        Region of interest at downsampled resolution.
    min_dist : float
        Initial distance threshold (in original-resolution units) used
        to get a first estimate of M.
    min_size : int
        Minimum component size to be included in the M computation.
    th_cells : float or None
        If given, minimum allowed distance between cells; cells are
        pruned (greedily, minimal removals) before grouping.
    downsample_factor : int
        Factor used to map original-resolution xy into mask's grid.

    Returns
    -------
    components : dict {'C0': [orig_id, ...], ...}
        Ids index into the ORIGINAL xy passed to this function.
    sizes : dict {'C0': size, ...}
    M : float
    """
    xy = np.asarray(xy, dtype=float)
    n_total = len(xy)
    # global_ids[i] = index into the ORIGINAL xy of the point currently at
    # position i in whatever working array we have
    global_ids = np.arange(n_total)

    # --- optional pruning step ---
    if th_cells is not None:
        _, keep_ids = prune_close_cells(xy, th_cells=th_cells)
        xy = xy[keep_ids]
        global_ids = global_ids[keep_ids]
        print(f"Pruned {(n_total - len(keep_ids))/len(keep_ids) * 100:.2f}% cells.")

    if len(xy) == 0:
        return {}, {}, np.nan

    # --- mask filtering (uses downsampled coords just for indexing) ---
    xy_ds = (xy / downsample_factor).astype(int)
    rows = np.clip(xy_ds[:, 0], 0, mask.shape[0] - 1)
    cols = np.clip(xy_ds[:, 1], 0, mask.shape[1] - 1)
    in_mask = mask[rows, cols]

    local_ids = np.nonzero(in_mask)[0]      # indices into current xy/global_ids
    orig_ids = global_ids[local_ids]        # indices into the ORIGINAL xy
    pts = xy[local_ids]                     # full-resolution coords, mask-filtered

    if len(pts) == 0:
        return {}, {}, np.nan

    steps = tqdm(total=4, desc="Grouping cells", position=0)

    # --- Pass 1 ---
    steps.set_description(f"Pass 1: components @ min_dist={min_dist}")
    _, _, labels0 = _build_components(pts, orig_ids, min_dist)
    steps.update(1)

    steps.set_description("Pass 1: estimating M")
    M = _median_nn_dist(pts, labels0, min_size=min_size)
    steps.update(1)
    # print(f"Estimated M = {M:.3f} (median NN distance in components >= {min_size})")

    if np.isnan(M):
        steps.close()
        print("Warning: could not estimate M; returning pass-1 components")
        components, sizes, _ = _build_components(pts, orig_ids, min_dist)
        return components, sizes, M

    # --- Pass 2 ---
    adaptive_min_dist = 1.75 * M
    steps.set_description(f"Pass 2: components @ min_dist={adaptive_min_dist:.3f}")
    components, sizes, labels1 = _build_components(pts, orig_ids, adaptive_min_dist)
    steps.update(1)

    steps.set_description("Pass 2: recomputing M")
    M = _median_nn_dist(pts, labels1, min_size=min_size)
    print(f"Estimated M = {M:.3f} (median NN distance in components >= {min_size})")
    steps.update(1)
    steps.close()

    return components, sizes, M


def group_cells_into_components_old(xy, mask, min_dist=128, min_size=5):
    """
    Group cells into spatially connected components using a KDTree,
    with an adaptive two-pass distance threshold.

    Pass 1: use `min_dist` to get an initial estimate of M, the median
            nearest-neighbor distance within components of size >= min_size.
    Pass 2: rebuild components using min_dist=1.75*M.

    Parameters
    ----------
    xy : (N, 2) array
        Cell coordinates, columns = (row, col) matching mask indexing.
    mask : 2D boolean array
        Region of interest; only cells with mask==True are used.
    min_dist : float
        Initial distance threshold used to get a first estimate of M.
    min_size : int
        Minimum component size to be included in the M computation.

    Returns
    -------
    components : dict {'C0': [orig_id, ...], ...}
        Final cell ids per component (using the adaptive threshold).
    sizes : dict {'C0': size, ...}
        Number of cells per component.
    M : float
        Median nearest-neighbor distance (from the final pass), computed
        only over cells belonging to components of size >= min_size.
    """
    xy = np.asarray(xy)
    xy_in = xy.copy()
    xy = (xy.astype(float) / 16).astype(int)

    rows = np.clip(xy[:, 0].astype(np.int64), 0, mask.shape[0] - 1)
    cols = np.clip(xy[:, 1].astype(np.int64), 0, mask.shape[1] - 1)

    in_mask = mask[rows, cols]
    orig_ids = np.nonzero(in_mask)[0]
    pts = xy_in[orig_ids]

    if len(pts) == 0:
        return {}, {}, np.nan

    steps = tqdm(total=4, desc="Grouping cells", position=0)

    # --- Pass 1: initial components with default min_dist ---
    steps.set_description(f"Pass 1: components @ min_dist={min_dist}")
    _, _, labels0 = _build_components(pts, orig_ids, min_dist)
    steps.update(1)

    steps.set_description("Pass 1: estimating M")
    M = _median_nn_dist(pts, labels0, min_size=min_size)
    steps.update(1)

    if np.isnan(M):
        steps.close()
        # fall back to pass-1 components if M couldn't be estimated
        print("Warning: could not estimate M; returning pass-1 components")
        components, sizes, _ = _build_components(pts, orig_ids, min_dist)
        return components, sizes, M

    # --- Pass 2: rebuild with adaptive min_dist = 0.75 * M ---
    adaptive_min_dist = 1.75 * M
    steps.set_description(f"Pass 2: components @ min_dist={adaptive_min_dist:.3f}")
    components, sizes, labels1 = _build_components(pts, orig_ids, adaptive_min_dist)
    steps.update(1)

    steps.set_description("Pass 2: recomputing M")
    M = _median_nn_dist(pts, labels1, min_size=min_size)
    print(f"Estimated M = {M:.3f} (median NN distance in components >= {min_size})")
    steps.update(1)
    steps.close()

    return components, sizes, M

def compute_burden(out, gamma=1.0, min_size=3, cutoff=2):
    """
    Compute inverse-size-weighted burden from a single slide's output.

    Parameters
    ----------
    out : tuple (components, sizes, M)
        Output of group_cells_into_components: (components dict, sizes dict, M).
    gamma : float
        Inverse-size weighting exponent. gamma=0 -> break density (event count).
        gamma=1 -> strong fragmentation weighting (1/size per component).
    min_size : int
        Minimum component size to be counted as a "break" (sAE cluster) in
        the numerator.
    cutoff : int
        Components of size <= cutoff are treated as lonely fibroblasts, not
        true AE cells, and are excluded from total_AE (the denominator).

    Returns
    -------
    burden : float
    """
    _, sizes, _ = out
    size_vals = np.array(list(sizes.values()), dtype=float)

    # total AE cells = all cells in mask EXCLUDING singleton/doublet noise
    total_AE = size_vals[size_vals > cutoff].sum()

    keep = size_vals >= min_size
    if not keep.any() or total_AE == 0:
        return 0.0

    weighted = np.sum(1.0 / (size_vals[keep] ** gamma))
    return weighted / total_AE


def analyze_slides(slides, gamma=1.0, min_size=3, cutoff=2, age_threshold=35,
                    n_perm=10000, alternative='greater', seed=0):
    """
    Compute per-slide burden and test association with age across slides.

    Parameters
    ----------
    slides : dict {slide_id: [age, out]}
        out is the (components, sizes, M) tuple from group_cells_into_components.
    gamma : float
        Inverse-size weighting exponent for burden.
    min_size : int
        Minimum component size counted as a break (numerator).
    cutoff : int
        Components of size <= cutoff are excluded from total_AE (denominator).
    age_threshold : float
        Splits slides into two groups (age >= threshold vs < threshold) for
        the Mann-Whitney U test.
    n_perm : int
        Number of permutations for the Pearson r permutation test.
    alternative : {'greater', 'less'}
        One-sided direction for both tests: 'greater' tests whether burden
        increases with age (older group / higher age -> higher burden).
    seed : int
        RNG seed for the permutation test.

    Returns
    -------
    result : dict with keys
        'burden'        : {slide_id: burden}
        'ages'          : {slide_id: age}
        'mannwhitney'   : {'U': stat, 'p': pval, 'n_high': n, 'n_low': n}
        'pearson'       : {'r': r, 'p': pval}
    """
    rng = np.random.default_rng(seed)

    slide_ids = list(slides.keys())
    ages = np.array([slides[s][0] for s in slide_ids], dtype=float)
    burdens = np.array([
        compute_burden(slides[s][1], gamma=gamma, min_size=min_size, cutoff=cutoff)
        for s in slide_ids
    ])

    burden_dict = dict(zip(slide_ids, burdens))
    age_dict = dict(zip(slide_ids, ages))

    # --- Mann-Whitney U: burden in age>=threshold vs age<threshold ---
    high = burdens[ages >= age_threshold]
    low = burdens[ages < age_threshold]
    if len(high) > 0 and len(low) > 0:
        U, p_mw = mannwhitneyu(high, low, alternative=alternative)
    else:
        U, p_mw = np.nan, np.nan

    # --- Pearson r with permutation test (non-parametric p-value) ---
    if len(burdens) > 1 and np.std(ages) > 0 and np.std(burdens) > 0:
        r_obs, _ = pearsonr(ages, burdens)

        r_perm = np.empty(n_perm)
        shuffled = ages.copy()
        for i in range(n_perm):
            rng.shuffle(shuffled)
            r_perm[i], _ = pearsonr(shuffled, burdens)

        if alternative == 'greater':
            p_pearson = (np.sum(r_perm >= r_obs) + 1) / (n_perm + 1)
        elif alternative == 'less':
            p_pearson = (np.sum(r_perm <= r_obs) + 1) / (n_perm + 1)
        else:
            raise ValueError("alternative must be 'greater' or 'less'")
    else:
        r_obs, p_pearson = np.nan, np.nan

    return {
        'burden': burden_dict,
        'ages': age_dict,
        'mannwhitney': {'U': U, 'p': p_mw, 'n_high': len(high), 'n_low': len(low)},
        'pearson': {'r': r_obs, 'p': p_pearson},
    }
