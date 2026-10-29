/**
 * aligner.js
 *
 * Interactive affine aligner modal (Shift+click on "Align"). Ported from the notebook
 * aligner: the primary image is "fixed", the secondary image is "moving" and sits in an
 * affine-movable frame. Save posts the full-res 2x3 matrix (secondary -> primary) to
 * /aligner_save, which stores and persists it (./affine/<sample>.affine.csv).
 *
 * Exposes:
 *   createAffineAligner({ BASE_URL, getSample, onApplied })
 *   → { open }
 */
function createAffineAligner({ BASE_URL, getSample, onApplied }) {
  let overlay = null;

  const mul = (P, Q) => [[P[0][0]*Q[0][0] + P[0][1]*Q[1][0], P[0][0]*Q[0][1] + P[0][1]*Q[1][1]],
                         [P[1][0]*Q[0][0] + P[1][1]*Q[1][0], P[1][0]*Q[0][1] + P[1][1]*Q[1][1]]];
  const inv = P => { const d = P[0][0]*P[1][1] - P[0][1]*P[1][0];
                     return [[P[1][1]/d, -P[0][1]/d], [-P[1][0]/d, P[0][0]/d]]; };
  const mv  = (P, p) => [P[0][0]*p[0] + P[0][1]*p[1], P[1][0]*p[0] + P[1][1]*p[1]];
  const rot = th => [[Math.cos(th), -Math.sin(th)], [Math.sin(th), Math.cos(th)]];
  const dist = (p, q) => Math.hypot(p[0]-q[0], p[1]-q[1]);
  const loadImg = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function open() {
    if (overlay) return;
    const sample = getSample();
    const CW = Math.max(480, Math.min(900, Math.floor(window.innerWidth * 0.8)));
    const CH = Math.max(320, Math.min(600, Math.floor(window.innerHeight * 0.62)));

    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;z-index:2147483651;background:rgba(0,0,0,0.5);';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1a1a2e;color:#eaeaea;padding:12px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.7);font:12px monospace;display:flex;flex-direction:column;gap:8px;width:' + (CW + 24) + 'px;max-width:96%;box-sizing:border-box;';
    const BTN = 'font:12px monospace;padding:4px 12px;border:none;border-radius:5px;cursor:pointer;color:#eaeaea;background:#0f3460;';
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;"><b style="color:#e94560;letter-spacing:.1em;text-transform:uppercase;font-size:11px;">Affine aligner</b>' +
      '<span class="aa-name" style="background:#0f3460;padding:2px 8px;border-radius:5px;"></span>' +
      '<span style="margin-left:auto;color:#8892a4;"><i style="display:inline-block;width:9px;height:9px;background:#4fc3f7;margin-right:4px"></i>primary (fixed) ' +
      '<i style="display:inline-block;width:9px;height:9px;background:#ffb300;margin:0 4px 0 10px"></i>secondary (moving)</span></div>' +
      '<div style="position:relative;border:1.5px solid #0f3460;border-radius:6px;overflow:hidden;background:#111;"><canvas class="aa-cv" tabindex="0" style="display:block;outline:none;"></canvas>' +
      '<div class="aa-loading" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#32cd32;pointer-events:none;">' +
      '<style>@keyframes aa-spin{to{transform:rotate(360deg)}}</style>' +
      '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#32cd32" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:aa-spin 1.4s ease-in-out infinite;">' +
      '<path d="M6 2h12M6 22h12M7 2v4.5a5 5 0 0 0 2 4l1.5 1.5-1.5 1.5a5 5 0 0 0-2 4V22M17 2v4.5a5 5 0 0 1-2 4L13.5 12l1.5 1.5a5 5 0 0 1 2 4V22" fill="rgba(50,205,50,0.25)"/></svg>' +
      '<span class="aa-loadtxt">Loading thumbnails...</span></div></div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:#8892a4;">' +
      '<button class="aa-save" style="' + BTN + 'background:#e94560;color:#fff;">Apply &amp; save</button>' +
      '<button class="aa-fit" style="' + BTN + '">Fit</button><button class="aa-reset" style="' + BTN + '">Reset</button>' +
      '<button class="aa-tune" title="Fine-tunes the alignment with an automatic optimizer (edge/gradient-based affine, works across stains such as H&E vs mIF; ~seconds). Assumes the alignment already looks good visually; it only makes small corrections. Press u to undo." style="' + BTN + 'background:#1b6e3c;">Autotune</button>' +
      '<button class="aa-cancel" style="' + BTN + 'background:#2a2a4a;">Cancel</button>' +
      '<label>opacity <input type="range" class="aa-alpha" min="0" max="1" step="0.01" value="0.5" style="width:110px;accent-color:#e94560;vertical-align:middle;"></label>' +
      '<label>blend <select class="aa-blend" style="font:11px monospace;background:#22223a;color:#eaeaea;border:1px solid #0f3460;"><option value="source-over">normal</option><option value="difference">difference</option><option value="multiply">multiply</option><option value="screen">screen</option></select></label>' +
      '<label><input type="checkbox" class="aa-frame" checked> frame</label></div>' +
      '<div class="aa-status" style="color:#8892a4;min-height:15px;white-space:normal;overflow-wrap:anywhere;">Loading…</div>' +
      '<div style="color:#667;font-size:10px;line-height:1.5;max-width:' + CW + 'px;">Drag inside frame: move · squares: scale (Shift uniform, Alt about centre) · diamonds: shear · knob: rotate · drag background: pan · wheel: zoom · arrows nudge (Shift ×10) · q/e rotate · +/- scale · f fit · r reset · u undo autotune · [ ] opacity · b blend · Ctrl+S apply · Esc cancel</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const $ = s => box.querySelector(s);
    $('.aa-name').textContent = sample;
    const cv = $('.aa-cv'); cv.width = CW; cv.height = CH;
    const loadingEl = $('.aa-loading'), loadTxt = $('.aa-loadtxt'), tuneBtn = $('.aa-tune');
    const ctx = cv.getContext('2d'), statusEl = $('.aa-status');
    const alphaEl = $('.aa-alpha'), blendEl = $('.aa-blend'), frameEl = $('.aa-frame');

    let FW, FH, MW, MH, FS, MS, A = [[1,0],[0,1]], t = [0,0], A_INIT, T_INIT;
    let view = {z: 1, ox: 0, oy: 0}, alpha = 0.5, ready = false, drag = null;
    const im = {};
    let LOCAL;

    const movToWorld = p => { const q = mv(A, p); return [q[0] + t[0], q[1] + t[1]]; };
    const worldToMov = p => mv(inv(A), [p[0] - t[0], p[1] - t[1]]);
    const worldToCanvas = p => [p[0]*view.z + view.ox, p[1]*view.z + view.oy];
    const canvasToWorld = p => [(p[0] - view.ox)/view.z, (p[1] - view.oy)/view.z];
    const movToCanvas = p => worldToCanvas(movToWorld(p));
    function setAKeepingPivot(Anew, pv) {
      const w = movToWorld(pv); A = Anew; const q = mv(A, pv); t = [w[0] - q[0], w[1] - q[1]];
    }
    const fullMatrix = () => { const r = FS / MS;
      return [[A[0][0]*r, A[0][1]*r, t[0]*FS], [A[1][0]*r, A[1][1]*r, t[1]*FS]]; };

    function fitView() {
      const pts = [[0,0],[FW,0],[FW,FH],[0,FH], ...LOCAL.corners.map(movToWorld)];
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const bw = Math.max(x1 - x0, 1), bh = Math.max(y1 - y0, 1);
      view.z = Math.min(CW / bw, CH / bh) * 0.9;
      view.ox = CW/2 - (x0 + bw/2) * view.z; view.oy = CH/2 - (y0 + bh/2) * view.z;
      draw();
    }

    function handles() {
      const corners = LOCAL.corners.map(movToCanvas), mids = LOCAL.mids.map(movToCanvas), center = movToCanvas(LOCAL.center);
      let dx = mids[0][0] - center[0], dy = mids[0][1] - center[1];
      const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
      return {corners, mids, center, knob: [mids[0][0] + dx*28, mids[0][1] + dy*28], topMid: mids[0]};
    }

    function draw() {
      if (!ready) return;
      ctx.setTransform(1,0,0,1,0,0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, CW, CH);
      const {z, ox, oy} = view;
      ctx.imageSmoothingEnabled = true;
      ctx.setTransform(z, 0, 0, z, ox, oy); ctx.drawImage(im.fixed, 0, 0);
      ctx.globalAlpha = alpha; ctx.globalCompositeOperation = blendEl.value;
      ctx.setTransform(z*A[0][0], z*A[1][0], z*A[0][1], z*A[1][1], z*t[0] + ox, z*t[1] + oy);
      ctx.drawImage(im.moving, 0, 0);
      ctx.setTransform(1,0,0,1,0,0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      const poly = pts => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); };
      poly([[0,0],[FW,0],[FW,FH],[0,FH]].map(worldToCanvas));
      ctx.setLineDash([6, 4]); ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      if (!frameEl.checked) return;
      const h = handles();
      poly(h.corners); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4; ctx.stroke();
      ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(h.topMid[0], h.topMid[1]); ctx.lineTo(h.knob[0], h.knob[1]);
      ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(h.knob[0], h.knob[1], 7, 0, 2*Math.PI);
      ctx.fillStyle = '#ffb300'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke();
      h.corners.forEach(p => { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
        ctx.fillRect(p[0]-6, p[1]-6, 12, 12); ctx.strokeRect(p[0]-6, p[1]-6, 12, 12); });
      h.mids.forEach(p => { ctx.beginPath(); ctx.moveTo(p[0], p[1]-7); ctx.lineTo(p[0]+7, p[1]);
        ctx.lineTo(p[0], p[1]+7); ctx.lineTo(p[0]-7, p[1]); ctx.closePath();
        ctx.fillStyle = '#ffb300'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke(); });
      ctx.beginPath(); ctx.moveTo(h.center[0]-6, h.center[1]); ctx.lineTo(h.center[0]+6, h.center[1]);
      ctx.moveTo(h.center[0], h.center[1]-6); ctx.lineTo(h.center[0], h.center[1]+6);
      ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    const canvasXY = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function hitTest(p) {
      if (!frameEl.checked) return {mode: pointInPoly(p, LOCAL.corners.map(movToCanvas)) ? 'move' : 'pan'};
      const h = handles();
      if (dist(p, h.knob) <= 10) return {mode: 'rotate'};
      for (let i = 0; i < 4; i++) if (dist(p, h.corners[i]) <= 9) return {mode: 'scale', idx: i};
      for (let i = 0; i < 4; i++) if (dist(p, h.mids[i]) <= 9) return {mode: 'shear', idx: i};
      return {mode: pointInPoly(p, h.corners) ? 'move' : 'pan'};
    }
    const CURSORS = {rotate: 'grab', scale: 'nwse-resize', shear: 'ew-resize', move: 'move', pan: 'default'};

    cv.addEventListener('mousedown', e => {
      if (e.button !== 0 || !ready) return;
      const c = canvasXY(e), hit = hitTest(c);
      drag = {...hit, c0: c, w0: canvasToWorld(c), A0: A.map(r => r.slice()), t0: t.slice(), view0: {...view}, centerW: movToWorld(LOCAL.center)};
      if (hit.mode === 'scale') {
        drag.pivot = e.altKey ? LOCAL.center : LOCAL.corners[(hit.idx + 2) % 4];
        drag.uniform = e.shiftKey;
      }
      e.preventDefault();
    });
    const onMove = e => {
      if (!ready) return;
      const c = canvasXY(e);
      if (!drag) { cv.style.cursor = CURSORS[hitTest(c).mode]; return; }
      const w = canvasToWorld(c);
      if (drag.mode === 'pan') { view.ox = drag.view0.ox + (c[0] - drag.c0[0]); view.oy = drag.view0.oy + (c[1] - drag.c0[1]); draw(); return; }
      A = drag.A0.map(r => r.slice()); t = drag.t0.slice();
      if (drag.mode === 'move') {
        t = [drag.t0[0] + (w[0] - drag.w0[0]), drag.t0[1] + (w[1] - drag.w0[1])];
      } else if (drag.mode === 'rotate') {
        const a0 = Math.atan2(drag.w0[1] - drag.centerW[1], drag.w0[0] - drag.centerW[0]);
        const a1 = Math.atan2(w[1] - drag.centerW[1], w[0] - drag.centerW[0]);
        setAKeepingPivot(mul(rot(a1 - a0), drag.A0), LOCAL.center);
      } else if (drag.mode === 'scale') {
        const L = worldToMov(w), q = LOCAL.corners[drag.idx], p = drag.pivot;
        let fx = (L[0] - p[0]) / (q[0] - p[0]), fy = (L[1] - p[1]) / (q[1] - p[1]);
        if (drag.uniform) {
          const f = Math.hypot(L[0]-p[0], L[1]-p[1]) / Math.hypot(q[0]-p[0], q[1]-p[1]);
          fx = Math.sign(fx || 1) * f; fy = Math.sign(fy || 1) * f;
        }
        const clamp = v => Math.sign(v || 1) * Math.max(Math.abs(v), 0.02);
        setAKeepingPivot(mul(drag.A0, [[clamp(fx), 0], [0, clamp(fy)]]), p);
      } else if (drag.mode === 'shear') {
        const L = worldToMov(w), q = LOCAL.mids[drag.idx], c0 = LOCAL.center;
        const S = drag.idx % 2 === 0 ? [[1, (L[0] - q[0]) / (q[1] - c0[1])], [0, 1]] : [[1, 0], [(L[1] - q[1]) / (q[0] - c0[0]), 1]];
        setAKeepingPivot(mul(drag.A0, S), LOCAL.center);
      }
      draw();
    };
    const onUp = () => { drag = null; };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    cv.addEventListener('wheel', e => {
      e.preventDefault(); e.stopPropagation();
      const c = canvasXY(e), f = Math.exp(-e.deltaY * 0.0015);
      view.ox = c[0] - (c[0] - view.ox) * f; view.oy = c[1] - (c[1] - view.oy) * f; view.z *= f; draw();
    }, {passive: false});

    const nudge = (dx, dy) => { t = [t[0] + dx, t[1] + dy]; draw(); };
    const rotateBy = deg => { setAKeepingPivot(mul(rot(deg * Math.PI / 180), A), LOCAL.center); draw(); };
    const scaleBy = f => { setAKeepingPivot(mul(A, [[f, 0], [0, f]]), LOCAL.center); draw(); };
    const BLENDS = ['source-over', 'difference', 'multiply', 'screen'];
    const resetFrame = () => { A = A_INIT.map(r => r.slice()); t = T_INIT.slice(); draw(); };

    const setFromFull = M => { const r = MS / FS;
      A = [[M[0][0]*r, M[0][1]*r], [M[1][0]*r, M[1][1]*r]]; t = [M[0][2]/FS, M[1][2]/FS]; };
    let preTune = null;
    function undoTune() { if (preTune) { A = preTune.A; t = preTune.t; preTune = null; draw(); statusEl.textContent = 'Autotune undone.'; } }
    async function autotune() {
      if (!ready || tuneBtn.disabled) return;
      tuneBtn.disabled = true; loadTxt.textContent = 'Autotuning...'; loadingEl.style.display = 'flex';
      try {
        const r = await fetch(BASE_URL + '/aligner_autotune', {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({sample, M: fullMatrix()})});
        const j = await r.json();
        if (!j.ok) { statusEl.textContent = '⚠ Autotune: ' + j.error; }
        else {
          preTune = {A: A.map(r => r.slice()), t: t.slice()};
          setFromFull(j.M); draw();
          statusEl.textContent = 'Autotuned (corner shift ≤ ' + j.moved_px.toFixed(1) + ' px full-res, correlation ' + j.cc.toFixed(3) + '). Press u to undo, then Apply & save.';
        }
      } catch (e) { statusEl.textContent = '⚠ Autotune failed: ' + e; }
      loadingEl.style.display = 'none'; loadTxt.textContent = 'Loading thumbnails...'; tuneBtn.disabled = false;
    }

    function close() {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey, true);
      overlay.remove(); overlay = null; window.__iv_modal_visible = false;
    }
    async function save() {
      if (!ready) return;
      statusEl.textContent = 'Saving…';
      try {
        const r = await fetch(BASE_URL + '/aligner_save', {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({sample, M: fullMatrix()})});
        const j = await r.json();
        if (!j.ok) { statusEl.textContent = '⚠ ' + j.error; return; }
        onApplied(sample, j.matrix); close();
      } catch (e) { statusEl.textContent = '⚠ Save failed: ' + e; }
    }
    function onKey(e) {
      e.stopPropagation(); e.stopImmediatePropagation();
      if (e.key === 'Escape') { close(); return; }
      if (!ready) return;
      const big = e.shiftKey, step = big ? 10 : 1, k = e.key;
      if (e.target && e.target.tagName === 'SELECT') return;
      if      (k === 'ArrowLeft')  { e.preventDefault(); nudge(-step, 0); }
      else if (k === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
      else if (k === 'ArrowUp')    { e.preventDefault(); nudge(0, -step); }
      else if (k === 'ArrowDown')  { e.preventDefault(); nudge(0, step); }
      else if (k === 'q' || k === 'Q') rotateBy(big ? -2.5 : -0.25);
      else if (k === 'e' || k === 'E') rotateBy(big ? 2.5 : 0.25);
      else if (k === '+' || k === '=') scaleBy(big ? 1.05 : 1.005);
      else if (k === '-' || k === '_') scaleBy(big ? 1/1.05 : 1/1.005);
      else if (k === 'f') fitView();
      else if (k === 'r') resetFrame();
      else if (k === 'u') undoTune();
      else if (k === '[' || k === ']') { alpha = Math.min(1, Math.max(0, alpha + (k === ']' ? 0.05 : -0.05))); alphaEl.value = alpha; draw(); }
      else if (k === 'b') { blendEl.value = BLENDS[(BLENDS.indexOf(blendEl.value) + 1) % BLENDS.length]; draw(); }
      else if ((k === 's' || k === 'S') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    }
    window.addEventListener('keydown', onKey, true);
    window.__iv_modal_visible = true;
    $('.aa-save').onclick = save; $('.aa-cancel').onclick = close; $('.aa-fit').onclick = fitView; $('.aa-reset').onclick = resetFrame; tuneBtn.onclick = autotune;
    alphaEl.oninput = () => { alpha = parseFloat(alphaEl.value); draw(); };
    blendEl.onchange = draw; frameEl.onchange = draw;
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

    const q = '?sample=' + encodeURIComponent(sample);
    statusEl.textContent = 'Loading images (first open may take a few seconds)…';
    Promise.all([
      fetch(BASE_URL + '/aligner_info' + q).then(r => r.json()),
      loadImg(BASE_URL + '/aligner_image' + q + '&which=primary'),
      loadImg(BASE_URL + '/aligner_image' + q + '&which=secondary'),
    ]).then(([info, fImg, mImg]) => {
      if (!overlay) return;
      if (!info.ok) throw new Error(info.error);
      ({fw: FW, fh: FH, mw: MW, mh: MH, fs: FS, ms: MS} = info);
      im.fixed = fImg; im.moving = mImg;
      LOCAL = {corners: [[0,0],[MW,0],[MW,MH],[0,MH]], mids: [[MW/2,0],[MW,MH/2],[MW/2,MH],[0,MH/2]], center: [MW/2, MH/2]};
      // 'physical' start: same µm/px assumed, secondary centred on primary
      A_INIT = [[MS/FS, 0], [0, MS/FS]];
      T_INIT = [FW/2 - A_INIT[0][0]*MW/2, FH/2 - A_INIT[1][1]*MH/2];
      const m = info.matrix;
      if (m) {   // saved/current full-res matrix -> downsampled-primary space
        setFromFull([[m.m00, m.m01, m.tx], [m.m10, m.m11, m.ty]]);
      } else { A = A_INIT.map(r => r.slice()); t = T_INIT.slice(); }
      ready = true; loadingEl.style.display = 'none'; fitView(); cv.focus();
      statusEl.textContent = m ? 'Starting from the current alignment.' : 'No alignment yet: starting from a centred, same-resolution placement.';
    }).catch(e => { loadingEl.style.display = 'none'; statusEl.textContent = '⚠ Could not load images: ' + e; });
  }

  return { open };
}
