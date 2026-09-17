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


## Misc

- [ ] **Wildcard CORS on the viewer's HTTP server (`dianne-viewer/dianne_viewer/server.py`, `Handler._respond`).**
  Every response sets `Access-Control-Allow-Origin: *`, including state-changing POST routes (`/annotations/save`, `/save_classifier`, `/choose_sample`, `/run_inference`, `/settings/save`, …), with no Origin check or CSRF token. Combined with the server binding `0.0.0.0`, any page reachable from a user's browser that can also reach the viewer's port could trigger these actions cross-origin.
  Fix: restrict `Access-Control-Allow-Origin` to the JupyterHub proxy origin, or drop the header entirely if the frontend is same-origin through the hub proxy.

- [ ] **Zip Slip in `dianne-utils/dianne_utils/download.py` (`downloadZIPFromZenodo`, `downloadFromZenodo`).**
  `zipfile.ZipFile(...).extractall(targetDir)` doesn't validate entry names, so a malicious/corrupted archive with `../` path entries could write outside `targetDir`.
  Low priority — these only load Zenodo URLs/files the user supplies themselves. Fix: validate each `member.filename` resolves inside `targetDir` before extracting (or extract member-by-member), if this ever pulls from a less-trusted source.

## License

- [ ] **`LICENSE` file must be copied into each sub-package directory before building.**
  All three `pyproject.toml` files declare `license = { file = "LICENSE" }`.
  Add `cp ../LICENSE .` to your build/release script or CI workflow for each package.

- [ ] **Replace the placeholder MIT `LICENSE` file with the JAX Non-Commercial Software License** once it is finalised.
  Update all three `pyproject.toml` files: remove the OSI classifier and add `License :: Other/Proprietary License` (or omit the classifier entirely).
  See notes in each package's `pyproject.toml`.
