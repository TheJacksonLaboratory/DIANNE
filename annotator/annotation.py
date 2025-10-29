"""Author: Sergii Domanskyi
Organization: The Jackson Laboratory for Genomic Medicine
Date: 2025-01-01
"""

import pandas as pd
import numpy as np

from tqdm import tqdm

import tifffile
import zarr

from sklearn.svm import SVC
from sklearn.linear_model import LogisticRegression as LR
from sklearn.decomposition import PCA
from sklearn.metrics import roc_auc_score
from scipy.spatial.distance import pdist, squareform
from scipy.ndimage import gaussian_filter
import scipy

from scipy.spatial import KDTree

from sklearn.cluster import KMeans

from .stqutils import inferProb
from .transcriptomics import fetch_xenium_zarr_cell_coords, fetch_cell_by_gene_matrix, extract_transcripts_from_grid_locs
from .interpolation import interpolate_points

import matplotlib
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import Polygon, Rectangle
from matplotlib.collections import PatchCollection
from matplotlib.lines import Line2D
from matplotlib.colors import ListedColormap

import ipywidgets as widgets

def normalize_pseudo_channels(image, bounds):
    clipped_image = np.empty_like(image)
    for i in range(3):
        lower, upper = bounds[i]
        clipped_image[..., i] = np.clip(image[..., i], lower, upper)
        clipped_image[..., i] = ((clipped_image[..., i] - lower) / (upper - lower) * 255.)
    return clipped_image.astype(np.uint8)

def getXy(curated_positive, curated_negative, patchesCDFs, alpha=None, augFunc=None):
    if not alpha is None:
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
    return X_train, y_train

def inspectAnnotatedPatches(patchCoordinates, patchesCDFs, imgs, button_press_results, L=1, sh=112, pyramidscale=4, nInRow=4, startParams=None,
                            figsize=(5, 5), addOutline=True, minDiscrepancy=0.25, minN=8, samplesPerFold=4, nRepeats=10, alpha=0.5, augFunc=None, seed=None):

    np.random.seed(seed)

    patchCoordinatesFull = patchCoordinates.copy()
    patchCoordinates = patchCoordinates.set_index('patch', append=True).droplevel('barcode', axis=0)
    patchCoordinates = patchCoordinates.sort_index()

    progress_bar = widgets.IntProgress(value=0, min=0, max=nRepeats, description='Calculating:',
                                       bar_style='info', orientation='horizontal')
    display(progress_bar)

    potentially_false_positive = []
    potentially_false_negative = []
    p_ind = None
    p = None

    yes_button = widgets.Button(description='confirm', button_style='success')
    no_button = widgets.Button(description='remove', button_style='Warning')
    hbox = widgets.HBox([yes_button, no_button], layout=widgets.Layout(justify_content='flex-start'))
    the_output = widgets.Output()
    clear_output_widget = widgets.VBox([hbox, the_output])

    def showOne():

        nonlocal p
        nonlocal p_ind
        nonlocal potentially_false_positive
        nonlocal potentially_false_negative

        if p_ind is None:
            p_ind = 0
        elif p_ind > len(potentially_false_positive) + len(potentially_false_negative) - 1:
            print(f'All {p_ind} patches inspected.')
            hbox.layout.display = 'none'
            return

        print('Inspecting patch %d of %d' % (p_ind + 1, len(potentially_false_positive) + len(potentially_false_negative)))
        if p_ind <= len(potentially_false_positive)-1:
            p = potentially_false_positive[p_ind]
            patchType = 'positive'
        else:
            p = potentially_false_negative[p_ind - len(potentially_false_positive)]
            patchType = 'negative'

        img_, x1, x2, y1, y2 = loadPatch(p, patchCoordinates, L, sh, pyramidscale, imgs)

        if not startParams is None and 'mif_pca' in startParams.keys() and 'mif_bounds' in startParams.keys():
            temp_imgp = startParams['mif_pca'].transform(img_.reshape(-1, img_.shape[-1]))
            temp_imgp = temp_imgp.reshape(img_.shape[0], img_.shape[1], 3 * startParams['mif_nrep_pca'])
            temp_imgp = np.dstack([temp_imgp[..., i::3].sum(axis=-1)[..., None] for i in range(3)])
            img_ = normalize_pseudo_channels(temp_imgp, startParams['mif_bounds'])

        dims = img_.shape
        imgMarked = img_.copy()
        if addOutline:
            if patchType == 'positive':
                color = np.array([50, 50, 200], dtype=np.uint8)
            elif patchType == 'negative':
                color = np.array([255, 0, 0], dtype=np.uint8)
            else:
                color = np.array([240, 150, 0], dtype=np.uint8)

            borderWidth = max(1, int(0.01 * min(dims[0], dims[1])))
            
            if not color is None:
                imgMarked[:borderWidth, :, :] = color
                imgMarked[-borderWidth:, :, :] = color
                imgMarked[:, :borderWidth, :] = color
                imgMarked[:, -borderWidth:, :] = color

        fig, axMain = plt.subplots(figsize=figsize)

        axMain.imshow(imgMarked)
        axMain.set_xlim([0, imgMarked.shape[1]])
        axMain.set_ylim([imgMarked.shape[0], 0])
        axMain.axis('off')
        axMain.set_title(p)

        plt.show()

        p_ind += 1

        return

    def getSuspects():

        nonlocal potentially_false_positive
        nonlocal potentially_false_negative

        emptyIndex = pd.MultiIndex.from_tuples([((), ())])
        temp_positive = [k for k in button_press_results.keys() if button_press_results[k]=='positive']
        curated_positive = pd.MultiIndex.from_tuples(temp_positive) if len(temp_positive)>0 else emptyIndex
        temp_negative = [k for k in button_press_results.keys() if button_press_results[k]=='negative']
        curated_negative = pd.MultiIndex.from_tuples(temp_negative) if len(temp_negative)>0 else emptyIndex
        # print('Positive: ', curated_positive.difference(emptyIndex).shape[0], end='\n')
        # print('Negative: ', curated_negative.difference(emptyIndex).shape[0], end='\n')

        if (curated_positive.difference(emptyIndex).shape[0]>=minN) and (curated_negative.difference(emptyIndex).shape[0]>=minN):
            clf = LR(penalty='l2', C=10, class_weight='balanced', solver='liblinear', max_iter=1000)
            curated_positive = curated_positive.difference(emptyIndex)
            curated_negative = curated_negative.difference(emptyIndex)

            effective_minN = min(curated_positive.difference(emptyIndex).shape[0], curated_negative.difference(emptyIndex).shape[0])
            n_folds = max(2, effective_minN // samplesPerFold)
            # print('Number of folds:', n_folds)

            deviation_scores = np.zeros(len(curated_positive) + len(curated_negative), dtype=float)
            counts = np.zeros(len(deviation_scores), dtype=int)
            df = []
            for _ in range(nRepeats):
                splits_positive = np.array_split(np.random.permutation(curated_positive), n_folds)
                splits_negative = np.array_split(np.random.permutation(curated_negative), n_folds)

                ses = []
                for i in range(n_folds):
                    X_test, y_test = getXy(splits_positive[i],
                                        splits_negative[i],
                                        patchesCDFs, alpha=alpha, augFunc=augFunc)
                    X_train, y_train = getXy(curated_positive.difference(splits_positive[i]),
                                            curated_negative.difference(splits_negative[i]),
                                            patchesCDFs, alpha=alpha, augFunc=augFunc)
                    clf.fit(X_train, y_train)
                    preds = clf.predict(X_test)
                    
                    ses.append(y_test!=preds)
                ses = pd.concat(ses).astype(int).sort_index()
                df.append(ses)
                progress_bar.value += 1

            progress_bar.layout.display = 'none'

            df = pd.concat(df, axis=1)
            se = df.mean(axis=1)
            se = se[se>minDiscrepancy]

            potentially_false_positive = se.index.intersection(curated_positive)
            potentially_false_negative = se.index.intersection(curated_negative)
            # print("Potentially false positive patches:", potentially_false_positive)
            # print("Potentially false negative patches:", potentially_false_negative)
            # print('Total patches with discrepancies above threshold:', len(se))

            nRows = int(np.ceil(len(se) / nInRow))

        return

    getSuspects()

    def button_clicked(_button):
        nonlocal p
        the_output.clear_output()
        if _button.description=='remove':
            button_press_results.pop(p)
        with the_output:
            showOne()
        return

    with the_output:
        showOne()
    
    yes_button.on_click(button_clicked)
    no_button.on_click(button_clicked)

    return clear_output_widget

def runAnnotation(patchCoordinates, patchesCDFs, imgs, button_press_results, clfd, plog, ads=None, qs=None, L=1, sh=112, pyramidscale=4,
                minN=2, alpha=0.5, augFunc=None, figsize=(5, 5), seed=None, randomness=1., addOutline=True, pcut=[0.25, 0.75], R=1, cmapColors=['red', 'blue'],
                xeniumBundlePaths=None, xeniumMatrixPaths=None, selectedGenes=None, minCount=1, cmapGenes='viridis', numColumns='auto',
                transcriptsAlpha=0.85, transcriptsColor='lime', transcriptsSize=2., startParams=None,
                loadCells=False, loadCellBoundaries=False, loadTranscripts=False, showAnnotations=False, annotations=None, annotationsPalette='tab20'):

    """
    Run positive, negative, or uncertain label annotation of image patches.

    The function facilitates the annotation of image patches as positive, negative, or uncertain.
    It initializes the random seed for reproducibility and sets the figure size for plots. The function 
    creates several buttons for user interaction and a widget to display the output.

    User guide:
    1. The user can click on the "positive", "negative", or "uncertain" buttons to label the displayed patch.
        If a patch contains any amount of a target attribute, it is considered positive. If it contains none, it is negative.
        User can click "uncertain", and the patch will be excluded from any further use.

    2. The "undo" button allows the user to remove the last annotation. Successive "undo" clicks remove one more annotation each time.

    3. When there is enough curated positive and negative patches (as defined by "minN"), the function stats to suggest positive and negative patches for curation.
        If there are less positive patches than negative, the function suggests the most positive uncurated patch for curation, and vice versa.
        If the randomness parameter is set, the function randomly selects a patch for curation if a chance is above the set randomness threshold.
        The function evaluates the likelihood of the randomly selected patch being positive or negative based on the classifier's predictions and parameter "pcut".

    The nested showOne function displays an image patch and updates the classifier based on 
    user desigantion annotations. It identifies curated positive, negative, 
    and uncertain patches and calculates the uncurated patches. If the number of curated 
    positive and negative patches meets the minimum requirement, the function trains a logistic 
    regression classifier using the CDFs of the curated patches. If an augmentation 
    function is provided, it augments the positive patches before training. The classifier 
    predicts the labels of the uncurated patches and suggests a patch for curation based on the predictions.
    If the randomness parameter is set, the function randomly selects a patch for curation if a chance
    if above the set randomness threshold. The function displays the suggested patch for curation.

    The button_clicked function handles button click events. It updates the annotation 
    results based on the button clicked and calls showOne to refresh the display. If the "undo" 
    button is clicked, it removes the last annotation from the results and the patch log.

    Parameters
    ----------
    patchCoordinates : pd.DataFrame
        DataFrame with image patch coordinates.

    patchesCDFs : pd.DataFrame
        DataFrame with CDFs of image tiles.

    img : np.ndarray
        Image.

    button_press_results : dict
        Dictionary with annotation results.

    clfd : dict
        Dictionary with classifier.

    plog : list
        List with patches.

    ads : dictionary
        Dictionary with with pd.DataFrame(s) of samples.

    L : int
        Level of the image pyramid.

    sh : int
        Shift.

    pyramidscale : int
        Pyramid scale.

    minN : int
        Minimum number of patches.

    alpha : float
        Alpha parameter for augmentation.

    augFunc : function
        Augmentation function.

    figsize : tuple
        Figure size.

    seed : int
        Seed.

    randomness : float
        Randomness.

    Returns
    -------
    clear_output_widget : ipywidgets.VBox
        Clear output widget.
    """

    np.random.seed(seed)

    patchCoordinatesFull = patchCoordinates.copy()
    patchCoordinates = patchCoordinates.set_index('patch', append=True).droplevel('barcode', axis=0)
    patchCoordinates = patchCoordinates.sort_index()
    all_patches = patchCoordinates.index.unique()

    yes_button = widgets.Button(description='positive', button_style='success', style={'button_color': '#0D52BD'})
    no_button = widgets.Button(description='negative', button_style='Danger')

    uncertain_button = widgets.Button(description='uncertain', button_style='Warning')
    undo_button = widgets.Button(description='undo', button_style='')

    h_1 = widgets.HBox([yes_button, uncertain_button], layout=widgets.Layout(justify_content='flex-start'))
    h_2 = widgets.HBox([no_button, undo_button], layout=widgets.Layout(justify_content='flex-start'))

    checkbox = widgets.Checkbox(value=True, description='Show differential attributes')

    widget_Radius = widgets.BoundedIntText(value=R, min=0, max=5, step=1, description='Radius:', disabled=False, layout=widgets.Layout(width='140px'))

    hbox = widgets.HBox([checkbox, widget_Radius])

    change_output_button = widgets.Button(description="Change output?")
    the_output = widgets.Output()
    clear_output_widget = widgets.VBox([h_1, h_2, the_output, hbox])

    def toggle_visibility(change):
        widget_Radius.layout.display = 'block' if change['new'] else 'none'

    checkbox.observe(toggle_visibility, names='value')

    def update_Radius(change):
        nonlocal R
        R = change['new']

    widget_Radius.observe(update_Radius, names='value')

    def showOne():
        nonlocal p
        nonlocal clfd

        emptyIndex = pd.MultiIndex.from_tuples([((), ())])

        temp_positive = [k for k in button_press_results.keys() if button_press_results[k]=='positive']
        curated_positive = pd.MultiIndex.from_tuples(temp_positive) if len(temp_positive)>0 else emptyIndex

        temp_negative = [k for k in button_press_results.keys() if button_press_results[k]=='negative']
        curated_negative = pd.MultiIndex.from_tuples(temp_negative) if len(temp_negative)>0 else emptyIndex

        temp_uncertain = [k for k in button_press_results.keys() if button_press_results[k]=='uncertain']
        curated_uncertain = pd.MultiIndex.from_tuples(temp_uncertain) if len(temp_uncertain)>0 else emptyIndex

        uncurated = all_patches.difference(curated_positive).difference(curated_negative).difference(curated_uncertain)
        print('Positive: ', curated_positive.difference(emptyIndex).shape[0], end='\n')
        print('Negative: ', curated_negative.difference(emptyIndex).shape[0], end='\n')
        print('Uncertain: ', curated_uncertain.difference(emptyIndex).shape[0], end='\n')
        print('Uncurated: ', uncurated.difference(emptyIndex).shape[0], end='\n')

        if (curated_positive.difference(emptyIndex).shape[0]>=minN) and (curated_negative.difference(emptyIndex).shape[0]>=minN):
            clf = LR(penalty='l2', C=10, class_weight='balanced', solver='liblinear', max_iter=1000)

            if not alpha is None:
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
            
            X_test = patchesCDFs.loc[uncurated]

            clf.fit(X_train.values, y_train.values)
            clf.feat = X_train.columns.get_level_values(1) + '_' + pd.Index(np.round(X_train.columns.get_level_values(0), 2).astype(str))
            clfd.update({'clf': clf})
            
            if False:
                y_predt = clf.predict_proba(X_train.values)[:, 1]
                auroc_train = round(roc_auc_score(y_train.values, y_predt), 3)
                print('ROC AUC Train:', auroc_train)

            if np.random.rand()>=randomness:
                p = uncurated[np.random.choice(range(len(uncurated)))]
                y_pred = clf.predict_proba(patchesCDFs.loc[[p]].values)[:, 1][0]
                print('Suggested random patch: (%s)' % np.round(y_pred, 2))
                if y_pred >= pcut[1]:
                    patchType = 'positive'
                elif y_pred <= pcut[0]:
                    patchType = 'negative'
                else:
                    patchType = 'random'
            else:
                # Predict all uncurated
                y_pred = clf.predict_proba(X_test.values)[:, 1]
                if len(curated_positive)<len(curated_negative):
                    # Suggest most positive for curation
                    v = np.round(y_pred.max(), 2)
                    print(f'Suggested positive patch ({v})')
                    p = X_test.index[np.argmax(y_pred)]
                    patchType = 'positive'
                else:
                    # Suggest most negative for curation
                    v = np.round(y_pred.min(), 2)
                    print(f'Suggested negative patch ({v})')
                    p = X_test.index[np.argmin(y_pred)]
                    patchType = 'negative'
        else:
            print('Suggested random patch')
            p = uncurated[np.random.choice(range(len(uncurated)))]
            patchType = 'random'

        img_, x1, x2, y1, y2 = loadPatch(p, patchCoordinates, L, sh, pyramidscale, imgs)

        if not startParams is None and 'mif_pca' in startParams.keys() and 'mif_bounds' in startParams.keys():
            temp_imgp = startParams['mif_pca'].transform(img_.reshape(-1, img_.shape[-1]))
            temp_imgp = temp_imgp.reshape(img_.shape[0], img_.shape[1], 3 * startParams['mif_nrep_pca'])
            temp_imgp = np.dstack([temp_imgp[..., i::3].sum(axis=-1)[..., None] for i in range(3)])
            img_ = normalize_pseudo_channels(temp_imgp, startParams['mif_bounds'])

        dims = img_.shape
        imgMarked = img_.copy()
        if addOutline:
            if patchType == 'positive':
                color = np.array([50, 50, 200], dtype=np.uint8)
            elif patchType == 'negative':
                color = np.array([255, 0, 0], dtype=np.uint8)
            else:
                color = np.array([240, 150, 0], dtype=np.uint8)

            borderWidth = max(1, int(0.01 * min(dims[0], dims[1])))
            
            if not color is None:
                imgMarked[:borderWidth, :, :] = color
                imgMarked[-borderWidth:, :, :] = color
                imgMarked[:, :borderWidth, :] = color
                imgMarked[:, -borderWidth:, :] = color
    
        if checkbox.value and 'clf' in clfd:
            fig = plt.figure(figsize=(figsize[0]*2, figsize[1]))
            gs = gridspec.GridSpec(1, 2, width_ratios=[1, 1.25])

            axMain = fig.add_subplot(gs[0])
            axDiff = fig.add_subplot(gs[1])
        else:
            fig, axMain = plt.subplots(figsize=figsize)

        axMain.imshow(imgMarked)
        axMain.set_xlim([0, imgMarked.shape[1]])
        axMain.set_ylim([imgMarked.shape[0], 0])
        axMain.axis('off')
        axMain.set_title(p)

        def calculate_legend_columns(num_items, max_height, item_height):
            max_items_per_column = max_height // item_height
            num_columns = (num_items + max_items_per_column - 1) // max_items_per_column
            return num_columns

        if (not loadCells is None) or (loadTranscripts is not None):
            # print('Loading Xenium data...')
            if not xeniumBundlePaths is None:
                bundle_path = xeniumBundlePaths[p[0]]
                matrix_path = xeniumMatrixPaths[p[0]]

                mppxe = 0.2125
                patch_size = 8.*56.
                Ps = pyramidscale**L

                mat = pd.read_csv(matrix_path, index_col=None, header=None).values
                M, Tr = mat[:2, :2], mat[:2, -1]
                Mi = np.linalg.inv(M)

                tempv = patchCoordinatesFull.xs(p[0], level='sample').set_index('patch', append=True).xs(p[1], level='patch')[['x', 'y']].values
                tempv_xe = (np.dot(tempv, M.T) + Tr) * mppxe
                query_point = (tempv_xe.min(axis=0) + tempv_xe.max(axis=0)) / 2.

                if loadCells:
                    if not loadCellBoundaries:
                        # Find cells in the patch
                        cell_idx, coords = fetch_xenium_zarr_cell_coords(bundle_path, query_point, half_side=patch_size / 2.)
                        
                        # Convert Xenium um to HE pixel coordinates
                        coords_he = np.dot((coords / mppxe) - Tr, Mi.T)
                        coords_he[..., 0] = (coords_he[..., 0] - y1) / Ps
                        coords_he[..., 1] = (coords_he[..., 1] - x1) / Ps
                        
                        if showAnnotations and not annotations is None:
                            this_annotations = annotations[p[0]].iloc[cell_idx]
                            unique_annotations = this_annotations.unique()

                            if type(annotationsPalette) is str:
                                temp_palette = plt.get_cmap(annotationsPalette)
                                ucolors = {a: temp_palette(i) for i, a in enumerate(unique_annotations)}
                            elif type(annotationsPalette) is ListedColormap:
                                ucolors = {a: annotationsPalette(i) for i, a in enumerate(unique_annotations)}
                            elif type(annotationsPalette) in [dict]:
                                ucolors = {a: annotationsPalette[a] if a in annotationsPalette else 'gray' for a in unique_annotations}
                            else:
                                raise ValueError("Annotations palette should be a colormap name, e.g., 'tab20', or a dictionary mapping annotations to colors.")

                            colors = [ucolors[a] for a in this_annotations.values]

                            sca = axMain.scatter(coords_he[:, 0], coords_he[:, 1],
                                                s=10, c=colors, alpha=1.,
                                                edgecolors='none')

                            max_height = fig.get_figheight() * fig.dpi
                            item_height = 25
                            if numColumns == 'auto':
                                num_columns = calculate_legend_columns(len(unique_annotations), max_height, item_height)
                            else:
                                num_columns = numColumns
                            cic_handles = []
                            mkeys = sorted(list(ucolors.keys()), key=str.lower)
                            for annotation in mkeys:
                                color = ucolors[annotation]
                                cic_handles.append(Line2D([0], [0], marker='o', color='w', label=annotation, markerfacecolor=color, markersize=10))
                            leg = axMain.legend(handles=cic_handles, bbox_to_anchor=(1, 0.5), loc='center left', ncol=num_columns, fancybox=False,
                                    frameon=False, fontsize=10, title='', title_fontsize=16)
                            leg.set_zorder(10**8)

                        else:
                            # Extract cells by gene matrix from Xenium Zarr store
                            csrmat = fetch_cell_by_gene_matrix(bundle_path, sel_genes=selectedGenes, cell_idx=cell_idx)
                            sum_per_cell = csrmat.sum(axis=0).A1
                            vqmax = np.quantile(sum_per_cell, 0.99)

                            wh = sum_per_cell >= minCount
                            sca = axMain.scatter(coords_he[:, 0][wh], coords_he[:, 1][wh],
                                                s=10, c=sum_per_cell[wh], alpha=1.,
                                                cmap=cmapGenes, edgecolors='none',
                                                vmin=0, vmax=vqmax)
                            
                            plt.colorbar(sca, ax=axMain, shrink=0.35)
                    
                    else:
                        # Find cells in the patch
                        cell_idx, coords, boundaries = fetch_xenium_zarr_cell_coords(bundle_path, query_point, 
                                                                                    half_side=patch_size / 2., 
                                                                                    return_boundaries=True, 
                                                                                    boundary_id=1)

                        # Convert Xenium um to HE pixel coordinates
                        coords_he = np.dot((coords / mppxe) - Tr, Mi.T)
                        boundaries = np.dot((boundaries / mppxe) - Tr, Mi.T)
                        boundaries[..., 0] = (boundaries[..., 0] - y1) / Ps
                        boundaries[..., 1] = (boundaries[..., 1] - x1) / Ps

                        if showAnnotations and not annotations is None:
                            this_annotations = annotations[p[0]].iloc[cell_idx]
                            unique_annotations = this_annotations.unique()

                            if type(annotationsPalette) is str:
                                temp_palette = plt.get_cmap(annotationsPalette)
                                ucolors = {a: temp_palette(i) for i, a in enumerate(unique_annotations)}
                            elif type(annotationsPalette) is ListedColormap:
                                ucolors = {a: annotationsPalette(i) for i, a in enumerate(unique_annotations)}
                            elif type(annotationsPalette) in [dict]:
                                ucolors = {a: annotationsPalette[a] if a in annotationsPalette else 'gray' for a in unique_annotations}
                            else:
                                raise ValueError("Annotations palette should be a colormap name, e.g., 'tab20', or a dictionary mapping annotations to colors.")

                            colors = [ucolors[a] for a in this_annotations.values]

                            patches = []
                            for i in range(len(boundaries)):
                                patches.append(Polygon(boundaries[i], closed=True, fill=True, edgecolor='k',
                                                        linewidth=0.5, facecolor=colors[i], label=None, alpha=0.65))
                            pc = PatchCollection(patches, match_original=True)
                            axMain.add_collection(pc)

                            max_height = fig.get_figheight() * fig.dpi
                            item_height = 25
                            if numColumns == 'auto':
                                num_columns = calculate_legend_columns(len(unique_annotations), max_height, item_height)
                            else:
                                num_columns = numColumns
                            cic_handles = []
                            mkeys = ['Transcripts'] + sorted(list(ucolors.keys()), key=str.lower)
                            for annotation in mkeys:
                                color = ucolors[annotation] if not annotation=='Transcripts' else 'lime'
                                cic_handles.append(Line2D([0], [0], marker='o', color='w', label=annotation, markerfacecolor=color, markersize=10 if not annotation=='Transcripts' else 5))
                            leg = axMain.legend(handles=cic_handles, bbox_to_anchor=(1, 0.5), loc='center left', ncol=num_columns, fancybox=False,
                                    frameon=False, fontsize=10, title='', title_fontsize=16)
                            leg.set_zorder(10**8)

                        else:
                            # Extract cells by gene matrix from Xenium Zarr store
                            csrmat = fetch_cell_by_gene_matrix(bundle_path, sel_genes=selectedGenes, cell_idx=cell_idx)
                            sum_per_cell = csrmat.sum(axis=0).A1
                            vqmax = np.quantile(sum_per_cell, 0.99)      
                                                                        
                            cmap = plt.get_cmap(cmapGenes, 256)
                            vc = sum_per_cell
                            vmin, vmax = 0, vqmax
                            if vmax==vmin:
                                vmax = vmin + 1
                            # print('vmin, vmax:', vmin, vmax)
                            if vmin is not None and vmax is not None:
                                vc = (vc - vmin) / (vmax - vmin)
                                vc = np.clip(vc, 0, 1)

                            whid = np.where(sum_per_cell >= minCount)[0]
                            patchcolor = cmap(vc)
                            patches = []
                            for i in whid:
                                patches.append(Polygon(boundaries[i], closed=True, fill=True, edgecolor='k',
                                                        linewidth=0.5, facecolor=patchcolor[i], label=None, alpha=0.65))
                            pc = PatchCollection(patches, match_original=True)

                            axMain.add_collection(pc)
                            pc.set_clim(vmin=vmin, vmax=vmax)
                            cbar = plt.colorbar(pc, ax=axMain, label='Counts', orientation='vertical', fraction=0.03, pad=0.04, shrink=0.35)
                            cbar.ax.tick_params(labelsize=12)


                if loadTranscripts:
                    # Extract transcripts from the Xenium Zarr store
                    coords, gene_names = extract_transcripts_from_grid_locs(bundle_path, query_point, patch_size, selectedGenes)

                    coords_he = np.dot((coords / mppxe) - Tr, Mi.T)
                    axMain.scatter((coords_he[:, 0] - y1) / Ps,
                                    (coords_he[:, 1] - x1) / Ps,
                                    s=transcriptsSize, c=transcriptsColor, alpha=transcriptsAlpha, edgecolors='none')         

        if checkbox.value and 'clf' in clfd:
            df_temp = patchCoordinatesFull.xs(p[0], level='sample', axis=0)
            infTiles = df_temp[df_temp['patch'] == p[1]].index.sort_values()

            tree = KDTree(df_temp[['x', 'y']])
            indices = tree.query_ball_point(df_temp.loc[infTiles][['x', 'y']], R * 2 * sh + 2)
            wrkTiles = df_temp.index[np.unique(np.concatenate(indices))]
            bndTiles = wrkTiles.difference(infTiles)

            ad_sub = ads[p[0]][wrkTiles].copy()
            x_inf, y_inf, p_inf = inferProb(ad_sub, clfd['clf'], qs, tsize=2*sh, R=R, verbose=False, parallel=False, erode=True)

            searchTiles = ads[p[0]].obs.set_index(['pxl_col_in_wsi', 'pxl_row_in_wsi'])['original_barcode'].loc[pd.MultiIndex.from_arrays([x_inf, y_inf], names=['pxl_col_in_wsi', 'pxl_row_in_wsi'])].values
            df_inf = pd.DataFrame({'x': x_inf, 'y': y_inf, 'p': p_inf}, index=searchTiles).loc[infTiles]

            axDiff.imshow(img_, alpha=1.)
            f = pyramidscale**L

            heatmap = np.zeros((dims[0], dims[1]), dtype=np.float32) * np.nan
            idata = interpolate_points(df_inf['x'], df_inf['y'], df_inf['p'], multiplier=64)
            for x_temp, y_temp, p_temp in zip(idata[0], idata[1], idata[2]):
                heatmap[int((y_temp-x1-sh)/f):int((y_temp-x1+sh)/f),
                        int((x_temp-y1-sh)/f):int((x_temp-y1+sh)/f)] = p_temp

            cmap = LinearSegmentedColormap.from_list(None, cmapColors, N=256)
            pparams = dict(cmap=cmap, alpha=0.85, vmin=0, vmax=1)
            imh = axDiff.imshow(heatmap, **pparams)

            plt.colorbar(imh, ax=axDiff, shrink=0.35)
            axDiff.axis('off')
            axDiff.set_aspect('equal')
            axDiff.set_title('Positive class probability')

        plt.tight_layout()
        plt.show()

        return

    def button_clicked(_button):
        the_output.clear_output()
        if _button.description=='undo':
            button_press_results.pop(plog[-1])
            plog.pop(-1)
            with the_output:
                showOne()
        else:
            button_press_results[p] = _button.description
            plog.append(p)
            with the_output:
                showOne()
        return

    p = None

    with the_output:
        showOne()
    
    yes_button.on_click(button_clicked)
    no_button.on_click(button_clicked)
    uncertain_button.on_click(button_clicked)
    undo_button.on_click(button_clicked)

    return clear_output_widget

def loadPatch(p, patchCoordinates, L, sh, pyramidscale, imgs):

    df_vals = patchCoordinates[['y', 'x']].loc[p]
    x1, y1 = df_vals.min().values
    x2, y2 = df_vals.max().values
    
    x1, y1 = x1-sh, y1-sh
    x2, y2 = x2+sh, y2+sh

    f = pyramidscale**L
    mx1, mx2 = int(x1/f), int(x2/f)
    my1, my2 = int(y1/f), int(y2/f)

    if type(imgs[p[0]]) == str:
        # if the image is a path, connect to Zarr store, read the patch
        with tifffile.imread(imgs[p[0]], aszarr=True) as store:
            with zarr.open(store, mode='r') as zArray:
                pyramidscale_zarr = int(round(zArray[0].shape[1] / zArray[L].shape[1]))
                # TODO: Use pyramidscale input parameter only for ndarrays, not for zarr
                # For Zarr, pyramidscale is determined automatically from the zarr store
                # This is necessary to allow simultaneous use of Zarr images with different pyramid scales
                assert pyramidscale_zarr == pyramidscale, "Mismatch in pyramid scale between image and input parameter."
                img_ = np.moveaxis(zArray[L][:, mx1:mx2, my1:my2], 0, -1)
    elif type(imgs[p[0]]) == np.ndarray:
        # if the image is a numpy array, slice it
        img_ = imgs[p[0]][mx1:mx2, my1:my2].copy()
    else:
        raise ValueError("Unsupported image type. Must be either a path or a numpy array.")

    return img_, x1, x2, y1, y2

def jumpStart(patchCoordinates, patchesCDFs, imgs, startParams, ads=None, L=1, sh=112, pyramidscale=4, figsize=(3, 3),
            seed=None, nrows=3, ncols=4, metric='correlation', maxN=10**3, equal_pca=False):

    """ Jump start the annotation process by displaying a grid of image patches.
    This function initializes the annotation process by displaying a grid of image patches.
    For mIF images, it prepares PCA on the patches to normalize the pseudo-channels. The PCA is 
    used in the subsequent annotation process to ensure that the patches are displayed in a consistent manner.

    Instructions:
    1. Enter the index of the patch you want to start with in the "Selected" widget.
    2. Click on the "done" button to choose the starting positive patch in the annotation process.

    Parameters
    ----------
    patchCoordinates : pd.DataFrame
        DataFrame with image patch coordinates.

    patchesCDFs : pd.DataFrame
        DataFrame with CDFs of image tiles.

    imgs : dict
        Dictionary with images, where keys are sample names and values are either paths to Zarr stores or numpy arrays. 

    startParams : dict
        Dictionary with parameters for the annotation process, including PCA and bounds for mIF images.

    ads : dict, optional
        Dictionary with ads DataFrames for samples. Default is None.

    L : int, optional
        Level of the image pyramid. Default is 1.

    sh : int, optional
        Shift for the image patches. Default is 112.

    pyramidscale : int, optional
        Scale factor for the image pyramid. Default is 4.

    figsize : tuple, optional   
        Size of the figure for displaying patches. Default is (3, 3).

    seed : int, optional
        Seed for random number generation. Default is None.

    nrows : int, optional
        Number of rows in the grid of patches. Default is 3.

    ncols : int, optional
        Number of columns in the grid of patches. Default is 4.

    metric : str, optional
        Metric for clustering the patches. Default is 'correlation'.

    maxN : int, optional
        Maximum number of patches to use for clustering. Default is 1000.

    equal_pca : bool, optional
        Whether to apply equal PCA normalization for mIF images. Default is False.
        If False, PCs with larger variance will have stronger visual impact.
    """

    np.random.seed(seed)

    patchCoordinatesFull = patchCoordinates.copy()
    patchCoordinates = patchCoordinates.set_index('patch', append=True).droplevel('barcode', axis=0)
    patchCoordinates = patchCoordinates.sort_index()
    all_patches = patchCoordinates.index.unique()

    progress_bar = widgets.IntProgress(value=0, min=0, max=nrows*ncols, description='Loading:',
                                       bar_style='info', orientation='horizontal')

    # Display the progress bar
    display(progress_bar)

    done_button = widgets.Button(description='choose', button_style='success', style={'button_color': '#0D52BD'})
    choose_widget = widgets.BoundedIntText(value=0, min=0, max=nrows*ncols-1, step=1, description='Selected:', disabled=False)

    h_box = widgets.HBox([choose_widget, done_button], layout=widgets.Layout(justify_content='flex-start'))

    the_output = widgets.Output()
    the_widget = widgets.VBox([h_box, the_output])

    def loadAll():

        nonlocal ps
        nonlocal imgps
        nonlocal is_mif

        N = min(ncols*nrows, patchesCDFs.shape[0])

        kmeans = KMeans(n_clusters=N)
        if not maxN is None:
            subsetCDFs = patchesCDFs.sample(n=min(maxN, patchesCDFs.shape[0]))
        else:
            subsetCDFs = patchesCDFs
        
        distance = squareform(pdist(subsetCDFs.values, metric=metric))
        kmeans.fit(distance)
        clusters = kmeans.labels_

        sel_patches = subsetCDFs.index[[np.random.choice(np.where(clusters == i)[0]) for i in range(N)]]
        ps = sel_patches

        imgps = []
        for i in range(nrows):
            for j in range(ncols):
                ind = i*ncols+j
                if ind < N:
                    p_ = sel_patches[ind]
                    imgps.append(loadPatch(p_, patchCoordinates, L, sh, pyramidscale, imgs)[0])
                progress_bar.value += 1

        is_mif = False
        if imgps[0].shape[-1] > 3:
            progress_bar.description = 'Normalizing:'
            progress_bar.bar_style = 'success'
            progress_bar.max = 3
            progress_bar.value = 0

            is_mif = True

            Nrep = imgps[0].shape[-1] // 3
            pca = PCA(n_components=3 * Nrep, random_state=seed, whiten=equal_pca)
            fdata = np.vstack([imgp.reshape(-1, imgp.shape[-1]) for imgp in imgps])
            if fdata.shape[0] > 3*10**6:
                fdata = fdata[np.random.choice(fdata.shape[0], size=10**6, replace=False), :]
            pca.fit(fdata)

            progress_bar.value += 1

            startParams.update({'mif_pca': pca, 'mif_nrep_pca': Nrep})

            for i in range(nrows):
                for j in range(ncols):
                    ind = i*ncols+j
                    if ind < N:
                        temp_imgp = startParams['mif_pca'].transform(imgps[ind].reshape(-1, imgps[ind].shape[-1]))
                        temp_imgp = temp_imgp.reshape(imgps[ind].shape[0], imgps[ind].shape[1], 3 * startParams['mif_nrep_pca'])
                        temp_imgp = np.dstack([temp_imgp[..., i::3].sum(axis=-1)[..., None] for i in range(3)])
                        imgps[ind] = temp_imgp

            progress_bar.value += 1

            bounds = []
            for i in range(3):
                temp = np.vstack([np.quantile(imgp[..., i].flatten(), [0.025, 0.975]) for imgp in imgps])
                bounds.append(np.median(temp, axis=0))
            bounds = np.array(bounds)

            startParams.update({'mif_bounds': bounds})

            progress_bar.value += 1

            imgps = [normalize_pseudo_channels(imgp, startParams['mif_bounds']) for imgp in imgps]

    def showAll(indh=None):

        nonlocal ps
        nonlocal imgps
        nonlocal is_mif

        fig, axs = plt.subplots(nrows=nrows, ncols=ncols, figsize=(figsize[0]*ncols, figsize[1]*nrows))

        if nrows==1 and ncols==1:
            axs = np.array([axs])
 
        axs = axs.flatten()
        for i in range(nrows):
            for j in range(ncols):
                ind = i*ncols+j
                if ind < len(imgps):
                    p_ = ps[ind]
                    axs[ind].imshow(imgps[ind])

                    if not indh is None and ind==indh:
                        axs[ind].add_patch(Rectangle((0, 0), imgps[ind].shape[1], imgps[ind].shape[0], linewidth=4, edgecolor='blue', facecolor='none'))

                    if is_mif:
                        text_color = 'w'
                        outline_color = 'k'
                    else:
                        text_color = 'k'
                        outline_color = 'w'

                    txt = axs[ind].text(10, 10, f'({ind}) {p_[0]}\n{p_[1]}', horizontalalignment='left', 
                                        verticalalignment='top', fontsize=10, color=text_color, fontweight='bold')
                    txt.set_path_effects([matplotlib.patheffects.withStroke(linewidth=1, foreground=outline_color)])
                axs[ind].axis('off')

        progress_bar.layout.display = 'none'
        plt.show()
    
        return

    def showSelectedOne():

        nonlocal ps
        nonlocal imgps
        nonlocal is_mif

        ind = choose_widget.value
        p_ = ps[ind]

        fxx = 1.8
        fig, ax = plt.subplots(1, 1, figsize=(figsize[0]*fxx, figsize[1]*fxx))
    
        if is_mif:
            text_color = 'w'
            outline_color = 'k'
        else:
            text_color = 'k'
            outline_color = 'w'

        ax.imshow(imgps[ind])
        txt = ax.text(10, 10, f'({ind}) {p_[0]}\n{p_[1]}', horizontalalignment='left', 
                    verticalalignment='top', fontsize=10, color=text_color, fontweight='bold')
        txt.set_path_effects([matplotlib.patheffects.withStroke(linewidth=1, foreground=outline_color)])
        ax.axis('off')

        ax.add_patch(Rectangle((0, 0), imgps[ind].shape[1], imgps[ind].shape[0], linewidth=4, edgecolor='blue', facecolor='none'))

        plt.show()
    
        return

    def button_clicked(_button):

        # if not 'selected_patch' in startParams.keys():
        if True:
            the_output.clear_output()
            startParams.update({'selected_id': choose_widget.value})
            startParams.update({'selected_patch': ps[choose_widget.value]})
            startParams.update({'considered_patches': ps})

            # # Hide the button and the selection widget
            # done_button.layout.display = 'none'
            # choose_widget.layout.display = 'none'

            with the_output:
                showAll(indh=choose_widget.value)
                print('-' * 160)

                showSelectedOne()
        return

    ps = None
    imgps = None
    is_mif = False

    with the_output:
        if imgps is None:
            loadAll()
        showAll()
    
    done_button.on_click(button_clicked)

    return the_widget
