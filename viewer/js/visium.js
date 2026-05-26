/**
 * visium.js
 *
 * Semi-transparent disk overlay for Visium spot gene-expression data.
 * Spots (in primary image pixel space) are fetched lazily per (sample, gene)
 * from GET /visium_genes?sample=X&gene=G → {x, y, values, spot_size}
 *
 * UI:
 *   - "Genes" toolbar button: opens/closes the gene-selection panel
 *   - Searchable gene list (single selection)
 *   - Opacity slider
 *   - Low / high colour pickers (defaults: blue / red)
 *
 * Exposes:
 *   visium.setContext(sample, baseUrl)
 *   visium.draw()
 *   visium.genesBtn          → <button> element for toolbar
 */
function createVisiumOverlay(container, viewport, genesBySample) {
  // ── canvas ─────────────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:4;';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // ── state ──────────────────────────────────────────────────────────────────
  let currentSample  = null;
  let currentBaseUrl = null;
  let activeGene     = null;
  let opacity        = 0.6;
  let colorLow       = '#0000ff';
  let colorHigh      = '#ff0000';
  const dataCache    = {};  // key: `${sample}||${gene}` → {x, y, values, spotSize}

  // ── Gene panel ─────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.dataset.ivUi = 'true';
  panel.style.cssText = [
    'display:none', 'position:absolute', 'top:44px', 'left:8px',
    'z-index:20', 'background:rgba(20,20,20,0.92)', 'border:1px solid #555',
    'border-radius:6px', 'padding:10px', 'min-width:260px', 'max-width:320px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.5)', 'font-size:13px', 'color:#eee',
  ].join(';');

  // -- Search input
  const searchInput = document.createElement('input');
  searchInput.type        = 'text';
  searchInput.placeholder = 'Search gene…';
  searchInput.dataset.ivUi = 'true';
  searchInput.style.cssText = [
    'width:100%', 'box-sizing:border-box', 'background:#333', 'color:#eee',
    'border:1px solid #666', 'border-radius:4px', 'padding:4px 6px',
    'font-size:13px', 'margin-bottom:6px',
  ].join(';');

  // -- Gene list
  const listBox = document.createElement('div');
  listBox.style.cssText = [
    'max-height:220px', 'overflow-y:auto', 'border:1px solid #444',
    'border-radius:4px', 'background:#1a1a1a', 'margin-bottom:8px',
  ].join(';');

  // -- Controls row
  const ctrlRow = document.createElement('div');
  ctrlRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

  const opLabel = document.createElement('span');
  opLabel.textContent = 'Opacity';
  opLabel.style.cssText = 'color:#ccc;font-size:11px;';

  const opSlider = document.createElement('input');
  opSlider.type  = 'range';
  opSlider.min   = '0';
  opSlider.max   = '1';
  opSlider.step  = '0.05';
  opSlider.value = String(opacity);
  opSlider.style.width = '80px';
  opSlider.dataset.ivUi = 'true';

  const lowLabel = document.createElement('span');
  lowLabel.textContent = 'Low';
  lowLabel.style.cssText = 'color:#ccc;font-size:11px;';

  const lowPicker = document.createElement('input');
  lowPicker.type  = 'color';
  lowPicker.value = colorLow;
  lowPicker.style.cssText = 'width:26px;height:22px;border:none;background:none;cursor:pointer;padding:0;';
  lowPicker.dataset.ivUi = 'true';

  const highLabel = document.createElement('span');
  highLabel.textContent = 'High';
  highLabel.style.cssText = 'color:#ccc;font-size:11px;';

  const highPicker = document.createElement('input');
  highPicker.type  = 'color';
  highPicker.value = colorHigh;
  highPicker.style.cssText = 'width:26px;height:22px;border:none;background:none;cursor:pointer;padding:0;';
  highPicker.dataset.ivUi = 'true';

  ctrlRow.appendChild(opLabel);
  ctrlRow.appendChild(opSlider);
  ctrlRow.appendChild(lowLabel);
  ctrlRow.appendChild(lowPicker);
  ctrlRow.appendChild(highLabel);
  ctrlRow.appendChild(highPicker);

  panel.appendChild(searchInput);
  panel.appendChild(listBox);
  panel.appendChild(ctrlRow);
  container.appendChild(panel);

  // ── Toolbar "Genes" button ─────────────────────────────────────────────────
  const genesBtn = document.createElement('button');
  genesBtn.textContent = 'Genes';
  genesBtn.title = 'Show/hide gene expression overlay';
  genesBtn.dataset.ivUi = 'true';
  genesBtn.style.cssText = [
    'background:transparent', 'border:1px solid #888',
    'color:#eee', 'border-radius:4px', 'padding:2px 7px',
    'cursor:pointer', 'font-size:13px', 'line-height:1.4',
    'opacity:0.45',
  ].join(';');
  genesBtn.addEventListener('click', _togglePanel);

  let panelOpen = false;

  function _closePanel() {
    panelOpen = false;
    panel.style.display = 'none';
    genesBtn.style.background = 'transparent';
    genesBtn.style.opacity    = '0.45';
    document.removeEventListener('keydown', _genesPanelKeydown, true);
  }

  function _genesPanelKeydown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      _closePanel();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  function _togglePanel() {
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'block' : 'none';
    genesBtn.style.background = panelOpen ? 'rgba(255,255,255,0.2)' : 'transparent';
    genesBtn.style.opacity    = panelOpen ? '1' : '0.45';
    if (panelOpen) {
      _rebuildList();
      searchInput.focus();
      document.addEventListener('keydown', _genesPanelKeydown, true);
    } else {
      document.removeEventListener('keydown', _genesPanelKeydown, true);
    }
  }

  // ── Gene list rendering ────────────────────────────────────────────────────
  let _allGenes = [];
  let _filteredGenes = [];

  function _rebuildList() {
    _allGenes = (genesBySample && currentSample && genesBySample[currentSample]) || [];
    _filter(searchInput.value);
  }

  function _filter(query) {
    const q = query.trim().toLowerCase();
    _filteredGenes = q ? _allGenes.filter(g => g.toLowerCase().includes(q)) : _allGenes;
    _renderList();
  }

  function _renderList() {
    listBox.innerHTML = '';
    const MAX_VISIBLE = 300;
    const slice = _filteredGenes.slice(0, MAX_VISIBLE);
    for (const gene of slice) {
      const row = document.createElement('div');
      row.textContent = gene;
      const isActive = gene === activeGene;
      row.style.cssText = [
        'padding:4px 8px', 'cursor:pointer',
        'background:' + (isActive ? 'rgba(100,180,255,0.25)' : 'transparent'),
        'color:' + (isActive ? '#9df' : '#ddd'),
        'border-bottom:1px solid #2a2a2a',
      ].join(';');
      row.addEventListener('mouseenter', () => {
        if (gene !== activeGene) row.style.background = 'rgba(255,255,255,0.07)';
      });
      row.addEventListener('mouseleave', () => {
        if (gene !== activeGene) row.style.background = 'transparent';
      });
      row.addEventListener('click', () => _selectGene(gene));
      listBox.appendChild(row);
    }
    if (_filteredGenes.length > MAX_VISIBLE) {
      const more = document.createElement('div');
      more.textContent = `… ${_filteredGenes.length - MAX_VISIBLE} more — refine search`;
      more.style.cssText = 'padding:4px 8px;color:#888;font-size:11px;font-style:italic;';
      listBox.appendChild(more);
    }
  }

  function _selectGene(gene) {
    activeGene = gene;
    _renderList();
    _fetchAndDraw();
  }

  searchInput.addEventListener('input', () => _filter(searchInput.value));

  // ── Color helpers ──────────────────────────────────────────────────────────
  function _hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  }

  function _lerpColor(t, low, high) {
    // t in [0,1]
    const r = Math.round(low[0] + t * (high[0] - low[0]));
    const g = Math.round(low[1] + t * (high[1] - low[1]));
    const b = Math.round(low[2] + t * (high[2] - low[2]));
    return [r, g, b];
  }

  // ── Canvas size ────────────────────────────────────────────────────────────
  function _resizeCanvas() {
    const w = container.clientWidth  || container.offsetWidth  || 1;
    const h = container.clientHeight || container.offsetHeight || 1;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
    }
  }

  // ── Draw ───────────────────────────────────────────────────────────────────
  function draw() {
    _resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!activeGene || !currentSample) return;
    const key  = currentSample + '||' + activeGene;
    const data = dataCache[key];
    if (!data) return;

    const { scale, ox, oy } = viewport.getTransform();
    const spotR = (data.spotSize / 2) * scale;

    const rgbLow  = _hexToRgb(colorLow);
    const rgbHigh = _hexToRgb(colorHigh);

    const xs     = data.x;
    const ys     = data.y;
    const vals   = data.values;
    const n      = xs.length;

    // Compute min/max for normalisation
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (vals[i] < vmin) vmin = vals[i];
      if (vals[i] > vmax) vmax = vals[i];
    }
    const vrange = vmax > vmin ? vmax - vmin : 1;

    const margin = spotR + 2;
    const xMinV = (-ox - margin) / scale;
    const xMaxV = (canvas.width  - ox + margin) / scale;
    const yMinV = (-oy - margin) / scale;
    const yMaxV = (canvas.height - oy + margin) / scale;

    for (let i = 0; i < n; i++) {
      const px = xs[i];
      const py = ys[i];
      if (px < xMinV || px > xMaxV || py < yMinV || py > yMaxV) continue;
      const t = (vals[i] - vmin) / vrange;
      const [r, g, b] = _lerpColor(t, rgbLow, rgbHigh);
      ctx.beginPath();
      ctx.arc(px * scale + ox, py * scale + oy, Math.max(1, spotR), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${opacity})`;
      ctx.fill();
    }
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  function _fetchAndDraw() {
    if (!activeGene || !currentSample || !currentBaseUrl) { draw(); return; }
    const key = currentSample + '||' + activeGene;
    if (dataCache[key]) { draw(); return; }
    const url = currentBaseUrl + '/visium_genes?sample='
      + encodeURIComponent(currentSample)
      + '&gene=' + encodeURIComponent(activeGene);
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !data.x) return;
        dataCache[key] = {
          x:        new Float32Array(data.x),
          y:        new Float32Array(data.y),
          values:   new Float32Array(data.values),
          spotSize: data.spot_size,
        };
        if (currentSample + '||' + activeGene === key) draw();
      })
      .catch(() => {});
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  opSlider.addEventListener('input', () => {
    opacity = parseFloat(opSlider.value);
    draw();
  });
  lowPicker.addEventListener('input', () => { colorLow  = lowPicker.value;  draw(); });
  highPicker.addEventListener('input', () => { colorHigh = highPicker.value; draw(); });

  viewport.onChange(() => draw());

  // ── Public API ─────────────────────────────────────────────────────────────
  function setContext(sample, baseUrl) {
    currentSample  = sample;
    currentBaseUrl = baseUrl;
    // Rebuild list if panel is open
    if (panelOpen) { _rebuildList(); }
    // Redraw (may be blank if no gene selected or new sample)
    if (activeGene) {
      _fetchAndDraw();
    } else {
      draw();
    }
  }

  return { draw, setContext, genesBtn };
}
