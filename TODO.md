# DIANNE — Refactoring TODO

Items identified after splitting the monolith into `dianne-core`, `dianne-utils`, and `dianne-viewer`.

---

## Critical — will cause import failures

- [ ] **`dianne_utils` relative imports into `core` are broken.**
  `utils.py`, `stqutils.py`, and `extras.py` all contain `from .core import …`.
  There is no `core.py` inside `dianne_utils`; these must become `from dianne_core.core import …` (or `from dianne_core import …`).

- [ ] **`dianne_viewer/viewer.py` uses the old package name in imports.**
  All six internal imports use `from viewer.xxx import …` (the pre-rename name).
  Replace with relative imports: `from .tiff import PyramidImage`, `from .multichannel import …`, etc.

- [ ] **`dianne_utils/dianne_utils/guided/` is missing `__init__.py`.**
  The `guided/` sub-package contains `annotation.py` and `transcriptomics.py` but has no `__init__.py`, so `from .guided.annotation import …` will fail with `ModuleNotFoundError`.
  Add an empty `dianne_utils/guided/__init__.py`.

---

## Packaging

- [ ] **`LICENSE` file must be copied into each sub-package directory before building.**
  All three `pyproject.toml` files declare `license = { file = "LICENSE" }`.
  Add `cp ../LICENSE .` to your build/release script or CI workflow for each package.

- [ ] **`dianne_viewer/__init__.py` is missing `__version__`.**
  `dianne_core` and `dianne_utils` both define `__version__ = "0.1.0"` in their `__init__.py`; `dianne_viewer` does not.

- [ ] **No `py.typed` marker files.**
  Add an empty `py.typed` to each of `dianne_core/`, `dianne_utils/`, `dianne_viewer/` so type checkers (mypy, pyright) treat them as typed packages.
  Declare in each `pyproject.toml`:
  ```toml
  [tool.setuptools.package-data]
  dianne_core = ["py.typed"]
  ```

- [ ] **`dianne-utils` `pyproject.toml` does not include the `guided` sub-package.**
  Verify that `[tool.setuptools.packages.find]` picks up `dianne_utils.guided`.
  If using `find`, it should work automatically, but confirm with `python -c "import dianne_utils.guided"` after an editable install.

---

## Tests

- [ ] **No `tests/` directories exist in any of the three packages.**
  Publishing independently versioned packages without tests makes it hard to catch regressions when versions drift.
  Suggested structure:
  ```
  dianne-core/tests/test_core.py
  dianne-utils/tests/test_utils.py
  dianne-viewer/tests/test_viewer.py
  ```

---

## Developer experience

- [ ] **No `CONTRIBUTING.md` or development setup guide.**
  Contributors need to know to install all three packages in editable mode together.
  See the root `pyproject.toml` workspace setup (already added) and document it.

- [ ] **Consider adding a GitHub Actions CI workflow** (`.github/workflows/ci.yml`)
  to run tests and lint checks on each push, per package.

---

## License

- [ ] **Replace the placeholder MIT `LICENSE` file with the JAX Non-Commercial Software License** once it is finalised.
  Update all three `pyproject.toml` files: remove the OSI classifier and add `License :: Other/Proprietary License` (or omit the classifier entirely).
  See notes in each package's `pyproject.toml`.
