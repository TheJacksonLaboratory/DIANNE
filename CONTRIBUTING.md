
# Contributing to DIANNE

Thank you for your interest in contributing to DIANNE! This guide covers everything you need to get a working development environment and submit changes.

---

## Repository layout

```
DIANNE/
├── dianne-core/     # Core classifier, data loading, inference (no GUI deps)
├── dianne-utils/    # Annotation workflows, spatial tools, STQ/Xenium utilities
├── dianne-viewer/   # Jupyter-based WSI viewer and overlays
├── pyproject.toml   # Root workspace file (uv) — not published to PyPI
├── TODO.md
└── CONTRIBUTING.md
```

The three packages have an explicit dependency order:

```
dianne-core  ←  dianne-utils  ←  dianne-viewer
```

---

## Setting up a development environment

### Prerequisites

- Python 3.9 or later
- The project is typically developed inside a Singularity container with a pre-installed conda environment and Jupyter. The steps below work both inside and outside that container.

### Option A — plain pip (works everywhere)

```bash
git clone https://github.com/TheJacksonLaboratory/DIANNE.git
cd DIANNE
pip install -e dianne-core -e dianne-utils -e dianne-viewer
```

All three packages are installed as editable sources — any change to `.py` files is immediately active without reinstalling.

### Option B — uv workspace (faster, recommended for new setups)

```bash
pip install uv
cd DIANNE
uv sync   # installs all workspace members as editable, resolves inter-deps from local source
```

`uv` reads the `[tool.uv.workspace]` table in the root `pyproject.toml` and ensures that `dianne-utils` and `dianne-viewer` always resolve `dianne-core` from your local checkout rather than from PyPI.

### Verify the install

```python
import dianne_core, dianne_utils, dianne_viewer
print(dianne_core.__file__)   # must point into the repo, not site-packages
```

---

## Development inside a Jupyter notebook (Singularity / existing conda workflow)

If you develop inside a Singularity container with Jupyter and prefer not to install the packages at all, use `sys.path` and autoreload instead:

```python
%load_ext autoreload
%autoreload 2

import sys
DIANNE = "/path/to/DIANNE"   # absolute path to the repo root inside the container
sys.path.insert(0, f"{DIANNE}/dianne-core")
sys.path.insert(0, f"{DIANNE}/dianne-utils")
sys.path.insert(0, f"{DIANNE}/dianne-viewer")
```

**Keep `dianne-core` first** in the path so that `dianne_utils` and `dianne_viewer` resolve it from source rather than any installed wheel.

> **Note:** `%autoreload 2` does not reload Numba-JIT-compiled functions (`@jit` / `@njit`). If you modify `dianne_core/combineCDF.py` or any other Numba-decorated code, restart the kernel.

---

## Making changes

### Branch naming

```
feat/<short-description>     # new features
fix/<short-description>      # bug fixes
docs/<short-description>     # documentation only
refactor/<short-description> # internal restructuring, no behaviour change
```

### Commit style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(dianne-utils): add contour smoothing to makeProbMask
fix(dianne-core): correct KDTree query radius for non-square tiles
docs: update CONTRIBUTING with uv workspace instructions
```

### Which package does my change belong in?

| Change type | Package |
|---|---|
| Classifier training, data loading, CDF maths, core inference | `dianne-core` |
| Annotation GUIs, STQ/Xenium tools, masks, ROI selection, downloads | `dianne-utils` |
| WSI viewer, tile server, JS frontend, Zarr/TIFF readers | `dianne-viewer` |

If a change spans packages, split it into one commit (or PR) per package and list them in dependency order.

---

## Versioning

Each package is versioned independently following [Semantic Versioning](https://semver.org/):

- Bump `__version__` in the package's `__init__.py`.
- Add a corresponding entry to the package's `CHANGELOG.md` under a new `[X.Y.Z] — YYYY-MM-DD` heading.
- Update the minimum version constraint in downstream packages' `pyproject.toml` if the API changed.

---

## Building and publishing

Before building a wheel, copy the root license into the sub-package directory (wheels must be self-contained):

```bash
cd dianne-core   # repeat for dianne-utils, dianne-viewer
cp ../LICENSE .
python -m build
```

Upload to PyPI with `twine` (or `uv publish` when the license is finalised):

```bash
twine upload dist/*
```

> The JAX Non-Commercial Software License is not yet finalised. Publishing to PyPI is on hold until the `LICENSE` file is replaced and all three `pyproject.toml` files are updated. See [TODO.md](TODO.md).

---

## Reporting issues

Please open an issue on GitHub with:

1. A minimal reproducible example.
2. The output of `python -c "import dianne_core; print(dianne_core.__version__)"` (and the same for `dianne_utils` / `dianne_viewer` if relevant).
3. Your Python version and OS / container image.

---

## Questions

Contact Sergii Domanskyi (sergii.domanskyi@jax.org) or open a GitHub Discussion.
