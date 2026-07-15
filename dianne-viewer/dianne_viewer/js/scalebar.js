/**
 * scalebar.js
 *
 * Renders a solid black scale bar with a human-readable length label in the
 * bottom-left corner of the viewer root element.  Updates on every viewport
 * change so the bar always reflects the current zoom level.
 *
 * Usage:
 *   createScaleBar(root, viewport, mpp)
 *     root     — the viewer root DOM element
 *     viewport — viewport object (exposes getTransform(), onChange())
 *     mpp      — micrometres per image pixel (primary image)
 *
 * Returns nothing (the bar manages its own DOM lifecycle).
 */
function createScaleBar(root, viewport, mpp) {
  if (!mpp || mpp <= 0) return;  // no-op when mpp not provided

  // ── DOM ──────────────────────────────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.dataset.ivUi = 'true';
  wrapper.style.cssText = [
    'position:absolute',
    'left:12px',
    'bottom:46px',   // above the footer button row
    'z-index:12',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:3px',
    'pointer-events:none',
    'user-select:none',
  ].join(';');

  const label = document.createElement('div');
  label.style.cssText = [
    'font:bold 14px/1 monospace',
    'color:#fff',
    'text-shadow:0 0 3px #000,0 0 3px #000',
    'white-space:nowrap',
    'letter-spacing:0.04em',
  ].join(';');

  const bar = document.createElement('div');
  bar.style.cssText = [
    'height:6px',
    'background:#000',
    'border:2px solid #fff',   // thin white outline for visibility on dark & light bg
    'border-radius:2px',
    'box-shadow:0 0 2px rgba(0,0,0,0.7)',
    'min-width:4px',
  ].join(';');

  wrapper.appendChild(label);
  wrapper.appendChild(bar);
  root.appendChild(wrapper);

  // ── Nice-number logic ─────────────────────────────────────────────────────
  // Target bar width in screen pixels (approximate).
  const TARGET_PX = 25;

  // Candidate step values in µm that produce pleasing labels.
  // These cover the range from 0.1 µm to 100 000 µm (= 10 cm).
  const STEPS_UM = [
    0.1, 0.2, 0.5,
    1, 2, 5,
    10, 20, 50,
    100, 200, 500,
    1000, 2000, 5000,
    10000, 20000, 50000,
    100000,
  ];

  function _format(um) {
    if (um < 1000) {
      // µm range  (use Unicode µ)
      return um + '\u00a0\u00b5m';   // non-breaking space + µm
    } else if (um < 10000) {
      const mm = um / 1000;
      return mm + '\u00a0mm';
    } else {
      const cm = um / 10000;
      return cm + '\u00a0cm';
    }
  }

  // ── Redraw ────────────────────────────────────────────────────────────────
  function _update() {
    const { scale } = viewport.getTransform();
    // screen pixels per µm  =  scale (screen px / image px) / mpp (µm / image px)
    //                       =  scale / mpp
    const pxPerUm = scale / mpp;

    // Find the step that produces a bar closest to TARGET_PX, preferring a
    // slightly larger bar to a too-short one (hence .find from the back).
    let best = STEPS_UM[0];
    for (const step of STEPS_UM) {
      const barPx = step * pxPerUm;
      if (barPx >= TARGET_PX * 0.4) best = step;  // keep advancing while reasonable
      if (barPx > TARGET_PX * 2.5) break;         // overshot — stop
    }

    const barPx = Math.round(best * pxPerUm);
    bar.style.width = barPx + 'px';
    label.textContent = _format(best);
  }

  viewport.onChange(_update);
  _update();
}
