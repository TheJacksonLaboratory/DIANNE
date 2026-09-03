/**
 * annotations.js
 *
 * Core data model, geometry engine, and persistence for the annotation
 * library (task.md §2, §5, §6, §7, §8, §9, §11, §12, §13).
 *
 * Coexists with (does not replace) the pre-existing draw.js positive/negative
 * stroke system. draw.js remains the canvas layer for line/noodle strokes;
 * this module adds:
 *   - a richer annotation object schema (id/group_id/label/class/status/...)
 *   - library annotations (arbitrary class, active-slide scope)
 *   - promotion copies to/from the positive/negative sets
 *   - polygon / freehand-brush / vertex-edit / boolean-op tools
 *   - a single-measurement ruler tool with mpp-aware units
 *   - per-slide dirty tracking + autosave to the new /annotations/save route
 *   - a persistent history log flushed to /history_log
 *
 * Boolean ops are implemented via canvas rasterization + marching squares
 * (same technique already used by draw.js's noodle-brush contour extraction)
 * rather than a bundled polygon-clipping dependency, to avoid adding a new
 * external library to a build-less, plain-<script> codebase.
 *
 * Exposes createAnnotations({ viewport, log, getMppForSample, baseUrl }) → API
 * (see bottom of file for the returned object shape).
 */

function createAnnotations({ viewport, log, getMppForSample, baseUrl, onPromotedToPosNeg, onChange, currentUser, confirmEditReviewed }) {
  const STATUS_VALUES = ['draft', 'proposed', 'reviewed', 'edited'];
  // Resolved once (server-side, via whoami) and injected as `currentUser`;
  // falls back to 'Unknown' so every annotation always has an attributable
  // author/editor even if that resolution failed.
  function _currentUser() { return currentUser || 'Unknown'; }
  // Fired after any mutation (add/delete/edit/status/promote/undo/redo/load) so
  // callers can refresh the Annotations tab list, thumbnail overlay, and
  // sample badges without needing a tab switch to pick up the change.
  function _notify(sample) { if (typeof onChange === 'function') onChange(sample); }
  let _idSeq = 1;
  function _nextId(prefix) { return (prefix || 'a') + '_' + (_idSeq++) + '_' + Date.now().toString(36); }

  // ── class colors (global, not per-slide — a class means the same thing
  // across every sample, so its color and the class list itself are shared).
  // Persisted alongside annotation data on every save/load (§ class colors
  // must save along with classes and all the other details).
  const classColors = { positive: '#22f0ff', negative: '#ff5233' };
  /** `silent` skips markDirty/_notify (used for live preview while a native
   *  <input type=color> picker is still open — _notify fans out to a full
   *  Annotations-tab list rebuild, which would tear down the very <input>
   *  element the browser's color popup is anchored to and force-close it
   *  mid-pick; callers should follow up with a non-silent call once the
   *  picker actually closes, e.g. on the input's 'change' event). */
  function setClassColor(sample, cls, color, silent) {
    if (!cls) return false;
    classColors[cls] = color;
    if (silent) return true;
    if (sample) markDirty(sample);
    _notify(sample);
    return true;
  }
  function getClassColor(cls) { return classColors[cls]; }
  function getClassColors() { return { ...classColors }; }
  function knownClasses(sample) {
    const set = new Set(Object.keys(classColors));
    if (sample) for (const a of listAnnotationsAllClasses(sample)) set.add(a.class);
    return Array.from(set).sort();
  }
  function listAnnotationsAllClasses(sample) {
    const b = _bucket(sample);
    return [].concat(b.library || [], b.positive || [], b.negative || []);
  }

  // ── per-slide store ────────────────────────────────────────────────────
  // { [sample]: { library: [ann...], positive: [ann...], negative: [ann...] } }
  const store = {};
  const dirty = {};          // { [sample]: bool }
  const undoStacks = {};     // { [sample]: [ {undo, redo} geometry-only ops ] } — see §6/§15
  const redoStacks  = {};
  const historyBuffer = [];  // pending {ts, message} entries awaiting flush (§9)
  const selection = {};      // { [sample]: Set(id) } multi-select state for the tab (§4)

  function _bucket(sample) {
    if (!store[sample]) store[sample] = { library: [], positive: [], negative: [] };
    return store[sample];
  }
  function _undo(sample) { if (!undoStacks[sample]) undoStacks[sample] = []; return undoStacks[sample]; }
  function _redo(sample) { if (!redoStacks[sample])  redoStacks[sample]  = []; return redoStacks[sample]; }

  function markDirty(sample) { dirty[sample] = true; }
  function isDirty(sample)   { return !!dirty[sample]; }

  // ── history log (transient status bar mirror, §9) ──────────────────────
  function logAndRecord(msg) {
    if (typeof log === 'function') log(msg);
    historyBuffer.push({ ts: new Date().toISOString(), message: msg });
  }
  function flushHistoryLog() {
    if (!historyBuffer.length) return Promise.resolve();
    const entries = historyBuffer.splice(0, historyBuffer.length);
    return fetch(baseUrl + '/history_log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }).catch(() => {});
  }

  // ── geometry: shoelace area / perimeter over one or more rings ─────────
  // Outer ring (index 0) contributes positively; hole rings (index>0)
  // subtract, per GeoJSON polygon-with-holes convention (§2).
  function _ringArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }
  function _ringPerimeter(pts) {
    let p = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      p += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return p;
  }
  function computeAreaPx2(rings) {
    if (!rings || !rings.length) return 0;
    let area = _ringArea(rings[0]);
    for (let i = 1; i < rings.length; i++) area -= _ringArea(rings[i]);
    return Math.max(0, area);
  }
  function computePerimeterPx(rings) {
    if (!rings || !rings.length) return 0;
    return rings.reduce((s, r) => s + _ringPerimeter(r), 0);
  }

  // ── §12 unit logic: mm²/µm if mpp known, else megapixels/px ────────────
  function unitsForSample(sample) {
    const mpp = typeof getMppForSample === 'function' ? getMppForSample(sample) : null;
    return {
      hasMpp: !!mpp,
      mpp: mpp || null,
      areaLabel: mpp ? 'mm\u00b2' : 'Mpx',
      lengthLabel: mpp ? '\u00b5m' : 'px',
    };
  }
  function formatArea(areaPx2, sample) {
    const u = unitsForSample(sample);
    if (u.hasMpp) {
      const mm2 = areaPx2 * (u.mpp * u.mpp) / 1e6;
      return mm2.toFixed(4) + ' ' + u.areaLabel;
    }
    return (areaPx2 / 1e6).toFixed(4) + ' ' + u.areaLabel;
  }
  function formatLength(lengthPx, sample) {
    const u = unitsForSample(sample);
    if (u.hasMpp) {
      const um = lengthPx * u.mpp;
      return (um >= 1000 ? (um / 1000).toFixed(3) + ' mm' : um.toFixed(1) + ' \u00b5m');
    }
    return lengthPx.toFixed(1) + ' px';
  }

  // ── §2 annotation factory ───────────────────────────────────────────────
  function makeAnnotation({ sample, rings, label, cls, author, magnification, groupId }) {
    const now = new Date().toISOString();
    const id = _nextId('ann');
    const createdBy = author || _currentUser();
    return {
      id,
      group_id: groupId || id,
      label: label || '',
      class: cls || 'unclassified',
      status: 'draft',
      locked: false,
      author: createdBy,        // first author — who created this annotation, immutable after creation
      last_editor: createdBy,   // most recent author — who last modified it (may equal `author`)
      created_at: now,
      updated_at: now,
      slide_id: sample,
      magnification_drawn_at: magnification || (viewport ? viewport.getTransform().scale : null),
      notes: '',
      rings: rings || [],       // array of rings; ring0=outer, rest=holes (image-space points)
      area: 0,
      perimeter: 0,
      promoted_copies: [],
    };
  }
  function recomputeMetrics(ann) {
    ann.area = computeAreaPx2(ann.rings);
    ann.perimeter = computePerimeterPx(ann.rings);
  }

  // ── §6 ring nesting: assemble a flat bag of closed rings (e.g. several
  // disjoint noodle-brush contour pieces, or several raw draw+/draw- stroke
  // rings sharing one group_id) into proper outer+hole pieces, using
  // even/odd nesting DEPTH (containment count) rather than a single-level
  // "is this point inside that ring" test. This correctly distinguishes:
  //  - depth 0 (not inside anything)              \u2192 new top-level outer ring
  //  - depth 1 (inside exactly one other ring)     \u2192 hole of its parent
  //  - depth 2 (inside a hole, i.e. an "island")    \u2192 its OWN new outer ring
  // A naive single-level containment test would wrongly fold an island-in-
  // a-hole into the outer ring as a second hole, merging unrelated solid
  // regions and corrupting both fill and hit-testing. Shared by every
  // caller that turns raw traced/drawn contours into ring-with-holes
  // annotations (noodle-brush freehand draw, pos/neg stroke import, and any
  // future multi-contour source) so the behavior is identical everywhere.
  function _pointInRingPts(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
      const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  // A single sample point (e.g. a centroid) is NOT reliable for concave or
  // crescent-shaped noodle-brush contours: the plain vertex-average centroid
  // of a "C"/banana-shaped ring can fall entirely outside that ring's own
  // boundary, which can make two disjoint blobs look like they mutually
  // contain each other (both get misclassified as holes, so neither
  // qualifies as a top-level outer ring and the whole shape vanishes).
  // Instead, containment is decided by a majority vote across several
  // sampled vertices of the candidate inner ring: a genuine hole/island has
  // (almost) ALL of its vertices inside the other ring, whereas an unrelated
  // disjoint ring has none/very few.
  function _ringInsideRing(inner, outer) {
    if (!inner.length || !outer.length) return false;
    const step = Math.max(1, Math.floor(inner.length / 12)); // sample up to ~12 points
    let total = 0, insideCount = 0;
    for (let i = 0; i < inner.length; i += step) {
      total++;
      if (_pointInRingPts(inner[i], outer)) insideCount++;
    }
    return total > 0 && insideCount / total > 0.5;
  }
  function assembleRingsIntoPieces(rings) {
    const n = rings.length;
    if (!n) return [];
    const containers = rings.map(() => []); // containers[k] = indices of rings containing ring k
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        if (i !== k && _ringInsideRing(rings[k], rings[i])) containers[k].push(i);
      }
    }
    const depth = containers.map(c => c.length);
    function _immediateParent(k) {
      // The immediate parent is the containing ring with the greatest depth
      // itself (i.e. the smallest/innermost ring among those that contain k).
      let best = -1, bestDepth = -1;
      for (const i of containers[k]) if (depth[i] > bestDepth) { bestDepth = depth[i]; best = i; }
      return best;
    }
    const pieces = [];
    const pieceIdxByOuter = new Map();
    for (let k = 0; k < n; k++) {
      if (depth[k] % 2 === 0) { pieceIdxByOuter.set(k, pieces.length); pieces.push({ outer: rings[k], holes: [] }); }
    }
    for (let k = 0; k < n; k++) {
      if (depth[k] % 2 === 1) {
        const parent = _immediateParent(k);
        const pieceIdx = pieceIdxByOuter.get(parent);
        // Safety fallback: if the computed parent piece is somehow missing
        // (shouldn't normally happen, but a ring must never silently vanish
        // from the assembled result), fall back to treating it as its own
        // top-level outer piece instead of dropping it.
        if (pieceIdx !== undefined) pieces[pieceIdx].holes.push(rings[k]);
        else pieces.push({ outer: rings[k], holes: [] });
      }
    }
    return pieces;
  }
  /** Turn a flat bag of closed point-rings (e.g. from noodle-brush contour
   *  extraction, or several raw draw+/draw- strokes sharing one group_id)
   *  into properly-assembled annotation objects: rings that are genuinely
   *  nested become a single outer+holes annotation, while disjoint rings
   *  become separate sibling annotations sharing one group_id. Objects are
   *  built (recomputeMetrics'd) but NOT added to the store \u2014 callers should
   *  pass the result to addAnnotationGroup(). */
  function buildAnnotationsFromRings(sample, rings, { cls, author, label } = {}) {
    const pieces = assembleRingsIntoPieces(rings);
    const anns = pieces.map(p => makeAnnotation({ sample, rings: [p.outer, ...p.holes], cls, author, label }));
    if (anns.length > 1) { const gid = anns[0].group_id; for (const a of anns) a.group_id = gid; }
    for (const a of anns) recomputeMetrics(a);
    return anns;
  }

  // ── §7 status / lock ────────────────────────────────────────────────────
  function isLocked(ann) { return ann.status === 'ready_for_review' || ann.status === 'reviewed'; }

  function setStatus(sample, cls, id, status) {
    const ann = findAnnotation(sample, cls, id);
    if (!ann || STATUS_VALUES.indexOf(status) < 0) return false;
    ann.status = status;
    ann.locked = isLocked(ann);
    ann.last_editor = _currentUser();
    ann.updated_at = new Date().toISOString();
    markDirty(sample);
    logAndRecord(`Status changed: "${ann.label}" \u2192 ${status}`);
    _notify(sample);
    return true;
  }

  /** Metadata edit on a locked annotation reverts status to 'edited' (§7/§15,
   *  resolved decision) and unlocks geometry; unlocked annotations are
   *  updated in place with no status side-effect. */
  function editMetadata(sample, cls, id, patch) {
    const ann = findAnnotation(sample, cls, id);
    if (!ann) return false;
    const fields = ['label', 'class', 'notes'];
    let changed = false;
    for (const f of fields) {
      if (patch[f] !== undefined && patch[f] !== ann[f]) { ann[f] = patch[f]; changed = true; }
    }
    if (!changed) return false;
    if (isLocked(ann)) {
      ann.status = 'edited';
      ann.locked = false;
    }
    ann.last_editor = _currentUser();
    ann.updated_at = new Date().toISOString();
    markDirty(sample);
    _notify(sample);
    return true;
  }

  function guardGeometryEdit(sample, cls, id) {
    const ann = findAnnotation(sample, cls, id);
    if (ann && isLocked(ann)) {
      logAndRecord(`Locked: "${ann.label}" is ${ann.status} \u2014 unlock (revert to draft) to edit geometry.`);
      return false;
    }
    return true;
  }

  /** UI entry point for "user is about to edit a reviewed (locked)
   *  annotation": if it isn't locked, resolves true immediately with no
   *  dialog; if it is, shows the same-style confirm dialog (via the
   *  `confirmEditReviewed` callback \u2014 Esc/Cancel rejects, Enter/OK confirms,
   *  per modals.js's showConfirm) and, only on confirmation, flips the
   *  annotation to 'edited'/unlocked (recording who did it) so the caller's
   *  subsequent edit (geometry or metadata) then passes guardGeometryEdit /
   *  editMetadata's own lock check normally. Callers should await this
   *  before starting an edit interaction (e.g. a vertex drag) rather than
   *  attempting the edit and checking for failure. */
  function requestUnlockForEdit(sample, cls, id) {
    const ann = findAnnotation(sample, cls, id);
    if (!ann) return Promise.resolve(false);
    if (!isLocked(ann)) return Promise.resolve(true);
    if (typeof confirmEditReviewed !== 'function') return Promise.resolve(false);
    return Promise.resolve(confirmEditReviewed(ann)).then(ok => {
      if (!ok) return false;
      ann.status = 'edited';
      ann.locked = false;
      ann.last_editor = _currentUser();
      ann.updated_at = new Date().toISOString();
      markDirty(sample);
      logAndRecord(`"${ann.label}" unlocked for editing (was reviewed) \u2192 edited`);
      _notify(sample);
      return true;
    });
  }

  // ── lookup helpers ──────────────────────────────────────────────────────
  function findAnnotation(sample, cls, id) {
    const b = _bucket(sample);
    return (b[cls] || []).find(a => a.id === id);
  }
  function listAnnotations(sample, cls) {
    return _bucket(sample)[cls] || [];
  }
  /** All annotations in `cls` bucket sharing the same group_id (§6): several
   *  ids can belong to one logical shape (e.g. disjoint noodle-brush contours
   *  or an outer ring + separately-drawn holes), and undo/redo/export/copy/
   *  promote must all treat the group as a single atomic annotation. */
  function listGroupSiblings(sample, cls, groupId) {
    return (_bucket(sample)[cls] || []).filter(a => a.group_id === groupId);
  }
  /** Partition a list of annotations into arrays-per-group_id, preserving
   *  first-seen order. Used by bulk export/selection expansion. */
  function groupAnnotationsByGroupId(anns) {
    const order = [];
    const groups = new Map();
    for (const a of anns) {
      const gid = a.group_id || a.id;
      if (!groups.has(gid)) { groups.set(gid, []); order.push(gid); }
      groups.get(gid).push(a);
    }
    return order.map(gid => groups.get(gid));
  }

  // ── §6 geometry-only undo/redo ─────────────────────────────────────────
  function pushUndo(sample, op) {
    _undo(sample).push(op);
    _redo(sample).length = 0; // new op invalidates redo history
  }
  function undo(sample) {
    const stack = _undo(sample);
    const op = stack.pop();
    if (!op) return false;
    op.undo();
    _redo(sample).push(op);
    markDirty(sample);
    _notify(sample);
    return true;
  }
  function redo(sample) {
    const stack = _redo(sample);
    const op = stack.pop();
    if (!op) return false;
    op.redo();
    _undo(sample).push(op);
    markDirty(sample);
    _notify(sample);
    return true;
  }

  // ── create / delete (geometry, undoable) ───────────────────────────────
  /** Add one or more annotations as a single atomic (grouped) undo/redo op.
   *  Callers that create several sibling rings (e.g. noodle-brush multi-
   *  contour draws, or grouped promote/copy) should use this so a single
   *  undo removes the whole group instead of one piece at a time. */
  function addAnnotationGroup(sample, cls, anns) {
    if (!anns || !anns.length) return [];
    for (const ann of anns) recomputeMetrics(ann);
    const b = _bucket(sample);
    b[cls].push(...anns);
    markDirty(sample);
    pushUndo(sample, {
      undo: () => { for (const ann of anns) { const i = b[cls].indexOf(ann); if (i >= 0) b[cls].splice(i, 1); } },
      redo: () => { b[cls].push(...anns); },
    });
    logAndRecord(anns.length === 1 ? `Added ${cls} annotation "${anns[0].label}"` : `Added ${anns.length} ${cls} annotations (group)`);
    _notify(sample);
    return anns;
  }
  function addAnnotation(sample, cls, ann) {
    addAnnotationGroup(sample, cls, [ann]);
    return ann;
  }
  function deleteAnnotation(sample, cls, id) {
    if (!guardGeometryEdit(sample, cls, id)) return false;
    const b = _bucket(sample);
    const idx = (b[cls] || []).findIndex(a => a.id === id);
    if (idx < 0) return false;
    const [removed] = b[cls].splice(idx, 1);
    markDirty(sample);
    pushUndo(sample, {
      undo: () => { b[cls].splice(idx, 0, removed); },
      redo: () => { const i = b[cls].indexOf(removed); if (i >= 0) b[cls].splice(i, 1); },
    });
    logAndRecord(`Deleted "${removed.label}"`);
    _notify(sample);
    return true;
  }
  /** Delete every annotation in `cls` sharing groupId, as one atomic
   *  undo/redo op (mirrors draw.js's grouped undoLast for noodle strokes). */
  function deleteAnnotationGroup(sample, cls, groupId) {
    const b = _bucket(sample);
    const entries = [];
    (b[cls] || []).forEach((a, i) => { if (a.group_id === groupId) entries.push({ idx: i, ann: a }); });
    if (!entries.length) return false;
    for (const { ann } of entries) if (!guardGeometryEdit(sample, cls, ann.id)) return false;
    for (let k = entries.length - 1; k >= 0; k--) b[cls].splice(entries[k].idx, 1);
    markDirty(sample);
    pushUndo(sample, {
      undo: () => { for (const { idx, ann } of entries) b[cls].splice(idx, 0, ann); },
      redo: () => { for (const { ann } of entries) { const i = b[cls].indexOf(ann); if (i >= 0) b[cls].splice(i, 1); } },
    });
    logAndRecord(entries.length === 1 ? `Deleted "${entries[0].ann.label}"` : `Deleted group (${entries.length} annotations)`);
    _notify(sample);
    return true;
  }
  function replaceGeometry(sample, cls, id, newRings) {
    if (!guardGeometryEdit(sample, cls, id)) return false;
    const ann = findAnnotation(sample, cls, id);
    if (!ann) return false;
    const oldRings = ann.rings;
    ann.rings = newRings;
    recomputeMetrics(ann);
    ann.last_editor = _currentUser();
    ann.updated_at = new Date().toISOString();
    markDirty(sample);
    pushUndo(sample, {
      undo: () => { ann.rings = oldRings; recomputeMetrics(ann); },
      redo: () => { ann.rings = newRings; recomputeMetrics(ann); },
    });
    _notify(sample);
    return true;
  }

  // ── §5 promotion workflow (always an independent snapshot copy) ───────
  function _cloneRings(rings) { return rings.map(r => r.map(p => ({ x: p.x, y: p.y }))); }

  /** Copy an annotation (and every sibling sharing its group_id, so a
   *  multi-ring/multi-piece shape is copied as one unit) to positive/
   *  negative. Returns the array of copies (length 1 for a plain, ungrouped
   *  annotation). */
  function promoteToPosNeg(sample, id, targetCls) {
    if (targetCls !== 'positive' && targetCls !== 'negative') return null;
    const ann = findAnnotation(sample, 'library', id);
    if (!ann) return null;
    const siblings = listGroupSiblings(sample, 'library', ann.group_id);
    const newGroupId = _nextId('grp');
    const copies = siblings.map(src => {
      const copy = makeAnnotation({
        sample, rings: _cloneRings(src.rings), label: src.label, cls: src.class, author: src.author, groupId: newGroupId,
      });
      copy.derived_from = src.id;
      copy.last_editor = _currentUser();  // author is preserved from src for provenance; the copy itself was just made by the current user
      return copy;
    });
    addAnnotationGroup(sample, targetCls, copies);
    siblings.forEach((src, i) => src.promoted_copies.push({ id: copies[i].id, cls: targetCls }));
    markDirty(sample);
    logAndRecord(`Copied "${ann.label}" \u2192 ${targetCls}` + (copies.length > 1 ? ` (${copies.length} parts)` : ''));
    _notify(sample);
    // Bridge into the pre-existing draw+/draw- stroke system, which is the
    // actual positive/negative set consumed downstream by the Python kernel
    // (this module's own 'positive'/'negative' buckets only track the copy
    // for the Annotations tab / GeoJSON export, they are not the live feed).
    // Passed as one batch (not per-copy) so the callback can flatten every
    // ring (outer + holes, across every sibling piece) into the stroke
    // system under a single shared group_id, instead of dropping hole rings
    // or only pushing the first copy.
    if (typeof onPromotedToPosNeg === 'function') onPromotedToPosNeg(sample, targetCls, copies, newGroupId);
    return copies;
  }

  /** Copy a positive/negative stroke-derived annotation (and every sibling
   *  sharing its group_id) into the library as one grouped unit. Returns the
   *  array of copies (length 1 for a plain, ungrouped annotation). */
  function promoteToLibrary(sample, sourceCls, id, label, cls) {
    const ann = findAnnotation(sample, sourceCls, id);
    if (!ann) return null;
    const siblings = listGroupSiblings(sample, sourceCls, ann.group_id);
    const newGroupId = _nextId('grp');
    const copies = siblings.map(src => {
      const copy = makeAnnotation({
        sample, rings: _cloneRings(src.rings), label: label || src.label, cls: cls || 'unclassified', author: src.author, groupId: newGroupId,
      });
      copy.derived_from = src.id;  // provenance only; behaves as an independent library entry (§5)
      copy.last_editor = _currentUser();  // author is preserved from src for provenance; the copy itself was just made by the current user
      return copy;
    });
    addAnnotationGroup(sample, 'library', copies);
    siblings.forEach((src, i) => src.promoted_copies.push({ id: copies[i].id, cls: 'library' }));
    markDirty(sample);
    logAndRecord(`Saved ${sourceCls} contour "${ann.label}" to library` + (copies.length > 1 ? ` (${copies.length} parts)` : ''));
    _notify(sample);
    return copies;
  }

  // ══════════════════════════════════════════════════════════════════════
  // §6 Geometry engine: rasterize-and-retrace boolean ops (union/subtract/
  // intersect), reusing the marching-squares approach already proven in
  // draw.js for noodle-brush contour extraction, generalized to operate on
  // two arbitrary ring sets instead of a swept disk.
  // ══════════════════════════════════════════════════════════════════════

  function _polysBBox(ringsList) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rings of ringsList) for (const r of rings) for (const p of r) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function _rasterize(rings, minX, minY, scale, W, H) {
    const oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    const ctx = oc.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (const ring of rings) {
      if (!ring.length) continue;
      ctx.moveTo((ring[0].x - minX) * scale, (ring[0].y - minY) * scale);
      for (let i = 1; i < ring.length; i++) ctx.lineTo((ring[i].x - minX) * scale, (ring[i].y - minY) * scale);
      ctx.closePath();
    }
    ctx.fill('evenodd');  // holes (rings after index 0) subtract via evenodd fill
    const data = ctx.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
    return mask;
  }

  // Standalone marching-squares tracer (same algorithm as draw.js's private
  // copy; duplicated here since draw.js doesn't expose it).
  function _traceMask(mask, W, H) {
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

  /** Combine ringsA/ringsB with op in {'union','subtract','intersect'}.
   *  Returns a new array-of-rings (outer + holes are NOT distinguished by
   *  this generic op — callers treat the first returned ring as outer and
   *  any additional disjoint pieces as separate group_id siblings). */
  function booleanOp(ringsA, ringsB, op) {
    const MAX_DIM = 1024;
    const bbox = _polysBBox([ringsA, ringsB]);
    const boxW = Math.max(1, bbox.maxX - bbox.minX + 4);
    const boxH = Math.max(1, bbox.maxY - bbox.minY + 4);
    const scale = Math.min(1, MAX_DIM / Math.max(boxW, boxH));
    const W = Math.max(3, Math.ceil(boxW * scale) + 2);
    const H = Math.max(3, Math.ceil(boxH * scale) + 2);
    const minX = bbox.minX - 2, minY = bbox.minY - 2;

    const maskA = _rasterize(ringsA, minX, minY, scale, W, H);
    const maskB = _rasterize(ringsB, minX, minY, scale, W, H);
    const out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) {
      const a = maskA[i], b = maskB[i];
      out[i] = op === 'union' ? (a | b)
             : op === 'intersect' ? (a & b)
             : /* subtract: A - B */ (a & (1 - b));
    }
    const polys = _traceMask(out, W, H);
    return polys.map(poly => poly.map(p => ({ x: p.x / scale + minX, y: p.y / scale + minY })));
  }

  /** Apply a boolean op between two annotations of the same or different
   *  class within the same sample. Result rings are stored on `targetId`
   *  (subtract/intersect) or merge into a new/updated annotation (union).
   *  Works across rings sharing the same group_id per task.md §6. */
  function applyBooleanOp(sample, cls, targetId, otherRings, op) {
    if (!guardGeometryEdit(sample, cls, targetId)) return false;
    const ann = findAnnotation(sample, cls, targetId);
    if (!ann) return false;
    const resultRings = booleanOp(ann.rings, otherRings, op);
    return replaceGeometry(sample, cls, targetId, resultRings);
  }

  // ── §6 vertex-level editing (drag / insert / delete / simplify) ───────
  function moveVertex(sample, cls, id, ringIdx, vertIdx, newPt) {
    if (!guardGeometryEdit(sample, cls, id)) return false;
    const ann = findAnnotation(sample, cls, id);
    if (!ann || !ann.rings[ringIdx]) return false;
    const oldPt = { ...ann.rings[ringIdx][vertIdx] };
    ann.rings[ringIdx][vertIdx] = newPt;
    recomputeMetrics(ann);
    ann.last_editor = _currentUser();
    ann.updated_at = new Date().toISOString();
    markDirty(sample);
    pushUndo(sample, {
      undo: () => { ann.rings[ringIdx][vertIdx] = oldPt; recomputeMetrics(ann); },
      redo: () => { ann.rings[ringIdx][vertIdx] = newPt; recomputeMetrics(ann); },
    });
    _notify(sample);
    return true;
  }
  function insertVertex(sample, cls, id, ringIdx, afterVertIdx, newPt) {
    if (!guardGeometryEdit(sample, cls, id)) return false;
    const ann = findAnnotation(sample, cls, id);
    if (!ann || !ann.rings[ringIdx]) return false;
    ann.rings[ringIdx].splice(afterVertIdx + 1, 0, newPt);
    recomputeMetrics(ann);
    ann.last_editor = _currentUser();
    ann.updated_at = new Date().toISOString();
    markDirty(sample);
    pushUndo(sample, {
      undo: () => { ann.rings[ringIdx].splice(afterVertIdx + 1, 1); recomputeMetrics(ann); },
      redo: () => { ann.rings[ringIdx].splice(afterVertIdx + 1, 0, newPt); recomputeMetrics(ann); },
    });
    _notify(sample);
    return true;
  }
  function deleteVertex(sample, cls, id, ringIdx, vertIdx) {
    if (!guardGeometryEdit(sample, cls, id)) return false;
    const ann = findAnnotation(sample, cls, id);
    if (!ann || !ann.rings[ringIdx] || ann.rings[ringIdx].length <= 3) return false;
    const [removed] = ann.rings[ringIdx].splice(vertIdx, 1);
    recomputeMetrics(ann);
    ann.last_editor = _currentUser();
    ann.updated_at = new Date().toISOString();
    markDirty(sample);
    pushUndo(sample, {
      undo: () => { ann.rings[ringIdx].splice(vertIdx, 0, removed); recomputeMetrics(ann); },
      redo: () => { ann.rings[ringIdx].splice(vertIdx, 1); recomputeMetrics(ann); },
    });
    _notify(sample);
    return true;
  }
  /** Simplify/smooth via neighbor-averaging + Douglas-Peucker-ish decimation. */
  function simplifyRing(points, tolerancePx) {
    if (points.length < 4) return points;
    const tol2 = (tolerancePx || 1) ** 2;
    function distToSeg(p, a, b) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1e-9;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx, py = a.y + t * dy;
      return (p.x - px) ** 2 + (p.y - py) ** 2;
    }
    function rdp(pts) {
      if (pts.length < 3) return pts;
      let maxD = 0, idx = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const d = distToSeg(pts[i], pts[0], pts[pts.length - 1]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol2) {
        const left = rdp(pts.slice(0, idx + 1));
        const right = rdp(pts.slice(idx));
        return left.slice(0, -1).concat(right);
      }
      return [pts[0], pts[pts.length - 1]];
    }
    return rdp(points);
  }
  function simplifyAnnotation(sample, cls, id, tolerancePx) {
    if (!guardGeometryEdit(sample, cls, id)) return false;
    const ann = findAnnotation(sample, cls, id);
    if (!ann) return false;
    const newRings = ann.rings.map(r => simplifyRing(r, tolerancePx));
    return replaceGeometry(sample, cls, id, newRings);
  }

  // ── §11 ruler tool (single measurement at a time, per resolved decision) ─
  let ruler = null; // { start:{x,y}, end:{x,y}|null }
  function rulerStart(pt) { ruler = { start: pt, end: null }; }
  function rulerUpdate(pt) { if (ruler && !ruler.end) ruler.live = pt; }
  function rulerFinish(pt) { if (ruler) ruler.end = pt; }
  function rulerClear() { ruler = null; }
  function getRuler() { return ruler; }
  function rulerLengthPx() {
    if (!ruler) return 0;
    const end = ruler.end || ruler.live;
    if (!end) return 0;
    return Math.hypot(end.x - ruler.start.x, end.y - ruler.start.y);
  }

  // ── §8 persistence: save / load / autosave ─────────────────────────────
  function _serializeBucket(sample) {
    const b = _bucket(sample);
    return {
      library: b.library,
      positive: b.positive.map(a => ({ ...a, _promoted_class: 'positive' })),
      negative: b.negative.map(a => ({ ...a, _promoted_class: 'negative' })),
    };
  }
  function saveSample(sample) {
    const payload = { sample, class_colors: classColors, ...(_serializeBucket(sample)) };
    return fetch(baseUrl + '/annotations/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json()).then(res => {
      if (res && res.ok) { dirty[sample] = false; }
      return res;
    }).catch(() => ({ ok: false }));
  }
  function saveIfDirty(sample) {
    if (!isDirty(sample)) return Promise.resolve({ ok: true, skipped: true });
    return saveSample(sample);
  }
  function loadSample(sample) {
    return fetch(baseUrl + '/annotations/load?sample=' + encodeURIComponent(sample))
      .then(r => r.json())
      .then(res => {
        if (res && res.ok) {
          store[sample] = {
            library: res.library || [],
            positive: (res.positive || []).map(a => { const c = { ...a }; delete c._promoted_class; return c; }),
            negative: (res.negative || []).map(a => { const c = { ...a }; delete c._promoted_class; return c; }),
          };
          if (res.class_colors) Object.assign(classColors, res.class_colors);
          dirty[sample] = false;
        }
        _notify(sample);
        return res;
      }).catch(() => ({ ok: false }));
  }

  let _autosaveTimer = null;
  function startAutosave(getActiveSample, intervalMs) {
    stopAutosave();
    _autosaveTimer = setInterval(() => {
      const s = getActiveSample();
      if (s) saveIfDirty(s).then(res => {
        if (res && res.ok && !res.skipped) logAndRecord('Autosaved annotations for ' + s);
      });
      flushHistoryLog();
    }, intervalMs || 60000);
  }
  function stopAutosave() { if (_autosaveTimer) clearInterval(_autosaveTimer); _autosaveTimer = null; }

  // ── §13 export ──────────────────────────────────────────────────────────
  // Simplifies GeoJSON Polygon/MultiPolygon ring coordinate arrays in place
  // (image-px space, same units as the exported [x,y] pairs) using the same
  // Douglas-Peucker pass as simplifyRing, so "simplify on export" can trim
  // vertex count without needing a live annotation/ring object.
  function _simplifyCoordRing(coords, tolerancePx) {
    const pts = coords.map(c => ({ x: c[0], y: c[1] }));
    const simplified = simplifyRing(pts, tolerancePx);
    return simplified.map(p => [p.x, p.y]);
  }
  function simplifyFeatureCollection(fc, tolerancePx) {
    if (!fc || !fc.features || !tolerancePx) return fc;
    for (const feat of fc.features) {
      const geom = feat && feat.geometry;
      if (!geom) continue;
      if (geom.type === 'Polygon') {
        geom.coordinates = geom.coordinates.map(ring => _simplifyCoordRing(ring, tolerancePx));
      } else if (geom.type === 'MultiPolygon') {
        geom.coordinates = geom.coordinates.map(poly => poly.map(ring => _simplifyCoordRing(ring, tolerancePx)));
      }
    }
    return fc;
  }
  function exportGeoJSON(sampleOrAll, include, simplifyTolerancePx) {
    const inc = (include && include.length ? include : ['library', 'positive', 'negative']).join(',');
    const url = baseUrl + '/annotations/export?sample=' + encodeURIComponent(sampleOrAll) + '&include=' + encodeURIComponent(inc);
    return fetch(url).then(r => r.json()).then(fc => simplifyTolerancePx ? simplifyFeatureCollection(fc, simplifyTolerancePx) : fc);
  }
  function downloadGeoJSON(sampleOrAll, include, filename, simplifyTolerancePx) {
    return exportGeoJSON(sampleOrAll, include, simplifyTolerancePx).then(fc => {
      const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || ((sampleOrAll === 'all' ? 'annotations_all' : ('annotations_' + sampleOrAll)) + '.geojson');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      return fc;
    });
  }

  return {
    STATUS_VALUES,
    makeAnnotation, recomputeMetrics,
    assembleRingsIntoPieces, buildAnnotationsFromRings,
    addAnnotation, addAnnotationGroup, deleteAnnotation, deleteAnnotationGroup,
    replaceGeometry, findAnnotation, listAnnotations, listGroupSiblings, groupAnnotationsByGroupId,
    setStatus, editMetadata, isLocked, guardGeometryEdit, requestUnlockForEdit,
    promoteToPosNeg, promoteToLibrary,
    setClassColor, getClassColor, getClassColors, knownClasses,
    booleanOp, applyBooleanOp,
    moveVertex, insertVertex, deleteVertex, simplifyRing, simplifyAnnotation,
    rulerStart, rulerUpdate, rulerFinish, rulerClear, getRuler, rulerLengthPx,
    unitsForSample, formatArea, formatLength, computeAreaPx2, computePerimeterPx,
    markDirty, isDirty, undo, redo,
    saveSample, saveIfDirty, loadSample, startAutosave, stopAutosave,
    exportGeoJSON, downloadGeoJSON, simplifyFeatureCollection,
    logAndRecord, flushHistoryLog,
    selection,
  };
}
