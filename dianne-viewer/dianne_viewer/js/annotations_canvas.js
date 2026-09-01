/**
 * annotations_canvas.js
 *
 * Canvas overlay for §4/§6/§10/§11: renders library annotations (rings with
 * holes), the active ruler measurement, and implements the new geometry
 * tools (polygon, freehand brush, vertex-edit) on top of the annotations.js
 * data model. This is a sibling to draw.js's canvas (which continues to own
 * the pre-existing positive/negative stroke rendering, per task.md §0) —
 * kept as a separate layer so existing positive/negative behavior is
 * untouched.
 *
 * Exposes createAnnotationsCanvas({ container, viewport, annotations, getActiveSample, settings, log })
 *   .setTool(name)              → 'none'|'polygon'|'freehand'|'vertex_edit'|'ruler'
 *   .onMouseDown/onMouseMove/onMouseUp/onKeyDown(e)
 *   .setSelected(id)            → highlight + used by bidirectional list sync
 *   .panZoomTo(ann)             → center viewport on an annotation
 *   .redraw()
 *   .setVisibility(id, visible) / setClassVisibility(cls, visible)
 *
 * `settings` (optional) supplies the 'contourSimplify' / 'contourSimplifyPx'
 * viewer settings (see settings.js): newly finished polygon/freehand/noodle
 * rings are run through annotations.simplifyRing() with a tolerance derived
 * from the *screen*-px setting divided by the current viewport scale, so the
 * same on-screen fidelity is kept regardless of the zoom level the contour
 * was drawn at.
 */
function createAnnotationsCanvas({ container, viewport, annotations, getActiveSample, settings, log }) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:3;';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let tool = 'none';               // 'none' | 'polygon' | 'freehand' | 'vertex_edit' | 'ruler'
  let selectedId = null;
  let hiddenIds = new Set();       // per-annotation visibility (§4)
  let hiddenClasses = new Set();   // per-class-group visibility (§4)
  let opacityByClass = {};         // { [class]: 0..1 }
  // Class colors themselves live in annotations.js (global, persisted); this
  // module only reads/writes through it so every consumer (canvas, minimap,
  // tab swatches) stays in sync and the color survives save/load.

  // polygon tool state
  let polyPoints = [];
  // freehand tool state
  let freehandPoints = null;
  let freehandCls = 'unclassified'; // 'unclassified' | 'positive' | 'negative' — class tag for draw/draw+/draw-
  let brushMode = 'noodle';          // 'line' | 'noodle' (disk + marching squares, mirrors draw.js)
  let brushRadius = 300;           // noodle disk radius (image px); matches toolbar's noodle slider range (50-2000)
  let brushSmoothing = 0.35;
  // vertex-edit drag state
  let dragTarget = null; // { id, ringIdx, vertIdx }
  const VERTEX_HIT_RADIUS_VP = 8; // px in viewport space
  // freehand cursor tracking (mirrors draw.js so the brush preview is visible
  // even though the native cursor is hidden via container.style.cursor='none')
  let cursorVpX = -9999;
  let cursorVpY = -9999;
  let cursorVisible = false;

  function resize() {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    redraw();
  }
  new ResizeObserver(resize).observe(container);
  resize();
  viewport.onChange(() => redraw());

  function _toVp(pt) { return viewport.toScreenSpace(pt.x, pt.y); }

  function _classVisible(ann) {
    return !hiddenIds.has(ann.id) && !hiddenClasses.has(ann.class);
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sample = getActiveSample();
    if (!sample) return;

    // library annotations
    for (const ann of annotations.listAnnotations(sample, 'library')) {
      if (!_classVisible(ann)) continue;
      _drawAnnotation(ann, ann.id === selectedId);
    }

    // in-progress polygon tool
    if (tool === 'polygon' && polyPoints.length) {
      ctx.save();
      ctx.strokeStyle = '#3fff49';
      ctx.lineWidth = 4;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      const p0 = _toVp(polyPoints[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < polyPoints.length; i++) { const p = _toVp(polyPoints[i]); ctx.lineTo(p.x, p.y); }
      ctx.stroke();
      ctx.restore();
    }

    // in-progress freehand tool: line-mode preview stroke, or noodle-mode
    // swept-disk preview (same visual language as draw.js's draw+/draw-)
    if (tool === 'freehand' && freehandPoints && freehandPoints.length) {
      ctx.save();
      const previewColor = annotations.getClassColor(freehandCls) || '#3fff49';
      if (brushMode === 'noodle') {
        const { scale } = viewport.getTransform();
        ctx.strokeStyle = previewColor;
        ctx.lineWidth = brushRadius * 2 * scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.22;
      } else {
        ctx.strokeStyle = previewColor;
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.9;
      }
      ctx.beginPath();
      const p0 = _toVp(freehandPoints[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < freehandPoints.length; i++) { const p = _toVp(freehandPoints[i]); ctx.lineTo(p.x, p.y); }
      ctx.stroke();
      ctx.restore();
    }

    // ruler (§11)
    const ruler = annotations.getRuler();
    if (ruler) {
      const a = _toVp(ruler.start);
      const b = _toVp(ruler.end || ruler.live || ruler.start);
      ctx.save();
      ctx.strokeStyle = 'rgba(9, 9, 246, 0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash(ruler.end ? [] : [6, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = '#09037d';
      ctx.font = '16px monospace';
      const lengthPx = annotations.rulerLengthPx();
      const label = annotations.formatLength(lengthPx, sample);
      ctx.fillText(label, (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 6);
      ctx.restore();
    }

    // freehand brush cursor preview (line crosshair / noodle disk+crosshair)
    if (tool === 'freehand') _renderCursor();
  }

  function _renderCursor() {
    if (!cursorVisible) return;
    ctx.save();
    ctx.strokeStyle = '#00ff40';
    ctx.globalAlpha = 1.0;
    if (brushMode === 'noodle') {
      const { scale } = viewport.getTransform();
      const screenRadius = brushRadius * scale;
      const CH = Math.max(18, screenRadius + 10);
      const GAP = Math.max(4, Math.min(screenRadius, 6));
      ctx.lineWidth = 2.5;
      if (screenRadius >= 1) {
        ctx.beginPath();
        ctx.arc(cursorVpX, cursorVpY, screenRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cursorVpX - CH, cursorVpY);
      ctx.lineTo(cursorVpX - GAP, cursorVpY);
      ctx.moveTo(cursorVpX + GAP, cursorVpY);
      ctx.lineTo(cursorVpX + CH, cursorVpY);
      ctx.moveTo(cursorVpX, cursorVpY - CH);
      ctx.lineTo(cursorVpX, cursorVpY - GAP);
      ctx.moveTo(cursorVpX, cursorVpY + GAP);
      ctx.lineTo(cursorVpX, cursorVpY + CH);
      ctx.stroke();
    } else {
      const CH = 20;
      const GAP = 5;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cursorVpX - CH - GAP, cursorVpY);
      ctx.lineTo(cursorVpX - GAP, cursorVpY);
      ctx.moveTo(cursorVpX + GAP, cursorVpY);
      ctx.lineTo(cursorVpX + CH + GAP, cursorVpY);
      ctx.moveTo(cursorVpX, cursorVpY - CH - GAP);
      ctx.lineTo(cursorVpX, cursorVpY - GAP);
      ctx.moveTo(cursorVpX, cursorVpY + GAP);
      ctx.lineTo(cursorVpX, cursorVpY + CH + GAP);
      ctx.stroke();
    }
    ctx.restore();
  }

  function _drawAnnotation(ann, isSelected) {
    if (!ann.rings || !ann.rings.length) return;
    const alpha = opacityByClass[ann.class] != null ? opacityByClass[ann.class] : 0.9;
    const baseColor = annotations.getClassColor(ann.class) || '#53d9ff';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (const ring of ann.rings) {
      if (!ring.length) continue;
      const p0 = _toVp(ring[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < ring.length; i++) { const p = _toVp(ring[i]); ctx.lineTo(p.x, p.y); }
      ctx.closePath();
    }
    ctx.strokeStyle = isSelected ? '#ffd23f' : baseColor;
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.stroke();
    if (isSelected) {
      ctx.fillStyle = 'rgba(255,210,63,0.15)';
      ctx.fill('evenodd');
      if (tool === 'vertex_edit') {
        for (let ri = 0; ri < ann.rings.length; ri++) {
          for (const v of ann.rings[ri]) {
            const p = _toVp(v);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#ffd23f';
            ctx.fill();
          }
        }
      }
    }
    ctx.restore();
  }

  // ── hit testing (point-in-polygon w/ holes, screen-space tolerant) ─────
  function _pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
      const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function _pointInAnnotation(pt, ann) {
    if (!ann.rings.length || !_pointInRing(pt, ann.rings[0])) return false;
    for (let i = 1; i < ann.rings.length; i++) if (_pointInRing(pt, ann.rings[i])) return false;
    return true;
  }
  function hitTest(imgPt) {
    const sample = getActiveSample();
    if (!sample) return null;
    const anns = annotations.listAnnotations(sample, 'library');
    for (let i = anns.length - 1; i >= 0; i--) {
      if (_classVisible(anns[i]) && _pointInAnnotation(imgPt, anns[i])) return anns[i];
    }
    return null;
  }
  function _findNearestVertex(imgPt, vpPt) {
    const sample = getActiveSample();
    if (!sample || selectedId == null) return null;
    const ann = annotations.findAnnotation(sample, 'library', selectedId);
    if (!ann) return null;
    let best = null, bestD = Infinity;
    for (let ri = 0; ri < ann.rings.length; ri++) {
      for (let vi = 0; vi < ann.rings[ri].length; vi++) {
        const vp = _toVp(ann.rings[ri][vi]);
        const d = Math.hypot(vp.x - vpPt.x, vp.y - vpPt.y);
        if (d < bestD) { bestD = d; best = { ann, ringIdx: ri, vertIdx: vi }; }
      }
    }
    return (best && bestD <= VERTEX_HIT_RADIUS_VP) ? best : null;
  }

  // ── mouse handlers (invoked by toolbar routing, mirroring draw.js's API) ─
  function onMouseDown(vpX, vpY) {
    const imgPt = viewport.toImageSpace(vpX, vpY);
    const sample = getActiveSample();
    if (!sample) return;

    if (tool === 'polygon') {
      if (polyPoints.length >= 3) {
        const p0vp = _toVp(polyPoints[0]);
        const d = Math.hypot(p0vp.x - vpX, p0vp.y - vpY);
        if (d <= VERTEX_HIT_RADIUS_VP) { finishPolygon(); return; }
      }
      polyPoints.push(imgPt);
      redraw();
      return;
    }
    if (tool === 'freehand') {
      cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
      freehandPoints = [imgPt];
      return;
    }
    if (tool === 'vertex_edit') {
      const near = _findNearestVertex(imgPt, { x: vpX, y: vpY });
      if (near) { dragTarget = near; return; }
      const hit = hitTest(imgPt);
      if (hit) { setSelected(hit.id); }
      return;
    }
    if (tool === 'ruler') {
      const r = annotations.getRuler();
      if (!r || r.end) annotations.rulerStart(imgPt);
      else annotations.rulerFinish(imgPt);
      redraw();
      return;
    }
    // 'none' → selection click-through
    const hit = hitTest(imgPt);
    setSelected(hit ? hit.id : null);
  }

  function onMouseMove(vpX, vpY) {
    const imgPt = viewport.toImageSpace(vpX, vpY);
    if (tool === 'freehand') {
      cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
      if (freehandPoints) { freehandPoints.push(imgPt); redraw(); return; }
      redraw();
      return;
    }
    if (tool === 'vertex_edit' && dragTarget) {
      const sample = getActiveSample();
      dragTarget.ann.rings[dragTarget.ringIdx][dragTarget.vertIdx] = imgPt;
      annotations.recomputeMetrics(dragTarget.ann);
      redraw();
      return;
    }
    if (tool === 'ruler') {
      const r = annotations.getRuler();
      if (r && !r.end) { annotations.rulerUpdate(imgPt); redraw(); }
    }
  }

  function onMouseUp() {
    const sample = getActiveSample();
    if (tool === 'freehand' && freehandPoints) {
      if (brushMode === 'noodle') {
        if (freehandPoints.length >= 2) {
          const smoothed = _smoothOpenPath(freehandPoints, brushSmoothing, Math.max(1, Math.round(brushSmoothing * 8)));
          const contours = _extractNoodleContours(smoothed, brushRadius);
          for (const rings of contours) {
            const ann = annotations.makeAnnotation({ sample, rings: [_maybeSimplify(rings)], cls: freehandCls });
            annotations.addAnnotation(sample, 'library', ann);
          }
        }
      } else if (freehandPoints.length >= 8) {
        const ann = annotations.makeAnnotation({ sample, rings: [_maybeSimplify(_closeRing(freehandPoints))], cls: freehandCls });
        annotations.addAnnotation(sample, 'library', ann);
      }
      freehandPoints = null;
      redraw();
      return;
    }
    if (tool === 'vertex_edit' && dragTarget) {
      const { ann, ringIdx, vertIdx } = dragTarget;
      const newPt = ann.rings[ringIdx][vertIdx];
      annotations.moveVertex(sample, 'library', ann.id, ringIdx, vertIdx, newPt);
      dragTarget = null;
      redraw();
    }
  }

  // ── noodle (disk) brush: swept-disk rasterize + marching squares, mirrors
  // draw.js's noodle-mode contour extraction so "draw"/"draw+"/"draw-" behave
  // identically whether they create a stroke (draw.js) or a library
  // annotation (this module). ──────────────────────────────────────────────
  function _smoothOpenPath(points, amount, passes) {
    if (!points || points.length < 3 || amount <= 0) return points;
    let out = points.slice();
    for (let pass = 0; pass < (passes || 1); pass++) {
      const next = out.slice();
      for (let i = 1; i < out.length - 1; i++) {
        const avgX = (out[i - 1].x + out[i].x + out[i + 1].x) / 3;
        const avgY = (out[i - 1].y + out[i].y + out[i + 1].y) / 3;
        next[i] = { x: out[i].x * (1 - amount) + avgX * amount, y: out[i].y * (1 - amount) + avgY * amount };
      }
      out = next;
    }
    return out;
  }
  function _marchingSquares(mask, W, H) {
    const TABLE = [
      [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]],
      [[2, 3]], [[2, 0]], [[0, 1], [2, 3]], [[2, 1]], [[1, 3]], [[1, 0]], [[0, 3]], [],
    ];
    function ep(ci, cj, e) {
      if (e === 0) return { x: ci * 2 + 1, y: cj * 2 };
      if (e === 1) return { x: (ci + 1) * 2, y: cj * 2 + 1 };
      if (e === 2) return { x: ci * 2 + 1, y: (cj + 1) * 2 };
      return { x: ci * 2, y: cj * 2 + 1 };
    }
    const ekey = p => p.x + ',' + p.y;
    const nextPt = Object.create(null);
    for (let cj = 0; cj < H - 1; cj++) {
      for (let ci = 0; ci < W - 1; ci++) {
        const tl = mask[cj * W + ci], tr = mask[cj * W + ci + 1];
        const br = mask[(cj + 1) * W + ci + 1], bl = mask[(cj + 1) * W + ci];
        const idx = tl | (tr << 1) | (br << 2) | (bl << 3);
        for (const [e1, e2] of TABLE[idx]) nextPt[ekey(ep(ci, cj, e1))] = ep(ci, cj, e2);
      }
    }
    const visited = new Set();
    const polygons = [];
    for (const startKey of Object.keys(nextPt)) {
      if (visited.has(startKey)) continue;
      const poly = []; let cur = startKey; let safety = 0;
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
  function _extractNoodleContours(centerPts, radius) {
    const N = centerPts.length;
    if (N < 1) return [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of centerPts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const pad = radius + 2;
    minX = Math.floor(minX - pad); minY = Math.floor(minY - pad);
    maxX = Math.ceil(maxX + pad); maxY = Math.ceil(maxY + pad);
    const boxW = maxX - minX, boxH = maxY - minY;
    if (boxW <= 0 || boxH <= 0) return [];
    const MAX_DIM = 1024;
    const workScale = Math.min(1.0, MAX_DIM / Math.max(boxW, boxH));
    const cW = Math.max(3, Math.ceil(boxW * workScale) + 2);
    const cH = Math.max(3, Math.ceil(boxH * workScale) + 2);
    const oc = document.createElement('canvas');
    oc.width = cW; oc.height = cH;
    const oc2d = oc.getContext('2d');
    oc2d.fillStyle = '#000';
    oc2d.fillRect(0, 0, cW, cH);
    oc2d.strokeStyle = '#fff';
    oc2d.lineWidth = radius * 2 * workScale;
    oc2d.lineCap = 'round';
    oc2d.lineJoin = 'round';
    oc2d.beginPath();
    oc2d.moveTo((centerPts[0].x - minX) * workScale + 1, (centerPts[0].y - minY) * workScale + 1);
    for (let i = 1; i < N; i++) oc2d.lineTo((centerPts[i].x - minX) * workScale + 1, (centerPts[i].y - minY) * workScale + 1);
    oc2d.stroke();
    const data = oc2d.getImageData(0, 0, cW, cH).data;
    const mask = new Uint8Array(cW * cH);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4] > 127 ? 1 : 0;
    const polyList = _marchingSquares(mask, cW, cH);
    const { width: imgW, height: imgH } = viewport.getImageSize();
    const result = [];
    for (const poly of polyList) {
      if (poly.length < 6) continue;
      result.push(poly.map(p => ({
        x: Math.max(0, Math.min(imgW - 1, (p.x - 1) / workScale + minX)),
        y: Math.max(0, Math.min(imgH - 1, (p.y - 1) / workScale + minY)),
      })));
    }
    return result;
  }

  function _closeRing(points) {
    const out = points.slice();
    const first = out[0], last = out[out.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) > 1e-6) out.push({ x: first.x, y: first.y });
    return out;
  }

  // Reduce vertex count of a freshly-drawn ring, if enabled in settings.
  // Tolerance is specified in screen px so it reads the same to the user at
  // any zoom level; converted to image-space px (the unit simplifyRing and
  // ann.rings use) via the viewport scale active right now (i.e. when the
  // contour is finished), which is when a given ring's vertex density in
  // image-space was determined.
  function _maybeSimplify(ring) {
    if (!settings || settings.get('contourSimplify') === false) return ring;
    if (!ring || ring.length < 8) return ring;
    const screenTolPx = settings.get('contourSimplifyPx');
    if (!screenTolPx) return ring;
    const { scale } = viewport.getTransform();
    const tolerancePx = screenTolPx / (scale || 1);
    return annotations.simplifyRing(ring, tolerancePx);
  }

  function finishPolygon() {
    if (polyPoints.length < 3) { polyPoints = []; redraw(); return; }
    const sample = getActiveSample();
    const ann = annotations.makeAnnotation({ sample, rings: [_maybeSimplify(_closeRing(polyPoints))] });
    annotations.addAnnotation(sample, 'library', ann);
    polyPoints = [];
    redraw();
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && tool === 'polygon') { finishPolygon(); }
    else if (e.key === 'Escape') {
      if (tool === 'polygon') { polyPoints = []; redraw(); }
      else if (tool === 'ruler') { annotations.rulerClear(); redraw(); }
    }
  }

  function setTool(name) {
    tool = name || 'none';
    polyPoints = [];
    freehandPoints = null;
    dragTarget = null;
    cursorVisible = false;
    redraw();
  }
  function onMouseLeave() {
    cursorVisible = false;
    redraw();
  }
  function setSelected(id) { selectedId = id; redraw(); }
  function hasSelection() { return selectedId != null; }
  function clearSelection() { selectedId = null; redraw(); }
  function deleteSelected() {
    if (selectedId == null) return;
    const sample = getActiveSample();
    if (sample) annotations.deleteAnnotation(sample, 'library', selectedId);
    selectedId = null;
    redraw();
  }
  function setVisibility(id, visible) {
    if (visible) hiddenIds.delete(id); else hiddenIds.add(id);
    redraw();
  }
  function setClassVisibility(cls, visible) {
    if (visible) hiddenClasses.delete(cls); else hiddenClasses.add(cls);
    redraw();
  }
  function setClassOpacity(cls, alpha) { opacityByClass[cls] = alpha; redraw(); }
  function setClassColor(cls, color) { annotations.setClassColor(getActiveSample(), cls, color); redraw(); }
  function getClassColor(cls) { return annotations.getClassColor(cls); }
  function setFreehandMode(cls) { freehandCls = cls || 'unclassified'; }
  function getFreehandMode() { return freehandCls; }
  function setBrushMode(m) { brushMode = (m === 'noodle') ? 'noodle' : 'line'; }
  function getBrushMode() { return brushMode; }
  function setSmoothing(v) { brushSmoothing = Math.max(0, Math.min(1, Number(v) || 0)); }
  function getSmoothing() { return brushSmoothing; }
  function getBrushRadius() { return brushRadius; }
  function panZoomTo(ann) {
    if (!ann || !ann.rings.length || !ann.rings[0].length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ann.rings[0]) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.25 || 50;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const cw = container.clientWidth, ch = container.clientHeight;
    const scale = Math.max(0.01, Math.min(2.0, Math.min(cw / (maxX - minX), ch / (maxY - minY))));
    const ox = cw / 2 - ((minX + maxX) / 2) * scale;
    const oy = ch / 2 - ((minY + maxY) / 2) * scale;
    viewport.setTransform(scale, ox, oy);
  }

  return {
    setTool, onMouseDown, onMouseMove, onMouseUp, onKeyDown, onMouseLeave,
    setSelected, hasSelection, clearSelection, deleteSelected,
    setVisibility, setClassVisibility, setClassOpacity,
    setClassColor, getClassColor,
    setFreehandMode, getFreehandMode,
    setBrushMode, getBrushMode,
    setSmoothing, getSmoothing,
    panZoomTo, redraw, hitTest,
    finishPolygon,
    setBrushRadius: v => { brushRadius = v; redraw(); },
    getBrushRadius,
  };
}
