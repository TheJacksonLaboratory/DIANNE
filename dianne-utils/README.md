# dianne-utils

**Annotation utilities and spatial workflows for DIANNE — Segmentation-Free Localization of Histology Differential Attributes.**

[![License: JAX Non-Commercial](https://img.shields.io/badge/License-JAX%20Non--Commercial-blue.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](https://www.python.org/downloads/)

## Overview

`dianne-utils` extends `dianne-core` with higher-level tools for interactive annotation, spatial transcriptomics integration, and post-processing:

- **Guided annotation** — active-learning labelling loop (`jumpStart`, `runAnnotation`, `inspectAnnotatedPatches`).
- **Freehand annotation** — contour-based region selection from stroke input (`preparePatchesFromStrokes`, `getClassifierForFromStrokes`).
- **STQ / Xenium utilities** — inference, metric computation, and probability map generation for spatial transcriptomics data (`inferProb`, `inferProbPreview`, `showProbImg`, `get_metrics`).
- **Mask tools** — probability mask generation and QuPath-compatible contour export (`makeProbMask`, `extractContoursForQuPath`).
- **Spatial interpolation** — smooth point-set interpolation (`interpolatePoints`).
- **Download helpers** — Zenodo asset retrieval (`downloadZIPFromZenodo`, `downloadFromZenodo`).
- **ROI selection** — interactive region-of-interest selection widget (`runSelection`, `viewSelection`).
- **Color utilities** — curated categorical color palettes (`Set123`).

## Installation

```bash
pip install dianne-utils
```

`dianne-core` is installed automatically as a dependency.

### From source

```bash
git clone https://github.com/TheJacksonLaboratory/DIANNE.git
cd DIANNE/dianne-utils
pip install -e .
```

## Quick start

```python
from dianne_utils import jumpStart, runAnnotation, inferProb, makeProbMask

# Start guided annotation
jumpStart(samples, data_dir)

# Interactive annotation loop (Jupyter)
runAnnotation()

# Run inference on STQ data
x, y, prob = inferProb(ad, clf, qs)

# Generate probability mask
mask = makeProbMask(prob, x, y, shape)
```

## Module overview

| Module | Key exports |
|---|---|
| `guided.annotation` | `jumpStart`, `runAnnotation`, `inspectAnnotatedPatches`, `loadPatch` |
| `utils` | `loadDataAndPreparePatchesStatic`, `findMyJupyterServer`, `setupClassifierPaths`, `saveClassifier`, `loadClassifier`, `getTilesInContour`, `preparePatchesFromStrokes`, `visualizePatches`, `setNotebookWidth` |
| `stqutils` | `inferProb`, `inferProbPreview`, `showProbImg`, `get_metrics` |
| `mask` | `makeProbMask`, `extractContoursForQuPath`, `viewContoursOnImage` |
| `interpolation` | `interpolatePoints` |
| `download` | `downloadZIPFromZenodo`, `downloadFromZenodo` |
| `selection` | `runSelection`, `viewSelection` |
| `colors` | `Set123` |

## Dependencies

- `dianne-core>=0.1.0`
- `numpy`, `pandas`, `scipy`, `scikit-learn`, `matplotlib`
- `numba`, `tifffile`, `scanpy`
- `joblib`, `tqdm`, `psutil`
- `opencv-python`
- `ipywidgets`, `ipython`

## Citation

If you use DIANNE in your research, please cite:

> **DIANNE: Segmentation-Free Localization of Histology Differential Attributes**
> Sergii Domanskyi, Jill C. Rubinstein, Todd B. Sheridan, Adam Thiesen, Javad Noorbakhsh, Juliana Alcoforado Diniz, Ramalakshmi Ramasamy, Dylan S. Baker, Riley Sheldon, Qian Wu, George Kuchel, Paul Robson, Jeffrey H. Chuang
> *bioRxiv* 2026.04.28.721103; https://doi.org/10.64898/2026.04.28.721103

## License

This software is released under the **JAX Non-Commercial Software License**.
See [LICENSE](LICENSE) for full terms.
Commercial use requires a separate agreement with The Jackson Laboratory.

See ACKNOWLEDGEMENTS for third-party licenses.
