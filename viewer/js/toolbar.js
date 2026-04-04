/**
 * toolbar.js
 *
 * Owns the tool buttons DOM and all mouse event routing.
 * This is the ONLY place that attaches mousedown/mousemove/mouseup/wheel
 * to the container. Based on active tool it delegates to:
 *   - viewport  (pan tool)
 *   - draw      (draw tool)
 *   - baseUrl   (click tool → POST /click)
 *
 * Exposes:
 *   toolbar.getActiveTool()   → 'pan' | 'draw_positive' | 'draw_negative' | 'click'
 *   toolbar.setTool(name)
 */

function createToolbar(container, viewport, draw, baseUrl) {
  const ZOOM_SPEED = 0.001;

  let activeTool = 'pan';

  // ── build toolbar DOM ──────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.dataset.ivUi = 'true';
  bar.style.cssText = [
    'position:absolute', 'top:8px', 'left:8px', 'z-index:10',
    'display:flex', 'gap:4px', 'background:rgba(0,0,0,0.55)',
    'padding:4px 6px', 'border-radius:6px',
  ].join(';');
  container.appendChild(bar);

  const tools = [
    { name: 'pan',           label: '✥',     title: 'Pan / zoom' },
    { name: 'draw_positive', label: 'draw+', title: 'Draw positive contour' },
    { name: 'draw_negative', label: 'draw-', title: 'Draw negative contour' },
    // { name: 'click',         label: '⊕',     title: 'Click to record point' },
  ];

  const buttons = {};
  for (const t of tools) {
    const btn = document.createElement('button');
    btn.textContent = t.label;
    btn.title       = t.title;
    btn.style.cssText = [
      'background:transparent', 'border:1px solid #888',
      'color:#eee', 'border-radius:4px', 'padding:2px 7px',
      'cursor:pointer', 'font-size:13px', 'line-height:1.4',
    ].join(';');
    btn.addEventListener('click', () => setTool(t.name));
    bar.appendChild(btn);
    buttons[t.name] = btn;
  }

  // flush button — not a tool, just an action
  const flushBtn = document.createElement('button');
  flushBtn.textContent = '⬇'; // ⬆
  flushBtn.title       = 'Send strokes to Python';
  flushBtn.style.cssText = [
    'background:transparent', 'border:1px solid #888',
    'color:#eee', 'border-radius:4px', 'padding:2px 7px',
    'cursor:pointer', 'font-size:15px', 'line-height:1.4',
    'margin-left:6px',  // small gap to visually separate from tool buttons
  ].join(';');
  flushBtn.addEventListener('click', () => window.ivFlushStrokes());
  bar.appendChild(flushBtn);

  // annotations visibility toggle
  let annotationsVisible = true;
  const toggleAnnotBtn = document.createElement('button');
  toggleAnnotBtn.textContent = '👀';
  toggleAnnotBtn.title       = 'Toggle annotations visibility';
  toggleAnnotBtn.style.cssText = [
    'background:rgba(255,255,255,0.2)', 'border:1px solid #888',
    'color:#eee', 'border-radius:4px', 'padding:2px 7px',
    'cursor:pointer', 'font-size:13px', 'line-height:1.4',
  ].join(';');
  toggleAnnotBtn.addEventListener('click', () => {
    annotationsVisible = !annotationsVisible;
    draw.setVisible(annotationsVisible);
    toggleAnnotBtn.style.background = annotationsVisible
      ? 'rgba(255,255,255,0.2)' : 'transparent';
    toggleAnnotBtn.style.opacity = annotationsVisible ? '1' : '0.45';
  });
  bar.appendChild(toggleAnnotBtn);

  // extra draw controls — only visible in draw mode
  const drawControls = document.createElement('div');
  drawControls.style.cssText = 'display:none;gap:4px;align-items:center;';
  drawControls.innerHTML = `
    <button title="Brush mode: line" data-brush-mode-btn
      style="background:rgba(255,255,255,0.15);border:1px solid #aaa;color:#eee;
             border-radius:4px;padding:2px 7px;cursor:pointer;font-size:14px;
             line-height:1.3;">∿</button>
    <input type="color" value="#ff2222" title="Stroke color"
      style="width:26px;height:26px;border:none;background:none;cursor:pointer;padding:0;">
    <span style="color:#ddd;font-size:11px;">Width</span>
    <input type="range" min="1" max="50" step="1" value="2" title="Stroke width (px)"
      style="width:80px;">
    <span style="color:#ddd;font-size:11px;">Smoothing</span>
    <input type="range" min="0" max="1" step="0.05" value="0.35" title="Stroke smoothing"
      style="width:70px;">
    <button title="Undo last stroke"
      style="background:transparent;border:1px solid #888;color:#eee;
             border-radius:4px;padding:2px 7px;cursor:pointer;font-size:13px;">↩</button>
    <button title="Clear all strokes"
      style="background:transparent;border:1px solid #888;color:#eee;
             border-radius:4px;padding:2px 7px;cursor:pointer;font-size:13px;">✕</button>
  `;
  bar.appendChild(drawControls);

  const [brushModeBtn, colorPicker, widthSlider, smoothSlider, undoBtn, clearBtn] =
    drawControls.querySelectorAll('button[data-brush-mode-btn], input, button:not([data-brush-mode-btn])');

  brushModeBtn.addEventListener('click', () => {
    const next = (typeof draw.getBrushMode === 'function' && draw.getBrushMode() === 'noodle')
      ? 'line' : 'noodle';
    if (typeof draw.setBrushMode === 'function') draw.setBrushMode(next);
    _syncBrushModeBtn(next);
    _syncWidthSlider(next);
    container.style.cursor = next === 'noodle' ? 'none' : 'crosshair';
  });

  // icon shows the OTHER mode (what you'd switch TO)
  function _syncBrushModeBtn(bm) {
    if (bm === 'noodle') {
      brushModeBtn.textContent = '∿';
      brushModeBtn.title       = 'Brush mode: disk (noodle) — click for line';
      brushModeBtn.style.background = 'rgba(255,255,100,0.20)';
    } else {
      brushModeBtn.textContent = '⬤';
      brushModeBtn.title       = 'Brush mode: line — click for disk (noodle)';
      brushModeBtn.style.background = 'rgba(255,255,255,0.15)';
    }
  }

  // Update slider range+value to match the active brush mode.
  function _syncWidthSlider(bm) {
    if (bm === 'noodle') {
      widthSlider.min   = '50';
      widthSlider.max   = '10000';
      widthSlider.step  = '50';
      widthSlider.title = 'Disk radius (px)';
      widthSlider.value = String(
        (typeof draw.getNoodleRadius === 'function') ? draw.getNoodleRadius() : 500
      );
    } else {
      widthSlider.min   = '1';
      widthSlider.max   = '50';
      widthSlider.step  = '1';
      widthSlider.title = 'Stroke width (px)';
      widthSlider.value = String(
        (typeof draw.getWidth === 'function') ? draw.getWidth() : 2
      );
    }
  }

  colorPicker.addEventListener('input',  () => draw.setColor(colorPicker.value));
  widthSlider.addEventListener('input',  () => {
    const bm = (typeof draw.getBrushMode === 'function') ? draw.getBrushMode() : 'line';
    if (bm === 'noodle') {
      if (typeof draw.setNoodleRadius === 'function') draw.setNoodleRadius(Number(widthSlider.value));
    } else {
      draw.setWidth(Number(widthSlider.value));
    }
  });
  smoothSlider.addEventListener('input', () => {
    if (typeof draw.setSmoothing === 'function') {
      draw.setSmoothing(Number(smoothSlider.value));
    }
  });
  undoBtn.addEventListener('click', () => draw.undoLast());
  clearBtn.addEventListener('click', () => draw.clear());

  function _isDrawTool(name) {
    return name === 'draw_positive' || name === 'draw_negative';
  }

  function _isUiEventTarget(target) {
    return Boolean(target && target.closest && target.closest('[data-iv-ui="true"]'));
  }

  function setTool(name) {
    activeTool = name;
    for (const [n, btn] of Object.entries(buttons)) {
      btn.style.background = (n === name) ? 'rgba(255,255,255,0.2)' : 'transparent';
    }
    drawControls.style.display = _isDrawTool(name) ? 'flex' : 'none';
    if (name === 'draw_positive' || name === 'draw_negative') {
      draw.setMode(name === 'draw_negative' ? 'negative' : 'positive');
      if (typeof draw.getColor === 'function') {
        colorPicker.value = draw.getColor();
      }
      if (typeof draw.getSmoothing === 'function') {
        smoothSlider.value = String(draw.getSmoothing());
      }
      // sync brush mode button and width slider
      const bm = (typeof draw.getBrushMode === 'function') ? draw.getBrushMode() : 'line';
      _syncBrushModeBtn(bm);
      _syncWidthSlider(bm);
    }
    container.style.cursor =
      name === 'pan'  ? 'grab' :
      _isDrawTool(name) ? (
        (typeof draw.getBrushMode === 'function' && draw.getBrushMode() === 'noodle')
          ? 'none' : 'crosshair'
      ) : 'cell';
  }

  setTool('pan');   // initial state

  // ── mouse event routing ────────────────────────────────────────────────────
  let panning = false, panX = 0, panY = 0, panOx = 0, panOy = 0;
  let drawing  = false;
  let mouseDownPos = null;
  const clicks = [];

  container.addEventListener('mousedown', e => {
    if (_isUiEventTarget(e.target)) return;
    if (e.button !== 0) return;
    mouseDownPos = { x: e.clientX, y: e.clientY };
    const { x: vpX, y: vpY } = _toVP(e);

    if (activeTool === 'pan') {
      panning = true;
      panX = e.clientX; panY = e.clientY;
      const t = viewport.getTransform();
      panOx = t.ox; panOy = t.oy;
      container.style.cursor = 'grabbing';
    } else if (_isDrawTool(activeTool)) {
      drawing = true;
      draw.onMouseDown(vpX, vpY);
    }
  });

  window.addEventListener('mousemove', e => {
    if (activeTool === 'pan' && panning) {
      viewport.panBy(e.clientX - panX, e.clientY - panY);
      panX = e.clientX; panY = e.clientY;
    } else if (_isDrawTool(activeTool)) {
      // always forward to draw for cursor tracking; draw.onMouseMove internally
      // skips point recording when no active stroke
      draw.onMouseMove(..._toVPArr(e));
    }
  });

  container.addEventListener('mouseleave', () => {
    if (typeof draw.onMouseLeave === 'function') draw.onMouseLeave();
  });

  window.addEventListener('mouseup', e => {
    if (activeTool === 'pan' && panning) {
      panning = false;
      container.style.cursor = 'grab';
    } else if (_isDrawTool(activeTool) && drawing) {
      drawing = false;
      draw.onMouseUp();
    } else if (activeTool === 'click') {
      // only fire if not dragged
      if (mouseDownPos && _dist(e, mouseDownPos) < 4) {
        const [vpX, vpY] = _toVPArr(e);
        _sendClick(vpX, vpY);
      }
    }
    mouseDownPos = null;
  });

  // double-click → reset in any mode
  container.addEventListener('dblclick', e => {
    if (_isUiEventTarget(e.target)) return;
    viewport.reset();
  });

  // wheel → zoom in any mode
  container.addEventListener('wheel', e => {
    if (_isUiEventTarget(e.target)) return;
    e.preventDefault();
    const [vpX, vpY] = _toVPArr(e);
    viewport.zoomAt(vpX, vpY, -e.deltaY * ZOOM_SPEED);
  }, { passive: false });

  // ── click → POST to server ─────────────────────────────────────────────────
  function _sendClick(vpX, vpY) {
    const img  = viewport.toImageSpace(vpX, vpY);
    const t    = viewport.getTransform();
    clicks.push({
      img_x: Math.round(img.x),
      img_y: Math.round(img.y),
      vp_x:  Math.round(vpX),
      vp_y:  Math.round(vpY),
      zoom:  parseFloat(t.scale.toFixed(4)),
    });

    fetch(`${baseUrl}/click`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clicks }),
    }).catch(() => {});
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function _toVP(e) {
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function _toVPArr(e) {
    const r = container.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function _dist(a, b) {
    return Math.hypot(a.clientX - b.x, a.clientY - b.y);
  }

  return {
    getActiveTool: () => activeTool,
    setTool,
  };
}