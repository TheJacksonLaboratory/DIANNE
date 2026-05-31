# TODO

## Development

- [ ] **No `tests/` directories exist in any of the three packages.**
  Publishing independently versioned packages without tests makes it hard to catch regressions when versions drift.
  Suggested structure:
  ```
  dianne-core/tests/test_core.py
  dianne-utils/tests/test_utils.py
  dianne-viewer/tests/test_viewer.py
  ```

- [x] **`CONTRIBUTING.md` written** with editable install instructions (pip and uv), Singularity/Jupyter `sys.path` workflow, branch naming, commit style, versioning, and build/publish steps.


## License

- [ ] **`LICENSE` file must be copied into each sub-package directory before building.**
  All three `pyproject.toml` files declare `license = { file = "LICENSE" }`.
  Add `cp ../LICENSE .` to your build/release script or CI workflow for each package.

- [ ] **Replace the placeholder MIT `LICENSE` file with the JAX Non-Commercial Software License** once it is finalised.
  Update all three `pyproject.toml` files: remove the OSI classifier and add `License :: Other/Proprietary License` (or omit the classifier entirely).
  See notes in each package's `pyproject.toml`.
