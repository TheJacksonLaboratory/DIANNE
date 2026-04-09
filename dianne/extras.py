
from scipy.ndimage import gaussian_filter1d
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from scipy.interpolate import make_interp_spline
from matplotlib.patches import Patch
from sklearn.metrics import roc_auc_score, average_precision_score
from .utils import get_tile_mask_means3
from .stqutils import inferProbFast, interpolate_points as interpolatePoints

# import tifffile; tifffile.TiffFile(f"{annopath}/JDC_WP_012_ae-standalone.ome.tif").pages[0].tags[270].value.split('PhysicalSizeX="')[1].split('"')[0]
# import tifffile; tifffile.TiffFile(f"{annopath}/MC_PLACM_0015.ome.tif").pages[0].tags[270].value.split('PhysicalSizeX="')[1].split('"')[0]

def measureSample(annopath, infSample):
    x, y, p = inferProbFast(ads[infSample], clf, qs, tsize=ts/mpp, R=2, erode=False)
    
    # infSample = samples_mapping[infSample]
    # mfile = f'{annopath}/{infSample.replace("-", "_")}-postxenium-Papillary-tissue.tiff'
    mfile = f'{annopath}/{infSample.replace("-", "_")}-standalone-Islets.tiff'
    # mfile = f'{annopath}/{infSample.replace("-", "_")}-standalone-Fibrous-tissue.tiff'
    scale = 0.22644414755100656 / 0.25 # pancreas
    
    # mfile = f'{annopath}/{infSample}-Globally-sclerotic-glomeruli.tiff'
    # mfile = f'{annopath}/{infSample}-Glomeruli.tiff'
    # mfile = f'{annopath}/{infSample}-Fibrous-tissue.tiff'
    # mfile = f'{annopath}/{infSample}-Other.tiff'
    
    # mfile = f'{annopath}/{infSample.replace("-", "_")}-Blood-aggregates.tiff'
    # mfile = f'{annopath}/{infSample.replace("-", "_")}-Amnion.tiff'
    # mfile = f'{annopath}/{infSample.replace("-", "_")}-Chorion.tiff'
    
    # mfile = f'{annopath}/{infSample.replace("-", "_")}-standalone-Islets.tiff'
    # mfile = f'{annopath}/{infSample.replace("-", "_")}-standalone-Fibrous-tissue.tiff'
    # mfile = f'{annopath}/{infSample.replace("-", "_")}-standalone-Papillary-tissue.tiff'
    print(mfile)

    # scale = 0.22098959139024552 / 0.25 # placm
    # scale = 1. # pen, kidney, postxenium pancreas

    M = 8
    pth = 0.5
    xi, yi, pi = interpolatePoints(x, y, p, multiplier=M)
    print('Computing objects')
    m_labeled, means, objects = get_tile_mask_means3(mfile, int(ts/M), mpp, np.vstack([xi, yi]).T.round(0).astype(int), scale=scale)
    result = {'sample': infSample, 'manual_annotation': np.mean(means)}
    result.update(dianne.get_metrics(pd.Series(pi), pd.Series(means), pth, 0.0, prefix='dianne_'))
    try:
        auroc = roc_auc_score(pd.Series(means)>0., pd.Series(pi))
        auprc = average_precision_score(pd.Series(means)>0., pd.Series(pi))
        result.update({'auroc': auroc, 'auprc': auprc})
    except Exception as exception:
        print(exception)
    return result

def show_chosen_alpha_plot(path, F=2, alpha=0.80, dpi=75):
    dfrn = pd.read_csv(f'{path}/normal-F{F}-{alpha:.2f}-None.csv')
    dfr = pd.read_csv(f'{path}/tumor-F{F}-{alpha:.2f}-None.csv')

    fix, ax = plt.subplots(1, 1, figsize=(4,4), dpi=dpi)
    # fix, axs = plt.subplots(1, 2, figsize=(7,4), gridspec_kw = {'width_ratios':[2, 3]}, dpi=dpi)
    # ax = axs[0]
    # s = 10
    # ax.scatter(dfr['dianne_recall'], dfr['dianne_precision'], alpha=0.75, label='DIANNE', s=s, clip_on=False)
    # ax.scatter(dfr['clam_recall'], dfr['clam_precision'], alpha=0.75, label='CLAM', s=s, clip_on=False)
    # ax.scatter(dfr['segmenter_recall'], dfr['segmenter_precision'], alpha=0.75, label='Segmenter', s=s, clip_on=False, color='olive')
    # ax.set_xlabel('Recall', fontsize=14)
    # ax.set_ylabel('Precision', fontsize=14)
    # ax.set_aspect('equal', 'box')
    # ax.set_xlim(-0.025, 1.025)
    # ax.set_ylim(-0.025, 1.025)
    # ax.legend(fontsize=10, frameon=True, framealpha=0.35, loc='lower left')

    flierprops = dict(marker='o', markersize=4, markerfacecolor='grey', markeredgecolor='none')

    data = [dfr['dianne_precision'].dropna(), dfr['dianne_recall'].dropna(), 1.-dfr['dianne_fpr'].dropna(), 1.-dfrn['dianne_fpr'].dropna()]
    print(f'DIANNE medians.\tPrecision {np.median(data[0]):.3f}, Recall {np.median(data[1]):.3f}, Specificity {np.median(data[2]):.3f}, Sp. normal {np.median(data[3]):.3f}')
    dianne_boxes = ax.boxplot(
        data,
        tick_labels=['Precision', 'Recall', 'Specificity', 'Sp. normal'],
        positions=[1, 2, 3, 4],
        widths=0.6,
        patch_artist=True,
        flierprops=flierprops
    )

    data = [dfr['clam_precision'].dropna(), dfr['clam_recall'].dropna(), 1.-dfr['clam_fpr'].dropna(), 1.-dfrn['clam_fpr'].dropna()]
    print(f'CLAM medians.\tPrecision {np.median(data[0]):.3f}, Recall {np.median(data[1]):.3f}, Specificity {np.median(data[2]):.3f}, Sp. normal {np.median(data[3]):.3f}')
    clam_boxes = ax.boxplot(
        data,
        tick_labels=['Precision', 'Recall', 'Specificity', 'Sp. normal'],
        positions=[8, 9, 10, 11],
        widths=0.6,
        patch_artist=True,
        flierprops=flierprops
    )

    data = [dfr['segmenter_precision'].dropna(), dfr['segmenter_recall'].dropna(), (1.-dfr['segmenter_fpr'].dropna()), (1.-dfrn['segmenter_fpr'].dropna())]
    print(f'Segm. medians.\tPrecision {np.median(data[0]):.3f}, Recall {np.median(data[1]):.3f}, Specificity {np.median(data[2]):.3f}, Sp. normal {np.median(data[3]):.3f}')
    segmenter_boxes = ax.boxplot(
        data,
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

def show_alphas_plot(path, F=2, figsize=(9, 4.5)):
    # ', '.join([f'{v:.2f}' for v in np.linspace(0.0, 1.0, 21, endpoint=True)])
    # ', '.join([f'{v:.2f}' for v in np.linspace(0.0, 0.15, 15, endpoint=True)])

    alphas = [0.00, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.14, 0.15,
            0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00]

    dfs = []
    for alpha in alphas:
        df = pd.read_csv(f'{path}/tumor-F{F}-{alpha:.2f}-None.csv', index_col=0)
        df['alpha'] = alpha
        dfs.append(df)
    dft = pd.concat(dfs)
    dft['dianne_specificity'] = 1 - dft['dianne_fpr']

    dfs = []
    for alpha in alphas:
        df = pd.read_csv(f'{path}/normal-F{F}-{alpha:.2f}-None.csv', index_col=0)
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
    fig, (ax1, ax2) = plt.subplots(1, 2, sharey=True, figsize=figsize, gridspec_kw={'wspace': 0.05, 'hspace': 0., 'width_ratios': [r, 1]})

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

def show_nmaxs_plot(path, F=2, alpha=0.8,
                    nmaxs=[5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 
                        125, 150, 175, 200, 250, 300, 400, 500, 600, 700, 750], figsize=(9, 4.5)):

    dfs = []
    for nmax in nmaxs:
        df = pd.read_csv(f'{path}/tumor-F{F}-{alpha:.2f}-{nmax}.csv', index_col=0)
        df['N'] = nmax
        dfs.append(df)
    dft = pd.concat(dfs)
    dft['dianne_specificity'] = 1 - dft['dianne_fpr']

    dfs = []
    for nmax in nmaxs:
        df = pd.read_csv(f'{path}/normal-F{F}-{alpha:.2f}-{nmax}.csv', index_col=0)
        df['N'] = nmax
        dfs.append(df)
    dfn = pd.concat(dfs)
    dfn = dfn.rename(columns={'dianne_fpr': 'dianne_fpr_normal'}).fillna(0.)
    dfn['dianne_specificity_normal'] = 1 - dfn['dianne_fpr_normal']

    df_sub = dft.groupby('N').agg({
        'dianne_precision': ['mean', 'std'],
        'dianne_recall': ['mean', 'std'],
        'dianne_accuracy': ['mean', 'std'],
        'dianne_specificity': ['mean', 'std'],
        'dianne_fpr': ['mean', 'std'],
        'dianne_f1_score': ['mean', 'std'],
    })

    df_sub = pd.concat([df_sub, dfn.groupby('N').agg({'dianne_specificity_normal': ['mean', 'std'],
                                                        'dianne_fpr_normal': ['mean', 'std'],})], axis=1)

    r = 1.2 / 2.0
    fig, (ax1, ax2) = plt.subplots(1, 2, sharey=True, figsize=figsize, gridspec_kw={'wspace': 0.05, 'hspace': 0., 'width_ratios': [r, 1]})

    ax1.set_xlim(-1, 105)
    ax2.set_xlim(110, 800 + 10)

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
        plot_smooth(ax, df_sub.index, df_sub['dianne_specificity']['mean'], df_sub['dianne_specificity']['std'], color='black', label='Specificity')
        plot_smooth(ax, df_sub.index, df_sub['dianne_specificity_normal']['mean'], df_sub['dianne_specificity_normal']['std'], color='darkgray', label='Sp. normal')

        ax.grid()

    ax1.tick_params(left=True, labelright=False)

    ax2.legend(loc='lower right', fontsize=14)
    # ax1.axvline(x=60, color='gold', linestyle='-', linewidth=7.0, alpha=0.5)
    ax1.axvspan(58, 1000, alpha=0.5, color='lightgreen')
    ax2.axvspan(58, 1000, alpha=0.5, color='lightgreen')

    fig.text(0.5, 0.04, r'Maximum number of positive and negative slides, $N_{max}$', ha='center', va='top', fontsize=14)

    plt.show()
    return
