/**
 * cells.js
 *
 * Viewport-driven Xenium cell overlay with per-tile caching.
 * Supports sample switching and per-sample enable/disable at runtime.
 */

function createXeCells(container, baseUrl, imageMeta, cellsMeta, viewport, log, sharedRow, sampleName = null, settings = null, annotationLayers = []) {
  const MAX_CACHED = 200;
  const PREFETCH = 1;
  const BOUNDARY_LINE_WIDTH = 1.5;
  let POINT_RADIUS = 3;

  let drawToken = 0;
  let redrawQueued = false;
  let currentSample = sampleName;
  let currentImageMeta = imageMeta;
  let currentCellsMeta = cellsMeta;
  let enabled = !!currentCellsMeta;

  const layer = document.createElement('canvas');
  layer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2.5;';
  container.appendChild(layer);
  const ctx = layer.getContext('2d');

  const controls = document.createElement('div');
  controls.dataset.ivUi = 'true';
  controls.style.cssText = [
    ...(sharedRow ? [] : ['position:absolute', 'top:86px', 'right:8px', 'z-index:11']),
    'display:flex', 'flex-direction:column', 'gap:4px',
    'padding:4px 6px', 'border-radius:6px',
    'background:rgba(0,0,0,0.55)', 'color:#eee',
    'font:12px monospace',
  ].join(';');
  if (sharedRow) sharedRow.insertBefore(controls, sharedRow.firstChild);
  else container.appendChild(controls);

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Cells';
  toggleBtn.title = 'Toggle cell categories panel';
  toggleBtn.style.cssText = [
    'background:transparent', 'border:1px solid #888',
    'color:#eee', 'border-radius:4px', 'padding:3px 7px',
    'cursor:pointer', 'font-size:12px', 'line-height:1.4', 'text-align:left',
  ].join(';');
  toggleBtn.dataset.ivUi = 'true';
  controls.appendChild(toggleBtn);

  const panel = document.createElement('div');
  panel.style.cssText = [
    'display:none', 'max-height:220px', 'overflow-y:auto',
    'padding-top:2px', 'border-top:1px solid rgba(255,255,255,0.12)',
  ].join(';');
  controls.appendChild(panel);

  const cache = new Map();
  const inflight = new Map();
  let lastNeededKeys = new Set();

  let isVisible = true;
  let currentLevel = 0;
  let hasCategories = false;
  let categoryColors = { All: '#888888' };
  const selectedCategories = new Set();
  let activeLayerIdx = 0;
  let activeCellIdToCategory = {};  // {cell_id_str: category_str} for current sample + layer

  function _buildCellIdLookup() {
    if (!annotationLayers.length) { activeCellIdToCategory = {}; return; }
    const layer = annotationLayers[Math.min(activeLayerIdx, annotationLayers.length - 1)];
    activeCellIdToCategory = (layer.annotations_by_sample || {})[currentSample] || {};
  }

  function _applyCategoryColorsFromLayer() {
    if (!annotationLayers.length) return;
    const layer = annotationLayers[Math.min(activeLayerIdx, annotationLayers.length - 1)];
    if (layer.colors && Object.keys(layer.colors).length) {
      categoryColors = Object.assign({}, layer.colors);
    } else {
      categoryColors = { All: '#888888' };
    }
    hasCategories = !!(enabled && Object.keys(activeCellIdToCategory).length);
  }

  function applyMeta(meta) {
    currentCellsMeta = meta;
    enabled = !!currentCellsMeta;
    if (annotationLayers.length) {
      _buildCellIdLookup();
      _applyCategoryColorsFromLayer();
    } else {
      hasCategories = !!(enabled && currentCellsMeta.has_categories);
      if (enabled && hasCategories && currentCellsMeta.category_colors && Object.keys(currentCellsMeta.category_colors).length) {
        categoryColors = Object.assign({}, currentCellsMeta.category_colors);
      } else {
        categoryColors = { All: '#888888' };
      }
    }
    selectedCategories.clear();
  }

  function clearCache() {
    cache.clear();
    for (const ctrl of inflight.values()) ctrl.abort();
    inflight.clear();
  }

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

  function bestImageLevel(scale) {
    for (let i = 0; i < currentImageMeta.n_levels; i++) {
      if (scale >= 1 / currentImageMeta.levels[i].downsample) return i;
    }
    return currentImageMeta.n_levels - 1;
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
    const x1 = Math.min(lm.width, (cw - ox) / scale / (l0.width / lm.width));
    const y1 = Math.min(lm.height, (ch - oy) / scale / (l0.height / lm.height));

    const c0 = Math.max(0, Math.floor(x0 / TILE) - pad);
    const r0 = Math.max(0, Math.floor(y0 / TILE) - pad);
    const c1 = Math.min(lm.n_tiles_x - 1, Math.floor(x1 / TILE) + pad);
    const r1 = Math.min(lm.n_tiles_y - 1, Math.floor(y1 / TILE) + pad);

    const tiles = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        tiles.push({ level, row: r, col: c });
      }
    }
    return tiles;
  }

  function cacheKey(tile) {
    return `${currentSample}|${tile.level},${tile.row},${tile.col}`;
  }

  function fetchTile(tile) {
    const key = cacheKey(tile);
    if (cache.has(key) || inflight.has(key) || !enabled) return;
    if (selectedCategories.size === 0) return;

    const ctrl = new AbortController();
    inflight.set(key, ctrl);

    fetch(
      `${baseUrl}/xenium_cells?sample=${encodeURIComponent(currentSample)}&level=${tile.level}&row=${tile.row}&col=${tile.col}`,
      { signal: ctrl.signal }
    )
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const cells = data.cells || [];
        cache.set(key, cells);
        inflight.delete(key);

        const _maxCached = Math.max(
          settings ? settings.get('cellCacheSize') : MAX_CACHED,
          lastNeededKeys.size + 10
        );
        if (cache.size > _maxCached) {
          // Evict oldest entry that is not currently needed by the viewport.
          for (const k of cache.keys()) {
            if (!lastNeededKeys.has(k)) { cache.delete(k); break; }
          }
        }

        requestDraw();
      })
      .catch(() => { inflight.delete(key); });
  }

  function requestDraw() {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => {
      redrawQueued = false;
      draw(viewport.getTransform());
    });
  }

  function resolveCategory(cell) {
    if (annotationLayers.length) {
      const cat = activeCellIdToCategory[String(cell.cell_id)];
      return (cat != null) ? String(cat) : 'All';
    }
    if (!hasCategories) return 'All';
    return (cell.category != null) ? String(cell.category) : 'All';
  }

  function drawDot(vpX, vpY, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(vpX, vpY, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [
      parseInt(result[1], 16),
      parseInt(result[2], 16),
      parseInt(result[3], 16),
    ] : [128, 128, 128];
  }

  function drawBoundary(boundaryCoords, color) {
    if (!boundaryCoords || boundaryCoords.length < 3) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = BOUNDARY_LINE_WIDTH;
    ctx.fillStyle = `rgba(${hexToRgb(color).join(',')},0.1)`;

    ctx.beginPath();
    let isFirst = true;
    for (const [x, y] of boundaryCoords) {
      const sp = viewport.toScreenSpace(x, y);
      if (isFirst) {
        ctx.moveTo(sp.x, sp.y);
        isFirst = false;
      } else {
        ctx.lineTo(sp.x, sp.y);
      }
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function draw(transform) {
    const token = ++drawToken;
    if (!isVisible || !enabled) {
      ctx.clearRect(0, 0, layer.width, layer.height);
      return;
    }

    ctx.clearRect(0, 0, layer.width, layer.height);
    currentLevel = bestImageLevel(transform.scale);
    const _prefetch = settings ? Math.round(settings.get('prefetchBorder')) : PREFETCH;
    const tiles = visibleRange(currentLevel, transform, _prefetch);

    // Abort inflight requests for tiles no longer in the visible+prefetch set.
    const neededKeys = new Set(tiles.map(cacheKey));
    lastNeededKeys = neededKeys;
    for (const [k, ctrl] of [...inflight]) {
      if (!neededKeys.has(k)) { ctrl.abort(); inflight.delete(k); }
    }

    // Force-dot mode when visible cell count exceeds the settings threshold.
    // Use pad=0 so prefetch tiles beyond the viewport don't inflate the count.
    const _maxBounds = settings ? settings.get('maxCellsBoundaries') : 0;
    let _totalCells = 0;
    if (_maxBounds > 0) {
      for (const _t of visibleRange(currentLevel, transform, 0)) {
        const _k = cacheKey(_t);
        if (cache.has(_k)) _totalCells += (cache.get(_k) || []).length;
      }
    }
    const _forceDot = _maxBounds > 0 && _totalCells > _maxBounds;

    for (const tile of tiles) {
      const key = cacheKey(tile);
      if (!cache.has(key)) {
        fetchTile(tile);
        continue;
      }

      const cells = cache.get(key) || [];
      cache.delete(key);
      cache.set(key, cells);

      for (const cell of cells) {
        const cat = resolveCategory(cell);
        if (!selectedCategories.has(cat)) continue;

        const sp = viewport.toScreenSpace(cell.x, cell.y);
        if (sp.x < -20 || sp.x > layer.width + 20 || sp.y < -20 || sp.y > layer.height + 20) {
          continue;
        }

        const color = categoryColors[cat] || '#888888';
        if (_forceDot || cell.is_dot) {
          drawDot(sp.x, sp.y, POINT_RADIUS, color);
        } else if (cell.boundary) {
          drawBoundary(cell.boundary, color);
        } else {
          drawDot(sp.x, sp.y, POINT_RADIUS, color);
        }
      }
    }

    if (token !== drawToken) return;
  }

  function updateButton() {
    if (!enabled) {
      toggleBtn.textContent = 'Cells (off)';
      return;
    }
    const total = Object.keys(categoryColors).length;
    const on = selectedCategories.size;
    toggleBtn.textContent = total === 1 ? 'Cells' : `Cells (${on}/${total})`;
  }

  function rebuildCategoryPanel() {
    panel.innerHTML = '';
    if (!enabled) {
      updateButton();
      return;
    }

    // ── annotation layer picker (only when multiple layers available) ───────────────
    if (annotationLayers.length > 1) {
      const layerRow = document.createElement('div');
      layerRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:0 0 6px;border-bottom:1px solid rgba(255,255,255,0.12);margin-bottom:4px;';
      const layerLabel = document.createElement('span');
      layerLabel.textContent = 'Layer';
      layerLabel.style.cssText = 'color:#ddd;white-space:nowrap;';
      const layerSelect = document.createElement('select');
      layerSelect.style.cssText = 'background:#1a1a1a;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px;font:12px monospace;flex:1;min-width:0;';
      for (let i = 0; i < annotationLayers.length; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = annotationLayers[i].name || ('Layer ' + i);
        if (i === activeLayerIdx) opt.selected = true;
        layerSelect.appendChild(opt);
      }
      layerSelect.addEventListener('change', () => {
        activeLayerIdx = parseInt(layerSelect.value, 10);
        _buildCellIdLookup();
        _applyCategoryColorsFromLayer();
        selectedCategories.clear();
        rebuildCategoryPanel();
        requestDraw();
      });
      layerRow.appendChild(layerLabel);
      layerRow.appendChild(layerSelect);
      panel.appendChild(layerRow);
    }

    const cats = Object.keys(categoryColors);

    const sizeRow = document.createElement('div');
    sizeRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:0 0 4px;border-bottom:1px solid rgba(255,255,255,0.12);margin-bottom:4px;';
    sizeRow.innerHTML = '<span style="color:#ddd;">Cell size</span>';
    const cellSizeSlider = document.createElement('input');
    cellSizeSlider.type = 'range';
    cellSizeSlider.min = '1';
    cellSizeSlider.max = '16';
    cellSizeSlider.step = '1';
    cellSizeSlider.value = String(POINT_RADIUS);
    cellSizeSlider.style.cssText = 'width:90px;';
    cellSizeSlider.addEventListener('input', () => {
      POINT_RADIUS = Number(cellSizeSlider.value);
      requestDraw();
    });
    sizeRow.appendChild(cellSizeSlider);
    panel.appendChild(sizeRow);

    if (cats.length > 1) {
      const allRow = document.createElement('div');
      allRow.style.cssText = 'display:flex;gap:6px;padding:2px 0 4px;border-bottom:1px solid rgba(255,255,255,0.12);margin-bottom:2px;';
      const btnStyle = [
        'background:transparent', 'border:1px solid #666',
        'color:#ccc', 'border-radius:3px', 'padding:1px 6px',
        'cursor:pointer', 'font-size:11px', 'line-height:1.4',
      ].join(';');

      const allBtn = document.createElement('button');
      allBtn.textContent = 'all';
      allBtn.style.cssText = btnStyle;
      allBtn.addEventListener('click', () => {
        cats.forEach(c => selectedCategories.add(c));
        rebuildCategoryPanel(); updateButton(); requestDraw();
      });

      const noneBtn = document.createElement('button');
      noneBtn.textContent = 'none';
      noneBtn.style.cssText = btnStyle;
      noneBtn.addEventListener('click', () => {
        selectedCategories.clear();
        rebuildCategoryPanel(); updateButton(); requestDraw();
      });

      allRow.appendChild(allBtn);
      allRow.appendChild(noneBtn);
      panel.appendChild(allRow);
    }

    for (const cat of cats) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 0;';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cursor = 'pointer';
      checkbox.checked = selectedCategories.has(cat);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedCategories.add(cat);
        else selectedCategories.delete(cat);
        updateButton();
        requestDraw();
      });

      const colorPicker = document.createElement('input');
      colorPicker.type = 'color';
      colorPicker.value = categoryColors[cat];
      colorPicker.title = `Color for ${cat}`;
      colorPicker.style.cssText = 'width:20px;height:20px;border:none;background:none;padding:0;cursor:pointer;flex-shrink:0;';
      colorPicker.addEventListener('input', () => {
        categoryColors[cat] = colorPicker.value;
        requestDraw();
      });

      const label = document.createElement('label');
      label.textContent = cat;
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
      });

      row.appendChild(checkbox);
      row.appendChild(colorPicker);
      row.appendChild(label);
      panel.appendChild(row);
    }

    updateButton();
  }

  function setVisible(v) {
    isVisible = v;
    const on = isVisible && enabled;
    layer.style.display = on ? '' : 'none';
    controls.style.display = on ? 'flex' : 'none';
    if (!on) panel.style.display = 'none';
    requestDraw();
  }

  function setContext(sample, imageMetaNext, cellsMetaNext, stateToRestore) {
    currentSample = sample;
    currentImageMeta = imageMetaNext;
    if (stateToRestore && stateToRestore.activeLayerIdx != null) {
      activeLayerIdx = stateToRestore.activeLayerIdx;
    }
    applyMeta(cellsMetaNext);  // clears selectedCategories, rebuilds lookup
    if (stateToRestore && stateToRestore.selectedCategories) {
      stateToRestore.selectedCategories.forEach(c => selectedCategories.add(c));
    }
    clearCache();
    rebuildCategoryPanel();
    const shouldBeVisible = (stateToRestore && stateToRestore.visible !== undefined)
      ? stateToRestore.visible : true;
    setVisible(shouldBeVisible);
    if (stateToRestore && stateToRestore.panelOpen) {
      panel.style.display = 'block';
    }
  }

  function getState() {
    return {
      selectedCategories: [...selectedCategories],
      panelOpen: panel.style.display !== 'none',
      visible: isVisible,
      activeLayerIdx,
    };
  }

  toggleBtn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  function setAnnotationLayers(layers) {
    annotationLayers = layers || [];
    _buildCellIdLookup();
    _applyCategoryColorsFromLayer();
    rebuildCategoryPanel();
    requestDraw();
  }

  viewport.onChange(() => {
    requestDraw();
  });

  applyMeta(cellsMeta);
  rebuildCategoryPanel();
  setVisible(true);

  return {
    setVisible,
    setContext,
    setAnnotationLayers,
    getState,
    getVisible: () => isVisible,
    getSelectedCategories: () => [...selectedCategories],
  };
}
