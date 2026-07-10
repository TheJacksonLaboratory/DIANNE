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
}) {
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
    } else {
      // Widen ribbon for the table view (~double width)
      samplesRibbon.style.width = '520px';
      samplesRibbon.style.minWidth = '380px';
      samplesRibbon.style.maxWidth = '640px';
      ribbonWrap.style.display = 'none';
      metaPanel.style.display = 'flex';
      tabMeta.style.borderBottomColor = '#53d9ff';
      tabMeta.style.color = '#53d9ff';
      tabMeta.style.background = '#1f1f1f';
      tabSamples.style.borderBottomColor = 'transparent';
      tabSamples.style.color = '#888';
      tabSamples.style.background = 'transparent';
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
    if (distinct.length <= 15) {
      return { type: 'select', distinct };
    }
    return { type: 'text' };
  }

  const _colMeta = {};
  for (const k of _allKeys) _colMeta[k] = _colAnalysis(k);

  // Active filters: key → { type, value }
  const _filters = {};

  // ── Filter bar ────────────────────────────────────────────────────────
  const filterBar = document.createElement('div');
  filterBar.style.cssText = [
    'display:flex','flex-direction:column','gap:4px',
    'padding:6px 4px','border-bottom:1px solid #2a2a2a','flex-shrink:0',
    'max-height:140px','overflow-y:auto',
  ].join(';');

  for (const k of _allKeys) {
    const cm = _colMeta[k];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const lbl = document.createElement('span');
    lbl.textContent = k + ':';
    lbl.style.cssText = 'font:10px monospace;color:#888;white-space:nowrap;min-width:60px;overflow:hidden;text-overflow:ellipsis;';
    row.appendChild(lbl);

    if (cm.type === 'numeric') {
      _filters[k] = { type: 'numeric', min: null, max: null };
      const minIn = document.createElement('input');
      minIn.type = 'number'; minIn.placeholder = 'min';
      minIn.style.cssText = 'width:52px;font:10px monospace;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:2px 4px;';
      const maxIn = document.createElement('input');
      maxIn.type = 'number'; maxIn.placeholder = 'max';
      maxIn.style.cssText = 'width:52px;font:10px monospace;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:2px 4px;';
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
      sel.style.cssText = 'font:10px monospace;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:2px;max-width:100px;';
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
      inp.style.cssText = 'font:10px monospace;background:#1a1a1a;color:#ddd;border:1px solid #333;border-radius:3px;padding:2px 4px;width:100px;';
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
  table.style.cssText = 'border-collapse:collapse;width:100%;font:11px monospace;';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const _sortState = { key: null, asc: true };

  function _mkTh(label, key) {
    const th = document.createElement('th');
    th.textContent = label;
    th.style.cssText = [
      'padding:4px 6px','text-align:left','white-space:nowrap',
      'background:#1a1a1a','color:#888','border-bottom:1px solid #333',
      'cursor:pointer','user-select:none','position:sticky','top:0',
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

    const metaEntries = Object.entries(SAMPLE_METADATA[sampleName] || {});
    const metaHtml = metaEntries.length
      ? '<table style="border-collapse:collapse;margin-top:6px;">'
        + metaEntries.map(([k, v]) =>
            `<tr><td style="color:#888;padding:1px 8px 1px 0;font-weight:bold;white-space:nowrap;">${k}</td>`
            + `<td style="color:#eee;word-break:break-all;">${v}</td></tr>`
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
      tr.style.cssText = 'cursor:pointer;background:' + (isActive ? '#272727' : '#1a1a1a') + ';';
      tr.dataset.sampleName = sampleName;

      const tdSample = document.createElement('td');
      tdSample.textContent = sampleName;
      tdSample.style.cssText = [
        'padding:4px 6px','white-space:nowrap','color:' + (isActive ? '#53d9ff' : '#ddd'),
        'border-bottom:1px solid #222',
      ].join(';');
      tr.appendChild(tdSample);

      const m = SAMPLE_METADATA[sampleName] || {};
      for (const k of _allKeys) {
        const td = document.createElement('td');
        const val = Object.prototype.hasOwnProperty.call(m, k) ? m[k] : '';
        td.textContent = val === null || val === undefined ? '' : String(val);
        td.style.cssText = 'padding:4px 6px;color:#aaa;border-bottom:1px solid #222;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;';
        tr.appendChild(td);
      }

      // Hover: thumbnail preview
      tr.addEventListener('mouseenter', e => {
        tr.style.background = '#2a2a2a';
        _showThumbPreview(sampleName, e);
      });
      tr.addEventListener('mousemove', e => _positionPreview(e));
      tr.addEventListener('mouseleave', () => {
        tr.style.background = sampleName === ACTIVE_SAMPLE_REF() ? '#272727' : '#1a1a1a';
        _hideThumbPreview();
      });

      // Click: select sample
      tr.addEventListener('click', () => {
        setActiveSampleFn(sampleName);
        _renderRows(_filteredSamples);  // refresh row highlights
      });

      tbody.appendChild(tr);
    }
  }

  // ── Sync active sample highlight in table ─────────────────────────────
  function syncActiveSample() {
    const activeSample = ACTIVE_SAMPLE_REF();
    for (const tr of tbody.querySelectorAll('tr[data-sample-name]')) {
      const isActive = tr.dataset.sampleName === activeSample;
      tr.style.background = isActive ? '#272727' : '#1a1a1a';
      tr.querySelector('td').style.color = isActive ? '#53d9ff' : '#ddd';
    }
  }

  // Initial render
  _renderRows(_filteredSamples);
  _updateCount();

  return { syncActiveSample };
}
