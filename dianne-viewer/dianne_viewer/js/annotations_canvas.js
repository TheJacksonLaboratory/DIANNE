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
 *   .setTool(name)              → 'none'|'polygon'|'freehand'|'vertex_edit'|'ruler'|'split'|'erase'|'grow'|'wand'|'lasso'
 *   .onMouseDown/onMouseMove/onMouseUp/onKeyDown(e)
 *   .setPixelSource(src)        → wires the wand tool to a { getRegion(sx,sy,sw,sh) → ImageData|null }
 *                                  pixel provider for the active render mode (see boot.js)
 *   .setSelected(id)            → highlight + used by bidirectional list sync
 *   .panZoomTo(ann)             → center viewport on an annotation
 *   .redraw()
 *   .setVisibility(id, visible) / .isVisible(id) / setClassVisibility(cls, visible)
 *
 * `settings` (optional) supplies the 'contourSimplify' / 'contourSimplifyPx'
 * viewer settings (see settings.js): newly finished polygon/freehand/noodle
 * rings are run through annotations.simplifyRing() with a tolerance derived
 * from the *screen*-px setting divided by the current viewport scale, so the
 * same on-screen fidelity is kept regardless of the zoom level the contour
 * was drawn at.
 */
function createAnnotationsCanvas({ container, viewport, annotations, getActiveSample, settings, log, onSelect, onLassoSelect }) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:3;';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let tool = 'none';               // 'none' | 'polygon' | 'freehand' | 'vertex_edit' | 'ruler' | 'split' | 'erase' | 'grow' | 'wand' | 'lasso'
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
  // drag tool state: translate/rotate every sibling of the selected
  // annotation's group_id together as one rigid shape. Both are applied live
  // to ann.rings on every mousemove, recomputed from a frozen pre-drag
  // snapshot each time (not incrementally) so repeated float rounding can't
  // drift the shape, and only committed to the undo stack (via
  // annotations.transformAnnotationGroup) on mouseup.
  let dragMoveState = null;   // { groupId, siblings, oldRingsById, startPt, moved }
  let dragRotateState = null; // { groupId, siblings, oldRingsById, center, startAngle, angle, moved }
  const ROTATE_HANDLE_RADIUS_SCREEN_PX = 110; // fixed on-screen radius of the rotate-handle circle (constant at any zoom)
  const ROTATE_RING_HIT_TOLERANCE_VP = 12;   // grab band around the circle's circumference, in screen px
  // split tool state: freehand open trace, applied on mouseup against the
  // selected annotation (annotations.splitAnnotation)
  let splitPoints = null;
  const SPLIT_LINE_WIDTH_SCREEN_PX = 3; // constant on-screen thickness for the cut, converted to image px at apply time
  // eraser/grow tool state: freehand swept-disk path, applied on mouseup
  // against the selected annotation (annotations.sculptAnnotation)
  let sculptPoints = null;
  let sculptRadius = 150; // image px; independent of the freehand-draw brushRadius above

  // lasso (multi-)select tool state: freehand closed area, drawn mousedown→
  // mouseup, checkmarking every library annotation it touches. Unlike the
  // other freehand tools it doesn't consume itself on mouseup — `lassoRing`
  // and `lassoSelectedIds` persist (and keep rendering) across further
  // mousemoves/redraws until the user starts a new stroke, switches tool, or
  // presses Escape (see setTool/onKeyDown), per the tool's job of leaving a
  // visible "what did I select" area on screen.
  let lassoPoints = null;          // in-progress stroke, image space
  let lassoRing = null;            // finalized closed ring, image space (kept until tool switch/Esc)
  let lassoSelectedIds = new Set(); // ids touched by lassoRing, for the highlight-only overlay

  // ── wand tool state ────────────────────────────────────────────────────────
  // Two interaction modes, chosen at mousedown by the Alt/Option modifier:
  //   'brush' (plain click-drag)  — Quick-Select-style: grows the region along
  //     the dragged path, snapping to similar-colored pixels beyond the brush
  //     footprint. The reference color is sampled once, from the footprint's
  //     first frame, and frozen for the rest of the session (wandAdaptiveRef)
  //     — recomputing it from the whole path on every frame let it drift as
  //     more/different-colored area got painted, which could un-match pixels
  //     that had matched a moment before and made the grown region visibly
  //     shrink ("erase"). Releasing the mouse just pauses the stroke —
  //     pressing mousedown again keeps adding to the *same* growing region
  //     (like a paint tool: QuPath / Photoshop Quick Selection), instead of
  //     each drag becoming its own disconnected shape. Enter commits the
  //     accumulated region as one annotation; Escape cancels the whole
  //     in-progress shape.
  //   'seed'  (Alt+click)         — classic magic-wand: one click seeds a
  //     fixed reference color, then just moving the mouse (no drag) live-
  //     previews a flood fill whose tolerance ramps up with the *farthest*
  //     distance the cursor has reached from the seed this session
  //     (wandSeedMaxDist) rather than the current instantaneous distance —
  //     otherwise moving back toward the seed (e.g. out of habit, to click
  //     and confirm) silently re-shrank an already-grown preview right before
  //     it got accepted. Accepted by a second click or Enter, cancelled by
  //     Escape (which is also the only way to shrink it back down).
  // `pixelSource` is supplied by boot.js (setPixelSource) and differs by
  // active render mode (plain RGB tiles / multichannel / monochannel2D) — see
  // its call sites below for the { getRegion(sx,sy,sw,sh) → ImageData|null }
  // contract.
  let pixelSource = null;
  let wandRadius = 60;        // image px; brush-mode footprint radius
  let wandTolerance = 24;     // 0-100; brush-mode threshold, seed-mode ramp ceiling
  let wandMode = null;        // null | 'brush' | 'seed'
  let wandPathPoints = null;  // image-space points collected across the whole brush-mode session (all strokes, until commit/cancel)
  let wandDragging = false;   // true while the mouse button is held during a brush-mode stroke
  let wandAdaptiveRef = null; // { rgb, od } — brush-mode reference, frozen from the first frame of the session
  let wandSeedPoint = null;   // image-space seed point (seed mode)
  let wandSeedColor = null;   // { rgb: [r,g,b], od: [odR,odG,odB] } reference sample (seed mode only)
  let wandSeedMaxDist = 0;    // farthest image-px distance the cursor has reached from wandSeedPoint this session (ratchet, never decreases until reset)
  let wandPreviewRings = null; // current live-preview rings, image space (unsimplified)
  let wandFrozenScale = null; // raster workScale frozen at the first grow of the current session — see _wandGrow
  let _wandRecomputePending = false;
  const WAND_MAX_RASTER_DIM = 640;     // initial cap on the BFS working raster, for perf (session then freezes at whatever this yields — see wandFrozenScale)
  const WAND_HARD_MAX_CELLS = 4000000; // absolute ceiling on raster cell count regardless of the frozen scale, so a very long drag can't blow up memory/perf
  const WAND_SEED_MAX_REACH_PX = 450;  // hard safety cap on seed-mode growth radius (image px)
  const WAND_SEED_RAMP_PX = 300;       // image px of cursor travel to reach full tolerance in seed mode
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

    // library annotations. A grouped annotation (several sibling pieces
    // sharing group_id, e.g. disjoint noodle-brush contours from one
    // imported stroke) is one logical shape, so selecting any one piece
    // highlights every sibling.
    const libAnns = annotations.listAnnotations(sample, 'library');
    const selectedAnn = selectedId != null ? libAnns.find(a => a.id === selectedId) : null;
    const selectedGroupId = selectedAnn ? selectedAnn.group_id : null;
    for (const ann of libAnns) {
      if (!_classVisible(ann)) continue;
      const highlighted = (selectedGroupId != null && ann.group_id === selectedGroupId) || lassoSelectedIds.has(ann.id);
      _drawAnnotation(ann, highlighted);
    }

    // drag tool: rotate handle — a full circle around the selected group's
    // centroid (grab anywhere on it to rotate) plus its X/Y axis vectors,
    // drawn at the current in-progress rotation angle (0 when not actively
    // rotating, since geometry itself — not a stored angle — is the only
    // persisted state). Only shown while the drag tool is active and
    // something's selected.
    if (tool === 'drag' && selectedAnn) {
      const siblings = annotations.listGroupSiblings(sample, 'library', selectedAnn.group_id);
      const center = _groupCentroid(siblings);
      const cVp = _toVp(center);
      const angle = dragRotateState ? dragRotateState.angle : 0;
      const r = ROTATE_HANDLE_RADIUS_SCREEN_PX;
      ctx.save();
      ctx.strokeStyle = dragRotateState ? '#7fd0ff' : '#2596ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cVp.x, cVp.y, r, 0, Math.PI * 2);
      ctx.stroke();
      // X axis (red) and Y axis (green), rotated by the live angle
      ctx.strokeStyle = '#ff5555';
      ctx.beginPath();
      ctx.moveTo(cVp.x, cVp.y);
      ctx.lineTo(cVp.x + r * Math.cos(angle), cVp.y + r * Math.sin(angle));
      ctx.stroke();
      ctx.fillStyle = '#ff5555';
      ctx.font = 'bold 22px monospace';
      ctx.fillText('X', cVp.x + (r + 16) * Math.cos(angle) - 8, cVp.y + (r + 16) * Math.sin(angle) + 8);
      ctx.strokeStyle = '#55ff55';
      ctx.beginPath();
      ctx.moveTo(cVp.x, cVp.y);
      ctx.lineTo(cVp.x + r * Math.cos(angle - Math.PI / 2), cVp.y + r * Math.sin(angle - Math.PI / 2));
      ctx.stroke();
      ctx.fillStyle = '#55ff55';
      ctx.fillText('Y', cVp.x + (r + 16) * Math.cos(angle - Math.PI / 2) - 8, cVp.y + (r + 16) * Math.sin(angle - Math.PI / 2) + 8);
      // center dot
      ctx.beginPath();
      ctx.arc(cVp.x, cVp.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#2596ff';
      ctx.fill();
      ctx.restore();
      // current rotation, shown in degrees next to the mouse pointer while dragging
      if (dragRotateState) {
        const deg = Math.round(angle * 180 / Math.PI);
        ctx.save();
        ctx.font = 'bold 28px monospace';
        ctx.fillStyle = '#2596ff';
        ctx.fillText(deg + '°', cursorVpX + 14, cursorVpY - 10);
        ctx.restore();
      }
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

    // in-progress split trace: a thin freehand line/dashed preview across
    // the selected annotation (not filled — it's a cut, not a new shape)
    if (tool === 'split' && splitPoints && splitPoints.length) {
      ctx.save();
      ctx.strokeStyle = '#ff3b3b';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const p0 = _toVp(splitPoints[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < splitPoints.length; i++) { const p = _toVp(splitPoints[i]); ctx.lineTo(p.x, p.y); }
      ctx.stroke();
      ctx.restore();
    }

    // in-progress lasso stroke (open path, while dragging)
    if (tool === 'lasso' && lassoPoints && lassoPoints.length) {
      ctx.save();
      ctx.strokeStyle = '#00d2ff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const p0 = _toVp(lassoPoints[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < lassoPoints.length; i++) { const p = _toVp(lassoPoints[i]); ctx.lineTo(p.x, p.y); }
      ctx.stroke();
      ctx.restore();
    }
    // finalized lasso area (closed, filled lightly) — persists on screen
    // after mouseup until the next stroke, a tool switch, or Escape clears it
    if (lassoRing && lassoRing.length) {
      ctx.save();
      ctx.strokeStyle = '#00d2ff';
      ctx.fillStyle = 'rgba(0,210,255,0.10)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const p0 = _toVp(lassoRing[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < lassoRing.length; i++) { const p = _toVp(lassoRing[i]); ctx.lineTo(p.x, p.y); }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // in-progress eraser/grow swept-disk preview (same visual language as
    // the noodle brush, tinted red for erase / green for grow)
    if ((tool === 'erase' || tool === 'grow') && sculptPoints && sculptPoints.length) {
      ctx.save();
      const { scale } = viewport.getTransform();
      ctx.strokeStyle = tool === 'erase' ? '#ff3b3b' : '#3fff49';
      ctx.lineWidth = sculptRadius * 2 * scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      const p0 = _toVp(sculptPoints[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < sculptPoints.length; i++) { const p = _toVp(sculptPoints[i]); ctx.lineTo(p.x, p.y); }
      ctx.stroke();
      ctx.restore();
    }

    // in-progress wand region: filled/outlined preview of the currently
    // grown mask (brush-mode: as dragged so far; seed-mode: at the current
    // cursor-distance tolerance), same fill/stroke language as a finished
    // annotation but tinted amber so it reads as "not yet committed".
    if (tool === 'wand' && wandPreviewRings && wandPreviewRings.length) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,196,0,0.22)';
      ctx.strokeStyle = '#ffc400';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const ring of wandPreviewRings) {
        if (!ring.length) continue;
        const p0 = _toVp(ring[0]);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < ring.length; i++) { const p = _toVp(ring[i]); ctx.lineTo(p.x, p.y); }
        ctx.closePath();
      }
      ctx.fill('evenodd');
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
    if (tool === 'freehand') _renderCursor(brushMode === 'noodle', brushRadius, '#00ff40');
    // eraser/grow disk cursor preview (always disk footprint)
    if (tool === 'erase' || tool === 'grow') _renderCursor(true, sculptRadius, tool === 'erase' ? '#ff3b3b' : '#3fff49');
    // wand disk cursor preview: brush footprint in brush mode, a small fixed
    // marker at the seed point's scale in seed mode (footprint there is a
    // sampling nicety, not the actual grown extent)
    if (tool === 'wand') _renderCursor(true, wandMode === 'seed' ? 8 : wandRadius, '#ffc400');
  }

  function _renderCursor(isDisk, radius, color) {
    if (!cursorVisible) return;
    ctx.save();
    ctx.strokeStyle = color || '#00ff40';
    ctx.globalAlpha = 1.0;
    if (isDisk) {
      const { scale } = viewport.getTransform();
      const screenRadius = radius * scale;
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
    // Always fill with evenodd (not just when selected) so hole rings
    // (ring index > 0) visibly cut out — otherwise a hole is indistinguishable
    // from an ordinary nested outline until the shape is selected.
    ctx.fillStyle = isSelected ? 'rgba(255,210,63,0.15)' : _hexToRgba(baseColor, 0.18);
    ctx.fill('evenodd');
    ctx.stroke();
    if (isSelected && tool === 'vertex_edit') {
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
    ctx.restore();
  }
  function _hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return 'rgba(83,217,255,' + alpha + ')';
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
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
  // ── lasso "touch" test: do two closed rings overlap at all? ────────────────
  // Checked against an annotation's outer ring only (rings[0]) — a lasso
  // landing purely inside a hole, without touching the annotation's actual
  // painted area anywhere else, is treated as a rare edge case not worth the
  // extra even-odd bookkeeping here.
  function _ringBBox(ring) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }
  function _bboxOverlap(a, b) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY; }
  function _ccw(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
  function _segIntersect(p1, p2, p3, p4) {
    const d1 = _ccw(p3, p4, p1), d2 = _ccw(p3, p4, p2);
    const d3 = _ccw(p1, p2, p3), d4 = _ccw(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function _ringsTouch(ringA, ringB) {
    if (!ringA.length || !ringB.length) return false;
    if (!_bboxOverlap(_ringBBox(ringA), _ringBBox(ringB))) return false;
    // Cheap containment check first (covers full overlap and the vast
    // majority of partial overlaps); only fall back to the O(n*m) edge scan
    // for the rarer case of two boundaries crossing without either ring
    // having a vertex inside the other (e.g. a thin sliver of the lasso
    // clipping through an edge of a much larger annotation).
    for (const p of ringA) if (_pointInRing(p, ringB)) return true;
    for (const p of ringB) if (_pointInRing(p, ringA)) return true;
    for (let i = 0; i < ringA.length; i++) {
      const a1 = ringA[i], a2 = ringA[(i + 1) % ringA.length];
      for (let j = 0; j < ringB.length; j++) {
        if (_segIntersect(a1, a2, ringB[j], ringB[(j + 1) % ringB.length])) return true;
      }
    }
    return false;
  }
  function _lassoTouchedIds(ring) {
    const sample = getActiveSample();
    if (!sample) return [];
    const touched = [];
    for (const ann of annotations.listAnnotations(sample, 'library')) {
      if (!_classVisible(ann) || !ann.rings.length || !ann.rings[0].length) continue;
      if (_ringsTouch(ring, ann.rings[0])) touched.push(ann.id);
    }
    return touched;
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

  // ── drag tool: whole-group bbox/centroid (rotate-handle circle's pivot) ──
  function _cloneRingsList(rings) { return rings.map(r => r.map(p => ({ x: p.x, y: p.y }))); }
  function _snapshotGroupRings(siblings) {
    const out = {};
    for (const ann of siblings) out[ann.id] = _cloneRingsList(ann.rings);
    return out;
  }
  function _groupBBox(siblings) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ann of siblings) {
      for (const ring of ann.rings) {
        for (const p of ring) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
      }
    }
    return { minX, minY, maxX, maxY };
  }
  function _groupCentroid(siblings) {
    const bb = _groupBBox(siblings);
    return { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  }

  // ── mouse handlers (invoked by toolbar routing, mirroring draw.js's API) ─
  function onMouseDown(vpX, vpY, altKey) {
    const imgPt = viewport.toImageSpace(vpX, vpY);
    const sample = getActiveSample();
    if (!sample) return;

    if (tool === 'wand') {
      if (wandMode === 'seed') {
        // second click accepts whatever's currently previewed
        _wandFinalize();
        return;
      }
      const rgb = _wandSampleColorAt(imgPt);
      if (!rgb) {
        if (typeof log === 'function') log('Wand: no image data at that point yet — wait for tiles to load or zoom out.');
        return;
      }
      if (altKey) {
        wandMode = 'seed';
        wandSeedPoint = imgPt;
        wandSeedColor = { rgb, od: _od(rgb) };
        wandPreviewRings = null;
        wandSeedMaxDist = 0;
        wandFrozenScale = null; // starting a fresh session — don't reuse a scale frozen for a different (brush) bbox
        wandAdaptiveRef = null;
      } else {
        if (wandMode !== 'brush') {
          // Start a new brush session. If one is already in progress (this
          // is a second/third/... stroke), keep the accumulated path so the
          // new stroke's growth merges into the same region instead of
          // starting a disconnected shape.
          wandMode = 'brush';
          wandPathPoints = [];
          wandFrozenScale = null;
          wandAdaptiveRef = null;
        }
        wandDragging = true;
        wandPathPoints.push(imgPt);
        _wandRecomputeFromGrow(wandPathPoints, wandRadius, wandRadius * 1.5, wandTolerance / 100, true);
      }
      cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
      redraw();
      return;
    }
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
      if (near) {
        // Reviewed (locked) annotations need a confirm dialog before the
        // drag is allowed to start (see requestUnlockForEdit in
        // annotations.js); an unlocked annotation starts dragging right
        // away. Fire-and-forget is fine here — if the user hasn't moved the
        // mouse by the time the dialog resolves, the drag just starts from
        // the vertex's current position on the next mousemove.
        if (annotations.isLocked(near.ann)) {
          annotations.requestUnlockForEdit(sample, 'library', near.ann.id).then(ok => { if (ok) dragTarget = near; });
        } else {
          dragTarget = near;
        }
        return;
      }
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
    if (tool === 'lasso') {
      // A fresh stroke supersedes whatever was previously drawn/selected —
      // the old outline+highlight disappear immediately rather than lingering
      // underneath the new in-progress path.
      lassoRing = null;
      lassoSelectedIds = new Set();
      lassoPoints = [imgPt];
      redraw();
      return;
    }
    if (tool === 'drag') {
      const selAnn = selectedId != null ? annotations.findAnnotation(sample, 'library', selectedId) : null;
      if (selAnn) {
        const siblings = annotations.listGroupSiblings(sample, 'library', selAnn.group_id);
        const center = _groupCentroid(siblings);
        const cVp = _toVp(center);
        const distFromCenter = Math.hypot(cVp.x - vpX, cVp.y - vpY);
        // Grab anywhere on the circle's circumference (a band around its
        // radius), not just a single point on it.
        if (Math.abs(distFromCenter - ROTATE_HANDLE_RADIUS_SCREEN_PX) <= ROTATE_RING_HIT_TOLERANCE_VP) {
          const startRotate = () => {
            dragRotateState = {
              groupId: selAnn.group_id, siblings,
              oldRingsById: _snapshotGroupRings(siblings),
              center, startAngle: Math.atan2(imgPt.y - center.y, imgPt.x - center.x),
              angle: 0, moved: false,
            };
          };
          if (annotations.isLocked(selAnn)) {
            annotations.requestUnlockForEdit(sample, 'library', selAnn.id).then(ok => { if (ok) startRotate(); });
          } else startRotate();
          return;
        }
      }
      const hit = hitTest(imgPt);
      if (hit && selAnn && hit.group_id === selAnn.group_id) {
        // Click landed on the already-selected shape's body → start
        // translating it; a click on a *different* shape (or empty space,
        // handled by the fallthrough below) only (re)selects, mirroring
        // vertex_edit/split's "select first, next click acts" convention.
        const siblings = annotations.listGroupSiblings(sample, 'library', selAnn.group_id);
        const startDrag = () => {
          dragMoveState = { groupId: selAnn.group_id, siblings, oldRingsById: _snapshotGroupRings(siblings), startPt: imgPt, moved: false };
        };
        if (annotations.isLocked(hit)) {
          annotations.requestUnlockForEdit(sample, 'library', hit.id).then(ok => { if (ok) startDrag(); });
        } else startDrag();
        return;
      }
      setSelected(hit ? hit.id : null);
      return;
    }
    if (tool === 'merge') {
      const hit = hitTest(imgPt);
      const target = selectedId != null ? annotations.findAnnotation(sample, 'library', selectedId) : null;
      if (target && hit && hit.group_id !== target.group_id) {
        const overlaps = target.rings[0] && hit.rings[0] && _ringsTouch(target.rings[0], hit.rings[0]);
        if (overlaps) {
          const doMerge = () => {
            const result = annotations.mergeAnnotations(sample, 'library', target.id, hit.id);
            setSelected(result && result.ok ? result.targetId : target.id);
          };
          if (annotations.isLocked(target) || annotations.isLocked(hit)) {
            Promise.all([
              annotations.requestUnlockForEdit(sample, 'library', target.id),
              annotations.requestUnlockForEdit(sample, 'library', hit.id),
            ]).then(([ok1, ok2]) => { if (ok1 && ok2) doMerge(); });
          } else {
            doMerge();
          }
          return;
        }
        if (typeof log === 'function') {
          log(`"${hit.label || hit.class}" doesn't overlap "${target.label || target.class}" — pick an overlapping annotation to merge, or select a new anchor.`);
        }
      }
      // No target yet, hit a different non-overlapping shape, or clicked
      // empty space → (re)select, same click-through as the 'none' tool.
      setSelected(hit ? hit.id : null);
      return;
    }
    if (tool === 'split' || tool === 'erase' || tool === 'grow') {
      if (selectedId == null) {
        // Mirror vertex_edit's convention: a click with nothing selected
        // just selects the annotation under the cursor (if any); the user's
        // *next* mousedown is what actually starts the split/erase/grow
        // stroke, so a plain click never silently begins editing.
        const hit = hitTest(imgPt);
        if (hit) setSelected(hit.id);
        else if (typeof log === 'function') log('Select an annotation first to ' + (tool === 'split' ? 'split' : tool) + ' it.');
        return;
      }
      const ann = annotations.findAnnotation(sample, 'library', selectedId);
      if (!ann) return;
      const startTracking = () => {
        cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
        if (tool === 'split') splitPoints = [imgPt];
        else sculptPoints = [imgPt];
      };
      if (annotations.isLocked(ann)) {
        annotations.requestUnlockForEdit(sample, 'library', ann.id).then(ok => { if (ok) startTracking(); });
      } else {
        startTracking();
      }
      return;
    }
    // 'none' → selection click-through
    const hit = hitTest(imgPt);
    setSelected(hit ? hit.id : null);
  }

  function onMouseMove(vpX, vpY) {
    const imgPt = viewport.toImageSpace(vpX, vpY);
    if (tool === 'wand') {
      cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
      if (wandMode === 'brush' && wandDragging && wandPathPoints) wandPathPoints.push(imgPt);
      if ((wandMode === 'brush' && wandDragging) || wandMode === 'seed') { _wandScheduleRecompute(); return; }
      redraw();
      return;
    }
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
    if (tool === 'drag' && dragRotateState) {
      const { center, startAngle, siblings, oldRingsById } = dragRotateState;
      const angle = Math.atan2(imgPt.y - center.y, imgPt.x - center.x) - startAngle;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      for (const ann of siblings) {
        ann.rings = oldRingsById[ann.id].map(ring => ring.map(p => {
          const dx = p.x - center.x, dy = p.y - center.y;
          return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
        }));
        annotations.recomputeMetrics(ann);
      }
      dragRotateState.angle = angle;
      dragRotateState.moved = true;
      cursorVpX = vpX; cursorVpY = vpY;
      redraw();
      return;
    }
    if (tool === 'drag' && dragMoveState) {
      const dx = imgPt.x - dragMoveState.startPt.x, dy = imgPt.y - dragMoveState.startPt.y;
      for (const ann of dragMoveState.siblings) {
        ann.rings = dragMoveState.oldRingsById[ann.id].map(ring => ring.map(p => ({ x: p.x + dx, y: p.y + dy })));
        annotations.recomputeMetrics(ann);
      }
      dragMoveState.moved = true;
      redraw();
      return;
    }
    if (tool === 'ruler') {
      const r = annotations.getRuler();
      if (r && !r.end) { annotations.rulerUpdate(imgPt); redraw(); }
      return;
    }
    if (tool === 'lasso') {
      if (lassoPoints) { lassoPoints.push(imgPt); redraw(); }
      return;
    }
    if (tool === 'split') {
      cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
      if (splitPoints) { splitPoints.push(imgPt); redraw(); return; }
      redraw();
      return;
    }
    if (tool === 'erase' || tool === 'grow') {
      cursorVpX = vpX; cursorVpY = vpY; cursorVisible = true;
      if (sculptPoints) { sculptPoints.push(imgPt); redraw(); return; }
      redraw();
      return;
    }
  }

  function onMouseUp() {
    const sample = getActiveSample();
    if (tool === 'wand' && wandMode === 'brush') {
      // Pause, don't commit: releasing the mouse just ends this stroke so
      // the accumulated region keeps filling in across further strokes.
      // Enter commits it as one annotation; Escape cancels it.
      wandDragging = false;
      redraw();
      return;
    }
    if (tool === 'freehand' && freehandPoints) {
      if (brushMode === 'noodle') {
        if (freehandPoints.length >= 2) {
          const smoothed = _smoothOpenPath(freehandPoints, brushSmoothing, Math.max(1, Math.round(brushSmoothing * 8)));
          const contours = _extractNoodleContours(smoothed, brushRadius);
          // A single noodle stroke can trace several closed contour pieces
          // (marching squares) that may be genuinely nested (holes) or
          // merely disjoint blobs. Assemble them properly instead of always
          // treating every extra contour as a flat sibling: nested rings
          // become one outer+holes annotation, disjoint rings become
          // separate sibling annotations sharing one group_id.
          const rings = contours.map(_maybeSimplify);
          const anns = annotations.buildAnnotationsFromRings(sample, rings, { cls: freehandCls });
          if (anns.length) annotations.addAnnotationGroup(sample, 'library', anns);
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
      return;
    }
    if (tool === 'drag' && (dragRotateState || dragMoveState)) {
      const st = dragRotateState || dragMoveState;
      if (st.moved) {
        const newRingsById = {};
        for (const ann of st.siblings) newRingsById[ann.id] = ann.rings;
        annotations.transformAnnotationGroup(sample, 'library', st.groupId, st.oldRingsById, newRingsById);
      }
      dragRotateState = null;
      dragMoveState = null;
      redraw();
      return;
    }
    if (tool === 'lasso' && lassoPoints) {
      if (lassoPoints.length >= 3) {
        const ring = _maybeSimplify(_closeRing(lassoPoints));
        lassoRing = ring;
        lassoSelectedIds = new Set(_lassoTouchedIds(ring));
      } else {
        // A too-short drag (effectively a click) clears any prior area,
        // mirroring a plain click-to-deselect elsewhere in this file.
        lassoRing = null;
        lassoSelectedIds = new Set();
      }
      lassoPoints = null;
      _notifyLassoSelect(Array.from(lassoSelectedIds));
      redraw();
      return;
    }
    if (tool === 'split' && splitPoints) {
      if (splitPoints.length >= 2 && selectedId != null) {
        const smoothed = _smoothOpenPath(splitPoints, brushSmoothing, Math.max(1, Math.round(brushSmoothing * 8)));
        const { scale } = viewport.getTransform();
        const lineWidthPx = SPLIT_LINE_WIDTH_SCREEN_PX / (scale || 1);
        const result = annotations.splitAnnotation(sample, 'library', selectedId, smoothed, lineWidthPx);
        if (result && result.ok) {
          setSelected(result.newIds[0]);
        } else if (typeof log === 'function') {
          log('Split line must completely cross the annotation to split it.');
        }
      }
      splitPoints = null;
      redraw();
      return;
    }
    if ((tool === 'erase' || tool === 'grow') && sculptPoints) {
      if (selectedId != null) {
        const smoothed = sculptPoints.length >= 3
          ? _smoothOpenPath(sculptPoints, brushSmoothing, Math.max(1, Math.round(brushSmoothing * 8)))
          : sculptPoints;
        annotations.sculptAnnotation(sample, 'library', selectedId, smoothed, sculptRadius, tool);
        // The eraser can consume the annotation entirely — drop the stale
        // selection rather than keep pointing at a now-deleted id.
        if (!annotations.findAnnotation(sample, 'library', selectedId)) clearSelection();
      }
      sculptPoints = null;
      redraw();
      return;
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

  // ── wand: color/optical-density similarity region growing ──────────────────
  // Optical density follows the same -log(rgb/255) convention used server-side
  // for H&E stain deconvolution (see is_he_image in server.py) — it's more
  // robust than raw RGB to the brightness/thickness variation that's common
  // across a slide, so combining it with plain color distance lets the wand
  // follow stain-intensity boundaries (e.g. a nucleus edge) that flat RGB
  // similarity alone would blur through.
  function _od(rgb) {
    return [
      -Math.log(Math.max(1, rgb[0]) / 255),
      -Math.log(Math.max(1, rgb[1]) / 255),
      -Math.log(Math.max(1, rgb[2]) / 255),
    ];
  }
  // Combined similarity score in [0, ~1]; lower = more similar. Weighted
  // toward plain color distance (0.6) with optical density (0.4) as a
  // brightness-invariant secondary signal, then compared against the
  // 0-100 tolerance slider (normalized to 0-1).
  function _wandScore(rgbA, odA, rgbB, odB) {
    const dR = rgbA[0] - rgbB[0], dG = rgbA[1] - rgbB[1], dB = rgbA[2] - rgbB[2];
    const colorDist = Math.sqrt(dR * dR + dG * dG + dB * dB) / 441.7; // max possible RGB distance
    const oR = odA[0] - odB[0], oG = odA[1] - odB[1], oB = odA[2] - odB[2];
    const odDist = Math.sqrt(oR * oR + oG * oG + oB * oB) / 9.6; // ~max possible OD distance
    return 0.6 * colorDist + 0.4 * odDist;
  }
  // Samples a single point's color from the active pixel source; returns
  // null if the point falls outside the rendered viewport or lands on a
  // not-yet-loaded tile (transparent), so callers can refuse to start a wand
  // stroke from data that doesn't exist yet rather than guessing black.
  function _wandSampleColorAt(imgPt) {
    if (!pixelSource || typeof pixelSource.getRegion !== 'function') return null;
    const sp = _toVp(imgPt);
    const region = pixelSource.getRegion(sp.x - 1, sp.y - 1, 3, 3);
    if (!region || !region.width || !region.height) return null;
    const px = Math.min(region.width - 1, Math.max(0, Math.floor(region.width / 2)));
    const py = Math.min(region.height - 1, Math.max(0, Math.floor(region.height / 2)));
    const i = (py * region.width + px) * 4;
    if (region.data[i + 3] === 0) return null;
    return [region.data[i], region.data[i + 1], region.data[i + 2]];
  }
  // Flood-fills a working raster built from the active pixel source, seeded
  // by disks of `coreRadiusPx` (image px) around every point in `pathPtsImg`
  // (unconditionally included — this is the tool's physical footprint) and
  // grown outward from there while neighbor similarity to the fixed
  // `referenceRgb`/`referenceOd` stays within `tolerance` (0-1), bounded to a
  // working bbox no larger than `bboxMarginPx` beyond the path (the safety
  // cap that keeps a big uniform region, e.g. blank slide background, from
  // flooding the whole raster). Returns { mask, rw, rh, workScale, bbox } in
  // raster coordinates, or null if there's nothing to sample (e.g. path
  // entirely off-screen or no pixel source configured).
  function _wandGrow(pathPtsImg, coreRadiusPx, bboxMarginPx, referenceRgb, referenceOd, tolerance, forcedScale) {
    if (!pixelSource || typeof pixelSource.getRegion !== 'function' || !pathPtsImg.length) return null;
    const { width: imgW, height: imgH } = viewport.getImageSize();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pathPtsImg) {
      if (p.x - bboxMarginPx < minX) minX = p.x - bboxMarginPx;
      if (p.x + bboxMarginPx > maxX) maxX = p.x + bboxMarginPx;
      if (p.y - bboxMarginPx < minY) minY = p.y - bboxMarginPx;
      if (p.y + bboxMarginPx > maxY) maxY = p.y + bboxMarginPx;
    }
    minX = Math.max(0, minX); minY = Math.max(0, minY);
    maxX = Math.min(imgW - 1, maxX); maxY = Math.min(imgH - 1, maxY);
    const boxW = maxX - minX, boxH = maxY - minY;
    if (boxW <= 0 || boxH <= 0) return null;
    // The raster resolution is picked once per growing session and frozen by
    // the caller (see wandFrozenScale) instead of being recomputed from the
    // ever-changing path bbox on every frame: letting it drift down as a drag
    // gets longer made already-included pixels resample differently frame to
    // frame — visually "erasing" parts of the region — and since only
    // strongly-contrasted features (nuclei) survive that resampling
    // reliably, it also biased the whole selection toward them. A hard cell
    // count still caps the raster so a very long drag can't blow up memory.
    let workScale = forcedScale != null ? forcedScale : Math.min(1.0, WAND_MAX_RASTER_DIM / Math.max(boxW, boxH));
    if (boxW * workScale * (boxH * workScale) > WAND_HARD_MAX_CELLS) {
      workScale = Math.sqrt(WAND_HARD_MAX_CELLS / (boxW * boxH));
    }
    const rw = Math.max(3, Math.round(boxW * workScale));
    const rh = Math.max(3, Math.round(boxH * workScale));

    // One screen-space capture covers the whole working bbox; every raster
    // cell's color is then looked up inside it, so the pixel source is only
    // asked for a region once per growth step regardless of raster size.
    const p0 = viewport.toScreenSpace(minX, minY);
    const p1 = viewport.toScreenSpace(maxX, maxY);
    const screenW = Math.max(1, p1.x - p0.x);
    const screenH = Math.max(1, p1.y - p0.y);
    const region = pixelSource.getRegion(p0.x, p0.y, screenW, screenH);
    if (!region || !region.width || !region.height) return null;
    const rsx = region.width / screenW;
    const rsy = region.height / screenH;
    function sample(rx, ry) {
      const imgX = minX + rx / workScale, imgY = minY + ry / workScale;
      const sp = viewport.toScreenSpace(imgX, imgY);
      const px = Math.floor((sp.x - p0.x) * rsx);
      const py = Math.floor((sp.y - p0.y) * rsy);
      if (px < 0 || py < 0 || px >= region.width || py >= region.height) return null;
      const i = (py * region.width + px) * 4;
      if (region.data[i + 3] === 0) return null;
      return [region.data[i], region.data[i + 1], region.data[i + 2]];
    }

    const mask = new Uint8Array(rw * rh);
    const visited = new Uint8Array(rw * rh);
    const queue = [];
    const rasterRadius = Math.max(1, coreRadiusPx * workScale);
    const rr2 = rasterRadius * rasterRadius;
    // Footprint pixels (the swept path itself) are always included regardless
    // of color — that's the tool's physical brush stroke, not a similarity
    // match — but their colors are also averaged into an adaptive reference
    // when the caller doesn't pass a fixed one (brush mode): using the mean
    // of everything painted so far, rather than a single first-clicked pixel,
    // keeps the tolerance test representative of the whole region being
    // selected instead of biased toward whatever that one starting pixel
    // happened to be (e.g. a dark nucleus).
    let sumR = 0, sumG = 0, sumB = 0, coreCount = 0;
    for (const p of pathPtsImg) {
      const cx = (p.x - minX) * workScale, cy = (p.y - minY) * workScale;
      const x0 = Math.max(0, Math.floor(cx - rasterRadius)), x1 = Math.min(rw - 1, Math.ceil(cx + rasterRadius));
      const y0 = Math.max(0, Math.floor(cy - rasterRadius)), y1 = Math.min(rh - 1, Math.ceil(cy + rasterRadius));
      for (let ry = y0; ry <= y1; ry++) {
        for (let rx = x0; rx <= x1; rx++) {
          const dx = rx - cx, dy = ry - cy;
          if (dx * dx + dy * dy > rr2) continue;
          const idx = ry * rw + rx;
          if (visited[idx]) continue;
          visited[idx] = 1;
          const rgb = sample(rx, ry);
          if (!rgb) continue;
          mask[idx] = 1;
          queue.push(idx);
          sumR += rgb[0]; sumG += rgb[1]; sumB += rgb[2]; coreCount++;
        }
      }
    }
    let refRgb = referenceRgb, refOd = referenceOd;
    if (!refRgb) {
      refRgb = coreCount > 0 ? [sumR / coreCount, sumG / coreCount, sumB / coreCount] : [128, 128, 128];
      refOd = _od(refRgb);
    }
    let qi = 0;
    while (qi < queue.length) {
      const idx = queue[qi++];
      const ry = (idx / rw) | 0, rx = idx % rw;
      const nbrs = [[rx + 1, ry], [rx - 1, ry], [rx, ry + 1], [rx, ry - 1]];
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
        const nidx = ny * rw + nx;
        if (visited[nidx]) continue;
        visited[nidx] = 1;
        const rgb = sample(nx, ny);
        if (!rgb) continue;
        if (_wandScore(rgb, _od(rgb), refRgb, refOd) <= tolerance) {
          mask[nidx] = 1;
          queue.push(nidx);
        }
      }
    }
    return { mask, rw, rh, workScale, bbox: { minX, minY }, refRgb, refOd };
  }
  // Extracts contour rings (image space) from a _wandGrow() result via the
  // same marching-squares helper the noodle brush uses.
  function _wandMaskToRings(built) {
    if (!built) return [];
    const polys = _marchingSquares(built.mask, built.rw, built.rh);
    const { width: imgW, height: imgH } = viewport.getImageSize();
    return polys.filter(p => p.length >= 6).map(poly => poly.map(p => ({
      x: Math.max(0, Math.min(imgW - 1, p.x / built.workScale + built.bbox.minX)),
      y: Math.max(0, Math.min(imgH - 1, p.y / built.workScale + built.bbox.minY)),
    })));
  }
  function _wandRecomputeFromGrow(pathPtsImg, coreRadiusPx, bboxMarginPx, tolerance, adaptive) {
    let referenceRgb, referenceOd;
    if (adaptive) {
      // Reference is computed once, from the footprint of the *first* frame
      // of the session, and frozen (wandAdaptiveRef) — see the wand-state
      // comment block above for why recomputing it every frame is unsafe.
      referenceRgb = wandAdaptiveRef ? wandAdaptiveRef.rgb : null;
      referenceOd = wandAdaptiveRef ? wandAdaptiveRef.od : null;
    } else {
      referenceRgb = wandSeedColor.rgb;
      referenceOd = wandSeedColor.od;
    }
    const built = _wandGrow(pathPtsImg, coreRadiusPx, bboxMarginPx, referenceRgb, referenceOd, tolerance, wandFrozenScale);
    if (built) {
      if (wandFrozenScale == null) wandFrozenScale = built.workScale;
      if (adaptive && !wandAdaptiveRef) wandAdaptiveRef = { rgb: built.refRgb, od: built.refOd };
    }
    wandPreviewRings = built ? _wandMaskToRings(built) : null;
  }
  // Throttles wand recompute to one per animation frame — brush-mode drags
  // and seed-mode mousemoves can both fire far faster than the BFS needs to
  // re-run; each callback re-reads current wand state at fire time rather
  // than closing over a snapshot, so only the latest cursor position matters.
  function _wandScheduleRecompute() {
    if (_wandRecomputePending) return;
    _wandRecomputePending = true;
    requestAnimationFrame(() => {
      _wandRecomputePending = false;
      if (tool !== 'wand') return;
      if (wandMode === 'brush' && wandDragging && wandPathPoints) {
        _wandRecomputeFromGrow(wandPathPoints, wandRadius, wandRadius * 1.5, wandTolerance / 100, true);
        redraw();
      } else if (wandMode === 'seed' && wandSeedPoint) {
        const cur = viewport.toImageSpace(cursorVpX, cursorVpY);
        const dist = Math.hypot(cur.x - wandSeedPoint.x, cur.y - wandSeedPoint.y);
        // Ratchet on the farthest distance reached, not the current one —
        // moving the cursor back toward the seed (e.g. to click and accept)
        // must not silently shrink an already-grown preview.
        wandSeedMaxDist = Math.max(wandSeedMaxDist, dist);
        const t = Math.min(1, wandSeedMaxDist / WAND_SEED_RAMP_PX) * (wandTolerance / 100);
        _wandRecomputeFromGrow([wandSeedPoint], 3, WAND_SEED_MAX_REACH_PX, t);
        redraw();
      }
    });
  }
  function _wandFinalize() {
    const sample = getActiveSample();
    if (wandPreviewRings && wandPreviewRings.length) {
      const rings = wandPreviewRings.map(_maybeSimplify);
      const anns = annotations.buildAnnotationsFromRings(sample, rings, { cls: freehandCls });
      if (anns.length) annotations.addAnnotationGroup(sample, 'library', anns);
    } else if (typeof log === 'function') {
      log('Wand: no region found — try a larger tolerance or a different starting point.');
    }
    _wandReset();
    redraw();
  }
  function _wandReset() {
    wandMode = null;
    wandPathPoints = null;
    wandDragging = false;
    wandAdaptiveRef = null;
    wandSeedPoint = null;
    wandSeedColor = null;
    wandSeedMaxDist = 0;
    wandPreviewRings = null;
    wandFrozenScale = null;
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
    else if (e.key === 'Enter' && tool === 'wand' && (wandMode === 'seed' || wandMode === 'brush')) { _wandFinalize(); }
    else if (e.key === 'Escape') {
      if (tool === 'polygon') { polyPoints = []; redraw(); }
      else if (tool === 'ruler') { annotations.rulerClear(); redraw(); }
      else if (tool === 'wand') { _wandReset(); redraw(); }
      else if (tool === 'lasso') { _lassoReset(); redraw(); }
      else if (tool === 'drag') { _dragReset(); redraw(); }
    }
  }
  // Cancels an in-progress drag/rotate, restoring every affected sibling's
  // rings from the pre-drag snapshot rather than leaving the live preview
  // committed with no undo entry.
  function _dragReset() {
    const st = dragRotateState || dragMoveState;
    if (st) for (const ann of st.siblings) { ann.rings = st.oldRingsById[ann.id]; annotations.recomputeMetrics(ann); }
    dragRotateState = null;
    dragMoveState = null;
  }

  // Clears the lasso's drawn area + highlight only — deliberately leaves the
  // Annotations tab's checkmarks (selectedIds there) alone, since those are
  // the actual bulk-action selection the user is meant to keep using after
  // the visual outline goes away (tool switch, Escape, or a fresh stroke).
  function _lassoReset() {
    lassoPoints = null;
    lassoRing = null;
    lassoSelectedIds = new Set();
  }

  function setTool(name) {
    tool = name || 'none';
    polyPoints = [];
    freehandPoints = null;
    dragTarget = null;
    splitPoints = null;
    sculptPoints = null;
    _dragReset();
    _wandReset();
    _lassoReset();
    cursorVisible = false;
    redraw();
  }
  function onMouseLeave() {
    cursorVisible = false;
    redraw();
  }
  // Notifies the Annotations tab (via boot.js wiring) so a canvas-driven
  // selection (single click with an annot_* tool active, or a dblclick while
  // panning) highlights the matching list row too, not just the canvas
  // outline — the same hook fires for a list-row-driven selection since that
  // goes through setSelected as well, keeping both directions in sync
  // through one code path instead of two.
  function _notifySelect(id) { if (typeof onSelect === 'function') onSelect(id); }
  // Notifies the Annotations tab of the ids the just-finished lasso stroke
  // touched, so it can replace the checked set (see boot.js/annotations_tab.js
  // setCheckedIds) — a separate hook from _notifySelect since a lasso can
  // check many rows at once, not just highlight a single one.
  function _notifyLassoSelect(ids) { if (typeof onLassoSelect === 'function') onLassoSelect(ids); }
  function setSelected(id) { selectedId = id; redraw(); _notifySelect(id); }
  function hasSelection() { return selectedId != null; }
  function clearSelection() { selectedId = null; redraw(); _notifySelect(null); }
  function deleteSelected() {
    if (selectedId == null) return;
    const sample = getActiveSample();
    if (sample) {
      const ann = annotations.findAnnotation(sample, 'library', selectedId);
      // Delete the whole group_id group so every sibling piece of a
      // multi-contour annotation is removed together, not just the piece
      // that happened to be clicked.
      annotations.deleteAnnotationGroup(sample, 'library', ann ? ann.group_id : selectedId);
    }
    selectedId = null;
    redraw();
    _notifySelect(null);
  }
  function setVisibility(id, visible) {
    if (visible) hiddenIds.delete(id); else hiddenIds.add(id);
    redraw();
  }
  // Per-annotation manual visibility only (ignores class-level hide) — lets
  // the list's eye button reflect/toggle exactly the state setVisibility
  // controls, independent of any whole-class hide.
  function isVisible(id) { return !hiddenIds.has(id); }
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
  function setSculptRadius(v) { sculptRadius = Math.max(1, Number(v) || 1); redraw(); }
  function getSculptRadius() { return sculptRadius; }
  // Wand pixel source: boot.js picks the right one for the active render mode
  // (plain RGB tiles / multichannel / monochannel2D) and re-supplies it
  // whenever that mode changes (e.g. switching to/from a monochannel sample).
  function setPixelSource(src) { pixelSource = src || null; }
  function setWandRadius(v) { wandRadius = Math.max(1, Number(v) || 1); redraw(); }
  function getWandRadius() { return wandRadius; }
  function setWandTolerance(v) { wandTolerance = Math.max(0, Math.min(100, Number(v) || 0)); redraw(); }
  function getWandTolerance() { return wandTolerance; }
  function panZoomTo(ann) {
    if (!ann || !ann.rings.length || !ann.rings[0].length) return;
    // Fit the bounding box of every sibling sharing group_id, not just the
    // clicked piece, so a multi-contour annotation is framed as a whole.
    const sample = getActiveSample();
    const pieces = sample ? annotations.listGroupSiblings(sample, 'library', ann.group_id) : [ann];
    const ringsToFit = (pieces.length ? pieces : [ann]).flatMap(a => a.rings);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of ringsToFit) {
      for (const p of ring) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;
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
    setVisibility, isVisible, setClassVisibility, setClassOpacity,
    setClassColor, getClassColor,
    setFreehandMode, getFreehandMode,
    setBrushMode, getBrushMode,
    setSmoothing, getSmoothing,
    panZoomTo, redraw, hitTest,
    finishPolygon,
    setBrushRadius: v => { brushRadius = v; redraw(); },
    getBrushRadius,
    setSculptRadius, getSculptRadius,
    setPixelSource,
    setWandRadius, getWandRadius,
    setWandTolerance, getWandTolerance,
  };
}
