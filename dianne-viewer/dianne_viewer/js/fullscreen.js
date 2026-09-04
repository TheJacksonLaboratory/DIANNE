/**
 * fullscreen.js
 *
 * Fullscreen toggle button: expands iv-shell to fill the browser viewport,
 * with Esc-key exit support. The button is appended to the passed
 * overlayControls element.
 *
 * Exposes:
 *   createFullscreen({ overlayControls, resizePredLayer })
 *   → { enterFs, exitFs }
 */

// The custom fullscreen toggle below is a CSS/DOM trick: it does not call the
// real Fullscreen API, it just makes #iv-shell a fixed, full-viewport overlay
// that visually covers whatever is behind it — including Jupyter Notebook 7's
// own header bar. Exiting fullscreen shrinks the shell back down and
// "reveals" that header again, even though it was never actually toggled.
//
// Turn it off for real instead, the same way the View → Show Header menu
// item does: Notebook 7 exposes its running app instance as
// window.jupyterapp, and 'application:toggle-top' is the exact command that
// menu item runs (it flips notebookShell.top's Lumino visibility, which
// reflows the rest of the layout up — unlike hiding it with CSS, which
// leaves Lumino's own layout math stale). Poll for it since it may not exist
// yet when this script runs, execute it once (only if the header is
// currently shown, so re-running this is idempotent), and never call it
// again — the header should just stay off.
//
// The extension that owns this command only applies the user's saved
// visibility preference after app.restored resolves (it reads settings and
// calls top.setHidden() then) — checking isToggled() before that resolves
// races the real state and can read "already hidden" when it's actually
// still visible. Wait for app.restored too, not just for the command to be
// registered.
(function _hideNotebookHeader() {
  let attempts = 0;
  const poll = setInterval(() => {
    const app = window.jupyterapp;
    if (app && app.commands && app.restored) {
      clearInterval(poll);
      app.restored.then(() => {
        const cmdId = 'application:toggle-top';
        if (app.commands.hasCommand(cmdId) && app.commands.isToggled(cmdId)) {
          app.commands.execute(cmdId);
        }
      });
      return;
    }
    if (++attempts > 100) clearInterval(poll);  // give up after 10s (not JupyterLab/Notebook 7)
  }, 100);
})();

function createFullscreen({ overlayControls, resizePredLayer }) {
  const shell     = document.getElementById('iv-shell');
  const samplesEl = document.getElementById('iv-samples');
  const rootEl    = document.getElementById('iv-root');
  const ivMain    = document.getElementById('iv-main');

  const fsBtn = document.createElement('button');
  fsBtn.type = 'button';
  fsBtn.title = 'Toggle fullscreen';
  fsBtn.style.cssText = [
    'font:12px monospace','padding:6px 8px','border-radius:6px','border:1px solid #333',
    'background:#262626','color:#e6e6e6','cursor:pointer','display:flex','gap:6px','align-items:center'
  ].join(';');
  fsBtn.dataset.demoId = 'fs-btn';
  fsBtn.innerHTML = '<span style="font-size:12px">⛶</span>';

  let prev = null;
  function enterFs() {
    prev = {
      shellStyle:   shell.getAttribute('style')     || '',
      samplesStyle: samplesEl.getAttribute('style') || '',
      rootStyle:    rootEl.getAttribute('style')    || '',
      ivMainStyle:  ivMain.getAttribute('style')    || '',
      bodyOverflow: document.body.style.overflow    || '',
    };
    shell.style.position = 'fixed';
    shell.style.left   = '0';
    shell.style.top    = '0';
    shell.style.width  = '100vw';
    shell.style.height = '100vh';
    shell.style.zIndex = '2147483647';
    document.body.style.overflow = 'hidden';
    // set heights and padding so status bar and bottom buttons remain visible
    samplesEl.style.height         = 'calc(100vh - 60px)';
    rootEl.style.height            = 'calc(100vh - 56px)';
    samplesEl.style.paddingBottom  = '56px';
    ivMain.style.paddingBottom     = '56px';
    fsBtn.innerHTML = '<span style="font-size:12px">⤫</span>';
    resizePredLayer();
    document.addEventListener('keydown', onFsKeyDown);
    // This toggle is a CSS/DOM trick, not the native Fullscreen API, so the
    // browser's own 'fullscreenchange' never fires. Notify listeners that
    // care (e.g. hover.js hiding its ghost tooltip) via a private event name
    // rather than the real 'fullscreenchange' — Notebook 7's own Zen-mode
    // plugin also listens on that one, and since document.fullscreenElement
    // is never set by this trick, it would read "not fullscreen" on every
    // dispatch and force the notebook header back on.
    document.dispatchEvent(new Event('iv-fullscreenchange'));
  }

  function exitFs() {
    if (!prev) return;
    shell.setAttribute('style',     prev.shellStyle);
    samplesEl.setAttribute('style', prev.samplesStyle);
    rootEl.setAttribute('style',    prev.rootStyle);
    ivMain.setAttribute('style',    prev.ivMainStyle);
    document.body.style.overflow = prev.bodyOverflow;
    prev = null;
    fsBtn.innerHTML = '<span style="font-size:12px">⛶</span>';
    resizePredLayer();
    document.removeEventListener('keydown', onFsKeyDown);
    document.dispatchEvent(new Event('iv-fullscreenchange'));
  }

  let active = false;
  fsBtn.addEventListener('click', () => {
    active = !active;
    if (active) enterFs(); else exitFs();
  });

  function onFsKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      // if a modal is open, cancel it first
      if (window.__iv_modal_visible && typeof window.__iv_modal_cancel === 'function') {
        window.__iv_modal_cancel();
        return;
      }
      if (active) {
        active = false;
        exitFs();
      }
    }
  }

  overlayControls.appendChild(fsBtn);
  return { enterFs, exitFs };
}
