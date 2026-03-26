"""Author: Sergii Domanskyi
Organization: The Jackson Laboratory for Genomic Medicine
Date: 2025-03-14
"""

import os
import json
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.patheffects as path_effects
import numpy as np
import ipywidgets as widgets

def runSelection(thumbsPath, samples, ext='tiff', initCoords=[(0., 1.), (0., 1.)], alpha=0.5, figsize=(7, 5), precision=2, downsample=8, fontsize=16,
                addSuffix=True, clearInput=False, defaultSuffix=''):

    """Run ROI selection tool for a given image.

    The runSelection function is designed to facilitate the selection of a region of interest (ROI) within an image.
    It loads an image from a specified directory and optionally downsamples it. If a JSON file with the same name 
    as the image exists in the directory, it reads the initial coordinates for the bounding box from this file; 
    otherwise, it uses default coordinates.

    The function creates two sliders using the ipywidgets library, allowing the user to adjust the horizontal 
    and vertical boundaries of the ROI. These sliders are configured with initial values, precision, and layout settings.

    A nested function calculates the pixel coordinates of the bounding box based on the slider values and 
    plots the image with the bounding box overlay. If changes are made, the function saves the ROI coordinates to a JSON file.

    Every time the slider is moved it clears current output image, updates the coordinates based on the slider values.

    Parameters:
    thumbsPath (str):
        Path to the directory containing the thumbnails.

    sample (str):
        Name of the sample file.

    ext (str):
        File extension of the image file.

    initCoords (list):
        Initial coordinates of the bounding box. If a JSON file with the same name as the sample file exists 
        in the thumbsPath directory, the coordinates will be read from that file. 
        Otherwise, the coordinates will be set to the values provided in this argument.

    alpha (float):
        Transparency of the image.

    figsize (tuple):
        Size of the figure.

    precision (int):
        Precision of the sliders.

    downsample (int):
        Factor by which to downsample the image.

    fontsize (int):
        Font size of the text.

    Returns:
    None
    """

    def prepSample(b):

        nonlocal initCoords

        try:
            sample = samples[currentSample]
        except IndexError:
            return None, None, None, None, None

        img = plt.imread(f"{thumbsPath}/{sample}.{ext}")
        
        if not downsample is None:
            img = img[::downsample, ::downsample]

        if os.path.isfile(f'{thumbsPath}/{sample}.json'):
            with open(f'{thumbsPath}/{sample}.json', 'r') as tempfile:
                infodata = json.loads(tempfile.read())
            initCoords = [(infodata['0']['location'], infodata['0']['location']+infodata['0']['size']),
                        (infodata['1']['location'], infodata['1']['location']+infodata['1']['size'])]

        x = initCoords[0][0], initCoords[0][1]
        y = initCoords[1][0], initCoords[1][1]
        write = False
        return x, y, write, img, sample


    N = len(samples)

    currentSample = 0
    showOutOfSamplesMessage = True

    x, y, write, img, sample = prepSample(currentSample)

    next_button = widgets.Button(description='Next')

    h_slider = widgets.FloatRangeSlider(
        value=[x[0], x[1]],
        min=0.,
        max=1.,
        step=10**(-precision),
        description='',
        disabled=False,
        continuous_update=False,
        orientation='horizontal',
        readout=False,
        readout_format='.1f',
        layout=widgets.Layout(width=f'{1.*img.shape[1]}px'))

    v_slider = widgets.FloatRangeSlider(
        value=[y[0], y[1]],
        min=0.,
        max=1.,
        step=10**(-precision),
        description='',
        disabled=False,
        continuous_update=False,
        orientation='vertical',
        readout=False,
        readout_format='.1f',
        layout=widgets.Layout(height=f'{1.*img.shape[0]}px'))    

    def next_button_clicked(_button):
        nonlocal currentSample, x, y, write, img, sample, N
        nonlocal showOutOfSamplesMessage
        nonlocal h_slider, v_slider
        if currentSample == N-1:
            the_output.clear_output()
            h_slider.layout.display = 'none'
            v_slider.layout.display = 'none'
            save_button.layout.display = 'none'
            next_button.layout.display = 'none'
            input_text_savename.layout.display = 'none'
            if showOutOfSamplesMessage:
                with the_output:
                    print("Done processing all samples.")
                showOutOfSamplesMessage = False
            return

        currentSample += 1
        x, y, write, img, sample = prepSample(currentSample)
        if img is None:
            the_output.clear_output()
            return

        h_slider.unobserve(slider_moved, names='value')
        h_slider.value = x
        h_slider.observe(slider_moved, names='value')

        v_slider.unobserve(slider_moved, names='value')
        v_slider.value = y
        v_slider.observe(slider_moved, names='value')

        if clearInput:
            input_text_savename.value = ''

        the_output.clear_output()

        with the_output:
            showOne()
        return

    def save_button_clicked(_button):
        nonlocal currentSample, x, y, write, img, sample, N
        nonlocal showOutOfSamplesMessage
        nonlocal h_slider, v_slider

        if addSuffix:
            suffix = input_text_savename.value
            suffixp = '-0' if suffix == '' else f'{suffix}'
        else:
            suffixp = ''

        a = np.round(x[0], precision), np.round(y[0], precision)
        b = np.round(x[1] - x[0], precision), np.round(y[1] - y[0], precision)
        roi = {str(k): {"location": a[k], "size": b[k]} for k in range(2)}
        with open(f'{thumbsPath}/{sample}{suffixp}.json', 'w') as outfile:
            outfile.write(json.dumps(roi))

        if clearInput:
            input_text_savename.value = ''

        return


    input_text_savename = widgets.Text(description='', placeholder='ROI suffix, e.g., 0', layout=widgets.Layout(width='150px'))
    input_text_savename.value = defaultSuffix
    
    save_button = widgets.Button(description="Save ROI")
    the_output = widgets.Output()

    right_box = widgets.VBox([the_output, h_slider, input_text_savename, save_button, next_button])
    clear_output_widget = widgets.HBox([v_slider, right_box])

    def showOne(v=''):

        nonlocal x, y, write

        _x = x[0]*img.shape[1], x[1]*img.shape[1]
        _y = y[0]*img.shape[0], y[1]*img.shape[0]

        fig, ax = plt.subplots(figsize=figsize)
        
        ax.imshow(img, alpha=0.75)

        plt.plot([_x[0], _x[1], _x[1], _x[0], _x[0]],
                 [_y[0], _y[0], _y[1], _y[1], _y[0]], 'r-' )

        ax.add_patch(matplotlib.patches.Rectangle((_x[0], _y[0]), _x[1]-_x[0], _y[1]-_y[0],
                                                linewidth=1, edgecolor=None, facecolor='red', alpha=0.25))

        ax.axis('off')
        ax.set_aspect('equal', adjustable='box')
        ax.invert_yaxis()
        ax.set_title(sample, fontsize=fontsize)

        plt.show()

        return

    def slider_moved(_slider):

        the_output.clear_output()

        nonlocal x, y, write

        write = True

        d = _slider['owner'].orientation
        if d=='horizontal':
            x = _slider['new']
        elif d=='vertical':
            y = _slider['new']

        with the_output:
            showOne()
        return

    h_slider.observe(slider_moved, names='value')
    v_slider.observe(slider_moved, names='value')
    next_button.on_click(next_button_clicked)
    save_button.on_click(save_button_clicked)
 
    with the_output:
        showOne()

    return clear_output_widget

def viewSelection(thumbsPath, sample, selection, downsample=8, c='crimson', ext='tiff', fontsize=12):

    """
    Load JSON annotation and display a selected region of an image.

    Parameters:
    thumbsPath (str):
        Path to the directory containing the thumbnails.

    sample (str):
        Name of the sample file.

    selection (str):
        Name of the selection JSON file.

    downsample (int):
        Factor by which to downsample the image.

    c (str):
        Color of the bounding box.

    ext (str):
        File extension of the image file.

    fontsize (int):
        Font size of the text.

    Returns:
    None
    """

    if not os.path.isfile(thumbsPath + f'/{selection}.json'):
        print(f'No annotation found for {selection}.')
        return

    with open(thumbsPath + f'/{selection}.json', 'r') as tempfile:
        infodata = json.loads(tempfile.read())
    
    if not os.path.isfile(thumbsPath + f'/{sample}.{ext}'):
        print(f'No image found for {sample}.')
        return

    img = plt.imread(thumbsPath + f'/{sample}.{ext}')
    
    if not downsample is None:
        img  = img[::downsample, ::downsample, :]
    
    fx = img.shape[1]/300
    fy = img.shape[0]/300

    fig, ax = plt.subplots(1, 1, figsize=(fx*4, fy*4))

    ax.imshow(img[:, :, :3], origin='lower')
    ax.set_xticks([])
    ax.set_xticklabels([])
    ax.set_yticks([])
    ax.set_yticklabels([])
    ax.invert_yaxis()
    ax.set_aspect('equal')
    ax.axis('off')

    x1 = infodata['0']['location']*img.shape[1]
    x2 = x1 + infodata['0']['size']*img.shape[1]
    y1 = infodata['1']['location']*img.shape[0]
    y2 = y1 + infodata['1']['size']*img.shape[0]
    ax.plot([x1, x1, x2, x2, x1], [y1, y2, y2, y1, y1], linewidth=1.0, c=c)
    
    tx = ax.text((x1+x2)/2, (y1+y2)/2, selection, fontsize=8 * fontsize / downsample, ha='center', va='center', fontweight='bold', c='w')
    tx.set_path_effects([path_effects.Stroke(linewidth=2., foreground='k'), path_effects.Normal()])
    
    plt.tight_layout()
    plt.show()
    
    return

def viewSelectionMultipleTissues(thumbsPath, sample, tissue, downsample=8, c='crimson', ext='tiff', puttext=True, fontsize=12, vmin=None, vmax=None, savename=None, dpi=150):

    """
    Load JSON annotation and display a selected region of an image.

    Parameters:
    thumbsPath (str):
        Path to the directory containing the thumbnails.

    sample (str):
        Name of the sample file.

    downsample (int):
        Factor by which to downsample the image.

    c (str):
        Color of the bounding box.

    ext (str):
        File extension of the image file.

    fontsize (int):
        Font size of the text.

    Returns:
    None
    """

    if not os.path.isfile(thumbsPath + f'/{tissue}.json'):
        print(f'No annotation found for {tissue}.')
        return

    with open(thumbsPath + f'/{tissue}.json', 'r') as tempfile:
        infodata = json.loads(tempfile.read())
    
    if not os.path.isfile(thumbsPath + f'/{sample}.{ext}'):
        print(f'No image found for {sample}.')
        return

    img = plt.imread(thumbsPath + f'/{sample}.{ext}')
    
    if not downsample is None:
        img  = img[::downsample, ::downsample, ...]
    
    fx = img.shape[1]/300
    fy = img.shape[0]/300

    fig, ax = plt.subplots(1, 1, figsize=(fx*4, fy*4))

    if len(img.shape)==2:
        ax.imshow(img[:, :], origin='lower', vmin=vmin, vmax=vmax)
    else:
        ax.imshow(img[:, :, :3], origin='lower', vmin=vmin, vmax=vmax)
    ax.set_xticks([])
    ax.set_xticklabels([])
    ax.set_yticks([])
    ax.set_yticklabels([])
    ax.invert_yaxis()
    ax.set_aspect('equal')
    ax.invert_yaxis()
    ax.axis('off')

    x1 = infodata['0']['location']*img.shape[1]
    x2 = x1 + infodata['0']['size']*img.shape[1]
    y1 = infodata['1']['location']*img.shape[0]
    y2 = y1 + infodata['1']['size']*img.shape[0]
    ax.plot([x1, x1, x2, x2, x1], [y1, y2, y2, y1, y1], linewidth=1.0, c=c)
    
    if puttext:
        tx = ax.text((x1+x2)/2, (y1+y2)/2, tissue.split('.')[0], fontsize=8 * fontsize / downsample, ha='center', va='center', fontweight='bold', c='w')
        tx.set_path_effects([path_effects.Stroke(linewidth=2., foreground='k'), path_effects.Normal()])
    
    if savename is not None:
        plt.savefig(savename, dpi=dpi, bbox_inches='tight', pad_inches=0.1)

    plt.show()
    
    return
