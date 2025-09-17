
from scipy.ndimage import gaussian_filter1d
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from scipy.interpolate import make_interp_spline
from matplotlib.patches import Patch

def show_chosen_alpha_plot(path, F=2, alpha=0.80):
    dfrn = pd.read_csv(f'{path}/normal-F{F}-{alpha:.2f}.csv')
    dfr = pd.read_csv(f'{path}/tumor-F{F}-{alpha:.2f}.csv')

    fix, axs = plt.subplots(1, 2, figsize=(7,4), gridspec_kw = {'width_ratios':[2, 3]})
    ax = axs[0]
    s = 10
    ax.scatter(dfr['dianne_recall'], dfr['dianne_precision'], alpha=0.75, label='DIANNE', s=s, clip_on=False)
    ax.scatter(dfr['clam_recall'], dfr['clam_precision'], alpha=0.75, label='CLAM', s=s, clip_on=False)
    ax.scatter(dfr['segmenter_recall'], dfr['segmenter_precision'], alpha=0.75, label='Segmenter', s=s, clip_on=False, color='olive')
    ax.set_xlabel('Recall', fontsize=14)
    ax.set_ylabel('Precision', fontsize=14)
    ax.set_aspect('equal', 'box')
    ax.set_xlim(-0.025, 1.025)
    ax.set_ylim(-0.025, 1.025)
    ax.legend(fontsize=10, frameon=True, framealpha=0.35, loc='lower left')

    flierprops = dict(marker='o', markersize=4, markerfacecolor='grey', markeredgecolor='none')

    ax = axs[1]
    dianne_boxes = ax.boxplot(
        [dfr['dianne_precision'].dropna(), dfr['dianne_recall'].dropna(), 1.-dfr['dianne_fpr'].dropna(), 1.-dfrn['dianne_fpr'].dropna()],
        tick_labels=['Precision', 'Recall', 'Specificity', 'Sp. normal'],
        positions=[1, 2, 3, 4],
        widths=0.6,
        patch_artist=True,
        flierprops=flierprops
    )

    clam_boxes = ax.boxplot(
        [dfr['clam_precision'].dropna(), dfr['clam_recall'].dropna(), 1.-dfr['clam_fpr'].dropna(), 1.-dfrn['clam_fpr'].dropna()],
        tick_labels=['Precision', 'Recall', 'Specificity', 'Sp. normal'],
        positions=[8, 9, 10, 11],
        widths=0.6,
        patch_artist=True,
        flierprops=flierprops
    )


    segmenter_boxes = ax.boxplot(
        [dfr['segmenter_precision'].dropna(), dfr['segmenter_recall'].dropna(), (1.-dfr['segmenter_fpr'].dropna()), (1.-dfrn['segmenter_fpr'].dropna())],
        tick_labels=['Precision', 'Recall', 'Specificity', 'Sp. normal'],
        positions=[15, 16, 17, 18],
        widths=0.6,
        patch_artist=True,
        flierprops=flierprops
    )

    methods = ['DIANNE', 'CLAM', 'Segmenter'][:]
    fc = ['cornflowerblue', 'orange', 'olive'][:]
    for ib, b in enumerate([dianne_boxes, clam_boxes, segmenter_boxes]):
        for median in b['medians']:
            median.set_color('k')
        for face in b['boxes']:
            face.set_facecolor(fc[ib])

    ax.set_ylabel('Score', fontsize=14)
    ax.tick_params(axis='x', labelsize=12, rotation=90)
    ax.set_aspect('auto')


    legend_elements = [Patch(facecolor=fc[i], edgecolor='k', label=methods[i]) for i in range(len(methods))]
    ax.legend(handles=legend_elements, loc='lower right', fontsize=10, framealpha=0.35)

    plt.tight_layout()
    plt.show()
    return

def show_alphas_plot(path, F=2):
    # ', '.join([f'{v:.2f}' for v in np.linspace(0.0, 1.0, 21, endpoint=True)])
    # ', '.join([f'{v:.2f}' for v in np.linspace(0.0, 0.15, 15, endpoint=True)])

    alphas = [0.00, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.14, 0.15,
            0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00]

    dfs = []
    for alpha in alphas:
        df = pd.read_csv(f'{path}/tumor-F{F}-{alpha:.2f}.csv', index_col=0)
        df['alpha'] = alpha
        dfs.append(df)
    dft = pd.concat(dfs)
    dft['dianne_specificity'] = 1 - dft['dianne_fpr']

    dfs = []
    for alpha in alphas:
        df = pd.read_csv(f'{path}/normal-F{F}-{alpha:.2f}.csv', index_col=0)
        df['alpha'] = alpha
        dfs.append(df)
    dfn = pd.concat(dfs)
    dfn = dfn.rename(columns={'dianne_fpr': 'dianne_fpr_normal'}).fillna(0.)
    dfn['dianne_specificity_normal'] = 1 - dfn['dianne_fpr_normal']

    df_sub = dft.groupby('alpha').agg({
        'dianne_precision': ['mean', 'std'],
        'dianne_recall': ['mean', 'std'],
        'dianne_accuracy': ['mean', 'std'],
        'dianne_specificity': ['mean', 'std'],
        'dianne_fpr': ['mean', 'std'],
        'dianne_f1_score': ['mean', 'std'],
    })

    df_sub = pd.concat([df_sub, dfn.groupby('alpha').agg({'dianne_specificity_normal': ['mean', 'std'],
                                                        'dianne_fpr_normal': ['mean', 'std'],})], axis=1)

    r = 1.2 / 2.0
    fig, (ax1, ax2) = plt.subplots(1, 2, sharey=True, figsize=(9, 4.5), gridspec_kw={'wspace': 0.05, 'hspace': 0., 'width_ratios': [r, 1]})

    ax1.set_xlim(-0.005, 0.155)
    ax2.set_xlim(0.145, 1.025)

    # hide the spines between ax and ax2
    ax1.spines['right'].set_visible(False)
    ax2.spines['left'].set_visible(False)
    ax1.yaxis.tick_left()
    ax1.tick_params(labelright='off')

    d = 0.015
    kwargs1 = dict(transform=ax1.transAxes, color='k', clip_on=False)
    ax1.plot((1-d, 1+d), (-d, +d), **kwargs1)
    ax1.plot((1-d, 1+d), (1-d, 1+d), **kwargs1)
    kwargs2 = dict(transform=ax2.transAxes, color='k', clip_on=False)
    ax2.plot((-d*r, +d*r), (1-d, 1+d), **kwargs2)
    ax2.plot((-d*r, +d*r), (-d, +d), **kwargs2)


    ax1.set_ylabel('Score', fontsize=16)

    def plot_smooth(ax, x, y, err, color='navy', label='Precision', alpha=0.85):
        x_smooth = np.linspace(x.min(), x.max(), 300)
        spline = make_interp_spline(x, y)
        y_smooth = gaussian_filter1d(y, sigma=1.5)
        ax.errorbar(x, y, yerr=err, fmt='o', color=color, label=label, capsize=3, alpha=alpha)
        ax.plot(x, y_smooth, color=color, alpha=alpha)
        return

    for ax in (ax1, ax2):
        plot_smooth(ax, df_sub.index, df_sub['dianne_precision']['mean'], df_sub['dianne_precision']['std'], color='navy', label='Precision')
        plot_smooth(ax, df_sub.index, df_sub['dianne_recall']['mean'], df_sub['dianne_recall']['std'], color='maroon', label='Recall')
        # plot_smooth(ax, df_sub.index, df_sub['dianne_fpr']['mean'], df_sub['dianne_fpr']['std'], color='turquoise', label='Accuracy')
        plot_smooth(ax, df_sub.index, df_sub['dianne_specificity']['mean'], df_sub['dianne_specificity']['std'], color='black', label='Specificity')
        plot_smooth(ax, df_sub.index, df_sub['dianne_specificity_normal']['mean'], df_sub['dianne_specificity_normal']['std'], color='darkgray', label='Sp. normal')

        ax.grid()

    ax1.tick_params(left=True, labelright=False)

    ax2.legend(loc='lower right', fontsize=14)
    ax2.axvline(x=0.80, color='gold', linestyle='-', linewidth=7.0, alpha=0.5)

    fig.text(0.5, 0.04, r'Augmentation parameter $\alpha$', ha='center', va='top', fontsize=14)

    plt.show()
    return