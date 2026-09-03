"""
contours.py

Builds contour polygons directly from an already-computed inference
probability overlay (the xi/yi/pi arrays + delta returned by /run_inference
and drawn on screen as the probability heatmap), for the "show contours" /
"Add" buttons next to the Prob. Opacity control.

dianne_utils.mask.makeProbMask (which the notebook workflow otherwise uses to
build this same kind of downsampled probability mask) requires an AnnData
object and re-reads the original WSI file just to learn its shape, via an
original_barcode lookup that only makes sense for that specific
Xenium/Visium-oriented pipeline. The viewer already has everything it needs
client-side (the overlay points, their marker size, and the full-resolution
image dimensions from META), so make_prob_mask_from_points rebuilds the same
kind of mask directly from those, without touching AnnData or the image file.
The resulting (downsampled_map, fshape) pair is compatible with
dianne_utils.mask.extractContoursForQuPath, which is reused unmodified.
"""
import numpy as np


def make_prob_mask_from_points(xi, yi, pi, full_shape, delta, downfactor=16):
    """Rasterize per-patch probabilities into a downsampled 0-255 mask.

    Mirrors the rasterization loop in dianne_utils.mask.makeProbMask (each
    patch center paints a `delta`-wide square of intensity `p*255`, later
    overlapping squares overwrite earlier ones), but takes the patch centers
    and probabilities directly instead of looking them up through an
    AnnData/original_barcode table.

    Parameters:
        xi, yi: patch-center coordinates, full-resolution image pixel space.
        pi: probabilities in [0, 1], one per (xi, yi).
        full_shape: (height, width) of the full-resolution image.
        delta: overlay marker size (full patch width, in full-resolution
            pixel units) — the same square each point is drawn as by the
            on-screen probability overlay.
        downfactor: downsampling factor for the mask (default 16, matching
            makeProbMask/extractContoursForQuPath's default).

    Returns:
        downsampled_map: 2D uint8 numpy array.
        fshape: (height, width) of the full-resolution image, echoed back
            for direct use as extractContoursForQuPath's `fshape` argument.
    """
    fshape = (int(full_shape[0]), int(full_shape[1]))
    downsampled_map = np.zeros(
        (max(1, fshape[0] // downfactor), max(1, fshape[1] // downfactor)), dtype=np.uint8)
    halfsize = max(1, int(round(delta / (2 * downfactor))))

    for x, y, p in zip(xi, yi, pi):
        x_ds = int(x // downfactor)
        y_ds = int(y // downfactor)
        x1 = max(0, x_ds - halfsize)
        x2 = min(downsampled_map.shape[1], x_ds + halfsize)
        y1 = max(0, y_ds - halfsize)
        y2 = min(downsampled_map.shape[0], y_ds + halfsize)
        downsampled_map[y1:y2, x1:x2] = int(p * 255)

    return downsampled_map, fshape
