/**
 * demo.js
 *
 * Guided walkthrough / tour for the DIANNE viewer.
 *
 * Exposes:
 *   createDemo()  → { start, stop }
 *
 * Each UI element to tour is described in DEMO_STEPS below.
 * Add, remove, or reorder entries freely — the rest of the code adapts.
 * Elements whose selector is not found in the DOM are silently skipped.
 */

// ─────────────────────────────────────────────────────────────────────────────
// DEMO_STEPS  —  vertical list of all tour stops.
// Fields:
//   selector  CSS selector targeting the element to highlight (data-demo-id="…" or #id)
//   title     Short heading shown in the description panel
//   text      Explanation shown to the user
// ─────────────────────────────────────────────────────────────────────────────
const DEMO_STEPS = [
  {
    selector: '#iv-samples',
    title: 'Sample panel',
    text: 'Lists all available tissue samples. Click a thumbnail to make it active. The highlighted outline shows the currently active sample. When multiple samples are loaded their annotations are stored independently. XE indicates a sample with Xenium overlays available.',
  },
  {
    selector: '[data-demo-id="tool-pan"]',
    title: '✥  Pan / zoom',
    text: 'The default navigation tool. Drag to pan, scroll to zoom, double-click anywhere to reset to the full-view. No annotations are drawn while this tool is active.',
  },
  {
    selector: '[data-demo-id="tool-draw-positive"]',
    title: 'draw+  Positive draw',
    text: 'Draw freehand positive contours that mark regions of interest — typically tumour or cell-type you want to detect. Strokes are stored in image space and stay locked when you zoom.',
  },
  {
    selector: '[data-demo-id="tool-draw-negative"]',
    title: 'draw−  Negative draw',
    text: 'Draw negative contours to mark background or tissue you want the classifier to exclude. Using both positive and negative strokes improves classifier quality.',
  },
  {
    selector: '[data-demo-id="flush-btn"]',
    title: '⬇  Send strokes to Python API',
    text: 'Transfers all annotations for all samples from the browser to the Python kernel. Click this before calling run_inference() in Jupyter calls for reading strokes from Python code.',
  },
  {
    selector: '[data-demo-id="toggle-annot-btn"]',
    title: '👀  Toggle annotation visibility',
    text: 'Hides or shows all drawn contours without deleting them. While hidden the drawing cursor is still visible and new strokes can be added. The overlay and tiles are unaffected.',
  },
  {
    selector: '[data-demo-id="brush-mode-btn"]',
    title: 'Brush mode toggle (line ↔ disk)',
    text: 'Switches between Line mode (thin freehand stroke, good for outlines) and Disk mode (large swept-disk brush, good for quickly painting big regions). The slider to the right controls line width or disk radius depending on the active mode.',
  },
  {
    selector: '[data-demo-id="color-picker"]',
    title: 'Stroke color',
    text: 'Sets the display color of strokes drawn with the current tool. Only affects how contours are visualised; the positive/negative type is determined by the active draw tool, not the color.',
  },
  {
    selector: '[data-demo-id="width-slider"]',
    title: 'Width / radius slider',
    text: 'In Line mode: controls stroke width in screen pixels (1–50 px). In Disk mode: controls the disk radius in image pixels (50–10 000 px). Adjust before drawing; existing strokes are not affected.',
  },
  {
    selector: '[data-demo-id="smooth-slider"]',
    title: 'Smoothing slider',
    text: 'Adjusts how much the raw pointer path is smoothed before storing. 0 = no smoothing (jagged). 1 = heavy smoothing (rounded). Default 0.35 works well for most cases.',
  },
  {
    selector: '[data-demo-id="undo-btn"]',
    title: '↩  Undo',
    text: 'Removes the last stroke (or disk-brush group) for the current draw mode. Undo is per-mode: switching between draw+ and draw− gives independent undo histories.',
  },
  {
    selector: '[data-demo-id="run-inference-btn"]',
    title: '▶  Run inference',
    text: 'Flushes current strokes, trains the classifier, runs inference on the active sample, and renders the probability heatmap. Only available when a run_inference function was passed to create_viewer().',
  },
  // Add Save and Load buttons demo here
  {
    selector: '[data-demo-id="save-btn"]',
    title: '💾  Save annotations',
    text: 'Saves all current annotations to a file. This allows you to preserve your work and reload it later.',
  },
  {
    selector: '[data-demo-id="load-btn"]',
    title: '📂  Load annotations',
    text: 'Loads annotations from a previously saved file. This allows you to continue working from where you left off.',
  },
  {
    selector: '#iv-alpha',
    title: 'Overlay opacity',
    text: 'Controls the transparency of the probability heatmap rendered after running the classifier. 0 = fully transparent, 1 = fully opaque.',
  },
  {
    selector: '#iv-low',
    title: 'Low-probability color',
    text: 'The heatmap color assigned to cells with classifier probability ≈ 0 (background / negative class).',
  },
  {
    selector: '#iv-high',
    title: 'High-probability color',
    text: 'The heatmap color assigned to cells with classifier probability ≈ 1 (target / positive class). Colors between Low and High are linearly interpolated.',
  },
  {
    selector: '[data-demo-id="fs-btn"]',
    title: '⛶  Fullscreen',
    text: 'Expands the viewer to fill the entire browser viewport for a larger working area. Click again (or press Esc) to return to the notebook view.',
  },
  {
    selector: '[data-demo-id="clear-all-btn"]',
    title: 'Clear all annotations',
    text: 'Removes all drawn annotations across every sample in one go. A confirmation dialog is shown first. This action cannot be undone.',
  },
  {
    selector: '[data-demo-id="clear-sample-btn"]',
    title: 'Clear sample',
    text: 'Removes all annotations for the currently active sample only. A confirmation dialog is shown before deleting.',
  },
  {
    selector: '[data-demo-id="about-btn"]',
    title: 'About DIANNE',
    text: 'Shows version information, license, and copyright for the DIANNE viewer. You are here!',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
function createDemo() {
  let active      = false;
  let currentStep = 0;

  // ── spotlight ──────────────────────────────────────────────────────────────
  // A fixed-position box placed over the target element.
  // box-shadow with a huge spread creates the "dark overlay with a hole" effect.
  const spotlight = document.createElement('div');
  spotlight.style.cssText = [
    'position:fixed', 'z-index:2147483640', 'pointer-events:none',
    'border-radius:6px', 'transition:left 0.2s ease,top 0.2s ease,width 0.2s ease,height 0.2s ease',
    'box-shadow:0 0 0 9999px rgba(0,0,0,0.72)',
    'border:2px solid rgba(83,217,255,0.85)',
    'outline:2px solid rgba(83,217,255,0.35)',
    'outline-offset:2px',
  ].join(';');

  // ── description panel ──────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'z-index:2147483641',
    'min-width:280px', 'max-width:400px',
    'background:#1b1b1b', 'color:#eee',
    'border-radius:8px', 'border:1px solid #3a3a3a',
    'box-shadow:0 6px 24px rgba(0,0,0,0.75)',
    'padding:14px 16px',
    'font:13px/1.55 monospace',
    'transition:top 0.2s ease,left 0.2s ease',
  ].join(';');

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <span style="font-weight:700;color:#53d9ff;font-size:13px" data-demo-title></span>
      <span style="color:#666;font-size:11px" data-demo-counter></span>
    </div>
    <div style="margin-bottom:14px;white-space:normal;color:#ccc" data-demo-text></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button data-demo-stop
        style="padding:5px 10px;border-radius:6px;border:1px solid #555;
               background:#333;color:#bbb;cursor:pointer;font:12px monospace">
        Stop (Esc)
      </button>
      <button data-demo-next
        style="padding:5px 14px;border-radius:6px;border:none;
               background:#1f8cff;color:#fff;cursor:pointer;font:12px monospace">
        Next →
      </button>
    </div>
  `;

  const titleEl   = panel.querySelector('[data-demo-title]');
  const textEl    = panel.querySelector('[data-demo-text]');
  const counterEl = panel.querySelector('[data-demo-counter]');
  const nextBtn   = panel.querySelector('[data-demo-next]');
  const stopBtn   = panel.querySelector('[data-demo-stop]');

  nextBtn.addEventListener('click', advance);
  stopBtn.addEventListener('click', stop);

  // ── helpers ────────────────────────────────────────────────────────────────
  function _resolve(selector) {
    try { return document.querySelector(selector); } catch (_) { return null; }
  }

  // Find the first step index at or after `from` where the target exists in DOM.
  function _nextVisible(from) {
    for (let i = from; i < DEMO_STEPS.length; i++) {
      if (_resolve(DEMO_STEPS[i].selector)) return i;
    }
    return -1; // none found → tour is done
  }

  function _positionPanel(targetRect) {
    const vw     = window.innerWidth;
    const vh     = window.innerHeight;
    const margin = 14;
    // Force layout so offsetWidth/Height are current
    panel.style.visibility = 'hidden';
    panel.style.left = '0px';
    panel.style.top  = '0px';
    document.body.appendChild(panel); // ensure in DOM for measurement
    const pw = panel.offsetWidth  || 320;
    const ph = panel.offsetHeight || 140;
    panel.style.visibility = '';

    // Prefer below; fall back above; then centre vertically
    let top;
    if (targetRect.bottom + ph + margin <= vh) {
      top = targetRect.bottom + margin;
    } else if (targetRect.top - ph - margin >= 0) {
      top = targetRect.top - ph - margin;
    } else {
      top = Math.max(8, Math.min(targetRect.top, vh - ph - 8));
    }

    // Centre horizontally over the element; clamp to viewport
    let left = targetRect.left + targetRect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, vw - pw - 8));

    panel.style.top  = top  + 'px';
    panel.style.left = left + 'px';
  }

  function _showStep(stepIndex) {
    const s  = DEMO_STEPS[stepIndex];
    const el = _resolve(s.selector);

    titleEl.textContent   = s.title;
    textEl.textContent    = s.text;
    counterEl.textContent = (stepIndex + 1) + '\u202f/\u202f' + DEMO_STEPS.length;
    nextBtn.textContent   = (stepIndex === DEMO_STEPS.length - 1) ? 'Finish \u2713' : 'Next \u2192';

    if (el) {
      const rect = el.getBoundingClientRect();
      const pad  = 6;
      spotlight.style.display = 'block';
      spotlight.style.left    = (rect.left   - pad) + 'px';
      spotlight.style.top     = (rect.top    - pad) + 'px';
      spotlight.style.width   = (rect.width  + pad * 2) + 'px';
      spotlight.style.height  = (rect.height + pad * 2) + 'px';
      _positionPanel(rect);
    } else {
      // Element not in DOM — centre panel
      spotlight.style.display = 'none';
      panel.style.top         = '40%';
      panel.style.left        = '50%';
      panel.style.transform   = 'translate(-50%,-50%)';
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function advance() {
    if (!active) return;
    if (currentStep >= DEMO_STEPS.length - 1) { stop(); return; }
    const next = _nextVisible(currentStep + 1);
    if (next === -1) { stop(); return; }
    currentStep = next;
    _showStep(currentStep);
  }

  function start() {
    if (active) { stop(); return; }
    active = true;
    currentStep = _nextVisible(0);
    if (currentStep === -1) { active = false; return; }
    // Activate the draw+ tool so drawing controls are visible during the tour
    const drawPosBtn = document.querySelector('[data-demo-id="tool-draw-positive"]');
    if (drawPosBtn) drawPosBtn.click();
    document.body.appendChild(spotlight);
    document.body.appendChild(panel);
    document.addEventListener('keydown', _onKey);
    _showStep(currentStep);
  }

  function stop() {
    if (!active) return;
    active = false;
    spotlight.remove();
    panel.remove();
    document.removeEventListener('keydown', _onKey);
  }

  function _onKey(e) {
    if (e.key === 'Escape' || e.key === 'Esc') { stop(); return; }
    if (e.key === 'Enter') { e.preventDefault(); advance(); }
  }

  return { start, stop };
}
