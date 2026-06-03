/**
 * hover.js
 *
 * Spatial index + hover/click interactivity for the DIANNE viewer.
 *
 * Provides:
 *   SpatialIndex — grid-hash spatial index (world coordinates), reused for
 *                  cells and transcripts separately.
 *   createHoverInteraction(container, viewport, baseUrl)
 *       .addCells(cells, sample)        — feed tile cells into the index
 *       .addTranscripts(points, sample) — feed transcript points (grid 0 only)
 *       .clearSample(sample)            — reset index on sample switch
 *       .setDrawRef(draw)               — attach draw object for contour tests
 *       .setHasTranscripts(bool)        — flag whether transcripts exist
 *       .onMouseMove(vpX, vpY)          — throttled via requestAnimationFrame
 *       .onMouseClick(vpX, vpY)         — show rich click panel
 *       .onMouseLeave()                 — hide tooltip on container leave
 *
 * No external dependencies; runs in a plain browser context (Jupyter).
 */

// ── SpatialIndex ──────────────────────────────────────────────────────────────
class SpatialIndex {
  /**
   * @param {number} cellSize  Grid cell size in world (image-pixel) units.
   *                           Choose ~3-5× the typical inter-point spacing.
   */
  constructor(cellSize = 100) {
    this._cs   = cellSize;
    this._grid = new Map();   // string key → [{x, y, data}]
    this._n    = 0;           // total items
  }

  _key(gx, gy) { return gx + ',' + gy; }

  /** Add an item at world position (x, y). data is returned verbatim by queries. */
  add(x, y, data) {
    const gx = Math.floor(x / this._cs);
    const gy = Math.floor(y / this._cs);
    const k  = this._key(gx, gy);
    let bucket = this._grid.get(k);
    if (!bucket) { bucket = []; this._grid.set(k, bucket); }
    bucket.push({ x, y, data });
    this._n++;
  }

  /**
   * Nearest item within maxDist world units.
   * Returns `data` of the nearest item, or null if none within maxDist.
   */
  nearest(x, y, maxDist) {
    const r    = Math.ceil(maxDist / this._cs);
    const gx0  = Math.floor(x / this._cs);
    const gy0  = Math.floor(y / this._cs);
    const md2  = maxDist * maxDist;
    let best   = null;
    let bestD2 = md2 + 1e-10;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const bucket = this._grid.get(this._key(gx0 + dx, gy0 + dy));
        if (!bucket) continue;
        for (const item of bucket) {
          const d2 = (item.x - x) * (item.x - x) + (item.y - y) * (item.y - y);
          if (d2 < bestD2) { bestD2 = d2; best = item.data; }
        }
      }
    }
    return best;
  }

  /**
   * All items whose world position falls strictly inside the bounding box
   * [x0..x1] × [y0..y1].
   */
  queryBbox(x0, y0, x1, y1) {
    const gx0 = Math.floor(x0 / this._cs);
    const gy0 = Math.floor(y0 / this._cs);
    const gx1 = Math.floor(x1 / this._cs);
    const gy1 = Math.floor(y1 / this._cs);
    const result = [];
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const bucket = this._grid.get(this._key(gx, gy));
        if (!bucket) continue;
        for (const item of bucket) {
          if (item.x >= x0 && item.x <= x1 && item.y >= y0 && item.y <= y1)
            result.push(item.data);
        }
      }
    }
    return result;
  }

  clear() { this._grid.clear(); this._n = 0; }
  get size() { return this._n; }
}

// ── createHoverInteraction ────────────────────────────────────────────────────
function createHoverInteraction(container, viewport, baseUrl) {

  // One SpatialIndex per entity type; both share the same class.
  const cellIndex = new SpatialIndex(100);   // image-px grid cells
  const txIndex   = new SpatialIndex(50);    // tighter grid for denser transcripts

  // Deduplicate cells by cell_id (not by tile key) — the same cell appears in
  // tiles at every pyramid level, so tile-key dedup would still allow
  // multi-level duplicates to inflate contour counts.
  const _indexedCellIds   = new Set();
  const _indexedTxTiles   = new Set();  // transcripts: tile-key dedup is fine (coords differ by grid)

  let currentSample  = null;
  let drawRef        = null;
  let hasTranscripts = false;

  // ── Tooltip (floating, never redraws canvas) ──────────────────────────────
  // Remove any leftover tooltip from a previous viewer instance in this page.
  document.querySelectorAll('[data-iv-hover-tooltip]').forEach(el => el.remove());
  const tooltip = document.createElement('div');
  tooltip.dataset.ivHoverTooltip = '1';
  tooltip.style.cssText = [
    'position:fixed', 'z-index:99999', 'pointer-events:none',
    'background:rgba(12,16,24,0.93)', 'color:#e8eaf0',
    'border:1px solid rgba(100,150,255,0.35)', 'border-radius:7px',
    'padding:5px 10px', 'font:12px monospace', 'line-height:1.55',
    'max-width:300px', 'white-space:pre-wrap', 'word-break:break-word',
    'box-shadow:0 3px 14px rgba(0,0,0,0.65)', 'display:none',
  ].join(';');
  document.body.appendChild(tooltip);

  // Hide tooltip on fullscreen change (e.g. custom ⛶ toggle) and tab switch.
  const _hideOnFsChange = () => _hideTooltip();
  document.addEventListener('fullscreenchange', _hideOnFsChange);
  document.addEventListener('visibilitychange', _hideOnFsChange);
  // Hide on any scroll/wheel inside the container (viewport shift invalidates position).
  container.addEventListener('wheel',  _hideOnFsChange, { passive: true });
  container.addEventListener('scroll', _hideOnFsChange, { passive: true });
  // Hide when mouse button goes down anywhere (pan start, etc.).
  container.addEventListener('mousedown', _hideOnFsChange);

  // ── Sidebar panel (click details) ────────────────────────────────────────
  const sidebar = document.createElement('div');
  sidebar.dataset.ivUi = 'true';
  sidebar.style.cssText = [
    'position:absolute', 'top:8px', 'right:8px', 'z-index:22',
    'width:252px', 'max-height:calc(100% - 60px)', 'overflow-y:auto',
    'background:rgba(9,13,21,0.96)', 'color:#dde',
    'border:1px solid rgba(70,110,190,0.45)', 'border-radius:9px',
    'padding:10px 12px', 'font:12px monospace', 'line-height:1.5',
    'box-shadow:0 4px 22px rgba(0,0,0,0.75)', 'display:none',
    'scrollbar-width:thin', 'scrollbar-color:#334 #111',
  ].join(';');
  container.appendChild(sidebar);

  // ── Hover history bar (last 5 hovered cells) ─────────────────────────────
  const historyBar = document.createElement('div');
  historyBar.dataset.ivUi = 'true';
  historyBar.style.cssText = [
    'position:absolute', 'bottom:28px', 'left:8px', 'z-index:13',
    'display:none', 'flex-direction:row', 'gap:4px', 'align-items:center',
    'background:rgba(0,0,0,0.62)', 'border-radius:6px',
    'padding:3px 7px', 'font:11px monospace',
  ].join(';');
  const _histLbl = document.createElement('span');
  _histLbl.textContent = 'Recent:';
  _histLbl.style.cssText = 'color:#557;margin-right:2px;flex-shrink:0;';
  historyBar.appendChild(_histLbl);

  const historyChips = [];
  for (let i = 0; i < 5; i++) {
    const chip = document.createElement('span');
    chip.style.cssText = [
      'display:none', 'padding:1px 7px', 'border-radius:4px',
      'background:rgba(50,70,110,0.75)', 'color:#a8c8ee',
      'cursor:pointer', 'border:1px solid rgba(80,120,190,0.4)',
      'white-space:nowrap', 'max-width:110px',
      'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';');
    chip.addEventListener('click', () => {
      if (chip._cellData) _showCellPanel(chip._cellData);
    });
    historyBar.appendChild(chip);
    historyChips.push(chip);
  }
  container.appendChild(historyBar);

  const hoverHistory = [];  // [{cell_id, category, x, y, ...}]

  // ── Selection highlight canvas (glowing outline on clicked cell) ─────────
  const selCanvas = document.createElement('canvas');
  selCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:21;';
  container.appendChild(selCanvas);
  const selCtx = selCanvas.getContext('2d');
  let _selectedCell = null;

  function _resizeSelCanvas() {
    selCanvas.width  = container.clientWidth  || 1;
    selCanvas.height = container.clientHeight || 1;
    _drawSelectionHighlight();
  }
  new ResizeObserver(_resizeSelCanvas).observe(container);
  _resizeSelCanvas();

  // Redraw on every viewport change so the outline tracks pan/zoom.
  viewport.onChange(_drawSelectionHighlight);

  function _drawSelectionHighlight() {
    selCtx.clearRect(0, 0, selCanvas.width, selCanvas.height);
    if (!_selectedCell) return;
    const cell = _selectedCell;
    const t = Date.now() / 600;   // slow pulse
    const glow = 6 + 3 * Math.sin(t);

    selCtx.save();
    selCtx.strokeStyle = '#ffe600';
    selCtx.lineWidth   = 2.5;
    selCtx.shadowColor = '#ffe600';
    selCtx.shadowBlur  = glow * 3;

    if (cell.boundary && cell.boundary.length >= 3) {
      // Draw the actual cell boundary polygon.
      selCtx.beginPath();
      let first = true;
      for (const [bx, by] of cell.boundary) {
        const sp = viewport.toScreenSpace(bx, by);
        if (first) { selCtx.moveTo(sp.x, sp.y); first = false; }
        else        { selCtx.lineTo(sp.x, sp.y); }
      }
      selCtx.closePath();
      selCtx.stroke();
    } else {
      // Fallback: glowing circle at cell centre.
      const sp = viewport.toScreenSpace(cell.x, cell.y);
      const { scale } = viewport.getTransform();
      const r = Math.max(4, 7 / scale);
      selCtx.beginPath();
      selCtx.arc(sp.x, sp.y, r, 0, 2 * Math.PI);
      selCtx.stroke();
    }
    selCtx.restore();

    // Keep pulsing while panel is open.
    if (sidebar.style.display !== 'none') {
      requestAnimationFrame(_drawSelectionHighlight);
    }
  }

  function _setSelectionHighlight(cell) {
    _selectedCell = cell;
    _drawSelectionHighlight();
  }

  function _clearSelectionHighlight() {
    _selectedCell = null;
    selCtx.clearRect(0, 0, selCanvas.width, selCanvas.height);
  }

  // ── rAF throttle state ─────────────────────────────────────────────────────
  let _rafPending = false;
  let _pendVpX = 0, _pendVpY = 0;

  // ── Geometry helpers ───────────────────────────────────────────────────────
  function _pip(x, y, pts) {
    // Ray-casting point-in-polygon.
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
        inside = !inside;
    }
    return inside;
  }

  function _polyBbox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  // ── Contour helpers ────────────────────────────────────────────────────────
  function _getContourAt(imgX, imgY) {
    if (!drawRef) return null;
    // Respect the strokes visibility toggle (👀 button in toolbar).
    if (typeof drawRef.getVisible === 'function' && !drawRef.getVisible()) return null;
    const { strokes_positive, strokes_negative } = drawRef.getStrokes();
    for (const stroke of [...(strokes_positive || []), ...(strokes_negative || [])]) {
      if (stroke.points && stroke.points.length >= 3 &&
          _pip(imgX, imgY, stroke.points))
        return stroke;
    }
    return null;
  }

  function _contourStats(stroke) {
    const pts = stroke.points;
    const bb = _polyBbox(pts);
    const candidates = cellIndex.queryBbox(bb.minX, bb.minY, bb.maxX, bb.maxY);
    const counts = {};
    let total = 0;
    for (const cell of candidates) {
      if (_pip(cell.x, cell.y, pts)) {
        total++;
        const cat = (cell.category != null) ? String(cell.category) : 'All';
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    return { total, counts };
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────
  function _showTooltip(vpX, vpY, html) {
    const r  = container.getBoundingClientRect();
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    const tx = r.left + vpX + 18;
    const ty = r.top  + vpY + 6;
    // Keep within viewport
    const maxX = window.innerWidth  - tooltip.offsetWidth  - 8;
    const maxY = window.innerHeight - tooltip.offsetHeight - 8;
    tooltip.style.left = Math.min(tx, maxX) + 'px';
    tooltip.style.top  = Math.min(ty, maxY) + 'px';
  }
  function _hideTooltip() { tooltip.style.display = 'none'; }

  // ── Sidebar builders ───────────────────────────────────────────────────────
  function _closeSidebar() {
    sidebar.style.display = 'none';
    sidebar.innerHTML = '';
    // Remove the capture-phase Esc listener that was guarding this panel.
    document.removeEventListener('keydown', _sidebarEscHandler, true);
    _clearSelectionHighlight();
  }

  // Capture-phase Esc handler: fires before all bubble-phase listeners
  // (including the fullscreen onFsKeyDown), so fullscreen is never exited
  // while the panel is open. Mirrors the pattern used in toolbar modals.
  function _sidebarEscHandler(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.stopImmediatePropagation();
      e.preventDefault();
      _closeSidebar();
    }
  }

  function _registerSidebarEsc() {
    // Remove first to avoid stacking duplicate listeners if panel is re-opened.
    document.removeEventListener('keydown', _sidebarEscHandler, true);
    document.addEventListener('keydown', _sidebarEscHandler, true);
  }

  function _mkHdr(title) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;' +
      'margin-bottom:8px;border-bottom:1px solid rgba(80,120,200,0.28);padding-bottom:6px;';
    const tEl = document.createElement('span');
    tEl.style.cssText = 'color:#7ac;font-weight:700;font-size:13px;';
    tEl.textContent = title;
    const xBtn = document.createElement('button');
    xBtn.textContent = '×';
    xBtn.style.cssText = 'background:none;border:none;color:#778;font-size:17px;' +
      'cursor:pointer;line-height:1;padding:0;flex-shrink:0;';
    xBtn.addEventListener('click', _closeSidebar);
    hdr.appendChild(tEl); hdr.appendChild(xBtn);
    return hdr;
  }

  function _mkSection(label) {
    const el = document.createElement('div');
    el.style.cssText = 'color:#6a90b8;font-size:10px;text-transform:uppercase;' +
      'letter-spacing:0.06em;margin:7px 0 3px;';
    el.textContent = label;
    return el;
  }

  function _mkBarChart(entries, maxBars) {
    maxBars = maxBars || 15;
    const wrap = document.createElement('div');
    if (!entries || !entries.length) {
      wrap.innerHTML = '<span style="color:#446;font-size:11px;">No data</span>';
      return wrap;
    }
    const top    = entries.slice(0, maxBars);
    const maxVal = top[0][1] || 1;
    for (const [gene, count] of top) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:5px;margin:2px 0;';
      const nm = document.createElement('span');
      nm.textContent = gene;
      nm.title = gene;
      nm.style.cssText = 'width:95px;overflow:hidden;text-overflow:ellipsis;' +
        'white-space:nowrap;color:#bbd;font-size:11px;flex-shrink:0;';
      const bw = document.createElement('div');
      bw.style.cssText = 'flex:1;height:9px;background:#111a2a;border-radius:3px;overflow:hidden;';
      const bf = document.createElement('div');
      bf.style.cssText = 'height:100%;width:' + Math.round(count / maxVal * 100) +
        '%;background:linear-gradient(90deg,#2455d0,#4ab0ff);border-radius:3px;';
      bw.appendChild(bf);
      const cn = document.createElement('span');
      cn.textContent = String(count);
      cn.style.cssText = 'color:#778;font-size:10px;min-width:24px;text-align:right;flex-shrink:0;';
      row.appendChild(nm); row.appendChild(bw); row.appendChild(cn);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function _mkCategoryBreakdown(counts) {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return null;
    const wrap = document.createElement('div');
    const maxVal = entries[0][1] || 1;
    for (const [cat, cnt] of entries) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:5px;margin:2px 0;';
      const nm = document.createElement('span');
      nm.textContent = cat;
      nm.title = cat;
      nm.style.cssText = 'width:90px;overflow:hidden;text-overflow:ellipsis;' +
        'white-space:nowrap;color:#bbd;font-size:11px;flex-shrink:0;';
      const bw = document.createElement('div');
      bw.style.cssText = 'flex:1;height:9px;background:#111a2a;border-radius:3px;overflow:hidden;';
      const bf = document.createElement('div');
      bf.style.cssText = 'height:100%;width:' + Math.round(cnt / maxVal * 100) +
        '%;background:#2a5aab;border-radius:3px;';
      bw.appendChild(bf);
      const cn = document.createElement('span');
      cn.textContent = String(cnt);
      cn.style.cssText = 'color:#778;font-size:10px;min-width:24px;text-align:right;flex-shrink:0;';
      row.appendChild(nm); row.appendChild(bw); row.appendChild(cn);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // ── Hover history ──────────────────────────────────────────────────────────
  function _addToHistory(cell) {
    if (hoverHistory.length && hoverHistory[0].cell_id === cell.cell_id) return;
    hoverHistory.unshift(cell);
    if (hoverHistory.length > 5) hoverHistory.pop();
    _renderHistory();
  }

  function _renderHistory() {
    if (!hoverHistory.length) { historyBar.style.display = 'none'; return; }
    historyBar.style.display = 'flex';
    for (let i = 0; i < 5; i++) {
      const chip = historyChips[i];
      if (i < hoverHistory.length) {
        const cell = hoverHistory[i];
        const catShort = (cell.category != null) ? String(cell.category) : 'Cell';
        chip.style.display = 'inline-block';
        chip.textContent   = catShort + ' #' + cell.cell_id;
        chip._cellData     = cell;
        chip.title         = 'Cell ' + cell.cell_id + ' — ' + catShort + '  (click to inspect)';
      } else {
        chip.style.display = 'none';
        chip._cellData     = null;
      }
    }
  }

  // ── doHover (called from rAF) ─────────────────────────────────────────────
  function _doHover(vpX, vpY) {
    const { x: imgX, y: imgY } = viewport.toImageSpace(vpX, vpY);
    const { scale } = viewport.getTransform();
    const hitR = 14 / scale;   // 14 screen pixels → image units

    // Priority 1 — drawn contour
    const contour = _getContourAt(imgX, imgY);
    if (contour) {
      const stats = _contourStats(contour);
      const bkd   = Object.entries(stats.counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const bkdHtml = bkd.map(([c, n]) =>
        `<span style="color:#99b;">${c}: ${n}</span>`).join('<br>');
      _showTooltip(vpX, vpY,
        `<b style="color:#7ac;">Contour</b>&nbsp;` +
        `<span style="color:#dde;">${stats.total} cells</span>` +
        (bkdHtml ? '<br>' + bkdHtml : ''));
      return;
    }

    // Priority 2 — nearest cell
    const cell = cellIndex.nearest(imgX, imgY, hitR);
    if (cell) {
      const cat = (cell.category != null) ? String(cell.category) : '';
      _showTooltip(vpX, vpY,
        `<b style="color:#7ac;">Cell&nbsp;${cell.cell_id}</b>` +
        (cat ? `<br><span style="color:#a8c8a0;">${cat}</span>` : ''));
      _addToHistory(cell);
      return;
    }

    // Priority 3 — nearest transcript (only when transcripts layer is active)
    if (hasTranscripts && txIndex.size > 0) {
      const tx = txIndex.nearest(imgX, imgY, hitR * 1.6);
      if (tx) {
        _showTooltip(vpX, vpY,
          `<b style="color:#f0c060;">${tx.gene}</b>`);
        return;
      }
    }

    _hideTooltip();
  }

  // ── _showCellPanel ────────────────────────────────────────────────────────
  function _showCellPanel(cell) {
    sidebar.innerHTML = '';
    sidebar.style.display = 'block';
    _registerSidebarEsc();
    _setSelectionHighlight(cell);
    sidebar.appendChild(_mkHdr('Cell ' + cell.cell_id));

    if (cell.category != null) {
      sidebar.appendChild(_mkSection('Type / Cluster'));
      const typeEl = document.createElement('div');
      typeEl.textContent = String(cell.category);
      typeEl.style.cssText = 'color:#a0c898;margin-bottom:2px;';
      sidebar.appendChild(typeEl);
    }

    // Physical neighbors from in-memory index (no round-trip)
    const nbrR  = Math.max(60, 40 / viewport.getTransform().scale);
    const nbrs  = cellIndex.queryBbox(
      cell.x - nbrR, cell.y - nbrR,
      cell.x + nbrR, cell.y + nbrR
    ).filter(c => c.cell_id !== cell.cell_id);

    if (nbrs.length) {
      sidebar.appendChild(_mkSection('Neighbors (' + nbrs.length + ')'));
      const catCounts = {};
      for (const n of nbrs) {
        const cat = String(n.category != null ? n.category : 'Unknown');
        catCounts[cat] = (catCounts[cat] || 0) + 1;
      }
      const bkd = _mkCategoryBreakdown(catCounts);
      if (bkd) { bkd.style.maxHeight = '80px'; bkd.style.overflowY = 'auto'; sidebar.appendChild(bkd); }
    }

    // Gene expression via /cell_profile (async; only when transcripts exist)
    if (currentSample && hasTranscripts) {
      sidebar.appendChild(_mkSection('Gene Expression (nearby transcripts)'));
      const chartWrap = document.createElement('div');
      chartWrap.innerHTML = '<span style="color:#446;font-size:11px;">Loading…</span>';
      sidebar.appendChild(chartWrap);
      const url = baseUrl + '/cell_profile?sample=' +
        encodeURIComponent(currentSample) +
        '&x=' + cell.x.toFixed(2) +
        '&y=' + cell.y.toFixed(2) +
        '&radius=40';
      fetch(url)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          chartWrap.innerHTML = '';
          if (!data || !data.genes) {
            chartWrap.innerHTML = '<span style="color:#446;font-size:11px;">No data</span>';
            return;
          }
          const entries = Object.entries(data.genes).sort((a, b) => b[1] - a[1]);
          chartWrap.appendChild(_mkBarChart(entries, 15));
        })
        .catch(() => {
          chartWrap.innerHTML = '<span style="color:#446;font-size:11px;">Unavailable</span>';
        });
    }
  }

  // ── _showContourPanel ─────────────────────────────────────────────────────
  function _showContourPanel(stroke) {
    sidebar.innerHTML = '';
    sidebar.style.display = 'block';
    _registerSidebarEsc();
    const kind = stroke.kind === 'negative' ? 'Negative Contour' : 'Positive Contour';
    sidebar.appendChild(_mkHdr(kind));

    const stats = _contourStats(stroke);

    const totalEl = document.createElement('div');
    totalEl.style.cssText = 'font-size:15px;color:#eee;margin-bottom:5px;';
    totalEl.innerHTML = '<b style="color:#7ac;">' + stats.total + '</b> cells enclosed';
    sidebar.appendChild(totalEl);

    if (Object.keys(stats.counts).length) {
      sidebar.appendChild(_mkSection('Cell Type Breakdown'));
      const bkd = _mkCategoryBreakdown(stats.counts);
      if (bkd) sidebar.appendChild(bkd);
    }

    // Gene summary for all transcripts in the bounding area
    if (hasTranscripts && currentSample && stats.total > 0) {
      sidebar.appendChild(_mkSection('Gene Activity (contour area)'));
      const geneSummaryWrap = document.createElement('div');
      geneSummaryWrap.innerHTML = '<span style="color:#446;font-size:11px;">Loading…</span>';
      sidebar.appendChild(geneSummaryWrap);

      const bb = _polyBbox(stroke.points);
      const cx = (bb.minX + bb.maxX) / 2;
      const cy = (bb.minY + bb.maxY) / 2;
      const r  = Math.ceil(Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2);
      const url = baseUrl + '/cell_profile?sample=' +
        encodeURIComponent(currentSample) +
        '&x=' + cx.toFixed(2) +
        '&y=' + cy.toFixed(2) +
        '&radius=' + r;
      fetch(url)
        .then(resp => resp.ok ? resp.json() : null)
        .then(data => {
          geneSummaryWrap.innerHTML = '';
          if (!data || !data.genes) {
            geneSummaryWrap.innerHTML = '<span style="color:#446;font-size:11px;">No data</span>';
            return;
          }
          const entries = Object.entries(data.genes).sort((a, b) => b[1] - a[1]);
          geneSummaryWrap.appendChild(_mkBarChart(entries, 12));
        })
        .catch(() => {
          geneSummaryWrap.innerHTML = '<span style="color:#446;font-size:11px;">Unavailable</span>';
        });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function setDrawRef(d) { drawRef = d; }
  function setHasTranscripts(v) { hasTranscripts = !!v; }

  /**
   * Called by cells.js after each tile is fetched.
   * Deduplicates by cell_id — the same cell appears in tiles at every pyramid
   * level, so tile-key dedup would let multi-level fetches inflate counts.
   */
  function addCells(cells, sample, tileKey) {
    if (sample !== currentSample) return;
    for (const cell of cells) {
      const id = cell.cell_id;
      if (id !== undefined && _indexedCellIds.has(id)) continue;
      if (id !== undefined) _indexedCellIds.add(id);
      cellIndex.add(cell.x, cell.y, cell);
    }
  }

  /**
   * Called by transcripts.js after each tile is fetched (grid 0 only).
   * Capped to avoid runaway memory on high-density samples.
   */
  function addTranscripts(points, sample, tileKey) {
    if (sample !== currentSample) return;
    if (tileKey !== undefined && _indexedTxTiles.has(tileKey)) return;
    if (txIndex.size > 300000) return;   // safety cap
    if (tileKey !== undefined) _indexedTxTiles.add(tileKey);
    for (const pt of points) {
      txIndex.add(pt.x, pt.y, pt);
    }
  }

  /** Reset both indices and sidebar when the active sample changes. */
  function clearSample(sample) {
    currentSample = sample;
    cellIndex.clear();
    txIndex.clear();
    _indexedCellIds.clear();
    _indexedTxTiles.clear();
    _closeSidebar();
    _hideTooltip();
  }

  /** Throttled via rAF; safe to call on every raw mousemove event. */
  function onMouseMove(vpX, vpY) {
    _pendVpX = vpX;
    _pendVpY = vpY;
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      _doHover(_pendVpX, _pendVpY);
    });
  }

  /** Show rich click panel. Fired by toolbar on single click in pan mode. */
  function onMouseClick(vpX, vpY) {
    const { x: imgX, y: imgY } = viewport.toImageSpace(vpX, vpY);
    const { scale } = viewport.getTransform();
    const hitR = 32 / scale;

    const contour = _getContourAt(imgX, imgY);
    if (contour) { _showContourPanel(contour); return; }

    const cell = cellIndex.nearest(imgX, imgY, hitR);
    if (cell) { _showCellPanel(cell); return; }

    _closeSidebar();
  }

  /** Hide tooltip when mouse leaves the viewer container. */
  function onMouseLeave() { _hideTooltip(); }

  return {
    setDrawRef,
    setHasTranscripts,
    addCells,
    addTranscripts,
    clearSample,
    onMouseMove,
    onMouseClick,
    onMouseLeave,
  };
}
