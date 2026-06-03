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
  let   lineWidth    = 2;    // stroke weight for line mode
  let   noodleRadius = 500;  // disk radius for noodle mode (image px)
  let   smoothing    = 0.35; // 0=no smoothing, 1=strong smoothing
  let   brushMode    = 'line'; // 'line' | 'noodle'
  let   strokesVisible = true;  // false = hide strokes but keep cursor
  let   cursorVpX  = -9999;
  let   cursorVpY  = -9999;
  let   cursorVisible = false;
  let   strokeId   = 0;
  let   selectedId = null;  // id of the currently selected contour, or null

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
  // ResizeObserver catches CSS-driven resizes (e.g. custom fullscreen toggle)
  // as well as ordinary window resizes — both trigger canvas relayout.
  new ResizeObserver(resizeCanvas).observe(container);
  resizeCanvas();

  // ── viewport change → redraw ───────────────────────────────────────────────
  viewport.onChange(() => redraw());

  // ── image-space point clamping ─────────────────────────────────────────────
  function _clampToImage(pt) {
    const { width, height } = viewport.getImageSize();
    pt.x = Math.max(0, Math.min(width  - 1, pt.x));
    pt.y = Math.max(0, Math.min(height - 1, pt.y));
    return pt;
  }

  // ── public mouse API ───────────────────────────────────────────────────────
  function onMouseDown(vpX, vpY) {
    const pt = _clampToImage(viewport.toImageSpace(vpX, vpY));
    active   = { id: strokeId++, kind: mode, brushMode: brushMode, points: [pt] };
    cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
    redraw();
  }

  function onMouseMove(vpX, vpY) {
    cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
    if (!active) { redraw(); return; }
    const pt   = _clampToImage(viewport.toImageSpace(vpX, vpY));
    const last = active.points[active.points.length - 1];
    if (Math.abs(pt.x - last.x) < 0.5 && Math.abs(pt.y - last.y) < 0.5) return;
    active.points.push(pt);
    redraw();
  }

  function onMouseLeave() {
    cursorVisible = false;
    redraw();
  }

  function onMouseUp() {
    if (!active) return;
    if (active.brushMode === 'noodle') {
      _finalizeNoodleStroke(active);
    } else {
      if (active.points.length > 2) {
        _closeContour(active.points);
        active.points = _smoothPoints(active.points, smoothing);
      }
      if (active.points.length >= MIN_STROKE_POINTS) {
        const target = active.kind === 'negative' ? strokesNegative : strokesPositive;
        target.push(active);
      }
    }
    active = null;
    redraw();
  }

  function _finalizeNoodleStroke(stroke) {
    const center = stroke.points;
    if (center.length < 2) return;
    const gid      = strokeId++;  // group ID shared by all contour polygons from this action
    const smoothed = _smoothOpenPath(center, smoothing, Math.max(1, Math.round(smoothing * 8)));
    const contours = _extractNoodleContours(smoothed, noodleRadius, stroke.kind, gid);
    const target   = stroke.kind === 'negative' ? strokesNegative : strokesPositive;
    for (const s of contours) target.push(s);
  }

  // ── public controls ────────────────────────────────────────────────────────
  function setMode(nextMode) {
    mode = nextMode === 'negative' ? 'negative' : 'positive';
    redraw();
  }

  function undoLast() {
    const target = mode === 'negative' ? strokesNegative : strokesPositive;
    if (!target.length) { redraw(); return; }
    const last = target[target.length - 1];
    if (last.groupId !== undefined) {
      // Remove all strokes belonging to the same noodle action
      const gid = last.groupId;
      for (let i = target.length - 1; i >= 0; i--) {
        if (target[i].groupId === gid) target.splice(i, 1);
      }
    } else {
      target.pop();
    }
    redraw();
  }

  function clear() {
    strokesPositive.length = 0;
    strokesNegative.length = 0;
    active = null;
    selectedId = null;
    redraw();
  }

  function setColor(css)           { colors[mode] = css; }
  function getColor()               { return colors[mode]; }
  function setWidth(px)             { lineWidth = px; }
  function getWidth()               { return lineWidth; }
  function setNoodleRadius(px)      { noodleRadius = Math.max(1, Number(px)); }
  function getNoodleRadius()        { return noodleRadius; }
  function setSmoothing(v)          { smoothing = _clamp01(Number(v)); }
  function getSmoothing()           { return smoothing; }
  function setBrushMode(m)          { brushMode = (m === 'noodle') ? 'noodle' : 'line'; }
  function getBrushMode()           { return brushMode; }
  function setVisible(visible)      { strokesVisible = visible; redraw(); }
  function getVisible()              { return strokesVisible; }

  function _cloneStrokes(strokes) {
    return strokes.map(s => {
      const out = { id: s.id, points: s.points };
      if (s.brushMode === 'noodle') {
        out.brush_mode = 'noodle';
        if (s.groupId !== undefined) out.group_id = s.groupId;
      }
      return out;
    });
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

  // Smooth an open (non-closed) path; preserves endpoints, applies multiple passes.
  function _smoothOpenPath(points, amount, passes) {
    if (!points || points.length < 3) return points;
    const a = _clamp01(amount);
    if (a <= 0) return points;
    let out = points.slice();
    for (let pass = 0; pass < (passes || 1); pass++) {
      const next = out.slice();
      for (let i = 1; i < out.length - 1; i++) {
        const avgX = (out[i - 1].x + out[i].x + out[i + 1].x) / 3;
        const avgY = (out[i - 1].y + out[i].y + out[i + 1].y) / 3;
        next[i] = { x: out[i].x * (1 - a) + avgX * a,
                    y: out[i].y * (1 - a) + avgY * a };
      }
      out = next;
    }
    return out;
  }

  // ── Noodle contour extraction ─────────────────────────────────────────────────────────────
  // Renders the swept disk onto an offscreen canvas, builds a binary mask, then
  // traces its boundary polygon(s) with marching squares.  Returns completed
  // stroke objects whose points are the contour polygon(s) in image space.
  function _extractNoodleContours(centerPts, radius, kind, groupId) {
    const N = centerPts.length;
    if (N < 1) return [];

    // 1. Bounding box in image space, padded and clamped to image.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of centerPts) {
      if (p.x < minX) minX = p.x;  if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;  if (p.y > maxY) maxY = p.y;
    }
    const { width: imgW, height: imgH } = viewport.getImageSize();
    const pad = radius + 2;
    // Do NOT clamp to image bounds here: the full disk must be rendered so
    // marching squares always sees closed shapes. Contour vertices are clamped
    // to image bounds after extraction.
    minX = Math.floor(minX - pad);
    minY = Math.floor(minY - pad);
    maxX = Math.ceil(maxX  + pad);
    maxY = Math.ceil(maxY  + pad);
    const boxW = maxX - minX, boxH = maxY - minY;
    if (boxW <= 0 || boxH <= 0) return [];

    // 2. Work scale: keep offscreen canvas ≤ MAX_DIM on longest side.
    const MAX_DIM   = 1024;
    const workScale = Math.min(1.0, MAX_DIM / Math.max(boxW, boxH));
    const cW = Math.max(3, Math.ceil(boxW * workScale) + 2);  // +2 for 1-px border
    const cH = Math.max(3, Math.ceil(boxH * workScale) + 2);

    // 3. Render thick round stroke (black bg, white shape) onto offscreen canvas.
    const oc   = document.createElement('canvas');
    oc.width   = cW;
    oc.height  = cH;
    const oc2d = oc.getContext('2d');
    oc2d.fillStyle   = '#000';
    oc2d.fillRect(0, 0, cW, cH);
    oc2d.strokeStyle = '#fff';
    oc2d.lineWidth   = radius * 2 * workScale;
    oc2d.lineCap     = 'round';
    oc2d.lineJoin    = 'round';
    oc2d.beginPath();
    oc2d.moveTo((centerPts[0].x - minX) * workScale + 1,
                (centerPts[0].y - minY) * workScale + 1);
    for (let i = 1; i < N; i++) {
      oc2d.lineTo((centerPts[i].x - minX) * workScale + 1,
                  (centerPts[i].y - minY) * workScale + 1);
    }
    oc2d.stroke();

    // 4. Build binary mask (threshold anti-aliased edges at 127).
    const data = oc2d.getImageData(0, 0, cW, cH).data;
    const mask = new Uint8Array(cW * cH);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4] > 127 ? 1 : 0;

    // 5. Trace contour polygon(s) with marching squares.
    const polyList = _marchingSquares(mask, cW, cH);

    // 6. Convert vertices back to image space; wrap as stroke objects.
    const result = [];
    for (const poly of polyList) {
      if (poly.length < 6) continue;  // discard noise
      result.push({
        id:        strokeId++,
        kind,
        brushMode: 'noodle',
        groupId,
        points: poly.map(p => ({
          x: Math.max(0, Math.min(imgW - 1, (p.x - 1) / workScale + minX)),
          y: Math.max(0, Math.min(imgH - 1, (p.y - 1) / workScale + minY)),
        })),
      });
    }
    return result;
  }

  // Standard marching squares — traces closed boundary polygons on a binary mask.
  // mask: flat Uint8Array, row-major, W×H.  Returns array of [{x,y}] polygons.
  function _marchingSquares(mask, W, H) {
    // Cell case index: bit0=tl | bit1=tr | bit2=br | bit3=bl
    // (tl = mask[cj*W+ci], tr = mask[cj*W+ci+1],
    //  br = mask[(cj+1)*W+ci+1], bl = mask[(cj+1)*W+ci])
    // Edge indices: 0=top, 1=right, 2=bottom, 3=left
    const TABLE = [
      [],               // 0  0000
      [[3, 0]],         // 1  0001 tl
      [[0, 1]],         // 2  0010 tr
      [[3, 1]],         // 3  0011 tl+tr
      [[1, 2]],         // 4  0100 br
      [[3, 0], [1, 2]], // 5  0101 tl+br  saddle
      [[0, 2]],         // 6  0110 tr+br
      [[3, 2]],         // 7  0111 tl+tr+br
      [[2, 3]],         // 8  1000 bl
      [[2, 0]],         // 9  1001 tl+bl
      [[0, 1], [2, 3]], // 10 1010 tr+bl  saddle
      [[2, 1]],         // 11 1011 tl+tr+bl
      [[1, 3]],         // 12 1100 br+bl
      [[1, 0]],         // 13 1101 tl+br+bl
      [[0, 3]],         // 14 1110 tr+br+bl
      [],               // 15 1111
    ];

    // Edge midpoints encoded as integers ×2 to avoid floating-point key collisions:
    //   0=top (ci*2+1, cj*2)        1=right ((ci+1)*2, cj*2+1)
    //   2=bottom (ci*2+1,(cj+1)*2)  3=left  (ci*2, cj*2+1)
    function ep(ci, cj, e) {
      if (e === 0) return { x: ci * 2 + 1,      y: cj * 2 };
      if (e === 1) return { x: (ci + 1) * 2,    y: cj * 2 + 1 };
      if (e === 2) return { x: ci * 2 + 1,      y: (cj + 1) * 2 };
      return             { x: ci * 2,           y: cj * 2 + 1 };
    }
    function ekey(p) { return p.x + ',' + p.y; }

    // Build directed next-point map (one entry per boundary crossing).
    const nextPt = Object.create(null);
    for (let cj = 0; cj < H - 1; cj++) {
      for (let ci = 0; ci < W - 1; ci++) {
        const tl  = mask[cj * W + ci];
        const tr  = mask[cj * W + ci + 1];
        const br  = mask[(cj + 1) * W + ci + 1];
        const bl  = mask[(cj + 1) * W + ci];
        const idx = tl | (tr << 1) | (br << 2) | (bl << 3);
        for (const [e1, e2] of TABLE[idx]) {
          nextPt[ekey(ep(ci, cj, e1))] = ep(ci, cj, e2);
        }
      }
    }

    // Follow directed chains → closed polygons.
    const visited  = new Set();
    const polygons = [];
    for (const startKey of Object.keys(nextPt)) {
      if (visited.has(startKey)) continue;
      const poly   = [];
      let   cur    = startKey;
      let   safety = 0;
      while (cur && nextPt[cur] && !visited.has(cur) && safety++ < 500000) {
        visited.add(cur);
        const [x2, y2] = cur.split(',');
        poly.push({ x: +x2 / 2, y: +y2 / 2 });
        cur = ekey(nextPt[cur]);
      }
      if (poly.length >= 3) polygons.push(poly);
    }
    return polygons;
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
    selectedId = null;

    if (Array.isArray(positive)) {
      for (const s of positive) {
        if (s && Array.isArray(s.points)) {
          strokesPositive.push({
            id:        s.id || strokeId++,
            kind:      'positive',
            brushMode: s.brush_mode || 'line',
            groupId:   s.group_id,
            points:    s.points.map(p => ({ x: p.x, y: p.y })),
          });
        }
      }
    }

    if (Array.isArray(negative)) {
      for (const s of negative) {
        if (s && Array.isArray(s.points)) {
          strokesNegative.push({
            id:        s.id || strokeId++,
            kind:      'negative',
            brushMode: s.brush_mode || 'line',
            groupId:   s.group_id,
            points:    s.points.map(p => ({ x: p.x, y: p.y })),
          });
        }
      }
    }

    redraw();
  }

  // ── point-to-segment distance (screen space) ────────────────────────────
  function _ptSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Find the stroke id closest to (vpX, vpY); returns null if none within tolerance.
  function _hitTest(vpX, vpY) {
    if (!strokesVisible) return null;
    const TOLERANCE = Math.max(8, lineWidth / 2 + 4);
    let bestId   = null;
    let bestDist = TOLERANCE;
    const allStrokes = strokesPositive.concat(strokesNegative);
    for (const s of allStrokes) {
      if (s.points.length < 2) continue;
      const pts = s.points.map(p => viewport.toScreenSpace(p.x, p.y));
      const n   = pts.length;
      for (let i = 0; i < n - 1; i++) {
        const d = _ptSegDist(vpX, vpY, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        if (d < bestDist) { bestDist = d; bestId = s.id; }
      }
      // For noodle polygons the points array is not explicitly closed — check wrap segment.
      if (s.brushMode === 'noodle' && n >= 3) {
        const d = _ptSegDist(vpX, vpY, pts[n - 1].x, pts[n - 1].y, pts[0].x, pts[0].y);
        if (d < bestDist) { bestDist = d; bestId = s.id; }
      }
    }
    return bestId;
  }

  function _findStrokeById(id) {
    for (const s of strokesPositive) if (s.id === id) return s;
    for (const s of strokesNegative) if (s.id === id) return s;
    return null;
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (strokesVisible) {
      for (const s of strokesPositive) _renderStroke(s);
      for (const s of strokesNegative) _renderStroke(s);
      if (active)                      _renderStroke(active);
      // Draw selected stroke highlight on top of all other strokes.
      if (selectedId !== null) {
        const sel = _findStrokeById(selectedId);
        if (sel) _renderHighlight(sel);
        else selectedId = null;  // stroke was removed externally
      }
    }
    _renderCursor();
  }

  // Yellow glowing outline for the selected contour.
  function _renderHighlight(stroke) {
    if (!stroke || stroke.points.length < 2) return;
    ctx.save();
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.strokeStyle = '#ffe000';
    ctx.lineWidth   = Math.max(lineWidth, 2) + 4;
    ctx.globalAlpha = 0.92;
    ctx.shadowColor = 'rgba(255, 220, 0, 1.0)';
    ctx.shadowBlur  = 16;
    ctx.beginPath();
    const fp = viewport.toScreenSpace(stroke.points[0].x, stroke.points[0].y);
    ctx.moveTo(fp.x, fp.y);
    for (let i = 1; i < stroke.points.length; i++) {
      const sp = viewport.toScreenSpace(stroke.points[i].x, stroke.points[i].y);
      ctx.lineTo(sp.x, sp.y);
    }
    if (stroke.brushMode === 'noodle') ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function _renderCursor() {
    if (!cursorVisible) return;
    ctx.save();
    ctx.strokeStyle = '#00ff40';
    ctx.globalAlpha = 1.0;

    if (brushMode === 'noodle') {
      // ── disk mode: circle + crosshair extending beyond the circle ──────────
      const { scale } = viewport.getTransform();
      const screenRadius = noodleRadius * scale;
      const CH = Math.max(18, screenRadius + 10); // arms reach past the circle
      const GAP = Math.max(4, Math.min(screenRadius, 6)); // gap at centre
      ctx.lineWidth = 2.5;
      // circle outline
      if (screenRadius >= 1) {
        ctx.beginPath();
        ctx.arc(cursorVpX, cursorVpY, screenRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
      // crosshair with centre gap
      ctx.beginPath();
      ctx.moveTo(cursorVpX - CH,  cursorVpY);
      ctx.lineTo(cursorVpX - GAP, cursorVpY);
      ctx.moveTo(cursorVpX + GAP, cursorVpY);
      ctx.lineTo(cursorVpX + CH,  cursorVpY);
      ctx.moveTo(cursorVpX,  cursorVpY - CH);
      ctx.lineTo(cursorVpX,  cursorVpY - GAP);
      ctx.moveTo(cursorVpX,  cursorVpY + GAP);
      ctx.lineTo(cursorVpX,  cursorVpY + CH);
      ctx.stroke();
    } else {
      // ── line mode: large crosshair with centre gap ──────────────────────────
      const CH  = 20; // arm length from gap to tip
      const GAP = 5;  // half-gap at centre
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cursorVpX - CH - GAP, cursorVpY);
      ctx.lineTo(cursorVpX - GAP,      cursorVpY);
      ctx.moveTo(cursorVpX + GAP,      cursorVpY);
      ctx.lineTo(cursorVpX + CH + GAP, cursorVpY);
      ctx.moveTo(cursorVpX,  cursorVpY - CH - GAP);
      ctx.lineTo(cursorVpX,  cursorVpY - GAP);
      ctx.moveTo(cursorVpX,  cursorVpY + GAP);
      ctx.lineTo(cursorVpX,  cursorVpY + CH + GAP);
      ctx.stroke();
    }
    ctx.restore();
  }

  function _renderStroke(stroke) {
    // ── noodle active: thick brush sweep preview ────────────────────────────────
    if (stroke.brushMode === 'noodle' && stroke === active) {
      if (stroke.points.length < 1) return;
      const { scale } = viewport.getTransform();
      const color = (stroke.kind === 'negative') ? colors.negative : colors.positive;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = noodleRadius * 2 * scale;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      const fp = viewport.toScreenSpace(stroke.points[0].x, stroke.points[0].y);
      ctx.moveTo(fp.x, fp.y);
      for (let i = 1; i < stroke.points.length; i++) {
        const sp = viewport.toScreenSpace(stroke.points[i].x, stroke.points[i].y);
        ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    // ── noodle completed: contour polygon outline ─────────────────────────────
    if (stroke.brushMode === 'noodle') {
      if (stroke.points.length < 3) return;
      const color = (stroke.kind === 'negative') ? colors.negative : colors.positive;
      ctx.save();
      ctx.beginPath();
      const fp = viewport.toScreenSpace(stroke.points[0].x, stroke.points[0].y);
      ctx.moveTo(fp.x, fp.y);
      for (let i = 1; i < stroke.points.length; i++) {
        const sp = viewport.toScreenSpace(stroke.points[i].x, stroke.points[i].y);
        ctx.lineTo(sp.x, sp.y);
      }
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth   = lineWidth;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.restore();
      return;
    }

    // ── line mode ──────────────────────────────────────────────────────────
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

  // ── contour selection public API ───────────────────────────────────────────
  function hitTestStroke(vpX, vpY) { return _hitTest(vpX, vpY); }
  function selectStroke(id)        { selectedId = id; redraw(); }
  function hasSelection()          { return selectedId !== null; }
  function clearSelection()        { selectedId = null; redraw(); }
  function deleteSelected() {
    if (selectedId === null) return;
    const id = selectedId;
    selectedId = null;
    for (let i = strokesPositive.length - 1; i >= 0; i--) {
      if (strokesPositive[i].id === id) { strokesPositive.splice(i, 1); break; }
    }
    for (let i = strokesNegative.length - 1; i >= 0; i--) {
      if (strokesNegative[i].id === id) { strokesNegative.splice(i, 1); break; }
    }
    redraw();
  }

  return {
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onMouseLeave,
    setMode,
    getStrokes,
    setStrokes,
    undoLast,
    clear,
    setColor,
    getColor,
    setWidth,
    getWidth,
    setNoodleRadius,
    getNoodleRadius,
    setSmoothing,
    getSmoothing,
    setBrushMode,
    getBrushMode,
    setVisible,
    getVisible,
    hitTestStroke,
    selectStroke,
    hasSelection,
    clearSelection,
    deleteSelected,
  };
}