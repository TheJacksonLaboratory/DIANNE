"""Author: Sergii Domanskyi
Organization: The Jackson Laboratory for Genomic Medicine
Date: 2025-01-01
"""

import pandas as pd
import numpy as np

from sklearn.svm import SVC
from sklearn.linear_model import LogisticRegression as LR
from sklearn.metrics import roc_auc_score

import matplotlib
import matplotlib.pyplot as plt
import ipywidgets as widgets

def runAnnotation(patchCoordinates, patchesCDFs, imgs, button_press_results, clfd, plog, L=1, sh=112,
                minN=2, alpha=0.5, augFunc=None, figsize=(5, 5), seed=None, randomness=1., addOutline=True):

    """
    Run positive, negative, or uncertain label annotation of image patches.

    The function facilitates the annotation of image patches as positive, negative, or uncertain.
    It initializes the random seed for reproducibility and sets the figure size for plots. The function 
    creates several buttons for user interaction and a widget to display the output.

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

    L : int
        Level of the image pyramid.

    sh : int
        Shift.

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

    patchCoordinates = patchCoordinates.set_index('patch', append=True).droplevel('barcode', axis=0)
    patchCoordinates = patchCoordinates.sort_index()
    all_patches = patchCoordinates.index.unique()

    yes_button = widgets.Button(description='yes')
    no_button = widgets.Button(description='no')
    uncertain_button = widgets.Button(description='uncertain')
    undo_button = widgets.Button(description='undo')

    change_output_button = widgets.Button(description="Change output?")
    the_output = widgets.Output()
    clear_output_widget = widgets.VBox([yes_button, no_button, uncertain_button, undo_button, the_output])

    def showOne():
        nonlocal p
        nonlocal clfd

        emptyIndex = pd.MultiIndex.from_tuples([((), ())])

        temp_positive = [k for k in button_press_results.keys() if button_press_results[k]=='yes']
        curated_positive = pd.MultiIndex.from_tuples(temp_positive) if len(temp_positive)>0 else emptyIndex

        temp_negative = [k for k in button_press_results.keys() if button_press_results[k]=='no']
        curated_negative = pd.MultiIndex.from_tuples(temp_negative) if len(temp_negative)>0 else emptyIndex

        temp_uncertain = [k for k in button_press_results.keys() if button_press_results[k]=='uncertain']
        curated_uncertain = pd.MultiIndex.from_tuples(temp_uncertain) if len(temp_uncertain)>0 else emptyIndex

        uncurated = all_patches.difference(curated_positive).difference(curated_negative).difference(curated_uncertain)
        print('Positive: ', curated_positive.difference(emptyIndex).shape[0], end='\n')
        print('Negative: ', curated_negative.difference(emptyIndex).shape[0], end='\n')
        print('Uncertain: ', curated_uncertain.difference(emptyIndex).shape[0], end='\n')
        print('Uncurated: ', uncurated.difference(emptyIndex).shape[0], end='\n')

        if (len(curated_positive)>=minN) and (len(curated_negative)>=minN):
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
                print('Random patch')
                p = uncurated[np.random.choice(range(len(uncurated)))]
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
            print('Random patch')
            p = uncurated[np.random.choice(range(len(uncurated)))]
            patchType = 'random'


        df_vals = patchCoordinates[['y', 'x']].loc[p]
        x1, y1 = df_vals.min().values
        x2, y2 = df_vals.max().values
        
        x1, y1 = x1-sh, y1-sh
        x2, y2 = x2+sh, y2+sh
    
        f = 4**L
        mx1, mx2 = int(x1/f), int(x2/f)
        my1, my2 = int(y1/f), int(y2/f)

    
        fig, ax = plt.subplots(figsize=figsize)
        img_ = imgs[p[0]][mx1:mx2, my1:my2].copy()
        dims = img_.shape
        if addOutline:
            if patchType == 'positive':
                color = np.array([0, 255, 0], dtype=np.uint8)
            elif patchType == 'negative':
                color = np.array([255, 0, 0], dtype=np.uint8)
            else:
                color = None

            borderWidth = int(0.01 * min(dims[0], dims[1]))
            
            if not color is None:
                img_[:borderWidth, :, :] = color
                img_[-borderWidth:, :, :] = color
                img_[:, :borderWidth, :] = color
                img_[:, -borderWidth:, :] = color

        ax.imshow(img_)
        ax.axis('off')
        ax.set_title(p)
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
