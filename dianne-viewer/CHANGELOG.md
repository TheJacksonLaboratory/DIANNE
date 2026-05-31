# Changelog — dianne-viewer

All notable changes to `dianne-viewer` will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-31

### Added
- Initial extraction of the interactive viewer from the monolithic DIANNE package into a standalone `dianne-viewer` package.
- `viewer.py` — top-level `create_viewer`, `set_overlay_points`, `clear_overlay_points` factory and overlay API.
- `server.py` — lightweight threaded HTTP tile server (`ViewerServer`, `_ViewerHTTPServer`).
- `tiff.py` — pyramid TIFF reader (`PyramidImage`).
- `monochannel.py` — single-channel WSI tile renderer.
- `multichannel.py` — multi-channel OME-TIFF renderer.
- `zarrtools.py` — Zarr pyramid access utilities.
- `xencells.py` — Xenium cell overlay loaders (`XeniumCells`, `XeniumCellsFast`).
- `xencellsbuilder.py` — Xenium cell data builder.
- `xetranscripts.py` — Xenium transcript overlay loader.
- `parquetcellsbuilder.py` — Parquet-backed cell overlay builder.
- `utils.py` — `viewSTQ` and `viewMIQ` convenience wrappers.
- `pyproject.toml` and packaging metadata for PyPI publication.
