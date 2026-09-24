# Changelog — dianne-utils

All notable changes to `dianne-utils` will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Build backend changed to `setuptools.build_meta` (was the non-existent `setuptools.backends.legacy:build`).
- Declared previously-undeclared runtime dependencies: `scikit-image`, `zarr`, `fsspec`, `packaging` (a clean install failed on `import dianne_utils` with `No module named 'fsspec'`).
- Switched `opencv-python` to `opencv-python-headless` (same `cv2` API; avoids clashing with headless installs and needs no GUI system libraries).
- Added optional extra `features` (`torch`, `torchvision`, `timm`, `openslide-python`, `Pillow`) for `ctranspath` / `subtilegpu`.

## [0.1.0] — 2026-05-31

### Added
- Initial extraction of annotation and spatial utilities from the monolithic DIANNE package into a standalone `dianne-utils` package.
- `utils.py` — patch preparation, classifier I/O, notebook helpers, tile/contour utilities.
- `stqutils.py` — STQ/Xenium inference, probability maps, and performance metrics.
- `mask.py` — probability mask generation and QuPath contour export.
- `interpolation.py` — smooth spatial point interpolation.
- `download.py` — Zenodo asset download helpers.
- `selection.py` — interactive ROI selection widget.
- `colors.py` — categorical colour palettes (`Set123`).
- `extras.py` — supplementary visualisation and measurement utilities.
- `pyproject.toml` and packaging metadata for PyPI publication.
