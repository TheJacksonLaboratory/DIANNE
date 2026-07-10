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
