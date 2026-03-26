
import os
import psutil
import tifffile
import numpy as np
import pandas as pd
import cv2
from tqdm import tqdm
from IPython.display import display, HTML

from .stqutils import loadAd, preparePatchesWSI, getPatchRepresentation

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

    return ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L

def loadDataAndPreparePatchesStatic(samples, outsSTQpath, fname='img.data.ctranspath-1.h5ad', samplesToSTQnames=None, L=None, ts=56, mpp=0.25, N=8):

    if samplesToSTQnames is None:
        samplesToSTQnames = {sample: sample for sample in samples}

    # Load the STQ data for each sample
    ads = {}
    imgs = {}
    for sample in tqdm(samples):
        ads[sample], imgs[sample] = loadAd(outsSTQpath + samplesToSTQnames[sample] + '/', fname=fname, L=L)

    # Prepare the patches coordinates for each sample and concatenate them into a single DataFrame
    patchCoordinates = pd.concat([preparePatchesWSI(ads[sample].obs, N=8, spacing=ts/mpp, sample_id=sample) for sample in tqdm(samples)], axis=0)

    # Get the patch SAMPLER representations for each sample and combine them into a single DataFrame
    qs = np.linspace(0.05, 0.95, 10, endpoint=True)
    patchesCDFs = pd.concat([getPatchRepresentation(ads[sample], patchCoordinates.xs(sample, level='sample', axis=0), qs, sample_id=sample) for sample in tqdm(samples)], axis=0)

    return ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L

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
