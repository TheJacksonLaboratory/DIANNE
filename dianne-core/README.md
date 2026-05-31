# dianne-core

**Core engine for DIANNE — Segmentation-Free Localization of Histology Differential Attributes.**

[![License: JAX Non-Commercial](https://img.shields.io/badge/License-JAX%20Non--Commercial-blue.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](https://www.python.org/downloads/)

## Overview

`dianne-core` provides the fundamental building blocks of the DIANNE framework:

- **Classifier training** — logistic-regression-based spatial classifiers trained from weakly supervised annotations.
- **Data loading** — reading AnnData/H5AD patch feature stores and whole-slide image (WSI) tile grids.
- **Patch preparation** — construction of patch representation matrices for training and inference.
- **Fast spatial inference** — KD-tree-based neighbourhood inference for whole-slide prediction maps.
- **Combined CDF computation** — Numba-accelerated probability mixing across two feature distributions (`combineCDF`).

This package is intentionally dependency-light and has no GUI components. It is consumed by `dianne-utils` and `dianne-viewer`.

## Installation

```bash
pip install dianne-core
```

### From source

```bash
git clone https://github.com/TheJacksonLaboratory/DIANNE.git
cd DIANNE/dianne-core
pip install -e .
```

## Quick start

```python
from dianne_core import loadAd, preparePatchesWSI, trainClassifier, inferProbFast, PCMA

# Load patch features
ad = loadAd("/path/to/img.data.h5ad")

# Prepare training patches
patches, labels = preparePatchesWSI(ad, annotations)

# Train a spatial classifier
clf, qs = trainClassifier(patches, labels)

# Run inference
x, y, prob = inferProbFast(ad, clf, qs)
```

## Public API

| Symbol | Description |
|---|---|
| `PCMA` | `getDiscreteCombinedCDFofAllFeatures` — Numba-parallel combined CDF |
| `loadAd` | Load an AnnData patch-feature store |
| `preparePatchesWSI` | Extract patch feature matrix for a WSI |
| `getPatchRepresentation` | Build the patch representation matrix |
| `inferProbFast` | KD-tree spatial inference |
| `trainClassifier` | Train a logistic-regression spatial classifier |
| `loadDataAndPreparePatches` | Convenience loader + patch preparation |

## Dependencies

- `numpy`, `pandas`, `scipy`, `scikit-learn`
- `numba` (JIT-compiled CDF mixing)
- `tifffile`, `scanpy`
- `joblib`, `tqdm`

## Citation

If you use DIANNE in your research, please cite:

> **DIANNE: Segmentation-Free Localization of Histology Differential Attributes**
> Sergii Domanskyi, Jill C. Rubinstein, Todd B. Sheridan, Adam Thiesen, Javad Noorbakhsh, Juliana Alcoforado Diniz, Ramalakshmi Ramasamy, Dylan S. Baker, Riley Sheldon, Qian Wu, George Kuchel, Paul Robson, Jeffrey H. Chuang
> *bioRxiv* 2026.04.28.721103; https://doi.org/10.64898/2026.04.28.721103

## License

This software is released under the **JAX Non-Commercial Software License**.
See [LICENSE](LICENSE) for full terms.
Commercial use requires a separate agreement with The Jackson Laboratory.
