/**
 * transcripts.js
 *
 * Viewport-driven Xenium transcript overlay with per-tile caching.
 * Selected genes are fetched from the coarsest appropriate Xenium grid and
 * rendered in image space so they stay aligned during pan/zoom.
 */

function createXeTranscripts(container, baseUrl, imageMeta, transcriptMeta, viewport, log, sharedRow) {
  const TILE = imageMeta.tile_size;
  const MAX_CACHED = 300;
  const PREFETCH = 1;
  let POINT_RADIUS = 2;
  const SEARCH_PLACEHOLDER_COLOR = 'rgba(247, 245, 245, 0.35)';  // configurable placeholder opacity

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
  panel.appendChild(sizeRow);

  // inject ::placeholder color rule once per page so the constant is respected
  const _phStyle = document.createElement('style');
  _phStyle.textContent = `.iv-gene-search::placeholder { color: ${SEARCH_PLACEHOLDER_COLOR}; opacity: 1; }`;
  document.head.appendChild(_phStyle);

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
  searchClear.textContent = '\u00d7';  // × character
  searchClear.title = 'Clear search';
  searchClear.style.cssText = [
    'display:none', 'flex-shrink:0',
    'background:transparent', 'border:none',
    'color:rgba(238,238,238,0.6)', 'font-size:15px', 'line-height:1',
    'cursor:pointer', 'padding:0 2px',
  ].join(';');
  searchRow.appendChild(searchClear);

  const geneList = document.createElement('div');
  geneList.style.cssText = 'overflow-y:auto;max-height:180px;';
  panel.appendChild(geneList);

  const cache = new Map();
  const inflight = new Map();
  const selectedGenes = new Set();
  const filteredGenes = transcriptMeta.genes.filter(gene => !/(Control|Unassigned)/i.test(gene));
  let geneFilter = '';

  let currentGrid = bestGrid(viewport.getTransform().scale);
  let currentLevel = bestImageLevel(viewport.getTransform().scale);
  let currentGeneKey = '';

  function resizeLayer() {
    layer.width = container.clientWidth;
    layer.height = container.clientHeight;
    draw(viewport.getTransform());
  }
  window.addEventListener('resize', resizeLayer);
  resizeLayer();

  function bestImageLevel(scale) {
    for (let i = 0; i < imageMeta.n_levels; i++) {
      if (scale >= 1 / imageMeta.levels[i].downsample) return i;
    }
    return imageMeta.n_levels - 1;
  }

  function bestGrid(scale) {
    for (let i = 0; i < transcriptMeta.n_grids; i++) {
      if (scale >= 1 / transcriptMeta.grids[i].downsample) return i;
    }
    return transcriptMeta.n_grids - 1;
  }

  function visibleRange(level, transform, pad) {
    const { scale, ox, oy } = transform;
    const lm = imageMeta.levels[level];
    const l0 = imageMeta.levels[0];
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

  // per-gene color map (populated lazily, mutable via color pickers)
  const geneColors = {};

  function defaultColor(gene) {
    let hash = 0;
    for (let i = 0; i < gene.length; i++) hash = ((hash * 31) + gene.charCodeAt(i)) % 360;
    // convert HSL → hex via a 1-pixel off-screen canvas
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
    return `${genes}|${grid}|${level}|${row}|${col}`;
  }

  function draw(transform) {
    ctx.clearRect(0, 0, layer.width, layer.height);
    if (selectedGenes.size === 0) return;

    const vis = visibleRange(currentLevel, transform, 0);
    for (let r = vis.r0; r <= vis.r1; r++) {
      for (let c = vis.c0; c <= vis.c1; c++) {
        const entry = cache.get(cacheKey(currentGrid, currentLevel, r, c, currentGeneKey));
        if (!entry) continue;
        entry.lastUsed = Date.now();
        for (const pt of entry.points) {
          const sp = viewport.toScreenSpace(pt.x, pt.y);
          if (sp.x < -POINT_RADIUS || sp.y < -POINT_RADIUS || sp.x > layer.width + POINT_RADIUS || sp.y > layer.height + POINT_RADIUS) {
            continue;
          }
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, POINT_RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = geneColor(pt.gene);
          ctx.fill();
        }
      }
    }
  }

  function fetchTile(grid, level, row, col, genes) {
    const k = cacheKey(grid, level, row, col, genes);
    if (cache.has(k) || inflight.has(k) || !genes) return;

    const ctrl = new AbortController();
    inflight.set(k, ctrl);
    const url = `${baseUrl}/xenium_tile?grid=${grid}&level=${level}&row=${row}&col=${col}&genes=${encodeURIComponent(genes)}`;
    fetch(url, { signal: ctrl.signal })
      .then(r => r.json())
      .then(data => {
        inflight.delete(k);
        cache.set(k, {
          points: Array.isArray(data.points) ? data.points : [],
          lastUsed: Date.now(),
        });
        evict();
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
    toggleBtn.textContent = `Genes (${selectedGenes.size}/${total})`;
  }

  function applyGeneFilter() {
    const needle = geneFilter.trim().toLowerCase();
    for (const row of geneList.children) {
      const gene = row.dataset.gene || '';
      row.style.display = (!needle || gene.toLowerCase().includes(needle)) ? 'flex' : 'none';
    }
  }

  function rebuildGenePanel() {
    geneList.innerHTML = '';
    for (const gene of filteredGenes) {
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
      geneList.appendChild(row);
    }

    applyGeneFilter();
  }

  function update(transform) {
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

  rebuildGenePanel();
  updateButton();
  viewport.onChange(update);
  update(viewport.getTransform());

  return {
    getSelectedGenes: () => [...selectedGenes],
    setVisible: visible => {
      layer.style.display = visible ? '' : 'none';
      controls.style.display = visible ? 'flex' : 'none';
    },
  };
}