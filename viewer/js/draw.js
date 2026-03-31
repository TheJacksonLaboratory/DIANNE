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
  const MIN_STROKE_POINTS = 15;

  // ── state (must be declared before resizeCanvas calls redraw) ─────────────
  const strokesPositive = [];
  const strokesNegative = [];
  let   active          = null;
  let   mode            = 'positive';
  const colors          = { positive: '#22f0ff', negative: '#ff5233' };
  let   lineWidth = 2;
  let   smoothing = 0.35; // 0=no smoothing, 1=strong smoothing
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
    if (active.points.length > 2) {
      _closeContour(active.points);
      active.points = _smoothPoints(active.points, smoothing);
    }
    if (active.points.length >= MIN_STROKE_POINTS) {
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
  function setSmoothing(v)      { smoothing = _clamp01(Number(v)); }
  function getSmoothing()        { return smoothing; }
  function setVisible(visible)  { canvas.style.display = visible ? '' : 'none'; }

  function _cloneStrokes(strokes) {
    return strokes.map(s => ({ id: s.id, points: s.points }));
  }

  function _clamp01(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
  }

  function _closeContour(points) {
    if (!points || points.length < 3) return;
    const first = points[0];
    const last = points[points.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    if ((dx * dx + dy * dy) > 1e-6) {
      points.push({ x: first.x, y: first.y });
    } else {
      points[points.length - 1] = { x: first.x, y: first.y };
    }
  }

  function _smoothPoints(points, amount) {
    if (!points || points.length < 4) return points;
    const a = _clamp01(amount);
    if (a <= 0) return points;

    // Blend original polyline with one pass of neighbor averaging.
    const out = points.map((p, i) => {
      if (i === 0 || i === points.length - 1) return { x: p.x, y: p.y };
      const prev = points[i - 1];
      const next = points[i + 1];
      const avgX = (prev.x + p.x + next.x) / 3;
      const avgY = (prev.y + p.y + next.y) / 3;
      return {
        x: p.x * (1 - a) + avgX * a,
        y: p.y * (1 - a) + avgY * a,
      };
    });

    // Preserve closed-loop endpoint exactness.
    if (out.length > 2) {
      out[out.length - 1] = { x: out[0].x, y: out[0].y };
    }
    return out;
  }

  function getStrokes() {
    return {
      strokes_positive: _cloneStrokes(strokesPositive),
      strokes_negative: _cloneStrokes(strokesNegative),
    };
  }

  function setStrokes(positive, negative) {
    strokesPositive.length = 0;
    strokesNegative.length = 0;
    active = null;

    if (Array.isArray(positive)) {
      for (const s of positive) {
        if (s && Array.isArray(s.points)) {
          strokesPositive.push({
            id: s.id || strokeId++,
            kind: 'positive',
            points: s.points.map(p => ({ x: p.x, y: p.y })),
          });
        }
      }
    }

    if (Array.isArray(negative)) {
      for (const s of negative) {
        if (s && Array.isArray(s.points)) {
          strokesNegative.push({
            id: s.id || strokeId++,
            kind: 'negative',
            points: s.points.map(p => ({ x: p.x, y: p.y })),
          });
        }
      }
    }

    redraw();
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
    setStrokes,
    undoLast,
    clear,
    setColor,
    getColor,
    setWidth,
    setSmoothing,
    getSmoothing,
    setVisible,
  };
}