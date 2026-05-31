# Changelog — dianne-core

All notable changes to `dianne-core` will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-31

### Added
- Initial extraction of core logic from the monolithic DIANNE package into a standalone `dianne-core` package.
- `core.py` — data loading (`loadAd`, `loadImFeatures`), patch preparation (`preparePatchesWSI`, `getPatchRepresentation`), classifier training (`trainClassifier`), and fast spatial inference (`inferProbFast`).
- `combineCDF.py` — Numba-JIT-compiled combined CDF computation (`getDiscreteCombinedCDF`, `getDiscreteCombinedCDFofAllFeatures` aliased as `PCMA`).
- `pyproject.toml` and packaging metadata for PyPI publication.
