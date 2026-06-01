# dianne-viewer

**Jupyter-based whole-slide image viewer for DIANNE — Segmentation-Free Localization of Histology Differential Attributes.**

[![License: JAX Non-Commercial](https://img.shields.io/badge/License-JAX%20Non--Commercial-blue.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](https://www.python.org/downloads/)

## Overview

`dianne-viewer` provides an interactive in-notebook viewer for whole-slide images (WSIs) and spatial-omics overlays. It wraps a lightweight in-process HTTP tile server with an `ipywidgets`-based frontend, supporting:

- **Pyramid TIFF and OME-TIFF** rendering (mono- and multi-channel).
- **Zarr-backed image pyramids** for remote and local access.
- **Xenium cell and transcript overlays** — interactive scatter overlays from Xenium output files.
- **Parquet-based cell overlays** for large-scale cell annotation display.
- **Classifier probability overlays** — live inference result rendering on top of WSI tiles.
- **STQ and MIQ data views** — helper functions `viewSTQ` and `viewMIQ` for standard DIANNE outputs.

## Installation

```bash
pip install dianne-viewer
```

`dianne-core` and `dianne-utils` are installed automatically as dependencies.

### From source

```bash
git clone https://github.com/TheJacksonLaboratory/DIANNE.git
cd DIANNE/dianne-viewer
pip install -e .
```

## Quick start

```python
from dianne_viewer import create_viewer, set_overlay_points, clear_overlay_points
from dianne_viewer import viewSTQ, viewMIQ

# Open a WSI in the notebook
viewer = create_viewer("/path/to/slide.ome.tif")

# Add inference probability overlay
set_overlay_points(viewer, x, y, prob)

# View a DIANNE STQ output directory
viewSTQ("/path/to/stq_output")
```

## Module overview

| Module | Description |
|---|---|
| `viewer` | Top-level viewer factory and overlay controls |
| `server` | Threaded HTTP tile server (`ViewerServer`) |
| `tiff` | Pyramid TIFF reader (`PyramidImage`) |
| `monochannel` | Single-channel image renderer |
| `multichannel` | Multi-channel OME-TIFF renderer |
| `zarrtools` | Zarr pyramid utilities |
| `xencells` | Xenium cell overlay loaders (`XeniumCells`, `XeniumCellsFast`) |
| `xencellsbuilder` | Xenium cell data builder |
| `xetranscripts` | Xenium transcript overlay loader |
| `parquetcellsbuilder` | Parquet-backed cell overlay builder |
| `utils` | `viewSTQ`, `viewMIQ` convenience functions |

## Dependencies

- `dianne-core>=0.1.0`, `dianne-utils>=0.1.0`
- `numpy`, `pandas`, `scipy`
- `tifffile`, `zarr`, `fsspec`
- `Pillow`
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
