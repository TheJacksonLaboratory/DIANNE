
import os
import pandas as pd
import sys
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dianne_utils.utils import loadDataAndPreparePatches, loadSTQParams
from dianne_utils.utils import getTilesInContour, preparePatchesFromStrokes, visualizePatches, getClassifierForFromStrokes, makeRunFn, makeSaveFn, makeLoadFn, makeListFn, get_tile_mask_means3
from .viewer import create_viewer
import matplotlib.colors as mcolors
import pickle

def viewSTQ(dpath, imfname='image.ome.tiff', load_features=False, samples=None, F=2, model='ctranspath',
            patch_size=8, classifierPaths=None, height="800px", PCMA_alpha=0.8, multiplier=2, erode=True, drop_dots=False, replacement='_', fs=None):

    """Creates a viewer for the given directory path containing sample subdirectories with image files.
    Args:
        dpath (str): The directory path containing sample subdirectories.
        imfname (str): The expected filename of the image file within each sample subdirectory.
        load_features (bool): Whether to load features for the samples.
        samples (list): A list of sample names to include in the viewer. If None, all valid samples will be included.
        F (int): A parameter used for feature loading.
        model (str): The model name used for feature loading.
        patch_size (int): The size of the patches to be used.
        classifierPaths (list): Paths to classifier files.
        height (str): The height of the viewer.
        PCMA_alpha (float): The alpha value for PCMA.
        multiplier (int): A multiplier value for scaling.
        erode (bool): Whether to apply erosion.
        drop_dots (bool): Whether to drop dots.
        replacement (str): The string to replace dots with in sample names.
        fs: A file system object for handling file operations, if needed.
    Returns:
        viewer: A viewer object created with the valid samples and their corresponding images.
    """

    if fs is None:
        samples_ = sorted([s for s in os.listdir(os.path.join(dpath)) if not s.startswith("pipeline") and os.path.isdir(os.path.join(dpath, s))])
    else:
        samples_ = sorted([s for s in fs.listdir(os.path.join(dpath)) if not s.startswith("pipeline") and fs.isdir(os.path.join(dpath, s))])

    if samples is not None:
        samples_ = [s for s in samples_ if s in samples]

    # Verify that each sample has image, otherwise filter out from the list
    valid_samples = []
    for s in samples_:
        img_path = os.path.join(dpath, s, imfname)
        if fs is None:
            if os.path.isfile(img_path):
                valid_samples.append(s)
            else:
                print(f"Warning: Sample '{s}' does not have the expected image file '{imfname}' and will be skipped.")
        else:
            if fs.isfile(img_path):
                valid_samples.append(s)
            else:
                print(f"Warning: Sample '{s}' does not have the expected image file '{imfname}' and will be skipped.")

    if not valid_samples:
        raise ValueError("No valid samples found with the expected image file.")


    if load_features:
        template1 = 'img.data.{model}-{F}.h5ad'
        template2 = 'features/false-{F}-{model}_features.tsv.gz'
        
        fname = template1.format(model=model, F=F)
        # Verify that the first (arbitrary sample) has the expected feature file
        if fs is None:
            if not os.path.isfile(os.path.join(dpath, valid_samples[0], fname)):
                # Try the second template
                fname = template2.format(model=model, F=F)
                if not os.path.isfile(os.path.join(dpath, valid_samples[0], fname)):
                    raise ValueError(f"Expected feature file not found for the first sample using either template: "
                    f"'{template1.format(model=model, F=F)}' or '{template2.format(model=model, F=F)}'. Please check the filenames and templates.")
        else:
            if not fs.isfile(os.path.join(dpath, valid_samples[0], fname)):
                # Try the second template
                fname = template2.format(model=model, F=F)
                if not fs.isfile(os.path.join(dpath, valid_samples[0], fname)):
                    raise ValueError(f"Expected feature file not found for the first sample using either template: "
                    f"'{template1.format(model=model, F=F)}' or '{template2.format(model=model, F=F)}'. Please check the filenames and templates.")

        # Verify that each sample has the expected feature file, otherwise filter out from the list
        if fs is None:
            valid_samples = [s for s in valid_samples if os.path.isfile(os.path.join(dpath, s, fname))]
        else:
            valid_samples = [s for s in valid_samples if fs.isfile(os.path.join(dpath, s, fname))]
        
        # number of tiles, in each dimension, to include in a patch (e.g. 8 means 8x8=64 tiles per patch)
        ts, mpp, tile_size = loadSTQParams(os.path.join(dpath, valid_samples[0]), F, fs=fs)
        ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L, N = loadDataAndPreparePatches(valid_samples, dpath if dpath.endswith('/') else dpath + '/',
                                                                                                fname, L=None, ts=ts, mpp=mpp, N=patch_size, fs=fs)
    
        if drop_dots:
            valid_samples = [s.replace('.', replacement) for s in valid_samples]
            ads = {s.replace('.', replacement): ads[s] for s in ads.keys()}
            imgs = {s.replace('.', replacement): imgs[s] for s in imgs.keys()}

            patchCoordinates.index = pd.MultiIndex.from_arrays([patchCoordinates.index.get_level_values('sample').str.replace('.', replacement, regex=False),
                                                                patchCoordinates.index.get_level_values('barcode')], names=['sample', 'barcode'])

            patchesCDFs.index = pd.MultiIndex.from_arrays([patchesCDFs.index.get_level_values('sample').str.replace('.', replacement, regex=False),
                                                        patchesCDFs.index.get_level_values('patch')], names=['sample', 'patch'])

        # return valid_samples, ads, imgs, patchCoordinates, patchesCDFs

        sizes = {s: ads[s].shape[0] for s in valid_samples}
        print(f'Prepared {patchesCDFs.shape[0]} patches')

        runfn = makeRunFn(patchCoordinates, ads, valid_samples, qs, ts, mpp, tile_size=tile_size, 
                        patch_size=patch_size, PCMA_alpha=PCMA_alpha, alpha_img=0.5, multiplier=multiplier, erode=erode)

        if classifierPaths is not None:
            savefn = makeSaveFn(patchCoordinates, ads, valid_samples, qs, ts, mpp, PCMA_alpha=PCMA_alpha, 
                            tile_size=tile_size, patch_size=patch_size, body_overlap=0.25, classifierPaths=classifierPaths)
        
            loadfn = makeLoadFn(classifierPaths)
            listfn = makeListFn(classifierPaths)
        else:
            savefn = None
            loadfn = None
            listfn = None

        imgs = {s: imgs[s] for s in valid_samples}

        return create_viewer(valid_samples, imgs, height=height, run_inference_fn=runfn, sample_sizes=sizes,
                                        save_func=savefn, load_func=loadfn, list_names_func=listfn)[1]

    else:
        imgs = {s: os.path.join(dpath, s, imfname) for s in valid_samples}
    
        if drop_dots:
            valid_samples = [s.replace('.', replacement) for s in valid_samples]
            imgs = {s.replace('.', replacement): imgs[s] for s in imgs.keys()}

        print(valid_samples, imgs)

        return create_viewer(valid_samples, imgs, height=height)[1]

def viewSTQkomp(dataPath, samples, F=2, model='ctranspath', color='lime', patch_size=8, PCMA_alpha=0.8, multiplier=2,
                body_overlap=0.25, max_cells=20000, idm='./identity-matrix.csv', classifierPaths=None, load_features=False):

    """Views KOMP STQ data using the DIANNE viewer.
    Similar to viewSTQ, but specifically for KOMP data. It loads the necessary parameters and prepares the patches for viewing.
    See viewSTQ for more details on the parameters.
    """
    
    ts, mpp, tile_size = loadSTQParams(dataPath + samples[0], F)
    if load_features:
        fname = f'features/false-{F}-{model}_features.tsv.gz'
        ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L, N = loadDataAndPreparePatches(samples, 
                                                                dataPath, fname, L=None, ts=ts, mpp=mpp, N=patch_size)
        print(f'Prepared {patchesCDFs.shape[0]} patches')
        sizes = {s: ads[s].shape[0] for s in samples}
        runfn = makeRunFn(patchCoordinates, ads, samples, qs, ts, mpp, tile_size=tile_size, patch_size=patch_size,
                                 PCMA_alpha=PCMA_alpha, alpha_img=0.5, multiplier=multiplier)
        savefn = makeSaveFn(patchCoordinates, ads, samples, qs, ts, mpp, PCMA_alpha=PCMA_alpha, tile_size=tile_size,
                                   patch_size=patch_size, body_overlap=body_overlap, classifierPaths=classifierPaths)
        loadfn = makeLoadFn(classifierPaths)
        listfn = makeListFn(classifierPaths)
    else:
        imgs = {s: iname for s in samples if os.path.isfile((iname:=f'{dataPath}/{s}/image.ome.tiff'))}
        samples = [s for s in samples if s in imgs.keys()]
        runfn, savefn, loadfn, listfn, sizes = None, None, None, None, None
    
    matrices = {s: idm for s in samples}
    bundle_paths = {s:f'{dataPath}{s}' for s  in samples}
    all_annotations = {}
    for sample in samples:
        try:
            with open(f'{dataPath}{sample}/cells-index.pkl', 'rb') as f:
                index = pickle.load(f)
            all_annotations[sample] = pd.Categorical(['Cell expanded from nucleus']*len(index))
        except:
            pass
    
    uannotations = sorted(set(a for sample in all_annotations.keys() for a in all_annotations[sample].unique())) 
    annotationsPalette = {a: mcolors.to_hex(color) for i, a in enumerate(uannotations)}
    
    drawings = create_viewer(samples, imgs, height="800px", run_inference_fn=runfn, sample_sizes=sizes,
                                    xenium_mpp=mpp, max_cells=max_cells, matrices=matrices, xenium_bundle_paths=bundle_paths,
                                    annotations=all_annotations, category_colors=annotationsPalette,
                                    save_func=savefn, load_func=loadfn, list_names_func=listfn)[1]
    return drawings


def viewMIQ(dpath, imfname='adjusted-all-channels.ome.tif', samples=None, height="800px",
            mpp=0.2125, max_cells=10000):

    """Creates a viewer for the given directory path containing sample subdirectories with image files.
    Args:
        dpath (str): The directory path containing sample subdirectories.
        imfname (str): The expected filename of the image file within each sample subdirectory.
        samples (list): A list of sample names to include in the viewer. If None, all valid samples will be included.
        height (str): The height of the viewer.
        mpp (float): Microns per pixel for the images.
        max_cells (int): Maximum number of cells to display in the viewer.

    Returns:
        viewer: A viewer object created with the valid samples and their corresponding images.
    """
    samples_ = sorted([s for s in os.listdir(os.path.join(dpath)) if not s.startswith("pipeline") and os.path.isdir(os.path.join(dpath, s))])

    if samples is not None:
        samples_ = [s for s in samples_ if s in samples]

    # Verify that each sample has image, otherwise filter out from the list
    valid_samples = []
    for s in samples_:
        img_path = os.path.join(dpath, s, imfname)
        if os.path.isfile(img_path):
            valid_samples.append(s)
        else:
            print(f"Warning: Sample '{s}' does not have the expected image file '{imfname}' and will be skipped.")

    if not valid_samples:
        raise ValueError("No valid samples found with the expected image file.")


    mif_images = {s: os.path.join(dpath, s, imfname) for s in valid_samples}
    identity_matrices = {sample: './identity-matrix.csv' for sample in valid_samples}

    xenium_bundle_paths = {sample: f"{dpath}/{sample}" for sample in valid_samples}

    drawings = create_viewer(valid_samples, mif_images, height=height,
                            xenium_mpp=mpp, max_cells=max_cells,
                            matrices=identity_matrices,
                            xenium_bundle_paths=xenium_bundle_paths,
                        )[1]

    return drawings
