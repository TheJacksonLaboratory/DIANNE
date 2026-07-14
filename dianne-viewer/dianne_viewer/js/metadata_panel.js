/**
 * metadata_panel.js
 *
 * Adds a "Samples / Metadata" tab strip above the sample ribbon, and implements
 * the metadata panel: a filterable, sortable table of all samples with their
 * per-sample metadata, thumbnail preview on row hover, and row-click to select.
 *
 * Hidden entirely when no sample has metadata (fully optional feature).
 *
 * Exposes:
 *   createMetadataPanel({
 *     samplesRibbon, root,
 *     SAMPLES, SAMPLE_META, SAMPLE_METADATA,
 *     BASE_URL,
 *     ACTIVE_SAMPLE_REF,
 *     setActiveSampleFn,
 *   })
 *   → { syncActiveSample }   — call when active sample changes externally
 */
function createMetadataPanel({
  samplesRibbon, root,
  SAMPLES, SAMPLE_META, SAMPLE_METADATA,
  BASE_URL,
  ACTIVE_SAMPLE_REF,
  setActiveSampleFn,
  onFilterChange,   // optional: called with filtered sample array on every filter change
  onSampleSelect,   // optional: called with sampleName after table row click (e.g. to scroll ribbon)
  scrollRibbonToSample, // optional: called when switching to Samples tab to autoscroll ribbon
}) {
  // ── Layout constants (adjust here) ──────────────────────────────────────
  const COL_MIN_WIDTH  = 80;   // px — minimum width of each metadata column in the table
  const COL_MAX_WIDTH  = 280;   // px — maximum width of each metadata column
  const FILTER_BAR_MAX_HEIGHT = 80;  // px — max height of the collapsed filter grid
  const PIE_MAX_LABELS = 10;   // max slices shown in the value-count pie chart tooltip
  const PIE_SIZE      = 140;   // px — diameter of the pie chart canvas
  const TOOLTIP_MAX_LABEL_CHARS = 25;  // max chars for key/value in sample hover tooltip
  // ── Determine if any sample has metadata ─────────────────────────────────
  const _hasAnyMeta = SAMPLES.some(s => {
    const m = SAMPLE_METADATA[s];
    return m && Object.keys(m).length > 0;
  });
  if (!_hasAnyMeta) {
    // Feature is invisible when no metadata provided
    return { syncActiveSample: () => {} };
  }

  // ── Collect all column keys (union across all samples) ─────────────────
  const _allKeys = [];
  const _keySet  = new Set();
  for (const s of SAMPLES) {
    const m = SAMPLE_METADATA[s] || {};
    for (const k of Object.keys(m)) {
      if (!_keySet.has(k)) { _keySet.add(k); _allKeys.push(k); }
    }
  }

  // ── Restructure iv-samples: tabStrip + ribbonWrap + metaPanel all inside ─
  // samplesRibbon IS iv-samples (a flex-column). We:
  //  1. move its current children (sample cards) into a ribbonWrap scroll div
  //  2. prepend a tabStrip inside samplesRibbon
  //  3. show/hide ribbonWrap vs metaPanel on tab click

  // Capture original ribbon style so we can restore it when leaving Metadata tab
  const _origRibbonStyle = samplesRibbon.getAttribute('style') || '';

  // 1. Wrap existing ribbon children
  const ribbonWrap = document.createElement('div');
  ribbonWrap.style.cssText = 'flex:1 1 auto;overflow-y:auto;display:flex;flex-direction:column;gap:8px;min-height:0;';
  while (samplesRibbon.firstChild) ribbonWrap.appendChild(samplesRibbon.firstChild);
  samplesRibbon.appendChild(ribbonWrap);

  // 2. Tab strip
  const tabStrip = document.createElement('div');
  tabStrip.style.cssText = [
    'display:flex','gap:0','width:100%','border-bottom:1px solid #2f2f2f',
    'margin-bottom:4px','flex-shrink:0',
  ].join(';');

  function _makeTabBtn(label, active) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'flex:1','padding:5px 2px','font:11px monospace','cursor:pointer',
      'border:none','border-bottom:2px solid ' + (active ? '#53d9ff' : 'transparent'),
      'background:' + (active ? '#1f1f1f' : 'transparent'),
      'color:' + (active ? '#53d9ff' : '#888'),
    ].join(';');
    return b;
  }

  const tabSamples  = _makeTabBtn('Samples', true);
  const tabMeta     = _makeTabBtn('Metadata', false);
  tabStrip.appendChild(tabSamples);
  tabStrip.appendChild(tabMeta);

  // Prepend tab strip inside samplesRibbon (before ribbonWrap)
  samplesRibbon.insertBefore(tabStrip, samplesRibbon.firstChild);

  // Count label — always visible between tabStrip and content
  const countLabel = document.createElement('div');
  countLabel.style.cssText = 'font:10px monospace;color:#666;text-align:right;padding:2px 6px 2px 0;flex-shrink:0;';
  samplesRibbon.insertBefore(countLabel, ribbonWrap);

  function _updateCount() {
    const n = _filteredSamples.length, total = SAMPLES.length;
    countLabel.textContent = n + ' / ' + total + ' samples';
    countLabel.style.color = n < total ? '#fa6' : '#666';
  }

  // ── Metadata panel container ────────────────────────────────────────────
  const metaPanel = document.createElement('div');
  metaPanel.style.cssText = [
    'display:none','flex-direction:column','gap:6px',
    'width:100%','flex:1 1 auto','overflow:hidden','min-height:0',
    'box-sizing:border-box',
  ].join(';');
  samplesRibbon.appendChild(metaPanel);

  // ── Tab switch logic ───────────────────────────────────────────────────
  let _activeTab = 'samples';
  function _switchTab(tab) {
    _activeTab = tab;
    if (tab === 'samples') {
      // Restore original ribbon width
      samplesRibbon.setAttribute('style', _origRibbonStyle);
      ribbonWrap.style.display = '';
      metaPanel.style.display = 'none';
      tabSamples.style.borderBottomColor = '#53d9ff';
      tabSamples.style.color = '#53d9ff';
      tabSamples.style.background = '#1f1f1f';
      tabMeta.style.borderBottomColor = 'transparent';
      tabMeta.style.color = '#888';
      tabMeta.style.background = 'transparent';
      // Autoscroll ribbon to the active sample
      if (scrollRibbonToSample) setTimeout(() => scrollRibbonToSample(ACTIVE_SAMPLE_REF()), 0);
    } else {
      // Widen ribbon for the table view (~double width)
      samplesRibbon.style.width = '1500px';
      samplesRibbon.style.minWidth = '380px';
      samplesRibbon.style.maxWidth = '1500px';
      ribbonWrap.style.display = 'none';
      metaPanel.style.display = 'flex';
      tabMeta.style.borderBottomColor = '#53d9ff';
      tabMeta.style.color = '#53d9ff';
      tabMeta.style.background = '#1f1f1f';
      tabSamples.style.borderBottomColor = 'transparent';
      tabSamples.style.color = '#888';
      tabSamples.style.background = 'transparent';
      // Scroll active row into view
      setTimeout(() => syncActiveSample(), 0);
    }
  }
  tabSamples.addEventListener('click', () => _switchTab('samples'));
  tabMeta.addEventListener('click',    () => _switchTab('metadata'));

  // ── Build filter controls ─────────────────────────────────────────────
  // Analyse each column's data type and cardinality
  function _colAnalysis(key) {
    const values = SAMPLES.map(s => {
      const m = SAMPLE_METADATA[s] || {};
      return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
    }).filter(v => v !== null && v !== undefined && v !== '');
    const allNumeric = values.every(v => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))));
    if (allNumeric && values.length > 0) {
      const nums = values.map(Number);
      return { type: 'numeric', min: Math.min(...nums), max: Math.max(...nums) };
    }
    const distinct = Array.from(new Set(values.map(String)));
    if (distinct.length <=100) {
      return { type: 'select', distinct };
    }
    return { type: 'text' };
  }

  const _colMeta = {};
  for (const k of _allKeys) _colMeta[k] = _colAnalysis(k);

  // ── Value-count cache for pie chart ───────────────────────────────────
  // _colValueCounts[key] = [ {label, count}, … ] sorted desc, top PIE_MAX_LABELS
  const _colValueCounts = {};
  for (const k of _allKeys) {
    const counts = {};
    for (const s of SAMPLES) {
      const m = SAMPLE_METADATA[s] || {};
      if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
      const v = m[k] === null || m[k] === undefined ? '(blank)' : String(m[k]);
      counts[v] = (counts[v] || 0) + 1;
    }
    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, PIE_MAX_LABELS);
    _colValueCounts[k] = sorted.map(([label, count]) => ({ label, count }));
  }

  // ── Shared pie-chart tooltip ───────────────────────────────────────────
  // Palette of 10 distinct muted colours
  const _PIE_PALETTE = [
    '#4fa3e0','#e07b4f','#6dbf67','#b06dbf','#e0c14f',
    '#4fbfbf','#e06b8a','#9dbf4f','#bf8f4f','#7b7bbf',
  ];

  const _pieTooltip = document.createElement('div');
  _pieTooltip.style.cssText = [
    'position:fixed','pointer-events:none','display:none','z-index:2147483647',
    'background:rgba(18,18,18,0.97)','border:1px solid #444','border-radius:8px',
    'padding:10px 12px','box-shadow:0 4px 18px rgba(0,0,0,0.75)',
    'font:11px monospace','color:#ddd','min-width:200px',
  ].join(';');
  document.body.appendChild(_pieTooltip);

  const _pieCanvas = document.createElement('canvas');
  _pieCanvas.width  = PIE_SIZE;
  _pieCanvas.height = PIE_SIZE;
  _pieCanvas.style.cssText = 'display:block;margin:0 auto 8px auto;';
  _pieTooltip.appendChild(_pieCanvas);

  const _pieLegend = document.createElement('div');
  _pieLegend.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
  _pieTooltip.appendChild(_pieLegend);

  function _drawPie(key) {
    const entries = _colValueCounts[key] || [];
    const ctx = _pieCanvas.getContext('2d');
    const total = entries.reduce((s, e) => s + e.count, 0);
    const cx = PIE_SIZE / 2, cy = PIE_SIZE / 2, r = PIE_SIZE / 2 - 4;
    ctx.clearRect(0, 0, PIE_SIZE, PIE_SIZE);
    let angle = -Math.PI / 2;
    for (let i = 0; i < entries.length; i++) {
      const slice = (entries[i].count / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = _PIE_PALETTE[i % _PIE_PALETTE.length];
      ctx.fill();
      angle += slice;
    }
    // Remaining samples not in top-N get a grey slice
    const shown = entries.reduce((s, e) => s + e.count, 0);
    const rest  = SAMPLES.length - shown;
    if (rest > 0) {
      const slice = (rest / SAMPLES.length) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = '#444';
      ctx.fill();
    }
    // Legend
    _pieLegend.innerHTML = '';
    const pct = (n) => ((n / SAMPLES.length) * 100).toFixed(1) + '%';
    for (let i = 0; i < entries.length; i++) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:5px;';
      const swatch = document.createElement('span');
      swatch.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:2px;flex-shrink:0;background:' + _PIE_PALETTE[i % _PIE_PALETTE.length] + ';';
      const txt = document.createElement('span');
      txt.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;';
      txt.textContent = entries[i].label + '  (' + entries[i].count + ', ' + pct(entries[i].count) + ')';
      row.appendChild(swatch);
      row.appendChild(txt);
      _pieLegend.appendChild(row);
    }
    if (rest > 0) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:5px;';
      const swatch = document.createElement('span');
      swatch.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:2px;flex-shrink:0;background:#444;';
      const txt = document.createElement('span');
      txt.style.cssText = 'color:#666;';
      txt.textContent = 'other  (' + rest + ', ' + pct(rest) + ')';
      row.appendChild(swatch);
      row.appendChild(txt);
      _pieLegend.appendChild(row);
    }
  }

  let _pieHideTimer = null;
  function _showPieTooltip(key, targetEl) {
    clearTimeout(_pieHideTimer);
    const title = _pieTooltip.querySelector('._pie-title') || (() => {
      const t = document.createElement('div');
      t.className = '_pie-title';
      t.style.cssText = 'font:bold 11px monospace;color:#53d9ff;margin-bottom:6px;text-align:center;';
      _pieTooltip.insertBefore(t, _pieCanvas);
      return t;
    })();
    title.textContent = key;
    _drawPie(key);
    _pieTooltip.style.display = 'block';
    // Position near the element
    const r = targetEl.getBoundingClientRect();
    const tw = _pieTooltip.offsetWidth  || 220;
    const th = _pieTooltip.offsetHeight || 220;
    let tx = r.right + 8;
    let ty = r.top;
    if (tx + tw > window.innerWidth)  tx = r.left - tw - 8;
    if (ty + th > window.innerHeight) ty = window.innerHeight - th - 8;
    if (ty < 4) ty = 4;
    _pieTooltip.style.left = tx + 'px';
    _pieTooltip.style.top  = ty + 'px';
  }
  function _hidePieTooltip() {
    _pieHideTimer = setTimeout(() => { _pieTooltip.style.display = 'none'; }, 120);
  }
  function _attachPieHover(el, key) {
    el.addEventListener('mouseenter', () => _showPieTooltip(key, el));
    el.addEventListener('mouseleave', _hidePieTooltip);
  }

  // Active filters: key → { type, value }
  const _filters = {};

  // ── Filter bar ────────────────────────────────────────────────────────
  const filterBar = document.createElement('div');
  filterBar.style.cssText = [
    'display:grid',
    'grid-template-columns:repeat(auto-fill,minmax(180px,1fr))',
    'gap:4px 8px',
    'padding:6px 4px','border-bottom:1px solid #2a2a2a','flex-shrink:0',
    'max-height:' + FILTER_BAR_MAX_HEIGHT + 'px','overflow-y:auto',
  ].join(';');

  for (const k of _allKeys) {
    const cm = _colMeta[k];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;';

    const lbl = document.createElement('span');
    lbl.textContent = k + ':';
    lbl.style.cssText = 'font:10px monospace;color:#888;white-space:nowrap;min-width:0;max-width:70px;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;cursor:help;';
    _attachPieHover(lbl, k);
    row.appendChild(lbl);

    if (cm.type === 'numeric') {
      _filters[k] = { type: 'numeric', min: null, max: null };
      const minIn = document.createElement('input');
      minIn.type = 'number'; minIn.placeholder = 'min';
      minIn.style.cssText = 'width:48px;min-width:0;font:10px monospace;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:2px 3px;';
      const maxIn = document.createElement('input');
      maxIn.type = 'number'; maxIn.placeholder = 'max';
      maxIn.style.cssText = 'width:48px;min-width:0;font:10px monospace;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:2px 3px;';
      const _upd = () => {
        _filters[k].min = minIn.value !== '' ? Number(minIn.value) : null;
        _filters[k].max = maxIn.value !== '' ? Number(maxIn.value) : null;
        _applyFilters();
      };
      minIn.addEventListener('input', _upd);
      maxIn.addEventListener('input', _upd);
      row.appendChild(minIn);
      const dash = document.createElement('span');
      dash.textContent = '–'; dash.style.cssText = 'color:#666;font:10px monospace;';
      row.appendChild(dash);
      row.appendChild(maxIn);
    } else if (cm.type === 'select') {
      _filters[k] = { type: 'select', selected: new Set() };
      const sel = document.createElement('select');
      sel.multiple = false;
      sel.style.cssText = 'font:10px monospace;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:2px;min-width:0;flex:1 1 auto;max-width:140px;';
      const optAll = document.createElement('option');
      optAll.value = ''; optAll.textContent = '(all)';
      sel.appendChild(optAll);
      for (const v of cm.distinct) {
        const opt = document.createElement('option');
        opt.value = String(v); opt.textContent = String(v);
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        _filters[k].selected = sel.value ? new Set([sel.value]) : new Set();
        _applyFilters();
      });
      row.appendChild(sel);
    } else {
      _filters[k] = { type: 'text', value: '' };
      const inp = document.createElement('input');
      inp.type = 'text'; inp.placeholder = 'search…';
      inp.style.cssText = 'font:10px monospace;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:2px 3px;min-width:0;flex:1 1 auto;max-width:140px;';
      inp.addEventListener('input', () => {
        _filters[k].value = inp.value.toLowerCase();
        _applyFilters();
      });
      row.appendChild(inp);
    }
    filterBar.appendChild(row);
  }
  metaPanel.appendChild(filterBar);

  // ── Table ─────────────────────────────────────────────────────────────
  const tableWrap = document.createElement('div');
  tableWrap.style.cssText = 'flex:1 1 auto;overflow:auto;min-height:0;';

  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;width:max-content;min-width:100%;font:11px monospace;';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const _sortState = { key: null, asc: true };

  function _mkTh(label, key) {
    const th = document.createElement('th');
    th.textContent = label;
    th.style.cssText = [
      'padding:3px 8px','text-align:left','white-space:nowrap',
      'background:#1a1a1a','color:#888','border-bottom:1px solid #333',
      'cursor:pointer','user-select:none','position:sticky','top:0',
      'min-width:' + COL_MIN_WIDTH + 'px','max-width:' + COL_MAX_WIDTH + 'px',
    ].join(';');
    th.addEventListener('click', () => {
      if (_sortState.key === key) {
        _sortState.asc = !_sortState.asc;
      } else {
        _sortState.key = key;
        _sortState.asc = true;
      }
      _renderRows(_filteredSamples);
    });
    // Pie chart on hover (only for real metadata columns, not the sample name column)
    if (key !== '__sample__') _attachPieHover(th, key);
    return th;
  }

  headerRow.appendChild(_mkTh('Sample', '__sample__'));
  for (const k of _allKeys) headerRow.appendChild(_mkTh(k, k));
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  metaPanel.appendChild(tableWrap);

  // ── Row hover thumbnail preview ────────────────────────────────────────
  const _thumbPreview = document.createElement('div');
  _thumbPreview.style.cssText = [
    'position:fixed','pointer-events:none','display:none','z-index:2147483648',
    'background:rgba(0,0,0,0.92)','border:1px solid #444','border-radius:8px',
    'padding:8px','box-shadow:0 4px 16px rgba(0,0,0,0.7)',
    'font:11px monospace','color:#ddd','max-width:280px',
  ].join(';');
  document.body.appendChild(_thumbPreview);

  let _previewImg = null;
  function _showThumbPreview(sampleName, e) {
    const m = SAMPLE_META[sampleName];
    const thumbLevel = Math.max(0, Number(m.n_levels) - 1);
    const thumbUrl = BASE_URL + '/thumb?sample=' + encodeURIComponent(sampleName)
      + '&level=' + thumbLevel + '&size=128';

    function _truncate(str, max) {
      const s = String(str);
      return s.length > max ? s.slice(0, max) + '\u2026' : s;
    }
    const metaEntries = Object.entries(SAMPLE_METADATA[sampleName] || {});
    const metaHtml = metaEntries.length
      ? '<table style="border-collapse:collapse;margin-top:6px;">'
        + metaEntries.map(([k, v]) =>
            `<tr><td style="color:#888;padding:1px 8px 1px 0;font-weight:bold;white-space:nowrap;" title="${k}">${_truncate(k, TOOLTIP_MAX_LABEL_CHARS)}</td>`
            + `<td style="color:#eee;word-break:break-all;" title="${v}">${_truncate(String(v), TOOLTIP_MAX_LABEL_CHARS)}</td></tr>`
          ).join('')
        + '</table>'
      : '';

    _thumbPreview.innerHTML =
      `<div style="font:12px monospace;color:#53d9ff;margin-bottom:6px;">${sampleName}</div>`
      + `<img src="${thumbUrl}" style="width:128px;height:128px;object-fit:contain;background:#0f0f0f;display:block;border-radius:4px;">`
      + metaHtml;
    _thumbPreview.style.display = 'block';
    _positionPreview(e);
  }

  function _positionPreview(e) {
    const MARGIN = 14;
    let tx = e.clientX + MARGIN;
    let ty = e.clientY + MARGIN;
    const tw = _thumbPreview.offsetWidth  || 200;
    const th = _thumbPreview.offsetHeight || 160;
    if (tx + tw > window.innerWidth)  tx = e.clientX - tw - MARGIN;
    if (ty + th > window.innerHeight) ty = e.clientY - th - MARGIN;
    _thumbPreview.style.left = tx + 'px';
    _thumbPreview.style.top  = ty + 'px';
  }

  function _hideThumbPreview() {
    _thumbPreview.style.display = 'none';
  }

  // ── Filtered sample list + render ─────────────────────────────────────
  let _filteredSamples = SAMPLES.slice();

  function _rowBg(isActive) { return isActive ? '#1e2e38' : '#1a1a1a'; }

  function _applyRowStyle(tr, isActive) {
    tr.style.background = isActive ? '#1e2e38' : '#1a1a1a';
    tr.style.borderLeft  = isActive ? '3px solid #53d9ff' : '3px solid transparent';
    const tds = tr.querySelectorAll('td');
    tds.forEach((td, i) => {
      td.style.color = i === 0 ? (isActive ? '#53d9ff' : '#ddd') : (isActive ? '#c8eaff' : '#aaa');
    });
  }

  function _applyFilters() {
    _filteredSamples = SAMPLES.filter(s => {
      const m = SAMPLE_METADATA[s] || {};
      for (const [k, f] of Object.entries(_filters)) {
        const v = Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
        if (f.type === 'numeric') {
          if (v === null || v === undefined) continue; // blank = pass
          const n = Number(v);
          if (f.min !== null && n < f.min) return false;
          if (f.max !== null && n > f.max) return false;
        } else if (f.type === 'select') {
          if (!f.selected.size) continue;
          if (!f.selected.has(v === null ? '' : String(v))) return false;
        } else { // text
          if (!f.value) continue;
          if (!(String(v === null ? '' : v).toLowerCase().includes(f.value))) return false;
        }
      }
      return true;
    });
    _renderRows(_filteredSamples);
    _updateCount();
    if (onFilterChange) onFilterChange(_filteredSamples);
  }

  function _renderRows(samples) {
    // Sort
    let sorted = samples.slice();
    if (_sortState.key) {
      const key = _sortState.key;
      const asc = _sortState.asc;
      sorted.sort((a, b) => {
        const va = key === '__sample__' ? a : ((SAMPLE_METADATA[a] || {})[key] ?? '');
        const vb = key === '__sample__' ? b : ((SAMPLE_METADATA[b] || {})[key] ?? '');
        const na = Number(va), nb = Number(vb);
        if (!isNaN(na) && !isNaN(nb)) return asc ? na - nb : nb - na;
        return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
      });
    }

    tbody.innerHTML = '';
    const activeSample = ACTIVE_SAMPLE_REF();
    for (const sampleName of sorted) {
      const tr = document.createElement('tr');
      const isActive = sampleName === activeSample;
      tr.dataset.sampleName = sampleName;
      tr.style.cssText = 'cursor:pointer;border-left:3px solid ' + (isActive ? '#53d9ff' : 'transparent') + ';background:' + (isActive ? '#1e2e38' : '#1a1a1a') + ';';

      const tdSample = document.createElement('td');
      tdSample.textContent = sampleName;
      tdSample.style.cssText = [
        'padding:3px 8px','white-space:nowrap','color:' + (isActive ? '#53d9ff' : '#ddd'),
        'border-bottom:1px solid #222',
        'min-width:' + COL_MIN_WIDTH + 'px','max-width:' + COL_MAX_WIDTH + 'px',
      ].join(';');
      tr.appendChild(tdSample);

      const m = SAMPLE_METADATA[sampleName] || {};
      for (const k of _allKeys) {
        const td = document.createElement('td');
        const val = Object.prototype.hasOwnProperty.call(m, k) ? m[k] : '';
        td.textContent = val === null || val === undefined ? '' : String(val);
        td.style.cssText = 'padding:3px 8px;color:' + (isActive ? '#c8eaff' : '#aaa') + ';border-bottom:1px solid #222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:' + COL_MIN_WIDTH + 'px;max-width:' + COL_MAX_WIDTH + 'px;';
        tr.appendChild(td);
      }

      // Hover: thumbnail preview
      tr.addEventListener('mouseenter', e => {
        if (sampleName !== ACTIVE_SAMPLE_REF()) tr.style.background = '#252525';
        _showThumbPreview(sampleName, e);
      });
      tr.addEventListener('mousemove', e => _positionPreview(e));
      tr.addEventListener('mouseleave', () => {
        _applyRowStyle(tr, sampleName === ACTIVE_SAMPLE_REF());
        _hideThumbPreview();
      });

      // Click: select sample
      tr.addEventListener('click', () => {
        setActiveSampleFn(sampleName);
        if (onSampleSelect) onSampleSelect(sampleName);
        _renderRows(_filteredSamples);  // refresh row highlights
      });

      tbody.appendChild(tr);
    }
  }

  // ── Sync active sample highlight in table ─────────────────────────────
  function syncActiveSample() {
    const activeSample = ACTIVE_SAMPLE_REF();
    let activeRow = null;
    for (const tr of tbody.querySelectorAll('tr[data-sample-name]')) {
      const isActive = tr.dataset.sampleName === activeSample;
      _applyRowStyle(tr, isActive);
      if (isActive) activeRow = tr;
    }
    // Scroll the active row into view when the metadata tab is open
    if (activeRow && metaPanel.style.display !== 'none') {
      activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Initial render
  _renderRows(_filteredSamples);
  _updateCount();

  return { syncActiveSample };
}
