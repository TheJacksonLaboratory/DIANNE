/**
 * draw.js
 *
 * Canvas overlay for freehand contour drawing.
 * Strokes are stored in image space and re-projected on every viewport change
 * so they stay locked to the image regardless of pan/zoom.
 *
 * Exposes:
 *   draw.onMouseDown(vpX, vpY)
 *   draw.onMouseMove(vpX, vpY)
 *   draw.onMouseUp()
 *   draw.setMode(mode)       → 'positive' | 'negative'
 *   draw.getStrokes()        → {strokes_positive, strokes_negative}
 *   draw.undoLast()
 *   draw.clear()
 *   draw.setColor(css)
 *   draw.getColor()
 *   draw.setWidth(px)
 */

function createDraw(container, viewport) {
  // ── state (must be declared before resizeCanvas calls redraw) ─────────────
  const strokesPositive = [];
  const strokesNegative = [];
  let   active          = null;
  let   mode            = 'positive';
  const colors          = { positive: '#22f0ff', negative: '#ff5233' };
  let   lineWidth = 2;
  let   strokeId  = 0;

  // ── canvas setup ───────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:3;';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    canvas.width  = container.clientWidth;
    canvas.height = container.clientHeight;
    redraw();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ── viewport change → redraw ───────────────────────────────────────────────
  viewport.onChange(() => redraw());

  // ── public mouse API ───────────────────────────────────────────────────────
  function onMouseDown(vpX, vpY) {
    const pt = viewport.toImageSpace(vpX, vpY);
    active   = { id: strokeId++, kind: mode, points: [pt] };
    redraw();
  }

  function onMouseMove(vpX, vpY) {
    if (!active) return;
    const pt   = viewport.toImageSpace(vpX, vpY);
    const last = active.points[active.points.length - 1];
    if (Math.abs(pt.x - last.x) < 0.5 && Math.abs(pt.y - last.y) < 0.5) return;
    active.points.push(pt);
    redraw();
  }

  function onMouseUp() {
    if (!active) return;
    if (active.points.length > 1) {
      const target = active.kind === 'negative' ? strokesNegative : strokesPositive;
      target.push(active);
    }
    active = null;
    redraw();
  }

  // ── public controls ────────────────────────────────────────────────────────
  function setMode(nextMode) {
    mode = nextMode === 'negative' ? 'negative' : 'positive';
    redraw();
  }

  function undoLast() {
    const target = mode === 'negative' ? strokesNegative : strokesPositive;
    target.pop();
    redraw();
  }

  function clear() {
    strokesPositive.length = 0;
    strokesNegative.length = 0;
    active = null;
    redraw();
  }

  function setColor(css)       { colors[mode] = css; }
  function getColor()           { return colors[mode]; }
  function setWidth(px)         { lineWidth = px; }
  function setVisible(visible)  { canvas.style.display = visible ? '' : 'none'; }

  function _cloneStrokes(strokes) {
    return strokes.map(s => ({ id: s.id, points: s.points }));
  }

  function getStrokes() {
    return {
      strokes_positive: _cloneStrokes(strokesPositive),
      strokes_negative: _cloneStrokes(strokesNegative),
    };
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokesPositive) _renderStroke(s);
    for (const s of strokesNegative) _renderStroke(s);
    if (active)                      _renderStroke(active);
  }

  function _renderStroke(stroke) {
    const strokeColor = (stroke.kind === 'negative') ? colors.negative : colors.positive;
    if (stroke.points.length < 2) {
      const sp = viewport.toScreenSpace(stroke.points[0].x, stroke.points[0].y);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, lineWidth, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth   = lineWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    const first = viewport.toScreenSpace(stroke.points[0].x, stroke.points[0].y);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.points.length; i++) {
      const sp = viewport.toScreenSpace(stroke.points[i].x, stroke.points[i].y);
      ctx.lineTo(sp.x, sp.y);
    }
    ctx.stroke();
  }

  return {
    onMouseDown,
    onMouseMove,
    onMouseUp,
    setMode,
    getStrokes,
    undoLast,
    clear,
    setColor,
    getColor,
    setWidth,
    setVisible,
  };
}