/**
 * transcripts.js
 *
 * Viewport-driven Xenium transcript overlay with per-tile caching.
 * Supports sample switching and per-sample enable/disable at runtime.
 */

function createXeTranscripts(container, baseUrl, imageMeta, transcriptMeta, viewport, log, sharedRow, sampleName = null, hoverCallbacks = null) {
  const MAX_CACHED = 300;
  const PREFETCH = 1;
  let POINT_RADIUS = 2;
  const SEARCH_PLACEHOLDER_COLOR = 'rgba(247, 245, 245, 0.35)';

  let currentSample = sampleName;
  let currentImageMeta = imageMeta;
  let currentTranscriptMeta = transcriptMeta;
  let enabled = !!(currentTranscriptMeta && currentTranscriptMeta.genes && currentTranscriptMeta.genes.length);

  const layer = document.createElement('canvas');
  layer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2;';
  container.appendChild(layer);
  const ctx = layer.getContext('2d');

  const controls = document.createElement('div');
  controls.dataset.ivUi = 'true';
  controls.style.cssText = [
    ...(sharedRow ? [] : ['position:absolute', 'top:46px', 'right:8px', 'z-index:11']),
    'display:flex', 'flex-direction:column', 'gap:4px',
    'padding:4px 6px', 'border-radius:6px',
    'background:rgba(0,0,0,0.55)', 'color:#eee',
    'font:12px monospace', 'min-width:210px',
  ].join(';');
  if (sharedRow) sharedRow.appendChild(controls);
  else container.appendChild(controls);

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Genes (0)';
  toggleBtn.title = 'Select transcript genes';
  toggleBtn.style.cssText = [
    'background:transparent', 'border:1px solid #888',
    'color:#eee', 'border-radius:4px', 'padding:3px 7px',
    'cursor:pointer', 'font-size:12px', 'line-height:1.4', 'text-align:left',
  ].join(';');
  controls.appendChild(toggleBtn);

  const panel = document.createElement('div');
  panel.style.cssText = [
    'display:none', 'flex-direction:column',
    'border-top:1px solid rgba(255,255,255,0.12)', 'padding-top:4px',
  ].join(';');
  controls.appendChild(panel);

  const sizeRow = document.createElement('div');
  sizeRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:0 0 4px 0;flex-shrink:0;';
  sizeRow.innerHTML = '<span style="color:#ddd;">Transcript size</span>';
  const transcriptSizeSlider = document.createElement('input');
  transcriptSizeSlider.type = 'range';
  transcriptSizeSlider.min = '1';
  transcriptSizeSlider.max = '12';
  transcriptSizeSlider.step = '1';
  transcriptSizeSlider.value = String(POINT_RADIUS);
  transcriptSizeSlider.style.cssText = 'width:90px;';
  transcriptSizeSlider.addEventListener('input', () => {
    POINT_RADIUS = Number(transcriptSizeSlider.value);
    draw(viewport.getTransform());
  });
  sizeRow.appendChild(transcriptSizeSlider);

  const noneBtn = document.createElement('button');
  noneBtn.textContent = 'None';
  noneBtn.title = 'Deselect all genes';
  noneBtn.style.cssText = [
    'background:transparent', 'border:1px solid #666',
    'color:#aaa', 'border-radius:4px', 'padding:1px 5px',
    'cursor:pointer', 'font-size:11px', 'line-height:1.4', 'flex-shrink:0',
  ].join(';');
  noneBtn.addEventListener('click', () => {
    selectedGenes.clear();
    clearCache();
    _renderList();
    updateButton();
    update(viewport.getTransform());
  });
  sizeRow.appendChild(noneBtn);
  panel.appendChild(sizeRow);

  const phStyle = document.createElement('style');
  phStyle.textContent = `.iv-gene-search::placeholder { color: ${SEARCH_PLACEHOLDER_COLOR}; opacity: 1; }`;
  document.head.appendChild(phStyle);

  const searchRow = document.createElement('div');
  searchRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin:0 0 4px 0;flex-shrink:0;';
  panel.appendChild(searchRow);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'search gene';
  searchInput.className = 'iv-gene-search';
  searchInput.style.cssText = [
    'flex:1', 'min-width:0', 'box-sizing:border-box',
    'padding:4px 6px', 'border-radius:4px', 'border:1px solid #666',
    'background:rgba(255,255,255,0.08)', 'color:#eee',
    'outline:none', 'font:12px monospace',
  ].join(';');
  searchRow.appendChild(searchInput);

  const searchClear = document.createElement('button');
  searchClear.textContent = '\u00d7';
  searchClear.title = 'Clear search';
  searchClear.style.cssText = [
    'display:none', 'flex-shrink:0',
    'background:transparent', 'border:none',
    'color:rgba(238,238,238,0.6)', 'font-size:15px', 'line-height:1',
    'cursor:pointer', 'padding:0 2px',
  ].join(';');
  searchRow.appendChild(searchClear);

  const geneList = document.createElement('div');
  geneList.style.cssText = 'overflow-y:auto;max-height:360px;';
  panel.appendChild(geneList);

  const cache = new Map();
  const inflight = new Map();
  const selectedGenes = new Set();
  const geneColors = {};

  let filteredGenes = [];
  let geneFilter = '';
  let currentGrid = 0;
  let currentLevel = 0;
  let currentGeneKey = '';

  function resizeLayer() {
    layer.width = container.clientWidth;
    layer.height = container.clientHeight;
    draw(viewport.getTransform());
  }
  // ResizeObserver catches CSS-driven resizes (e.g. custom fullscreen toggle).
  // window 'resize' does not fire for those, causing the canvas to stay
  // clipped to the original non-fullscreen dimensions.
  new ResizeObserver(resizeLayer).observe(container);
  resizeLayer();

  function clearCache() {
    cache.clear();
    for (const [, ctrl] of inflight) ctrl.abort();
    inflight.clear();
  }

  function bestImageLevel(scale) {
    for (let i = 0; i < currentImageMeta.n_levels; i++) {
      if (scale >= 1 / currentImageMeta.levels[i].downsample) return i;
    }
    return currentImageMeta.n_levels - 1;
  }

  function bestGrid(scale) {
    for (let i = 0; i < currentTranscriptMeta.n_grids; i++) {
      if (scale >= 1 / currentTranscriptMeta.grids[i].downsample) return i;
    }
    return currentTranscriptMeta.n_grids - 1;
  }

  function visibleRange(level, transform, pad) {
    const TILE = currentImageMeta.tile_size;
    const { scale, ox, oy } = transform;
    const lm = currentImageMeta.levels[level];
    const l0 = currentImageMeta.levels[0];
    const cw = container.clientWidth;
    const ch = container.clientHeight;

    const x0 = Math.max(0, (-ox / scale) / (l0.width / lm.width));
    const y0 = Math.max(0, (-oy / scale) / (l0.height / lm.height));
    const x1 = Math.min(lm.width, ((cw - ox) / scale) / (l0.width / lm.width));
    const y1 = Math.min(lm.height, ((ch - oy) / scale) / (l0.height / lm.height));

    return {
      c0: Math.max(0, Math.floor(x0 / TILE) - pad),
      r0: Math.max(0, Math.floor(y0 / TILE) - pad),
      c1: Math.min(lm.n_tiles_x - 1, Math.floor(x1 / TILE) + pad),
      r1: Math.min(lm.n_tiles_y - 1, Math.floor(y1 / TILE) + pad),
    };
  }

  function defaultColor(gene) {
    let hash = 0;
    for (let i = 0; i < gene.length; i++) hash = ((hash * 31) + gene.charCodeAt(i)) % 360;
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = 1;
    const tc = tmp.getContext('2d');
    tc.fillStyle = `hsl(${hash}, 78%, 62%)`;
    tc.fillRect(0, 0, 1, 1);
    const [r, g, b] = tc.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function geneColor(gene) {
    if (!geneColors[gene]) geneColors[gene] = defaultColor(gene);
    return geneColors[gene];
  }

  function geneKey() {
    return [...selectedGenes].sort().join(',');
  }

  function cacheKey(grid, level, row, col, genes) {
    return `${currentSample}|${genes}|${grid}|${level}|${row}|${col}`;
  }

  function draw(transform) {
    ctx.clearRect(0, 0, layer.width, layer.height);
    if (!enabled || selectedGenes.size === 0) return;

    const vis = visibleRange(currentLevel, transform, 0);
    for (let r = vis.r0; r <= vis.r1; r++) {
      for (let c = vis.c0; c <= vis.c1; c++) {
        const entry = cache.get(cacheKey(currentGrid, currentLevel, r, c, currentGeneKey));
        if (!entry) continue;
        entry.lastUsed = Date.now();
        const gridDownsample = currentTranscriptMeta.grids[currentGrid]
          ? currentTranscriptMeta.grids[currentGrid].downsample : 1;
        for (const pt of entry.points) {
          const r = pt.count ? POINT_RADIUS * Math.sqrt(pt.count) / gridDownsample : POINT_RADIUS;
          const sp = viewport.toScreenSpace(pt.x, pt.y);
          if (sp.x < -r || sp.y < -r || sp.x > layer.width + r || sp.y > layer.height + r) {
            continue;
          }
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
          ctx.fillStyle = geneColor(pt.gene);
          ctx.fill();
        }
      }
    }
  }

  function fetchTile(grid, level, row, col, genes) {
    const k = cacheKey(grid, level, row, col, genes);
    if (cache.has(k) || inflight.has(k) || !genes || !enabled) return;

    const ctrl = new AbortController();
    inflight.set(k, ctrl);
    const url = `${baseUrl}/xenium_tile?sample=${encodeURIComponent(currentSample)}&grid=${grid}&level=${level}&row=${row}&col=${col}&genes=${encodeURIComponent(genes)}`;
    fetch(url, { signal: ctrl.signal })
      .then(r => r.json())
      .then(data => {
        inflight.delete(k);
        const pts = Array.isArray(data.points) ? data.points : [];
        cache.set(k, { points: pts, lastUsed: Date.now() });
        evict();
        // Feed grid-0 points into the spatial index (individual transcripts only).
        if (hoverCallbacks && typeof hoverCallbacks.onTranscriptsLoaded === 'function' && grid === 0) {
          hoverCallbacks.onTranscriptsLoaded(pts, currentSample, k);
        }
        draw(viewport.getTransform());
      })
      .catch(() => { inflight.delete(k); });
  }

  function abortStale(visibleKeys) {
    for (const [k, ctrl] of inflight) {
      if (!visibleKeys.has(k)) {
        ctrl.abort();
        inflight.delete(k);
      }
    }
  }

  function evict() {
    if (cache.size <= MAX_CACHED) return;
    const sorted = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = sorted.slice(0, cache.size - MAX_CACHED);
    for (const [k] of toRemove) cache.delete(k);
  }

  function updateButton() {
    const total = filteredGenes.length;
    toggleBtn.textContent = enabled ? `Genes (${selectedGenes.size}/${total})` : 'Genes (off)';
  }

  function _makeGeneRow(gene) {
    const row = document.createElement('div');
    row.dataset.gene = gene;
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 0;';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.style.cursor = 'pointer';
    checkbox.checked = selectedGenes.has(gene);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedGenes.add(gene);
      else selectedGenes.delete(gene);
      updateButton();
      _renderList();
      update(viewport.getTransform());
    });

    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.value = geneColor(gene);
    colorPicker.title = `Color for ${gene}`;
    colorPicker.style.cssText = 'width:20px;height:20px;border:none;background:none;padding:0;cursor:pointer;flex-shrink:0;';
    colorPicker.addEventListener('input', () => {
      geneColors[gene] = colorPicker.value;
      draw(viewport.getTransform());
    });

    const label = document.createElement('label');
    label.textContent = gene;
    label.style.cursor = 'pointer';
    label.addEventListener('click', () => {
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });

    row.appendChild(checkbox);
    row.appendChild(colorPicker);
    row.appendChild(label);
    return row;
  }

  function _renderList() {
    geneList.innerHTML = '';
    const needle = geneFilter.trim().toLowerCase();
    const pinned   = filteredGenes.filter(g => selectedGenes.has(g));
    const rest     = filteredGenes.filter(g => !selectedGenes.has(g) && (!needle || g.toLowerCase().includes(needle)));

    if (pinned.length > 0) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'padding:1px 4px;color:#7ac;font-size:10px;border-bottom:1px solid #333;margin-bottom:2px;letter-spacing:0.04em;';
      hdr.textContent = `✓ Selected (${pinned.length})`;
      geneList.appendChild(hdr);
      for (const g of pinned) geneList.appendChild(_makeGeneRow(g));
      if (rest.length > 0) {
        const sep = document.createElement('div');
        sep.style.cssText = 'padding:1px 4px;color:#666;font-size:10px;border-bottom:1px solid #333;margin:3px 0 2px 0;letter-spacing:0.04em;';
        sep.textContent = 'All genes';
        geneList.appendChild(sep);
      }
    }
    for (const g of rest) geneList.appendChild(_makeGeneRow(g));
  }

  function applyGeneFilter() {
    _renderList();
  }

  function rebuildGenePanel() {
    filteredGenes = enabled
      ? currentTranscriptMeta.genes.filter(gene => !/(Control|Unassigned|Deprecated|Negative)/i.test(gene))
      : [];

    selectedGenes.clear();
    clearCache();
    _renderList();
    updateButton();
  }

  function setVisible(visible) {
    const on = visible && enabled;
    layer.style.display = on ? '' : 'none';
    controls.style.display = on ? 'flex' : 'none';
    if (!on) panel.style.display = 'none';
    draw(viewport.getTransform());
  }

  function setContext(sample, imageMetaNext, transcriptMetaNext, stateToRestore) {
    currentSample = sample;
    currentImageMeta = imageMetaNext;
    currentTranscriptMeta = transcriptMetaNext;
    // Notify hover system of sample change.
    if (hoverCallbacks && typeof hoverCallbacks.onSampleChanged === 'function') {
      hoverCallbacks.onSampleChanged(sample);
    }
    enabled = !!(currentTranscriptMeta && currentTranscriptMeta.genes && currentTranscriptMeta.genes.length);
    rebuildGenePanel();  // clears selectedGenes
    if (stateToRestore) {
      if (stateToRestore.selectedGenes) {
        stateToRestore.selectedGenes.forEach(g => {
          if (filteredGenes.includes(g)) selectedGenes.add(g);
        });
      }
      if (stateToRestore.geneColors) {
        Object.assign(geneColors, stateToRestore.geneColors);
      }
      if (stateToRestore.pointRadius !== undefined) {
        POINT_RADIUS = stateToRestore.pointRadius;
        transcriptSizeSlider.value = String(POINT_RADIUS);
      }
      if (stateToRestore.geneFilter !== undefined) {
        geneFilter = stateToRestore.geneFilter;
        searchInput.value = geneFilter;
        searchClear.style.display = geneFilter ? 'block' : 'none';
      }
      // Rebuild list now that selectedGenes and geneColors are restored
      _renderList();
      updateButton();
    }
    const shouldBeVisible = (stateToRestore && stateToRestore.visible !== undefined)
      ? stateToRestore.visible : true;
    setVisible(shouldBeVisible);
    if (stateToRestore && stateToRestore.panelOpen) {
      panel.style.display = 'flex';
    }
    update(viewport.getTransform());
  }

  function getState() {
    return {
      selectedGenes: [...selectedGenes],
      geneColors: { ...geneColors },
      geneFilter,
      pointRadius: POINT_RADIUS,
      panelOpen: panel.style.display !== 'none',
      visible: !!(enabled && layer.style.display !== 'none'),
    };
  }

  function update(transform) {
    if (!enabled) {
      abortStale(new Set());
      draw(transform);
      return;
    }

    currentGrid = bestGrid(transform.scale);
    currentLevel = bestImageLevel(transform.scale);
    currentGeneKey = geneKey();

    if (!currentGeneKey) {
      abortStale(new Set());
      draw(transform);
      return;
    }

    const visibleKeys = new Set();
    const all = visibleRange(currentLevel, transform, PREFETCH);
    for (let r = all.r0; r <= all.r1; r++) {
      for (let c = all.c0; c <= all.c1; c++) {
        const k = cacheKey(currentGrid, currentLevel, r, c, currentGeneKey);
        visibleKeys.add(k);
        if (cache.has(k)) cache.get(k).lastUsed = Date.now();
        fetchTile(currentGrid, currentLevel, r, c, currentGeneKey);
      }
    }

    abortStale(visibleKeys);
    draw(transform);
  }

  toggleBtn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });

  searchInput.addEventListener('input', () => {
    geneFilter = searchInput.value;
    searchClear.style.display = geneFilter ? 'block' : 'none';
    applyGeneFilter();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    geneFilter = '';
    searchClear.style.display = 'none';
    applyGeneFilter();
    searchInput.focus();
  });

  viewport.onChange(update);
  rebuildGenePanel();
  setVisible(true);
  update(viewport.getTransform());

  return {
    getSelectedGenes: () => [...selectedGenes],
    setVisible,
    setContext,
    getState,
  };
}
