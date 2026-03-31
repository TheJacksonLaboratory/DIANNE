/**
 * viewport.js
 *
 * Owns the pan/zoom transform state and coordinate conversion.
 * Does NOT handle mouse events directly — toolbar.js calls the
 * public mutators (panBy, zoomAt, reset) based on active tool.
 *
 * Exposes:
 *   viewport.panBy(dx, dy)
 *   viewport.zoomAt(mx, my, delta)   delta > 0 = zoom in
 *   viewport.reset()                 fit image to container
 *   viewport.toImageSpace(vpX, vpY)  → {x, y}  (image pixels, can be fractional)
 *   viewport.toScreenSpace(imgX, imgY) → {x, y} (viewport pixels)
 *   viewport.getTransform()          → {scale, ox, oy}
 *   viewport.onChange(fn)            register callback fired after every change
 */

function createViewport(container, imageWidth, imageHeight) {
  const MIN_SCALE = 0.01;
  const MAX_SCALE = 2.0;

  let scale = 1, ox = 0, oy = 0;
  const listeners = [];

  // ── init: fit image into container ────────────────────────────────────────
  function reset() {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    scale = Math.min(cw / imageWidth, ch / imageHeight);
    ox    = (cw - imageWidth  * scale) / 2;
    oy    = (ch - imageHeight * scale) / 2;
    _notify();
  }

  // ── mutators ───────────────────────────────────────────────────────────────
  function panBy(dx, dy) {
    ox += dx;
    oy += dy;
    _notify();
  }

  function zoomAt(mx, my, delta) {
    const factor   = 1 + delta;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    const ratio    = newScale / scale;
    ox    = mx - ratio * (mx - ox);
    oy    = my - ratio * (my - oy);
    scale = newScale;
    _notify();
  }

  // ── coordinate conversion ──────────────────────────────────────────────────
  function toImageSpace(vpX, vpY) {
    return {
      x: (vpX - ox) / scale,
      y: (vpY - oy) / scale,
    };
  }

  function toScreenSpace(imgX, imgY) {
    return {
      x: imgX * scale + ox,
      y: imgY * scale + oy,
    };
  }

  function getTransform() {
    return { scale, ox, oy };
  }

  // ── change notifications ───────────────────────────────────────────────────
  function onChange(fn) {
    listeners.push(fn);
  }

  function _notify() {
    const t = getTransform();
    for (const fn of listeners) fn(t);
  }

  // fit on creation
  reset();

  return { panBy, zoomAt, reset, toImageSpace, toScreenSpace, getTransform, onChange };
}