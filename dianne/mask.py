import json
import zarr
import tifffile
import cv2
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from packaging import version

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

if __name__ == "__main__":
    
    # Usage, where x, y, p are the tile-level coordinates and probabilities from the model inference
    downsampled_map, fshape = makeProbMask(ads[sample], imgs[sample], x, y, p, ts=ts, mpp=mpp, downfactor=16,
                                    savepath=classifierPaths, prefix=f'{sample}-purple', verbose=True)

    paramsGeoJSON = dict(cutoff=0.5, min_area=10**6, downfactor=16, sigma=224)
    geojson = extractContoursForQuPath(downsampled_map, fshape, **paramsGeoJSON)
    viewContoursOnImage(imgs[sample], geojson, fshape, level=2, figsize=(5, 5), linewidth=1)

    geojson = extractContoursForQuPath(downsampled_map, fshape, savepath=classifierPaths, prefix=f'{sample}-purple',
                                    scalefactor=0.25/0.2208, **paramsGeoJSON)
