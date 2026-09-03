/**
 * annotations_tab.js
 *
 * Builds the "Annotations" left-ribbon tab content (task.md §3/§4): a list of
 * library annotations for the active slide with rename/class/notes editing,
 * search/filter/sort, multi-select bulk actions, visibility/opacity toggles,
 * lock icons, a running summary, and promotion actions (§5) to/from
 * positive/negative.
 *
 * Exposes createAnnotationsTab({ container, annotations, annotationsCanvas,
 *   getActiveSample, viewport, settings, log, getPosNegCounts, getPosNegStrokes,
 *   onDeletePosNegStroke, onImportPosNegToAnnotation, modalHelpers }) → { refresh, onShow }
 */
function createAnnotationsTab({ container, annotations, annotationsCanvas, getActiveSample, viewport, settings, log, getPosNegCounts, getPosNegStrokes, onDeletePosNegStroke, onImportPosNegToAnnotation, modalHelpers }) {
  container.style.padding = '6px';
  container.style.gap = '6px';
  container.style.overflowY = 'auto';
  // Browser's native context menu (e.g. Jupyter's cell menu bleeding through)
  // has no use inside this panel; suppress it everywhere in the tab.
  container.addEventListener('contextmenu', e => e.preventDefault());

  let sortKey = 'label';
  let sortDir = 1;
  let filterText = '';
  let filterClass = '';
  let filterStatus = '';
  let selectedIds = new Set();

  // Deterministic per-class default color (used until the user overrides it
  // with the per-row color swatch), so classes are visually distinguishable
  // on the canvas/minimap without every class needing manual setup.
  const CLASS_PALETTE = ['#53d9ff', '#ffd23f', '#7cff6b', '#ff6bd8', '#ff8c42', '#a58bff', '#6bffe0', '#ff6b6b'];
  function _defaultClassColor(cls) {
    let h = 0;
    for (let i = 0; i < cls.length; i++) h = (h * 31 + cls.charCodeAt(i)) >>> 0;
    return CLASS_PALETTE[h % CLASS_PALETTE.length];
  }

  // ── toolbar: search / filter / sort ────────────────────────────────────
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex-shrink:0;';
  container.appendChild(bar);

  const searchInput = document.createElement('input');
  searchInput.placeholder = 'Search label/class/status\u2026';
  searchInput.style.cssText = 'width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:4px 6px;font:11px monospace;';
  searchInput.addEventListener('input', () => { filterText = searchInput.value.trim().toLowerCase(); refresh(); });
  bar.appendChild(searchInput);

  const sortRow = document.createElement('div');
  sortRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
  const sortSelect = document.createElement('select');
  sortSelect.style.cssText = 'flex:1;background:#111;color:#eee;border:1px solid #444;border-radius:4px;font:11px monospace;';
  for (const [val, label] of [['label', 'Label'], ['class', 'Class'], ['updated_at', 'Date'], ['area', 'Area']]) {
    const opt = document.createElement('option'); opt.value = val; opt.textContent = label; sortSelect.appendChild(opt);
  }
  sortSelect.addEventListener('change', () => { sortKey = sortSelect.value; refresh(); });
  const sortDirBtn = document.createElement('button');
  sortDirBtn.textContent = '\u2191';
  sortDirBtn.style.cssText = 'background:transparent;border:1px solid #666;color:#ddd;border-radius:4px;cursor:pointer;padding:2px 8px;';
  sortDirBtn.addEventListener('click', () => { sortDir *= -1; sortDirBtn.textContent = sortDir === 1 ? '\u2191' : '\u2193'; refresh(); });
  sortRow.appendChild(sortSelect);
  sortRow.appendChild(sortDirBtn);
  bar.appendChild(sortRow);

  const summaryEl = document.createElement('div');
  summaryEl.style.cssText = 'font:10px monospace;color:#8cf;padding:2px 0;flex-shrink:0;';
  container.appendChild(summaryEl);

  // "All" / "None" selection helpers, always visible above the bulk-action
  // row, so the user can select/deselect every currently-listed annotation
  // for deletion/export without clicking each checkbox individually.
  const selectRow = document.createElement('div');
  selectRow.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';
  container.appendChild(selectRow);
  let currentAnnIds = [];
  const selectAllBtn = document.createElement('button');
  selectAllBtn.textContent = 'All';
  selectAllBtn.style.cssText = 'background:#222;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;font:10px monospace;padding:2px 6px;';
  selectAllBtn.addEventListener('click', () => { selectedIds = new Set(currentAnnIds); refresh(); });
  selectRow.appendChild(selectAllBtn);
  const selectNoneBtn = document.createElement('button');
  selectNoneBtn.textContent = 'None';
  selectNoneBtn.style.cssText = 'background:#222;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;font:10px monospace;padding:2px 6px;';
  selectNoneBtn.addEventListener('click', () => { selectedIds.clear(); refresh(); });
  selectRow.appendChild(selectNoneBtn);
  const resetColorsBtn = document.createElement('button');
  resetColorsBtn.textContent = 'Reset colors';
  resetColorsBtn.title = 'Reset every class color to its default';
  resetColorsBtn.style.cssText = 'background:#222;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;font:10px monospace;padding:2px 6px;';
  resetColorsBtn.addEventListener('click', async () => {
    if (!modalHelpers) return;
    const ok = await modalHelpers.showConfirm('Reset all class colors to their defaults? This clears your saved class-color file.');
    if (!ok) return;
    await annotations.resetClassColors(getActiveSample());
    refresh();
    annotationsCanvas.redraw();
  });
  selectRow.appendChild(resetColorsBtn);

  const bulkRow = document.createElement('div');
  bulkRow.style.cssText = 'display:none;gap:4px;flex-wrap:wrap;flex-shrink:0;';
  container.appendChild(bulkRow);
  function _mkBulkBtn(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'background:#222;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;font:10px monospace;padding:2px 6px;';
    b.addEventListener('click', onClick);
    bulkRow.appendChild(b);
    return b;
  }
  _mkBulkBtn('Delete', () => {
    const sample = getActiveSample();
    if (!confirm(`Delete ${selectedIds.size} selected annotation(s)?`)) return;
    // Expand to whole groups (§6): deleting one piece of a multi-ring/hole
    // shape must remove every sibling sharing its group_id.
    const seenGroups = new Set();
    for (const id of selectedIds) {
      const ann = annotations.findAnnotation(sample, 'library', id);
      const gid = ann ? ann.group_id : id;
      if (seenGroups.has(gid)) continue;
      seenGroups.add(gid);
      annotations.deleteAnnotationGroup(sample, 'library', gid);
    }
    selectedIds.clear();
    refresh(); annotationsCanvas.redraw();
  });
  // Reduce vertex count of already-drawn contours (e.g. imported, or drawn
  // before turning on auto-simplify). Tolerance uses the same screen-px
  // setting as the auto-simplify-on-draw path, converted via the viewport's
  // *current* zoom level (the level the user is looking at when they choose
  // to simplify), so the visual fidelity trade-off is a screen concept
  // regardless of what zoom the contour was originally drawn at.
  _mkBulkBtn('Simplify', () => {
    if (!viewport || typeof annotations.simplifyAnnotation !== 'function') return;
    const sample = getActiveSample();
    const screenTolPx = (settings ? settings.get('contourSimplifyPx') : null) || 1.5;
    const { scale } = viewport.getTransform();
    const tolerancePx = screenTolPx / (scale || 1);
    for (const id of selectedIds) annotations.simplifyAnnotation(sample, 'library', id, tolerancePx);
    refresh(); annotationsCanvas.redraw();
  });
  _mkBulkBtn('Export selection', () => {
    const sample = getActiveSample();
    const anns = annotations.listAnnotations(sample, 'library').filter(a => selectedIds.has(a.id));
    // Group by group_id (§6): a group of one ring exports as a Polygon;
    // several sibling rings (disjoint noodle pieces / separately-added
    // holes) export as a single MultiPolygon feature, one polygon entry per
    // sibling annotation (each entry's own rings[0]=outer, rest=holes).
    const groups = annotations.groupAnnotationsByGroupId(anns);
    const fc = {
      type: 'FeatureCollection',
      features: groups.map(group => {
        const props = { ...group[0], rings: undefined };
        if (group.length === 1) {
          return { type: 'Feature', geometry: { type: 'Polygon', coordinates: group[0].rings.map(r => r.map(p => [p.x, p.y])) }, properties: props };
        }
        return {
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: group.map(a => a.rings.map(r => r.map(p => [p.x, p.y]))) },
          properties: props,
        };
      }),
    };
    const simplifyPx = (settings && settings.get('contourSimplifyOnExport')) ? settings.get('contourSimplifyExportPx') : 0;
    if (simplifyPx && typeof annotations.simplifyFeatureCollection === 'function') annotations.simplifyFeatureCollection(fc, simplifyPx);
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'annotations_selection.geojson';
    document.body.appendChild(a); a.click(); a.remove();
  });

  const listEl = document.createElement('div');
  listEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex:1 1 auto;overflow-y:auto;min-height:0;';
  container.appendChild(listEl);

  // ── row rendering ───────────────────────────────────────────────────────
  function _rowEl(ann, sample) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:5px 6px;border:1px solid #333;border-radius:5px;background:#191919;cursor:pointer;';
    row.dataset.annId = ann.id;
    row.addEventListener('contextmenu', e => e.preventDefault());

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:5px;';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(ann.id);
    checkbox.addEventListener('click', e => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(ann.id); else selectedIds.delete(ann.id);
      _syncBulkRow();
    });
    top.appendChild(checkbox);

    // const lockIcon = document.createElement('span');
    // lockIcon.textContent = annotations.isLocked(ann) ? '\ud83d\udd12' : '\ud83d\udd13';
    // lockIcon.title = 'Status: ' + ann.status;
    // top.appendChild(lockIcon);

    // Class input with a custom (non-native) dropdown, plus its color
    // swatch, now on the top row right after the checkbox. Unlike a
    // <datalist>, this always lists every known class regardless of what's
    // currently typed in the input — datalist filtering is native browser
    // behavior (and inconsistent across browsers) that can't be turned off,
    // so a small hand-rolled overlay is used instead.
    const classWrap = document.createElement('div');
    classWrap.style.cssText = 'position:relative;display:inline-block;';

    const classInput = document.createElement('input');
    classInput.value = ann.class;
    classInput.placeholder = 'class';
    classInput.autocomplete = 'off';
    classInput.style.cssText = 'width:80px;background:#111;border:1px solid #333;border-radius:3px;color:#9de0f5;font:10px monospace;';
    classInput.addEventListener('click', e => { e.stopPropagation(); _openClassDropdown(); });
    classInput.addEventListener('focus', () => _openClassDropdown());
    classInput.addEventListener('blur', () => { classDropdown.style.display = 'none'; });
    classInput.addEventListener('change', () => {
      const apply = () => {
        annotations.editMetadata(sample, 'library', ann.id, { class: classInput.value });
        colorInput.title = 'Color for class "' + classInput.value + '"';
        colorInput.value = annotations.getClassColor(classInput.value) || _defaultClassColor(classInput.value);
        refresh();
      };
      // Editing a reviewed annotation's metadata needs the same confirm
      // dialog as a geometry edit (annotations_canvas.js); a canceled dialog
      // just re-renders the row so the input snaps back to its saved value.
      if (annotations.isLocked(ann)) annotations.requestUnlockForEdit(sample, 'library', ann.id).then(ok => ok ? apply() : refresh());
      else apply();
    });
    classWrap.appendChild(classInput);

    const classDropdown = document.createElement('div');
    classDropdown.style.cssText = 'display:none;position:absolute;top:100%;left:0;z-index:20;background:#181818;border:1px solid #444;border-radius:4px;max-height:140px;overflow-y:auto;min-width:100px;box-shadow:0 2px 6px rgba(0,0,0,.5);';
    classWrap.appendChild(classDropdown);

    function _openClassDropdown() {
      const classes = annotations.knownClasses(sample);
      classDropdown.innerHTML = '';
      if (!classes.length) { classDropdown.style.display = 'none'; return; }
      for (const cls of classes) {
        const opt = document.createElement('div');
        opt.textContent = cls;
        opt.style.cssText = 'padding:3px 6px;font:10px monospace;color:#ddd;cursor:pointer;white-space:nowrap;';
        opt.addEventListener('mouseenter', () => opt.style.background = '#2a2a2a');
        opt.addEventListener('mouseleave', () => opt.style.background = 'transparent');
        // mousedown fires before the input's blur, so the selection
        // registers before the dropdown gets hidden by the blur handler.
        opt.addEventListener('mousedown', e => {
          e.preventDefault();
          classInput.value = cls;
          classDropdown.style.display = 'none';
          classInput.dispatchEvent(new Event('change'));
        });
        classDropdown.appendChild(opt);
      }
      classDropdown.style.display = 'block';
    }

    top.appendChild(classWrap);

    // Per-class color swatch (§ class designation): drives canvas/minimap
    // stroke color for every annotation sharing this class — stored globally
    // in annotations.js so it applies to every instance of the class and is
    // persisted alongside the rest of the annotation data.
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = annotations.getClassColor(ann.class) || _defaultClassColor(ann.class);
    colorInput.title = 'Color for class "' + ann.class + '"';
    colorInput.style.cssText = 'width:18px;height:18px;border:none;background:none;cursor:pointer;padding:0;';
    colorInput.addEventListener('click', e => e.stopPropagation());
    // 'input' fires continuously while the native color popup is still open
    // (e.g. every drag tick); update live (silent: no dirty/notify, so
    // nothing rebuilds the Annotations list) so the swatch/canvas preview
    // the color without tearing down the <input> the popup is anchored to
    // — doing that would force-close the still-open native picker. 'change'
    // fires once the popup actually closes, so it's safe to persist +
    // refresh there.
    colorInput.addEventListener('input', () => {
      annotations.setClassColor(sample, ann.class, colorInput.value, true);
      annotationsCanvas.redraw();
    });
    colorInput.addEventListener('change', () => {
      annotations.setClassColor(sample, ann.class, colorInput.value);
      refresh();
    });
    top.appendChild(colorInput);
    if (!annotations.getClassColor(ann.class)) annotations.setClassColor(sample, ann.class, colorInput.value);

    // Label field now lives on the second (meta) row. Defaults to an empty
    // string (rather than a placeholder value like "Untitled") so a fresh
    // annotation just shows an empty box with a "Notes" placeholder hint.
    const labelEl = document.createElement('input');
    labelEl.value = ann.label || '';
    labelEl.placeholder = 'Notes';
    labelEl.style.cssText = 'flex:1;min-width:100px;background:#111;border:1px solid #333;border-radius:3px;color:#eee;font:10px monospace;padding:2px 4px;';
    labelEl.addEventListener('click', e => e.stopPropagation());
    labelEl.addEventListener('change', () => {
      const apply = () => { annotations.editMetadata(sample, 'library', ann.id, { label: labelEl.value }); refresh(); };
      if (annotations.isLocked(ann)) annotations.requestUnlockForEdit(sample, 'library', ann.id).then(ok => ok ? apply() : refresh());
      else apply();
    });
    top.appendChild(labelEl);




    const visBtn = document.createElement('button');
    let visible = true;
    visBtn.textContent = '👀';
    visBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;font-size:13px;';
    visBtn.addEventListener('click', e => {
      e.stopPropagation();
      visible = !visible;
      visBtn.style.opacity = visible ? '1' : '0.35';
      annotationsCanvas.setVisibility(ann.id, visible);
    });
    top.appendChild(visBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '\u2715';
    delBtn.title = 'Delete';
    delBtn.style.cssText = 'background:transparent;border:none;color:#f66;cursor:pointer;font-size:12px;';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      // Delete the whole group_id group (§6) so a single click removes every
      // sibling ring/hole belonging to this logical annotation.
      annotations.deleteAnnotationGroup(sample, 'library', ann.group_id); refresh(); annotationsCanvas.redraw();
    });
    top.appendChild(delBtn);
    row.appendChild(top);

    const meta = document.createElement('div');
    meta.style.cssText = 'font:10px monospace;color:#999;display:flex;gap:8px;flex-wrap:wrap;align-items:center;';

    // Quick status designation: exclusive push-buttons instead of a dropdown
    // (task feedback: faster than opening a <select>). "Draft" is pressed by
    // default; clicking another status un-presses it.
    const statusRow = document.createElement('div');
    statusRow.style.cssText = 'display:flex;gap:2px;';
    for (const s of annotations.STATUS_VALUES) {
      const b = document.createElement('button');
      b.textContent = s.replace('_', ' ');
      b.title = s;
      const active = s === ann.status;
      b.style.cssText = 'font:9px monospace;padding:2px 4px;border-radius:3px;cursor:pointer;' +
        (active ? 'background: #747474;border:1px solid #a2a2a2;color:#012;' : 'background:#111;border:1px solid #333;color:#999;');
      b.addEventListener('click', e => { e.stopPropagation(); annotations.setStatus(sample, 'library', ann.id, s); refresh(); });
      statusRow.appendChild(b);
    }
    const toPos = document.createElement('button');
    toPos.textContent = 'Copy';
    toPos.style.cssText = 'background:#123;border:1px solid #22f0ff;color:#22f0ff;border-radius:3px;font:9px monospace;cursor:pointer;';
    toPos.addEventListener('click', e => { e.stopPropagation(); annotations.promoteToPosNeg(sample, ann.id, 'positive'); refresh(); });
    const toNeg = document.createElement('button');
    toNeg.textContent = 'Copy';
    toNeg.style.cssText = 'background:#321;border:1px solid #ff5233;color:#ff5233;border-radius:3px;font:9px monospace;cursor:pointer;';
    toNeg.addEventListener('click', e => { e.stopPropagation(); annotations.promoteToPosNeg(sample, ann.id, 'negative'); refresh(); });
    statusRow.appendChild(toPos); statusRow.appendChild(toNeg);
    const areaEl = document.createElement('span');
    const rounded_area = Math.round(ann.area * 100) / 100;
    areaEl.textContent = annotations.formatArea(rounded_area, sample);
    areaEl.style.cssText = 'white-space:nowrap;flex-shrink:0;padding:2px 5px;border-radius:8px;background:#111;border:1px solid #333;color:#999;font:9px monospace;';
    statusRow.appendChild(areaEl);
    meta.appendChild(statusRow);
    row.appendChild(meta);

    row.addEventListener('click', () => {
      annotationsCanvas.setSelected(ann.id);
      annotationsCanvas.panZoomTo(ann);
    });
    return row;
  }

  function _syncBulkRow() {
    bulkRow.style.display = selectedIds.size ? 'flex' : 'none';
  }

  function _summaryText(sample) {
    const anns = annotations.listAnnotations(sample, 'library');
    const byClass = {};
    for (const a of anns) { byClass[a.class] = (byClass[a.class] || 0) + a.area; }
    const parts = Object.entries(byClass).map(([c, areaPx2]) => `${c}: ${annotations.formatArea(areaPx2, sample)}`);
    // Positive/negative counts come from the pre-existing draw+/draw- stroke
    // system (strokesBySample in boot.js), not from this module's own
    // 'positive'/'negative' promoted-copy buckets, so the summary reflects
    // what the pathologist actually drew with the original tools.
    if (typeof getPosNegCounts === 'function') {
      const counts = getPosNegCounts(sample) || { positive: 0, negative: 0 };
      parts.push(`positive: ${counts.positive}`, `negative: ${counts.negative}`);
    } else {
      const pos = annotations.listAnnotations(sample, 'positive');
      const neg = annotations.listAnnotations(sample, 'negative');
      parts.push(`positive: ${pos.length}`, `negative: ${neg.length}`);
    }
    return `${anns.length} annotation(s) \u2014 ` + parts.join(' | ');
  }

  // ── draw+/draw- stroke rows (task feedback: these need to show up in the
  // list too, not just as a summary count) ───────────────────────────────
  // Several raw strokes can share one group_id (e.g. a noodle-brush sweep
  // that traced multiple contour pieces, some possibly holes of others), so
  // they must render/act as ONE row instead of one row per raw stroke.
  function _strokeRowEl(strokes, cls, sample) {
    const primary = strokes[0];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid #333;border-radius:5px;background:#151515;';
    row.addEventListener('contextmenu', e => e.preventDefault());
    const dot = document.createElement('span');
    dot.textContent = '\u25cf';
    dot.style.color = cls === 'negative' ? '#ff5233' : '#22f0ff';
    row.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = strokes.length > 1 ? `${cls} stroke (${strokes.length} contours)` : `${cls} stroke`;
    label.style.cssText = 'flex:1;color:#ccc;font:11px monospace;';
    row.appendChild(label);
    const areaEl = document.createElement('span');
    areaEl.style.cssText = 'font:10px monospace;color:#999;';
    // Each stroke object already carries its own outer ring (points) plus
    // any hole rings (holes) as one assembled piece; sum those per-piece
    // areas (not a flat sum of every raw ring) so a hole correctly
    // subtracts rather than inflating the total.
    const totalArea = strokes.reduce((sum, s) => sum + annotations.computeAreaPx2([s.points, ...(s.holes || [])]), 0);
    areaEl.textContent = annotations.formatArea(totalArea, sample);
    row.appendChild(areaEl);
    const toAnnoBtn = document.createElement('button');
    toAnnoBtn.textContent = 'Copy \u2192 anno';
    toAnnoBtn.title = 'Copy this contour (all parts) into the annotation library';
    toAnnoBtn.style.cssText = 'background:#222;border:1px solid #ffd23f;color:#ffd23f;border-radius:3px;font:9px monospace;cursor:pointer;';
    toAnnoBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (typeof onImportPosNegToAnnotation === 'function') onImportPosNegToAnnotation(sample, cls, primary);
      refresh();
    });
    row.appendChild(toAnnoBtn);
    const delBtn = document.createElement('button');
    delBtn.textContent = '\u2715';
    delBtn.title = 'Delete';
    delBtn.style.cssText = 'background:transparent;border:none;color:#f66;cursor:pointer;font-size:12px;';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (typeof onDeletePosNegStroke === 'function') for (const s of strokes) onDeletePosNegStroke(sample, cls, s.id);
      refresh();
    });
    row.appendChild(delBtn);
    return row;
  }

  function refresh() {
    const sample = getActiveSample();
    listEl.innerHTML = '';
    if (!sample) return;
    let anns = annotations.listAnnotations(sample, 'library').slice();
    if (filterText) {
      anns = anns.filter(a =>
        a.label.toLowerCase().includes(filterText) ||
        a.class.toLowerCase().includes(filterText) ||
        a.status.toLowerCase().includes(filterText));
    }
    anns.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
    // Track the ids currently on screen (post filter/sort) so "All" selects
    // exactly what's visible, not every annotation that ever existed.
    currentAnnIds = anns.map(a => a.id);
    for (const ann of anns) listEl.appendChild(_rowEl(ann, sample));
    if (typeof getPosNegStrokes === 'function') {
      const strokes = getPosNegStrokes(sample) || { strokes_positive: [], strokes_negative: [] };
      // Group raw strokes by group_id (falling back to each stroke's own id
      // when ungrouped) so several contour pieces from one noodle sweep
      // render as a single list row instead of one row per piece.
      const _groupStrokes = list => {
        const order = [];
        const groups = new Map();
        for (const s of (list || [])) {
          const gid = s.group_id !== undefined ? s.group_id : s.id;
          if (!groups.has(gid)) { groups.set(gid, []); order.push(gid); }
          groups.get(gid).push(s);
        }
        return order.map(gid => groups.get(gid));
      };
      for (const group of _groupStrokes(strokes.strokes_positive)) listEl.appendChild(_strokeRowEl(group, 'positive', sample));
      for (const group of _groupStrokes(strokes.strokes_negative)) listEl.appendChild(_strokeRowEl(group, 'negative', sample));
    }
    summaryEl.textContent = _summaryText(sample);
    _syncBulkRow();
  }

  return { refresh, onShow: refresh };
}