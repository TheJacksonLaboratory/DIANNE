# Changelog — dianne-utils

All notable changes to `dianne-utils` will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
