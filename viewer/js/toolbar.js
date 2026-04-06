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

function createToolbar(container, viewport, draw, baseUrl, runInferenceOptions, saveLoadOptions) {
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
    btn.dataset.demoId = 'tool-' + t.name.replace(/_/g, '-');
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
  flushBtn.dataset.demoId = 'flush-btn';
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
  toggleAnnotBtn.dataset.demoId = 'toggle-annot-btn';
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
    <button title="Brush mode: line" data-brush-mode-btn data-demo-id="brush-mode-btn"
      style="background:rgba(255,255,255,0.15);border:1px solid #aaa;color:#eee;
             border-radius:4px;padding:2px 7px;cursor:pointer;font-size:14px;
             line-height:1.3;">∿</button>
    <input type="color" value="#ff2222" title="Stroke color" data-demo-id="color-picker"
      style="width:26px;height:26px;border:none;background:none;cursor:pointer;padding:0;">
    <span style="color:#ddd;font-size:11px;">Width</span>
    <input type="range" min="1" max="50" step="1" value="2" title="Stroke width (px)" data-demo-id="width-slider"
      style="width:80px;">
    <span style="color:#ddd;font-size:11px;">Smoothing</span>
    <input type="range" min="0" max="1" step="0.05" value="0.35" title="Stroke smoothing" data-demo-id="smooth-slider"
      style="width:70px;">
    <button title="Undo last stroke" data-demo-id="undo-btn"
      style="background:transparent;border:1px solid #888;color:#eee;
             border-radius:4px;padding:2px 7px;cursor:pointer;font-size:13px;">↩</button>
    <button title="Clear all strokes"
      style="background:transparent;border:1px solid #888;color:#eee;
             border-radius:4px;padding:2px 7px;cursor:pointer;font-size:13px;">✕</button>
  `;
  bar.appendChild(drawControls);

  const [brushModeBtn, colorPicker, widthSlider, smoothSlider, undoBtn, clearBtn] =
    drawControls.querySelectorAll('button[data-brush-mode-btn], input, button:not([data-brush-mode-btn])');

  // hide the "Clear all strokes" control but keep it in the DOM for compatibility
  try { clearBtn.style.display = 'none'; } catch (e) {}

  brushModeBtn.addEventListener('click', () => {
    const next = (typeof draw.getBrushMode === 'function' && draw.getBrushMode() === 'noodle')
      ? 'line' : 'noodle';
    if (typeof draw.setBrushMode === 'function') draw.setBrushMode(next);
    _syncBrushModeBtn(next);
    _syncWidthSlider(next);
    container.style.cursor = 'none'; // custom cursor drawn on canvas for both modes
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
      _isDrawTool(name) ? 'none' :
      'cell';
  }

  setTool('pan');   // initial state

  // ── run inference button (optional) ───────────────────────────────────────
  if (runInferenceOptions && typeof runInferenceOptions.onRun === 'function') {
    const runBtn = document.createElement('button');
    runBtn.title = 'Train classifier & run inference on active sample';
    runBtn.style.cssText = [
      'width:26px', 'height:26px', 'border-radius:50%', 'border:none',
      'background:radial-gradient(circle, #00ff88 0%, #00cc55 100%)',
      'cursor:pointer', 'font-size:11px', 'padding:0', 'margin-left:6px',
      'box-shadow:0 0 8px 2px rgba(0,255,136,0.65)',
      'transition:box-shadow 0.2s, opacity 0.2s',
      'display:flex', 'align-items:center', 'justify-content:center',
      'color:#003322', 'font-weight:700',
    ].join(';');
    runBtn.textContent = '▶';
    runBtn.dataset.demoId = 'run-inference-btn';
    runBtn.addEventListener('mouseenter', () => {
      if (!runBtn.disabled) runBtn.style.boxShadow = '0 0 14px 5px rgba(0,255,136,0.95)';
    });
    runBtn.addEventListener('mouseleave', () => {
      if (!runBtn.disabled) runBtn.style.boxShadow = '0 0 8px 2px rgba(0,255,136,0.65)';
    });
    runBtn.addEventListener('click', () => {
      if (!runBtn.disabled) runInferenceOptions.onRun(runBtn);
    });
    bar.appendChild(runBtn);
  }

  // ── save / load buttons (optional) ────────────────────────────────────────
  if (saveLoadOptions) {
    // ── Save ──────────────────────────────────────────────────────────────────
    if (typeof saveLoadOptions.onSave === 'function') {
      const saveBtn = document.createElement('button');
      saveBtn.title    = 'Save classifier';
      saveBtn.textContent = '💾';
      saveBtn.dataset.demoId = 'save-btn';
      saveBtn.style.cssText = [
        'background:transparent', 'border:1px solid #888',
        'color:#eee', 'border-radius:4px', 'padding:2px 7px',
        'cursor:pointer', 'font-size:14px', 'line-height:1.4', 'margin-left:4px',
      ].join(';');
      saveBtn.addEventListener('click', () => {
        const name = prompt('Save classifier as:');
        if (name && name.trim()) saveLoadOptions.onSave(name.trim(), saveBtn);
      });
      bar.appendChild(saveBtn);
    }

    // ── Load ──────────────────────────────────────────────────────────────────
    if (typeof saveLoadOptions.onLoad === 'function' &&
        typeof saveLoadOptions.listNames === 'function') {
      const loadBtn = document.createElement('button');
      loadBtn.title    = 'Load classifier';
      loadBtn.textContent = '📂';
      loadBtn.dataset.demoId = 'load-btn';
      loadBtn.style.cssText = [
        'background:transparent', 'border:1px solid #888',
        'color:#eee', 'border-radius:4px', 'padding:2px 7px',
        'cursor:pointer', 'font-size:14px', 'line-height:1.4', 'margin-left:2px',
      ].join(';');
      loadBtn.addEventListener('click', async () => {
        const names = await saveLoadOptions.listNames();
        if (!names || !names.length) {
          alert('No saved classifiers found.');
          return;
        }
        // Build a small picker overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = [
          'position:fixed','left:0','top:0','width:100%','height:100%',
          'display:flex','align-items:center','justify-content:center',
          'z-index:2147483649','background:rgba(0,0,0,0.55)',
        ].join(';');
        const box = document.createElement('div');
        box.style.cssText = [
          'min-width:260px','background:#1b1b1b','color:#eee',
          'border-radius:8px','border:1px solid #3a3a3a',
          'box-shadow:0 6px 24px rgba(0,0,0,0.8)',
          'padding:16px 18px','font:13px monospace',
        ].join(';');
        box.innerHTML = '<div style="font-weight:700;color:#53d9ff;margin-bottom:10px;">Load classifier</div>';
        const select = document.createElement('select');
        select.style.cssText = 'width:100%;background:#111;color:#eee;border:1px solid #555;border-radius:4px;padding:4px;font:13px monospace;margin-bottom:12px;';
        for (const n of names) {
          const opt = document.createElement('option');
          opt.value = n; opt.textContent = n;
          select.appendChild(opt);
        }
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding:5px 10px;border-radius:6px;border:1px solid #555;background:#333;color:#bbb;cursor:pointer;font:12px monospace';
        const okBtn = document.createElement('button');
        okBtn.textContent = 'Load';
        okBtn.style.cssText = 'padding:5px 14px;border-radius:6px;border:none;background:#1f8cff;color:#fff;cursor:pointer;font:12px monospace';
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        box.appendChild(select);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        function _close() { overlay.remove(); document.removeEventListener('keydown', _key); }
        function _key(e) { if (e.key === 'Escape' || e.key === 'Esc') _close(); }
        cancelBtn.addEventListener('click', _close);
        overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });
        document.addEventListener('keydown', _key);
        okBtn.addEventListener('click', () => {
          const chosen = select.value;
          _close();
          if (chosen) saveLoadOptions.onLoad(chosen, loadBtn);
        });
      });
      bar.appendChild(loadBtn);
    }
  }


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