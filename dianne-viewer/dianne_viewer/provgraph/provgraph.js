// Provenance graph viewer: provGraph(rootEl, {nodes, chain, target, mode}) ; mode = 'chain' | 'tree'
(function (g) {
  const NS = 'http://www.w3.org/2000/svg', TIP_MS = 5000, COL = 170, ROW = 56, PAD = 40;
  const SYM = { source: ['circle', '#e6b800'], organ: ['diamond', '#d62728'], block: ['square', '#f78fb3'],
    section: ['rect', '#f78fb3'], suspension: ['circle', '#1f77b4'], dataset: ['circle', '#2ca02c'], other: ['circle', '#999'],
    project: ['diamond', '#8e44ad'], datagroup: ['rect', '#e67e22'], mouse: ['circle', '#e6b800'], slide: ['rect', '#17becf'], sample: ['circle', '#2ca02c'] };
  const el = (t, a = {}, p) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); p && p.appendChild(e); return e; };
  const h = (t, c, p) => { const e = document.createElement(t); if (c) e.className = c; p && p.appendChild(e); return e; };

  function symbol(p, kind, x, y, hi) {
    const [s, fill] = SYM[kind] || SYM.other, a = { fill, class: hi ? 'pg-sym pg-hi' : 'pg-sym' };
    if (s === 'circle') el('circle', { cx: x, cy: y, r: 11, ...a }, p);
    else if (s === 'square') el('rect', { x: x - 10, y: y - 10, width: 20, height: 20, ...a }, p);
    else if (s === 'rect') el('rect', { x: x - 15, y: y - 8, width: 30, height: 16, ...a }, p);
    else el('polygon', { points: `${x},${y - 14} ${x + 12},${y} ${x},${y + 14} ${x - 12},${y}`, ...a }, p);
  }

  const STEPS_UM = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];   // scale-bar steps (same as scalebar.js)
  const fmtUm = um => um < 1000 ? um + '\u00a0\u00b5m' : um < 10000 ? um / 1000 + '\u00a0mm' : um / 10000 + '\u00a0cm';
  function liveView(n, base, host, cx) {   // tiny pan/zoom tile viewer for an RGB OME-TIFF pyramid served by /komp_full_* (wheel: zoom, drag: pan, double-click: fit; Ctrl/Cmd+drag moves the node)
    const cv = h('canvas', '', host), c2 = cv.getContext('2d'), cache = new Map(), qs = `sample=${encodeURIComponent(n.sample)}`;
    cv.style.cssText = 'width:100%;height:100%;display:block';
    let m = null, v = null, raf = 0, dead = false; const L = i => m.levels[i], fitVw = () => Math.max(L(0).width, L(0).height * cv.width / cv.height);
    const sched = () => raf || (raf = requestAnimationFrame(draw));
    const tile = (lv, r, c) => { const key = `${lv}/${r}/${c}`; let e = cache.get(key);
      if (e) cache.delete(key); else { e = { img: new Image() }; e.img.onload = () => { e.ok = true; dead || sched(); }; e.img.src = `${base}/komp_full_tile?${qs}&level=${lv}&row=${r}&col=${c}&quality=95`; }
      cache.set(key, e); if (cache.size > 300) cache.delete(cache.keys().next().value); return e; };
    function draw() { raf = 0; if (!m || dead) return;
      const cw = cv.width, ch = cv.height, vh = v.vw * ch / cw, x0 = v.cx - v.vw / 2, y0 = v.cy - vh / 2, z = cw / v.vw, top = m.n_levels - 1, t = m.tile_size; let l = 0;
      for (let i = 0; i <= top; i++) if (L(i).downsample <= 1 / z) l = i;   // coarsest level that is still at least screen resolution
      c2.imageSmoothingQuality = 'high'; c2.fillStyle = '#0f0f0f'; c2.fillRect(0, 0, cw, ch);
      new Set([top, l]).forEach(lv => { const { downsample: ds, width: Wl, height: Hl, n_tiles_x: nx, n_tiles_y: ny } = L(lv);   // coarsest level underneath as fallback while sharper tiles load
        for (let r = Math.max(0, Math.floor(y0 / ds / t)); r <= Math.min(ny - 1, Math.floor((y0 + vh) / ds / t)); r++)
          for (let c = Math.max(0, Math.floor(x0 / ds / t)); c <= Math.min(nx - 1, Math.floor((x0 + v.vw) / ds / t)); c++) { const e = tile(lv, r, c); if (!e.ok) continue;
            const sw = Math.min(t, Wl - c * t), sh = Math.min(t, Hl - r * t), dx = (c * t * ds - x0) * z, dy = (r * t * ds - y0) * z;
            c2.drawImage(e.img, 0, 0, sw, sh, Math.floor(dx), Math.floor(dy), Math.ceil(sw * ds * z) + 1, Math.ceil(sh * ds * z) + 1); } });
      if (cx.mpp > 0) { const u = cw / n.w, pu = z / cx.mpp, tg = 30 * u; let b = STEPS_UM[0]; for (const st of STEPS_UM) { if (st * pu >= tg * .4) b = st; if (st * pu > tg * 2.5) break; }   // scale bar (canvas px, sized like the world-unit UI), mpp inherited from the main viewer's active sample
        const bw = Math.round(b * pu), bh = 5 * u, x = 10 * u, y = ch - 10 * u; c2.fillStyle = '#000'; c2.strokeStyle = '#fff'; c2.lineWidth = 1.5 * u; c2.fillRect(x, y - bh, bw, bh); c2.strokeRect(x, y - bh, bw, bh);
        c2.font = `bold ${11 * u}px monospace`; c2.fillStyle = '#fff'; c2.shadowColor = '#000'; c2.shadowBlur = 3 * u; c2.fillText(fmtUm(b), x, y - bh - 4 * u); c2.shadowBlur = 0; } }
    const size = () => { const w = Math.min(3072, Math.max(64, Math.round(n.w * cx.k() * Math.min(3, devicePixelRatio || 1))));
      if (!cv.width || Math.abs(w - cv.width) > cv.width * .08) { cv.width = w; cv.height = Math.round(w * n.h / n.w); sched(); } };   // backing store follows frame size and graph zoom (same aspect as the frame)
    const mv = e => e.ctrlKey || e.metaKey;   // modifier held: bubble up to the node drag
    host.addEventListener('pointermove', e => { if (!host.onpointermove) host.style.cursor = mv(e) ? 'move' : 'grab'; });
    host.addEventListener('pointerdown', e => { if (mv(e)) return;
      e.stopPropagation(); cx.front(n.g); host.setPointerCapture(e.pointerId); sched(); let X = e.clientX, Y = e.clientY;
      host.onpointermove = ev => { if (!ev.buttons) { host.onpointermove = host.onpointerup = null; return; } if (!v) return; const k = v.vw / host.getBoundingClientRect().width; v.cx -= (ev.clientX - X) * k; v.cy -= (ev.clientY - Y) * k; X = ev.clientX; Y = ev.clientY; sched(); };
      host.onpointerup = () => host.onpointermove = host.onpointerup = null; });
    host.addEventListener('wheel', e => { e.preventDefault(); e.stopPropagation(); if (!v) return;
      const r = host.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height, vh = v.vw * cv.height / cv.width,
        w2 = Math.min(fitVw() * 2, Math.max(cv.width / 4, v.vw * Math.exp(e.deltaY * .0015))), h2 = w2 * vh / v.vw;
      v.cx = v.cx - v.vw / 2 + fx * v.vw - fx * w2 + w2 / 2; v.cy = v.cy - vh / 2 + fy * vh - fy * h2 + h2 / 2; v.vw = w2; sched(); }, { passive: false });
    host.addEventListener('dblclick', e => { e.stopPropagation(); if (v) { v.cx = L(0).width / 2; v.cy = L(0).height / 2; v.vw = fitVw(); sched(); } });
    size();
    fetch(`${base}/komp_full_meta?${qs}`).then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(new Error(t)))).then(j => { if (dead) return; m = j; v = { cx: L(0).width / 2, cy: L(0).height / 2, vw: fitVw() }; sched(); })
      .catch(e => { if (!dead) { cv.remove(); host.style.padding = '24px 16px'; host.textContent = 'Full view unavailable: ' + e.message; } });
    return { size, draw: sched, kill() { dead = true; cache.forEach(e => e.img.src = ''); cache.clear(); fetch(`${base}/komp_full_close?${qs}`).catch(() => {}); } };   // closing drops the server-side image
  }

  let uid = 0; const TH = 96;   // thumbnail node size (1 in)
  function thumbImg(gr, n, base, cx) {   // thumbnail node sized to the image's aspect (longest side TH); click magnifies it in place (resizable by the corner handle, edges stay attached); retries while the server is still opening the sample
    gr.classList.add('pg-thumb'); const ig = el('g', {}, gr), big = 1024, cid = 'pgc' + (++uid), cp = el('clipPath', { id: cid }, el('defs', {}, gr)), cr = el('rect', {}, cp); n.iw = n.ih = n.w = n.h = TH; n.sc = 1; n.ky = 1; n.rl = [];   // rounded-corner clip: the image fills the frame, corner pixels are cut
    const bg = el('rect', { x: -TH / 2, y: -TH / 2, width: TH, height: TH, rx: 5, fill: 'none', stroke: SYM[n.type === 'slidepic' ? 'slide' : 'sample'][1], 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, ig);   // frame = color of the parent node (sample green / slide light blue)
    const im = n.im = el('image', { x: -TH / 2, y: -TH / 2, width: TH, height: TH, preserveAspectRatio: 'none', 'clip-path': `url(#${cid})` }, ig), pre = new Image(); let k = 0; ig.appendChild(bg);   // frame drawn on top of the (clipped) image, exact same size: no gap
    const ctl = el('g', { class: 'pg-ctl', display: 'none' }, gr), xb = el('g', { class: 'pg-x' }, ctl), rz = el('g', { class: 'pg-rz' }, ctl);   // close (top right) and resize (bottom right) handles
    el('circle', { r: 9, fill: '#222', stroke: '#fff' }, xb); el('path', { d: 'M-3.5,-3.5L3.5,3.5M3.5,-3.5L-3.5,3.5', stroke: '#fff', 'stroke-width': 1.6 }, xb);
    el('path', { d: 'M10,-10L10,10L-10,10Z', fill: '#fff', stroke: '#222', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, rz);
    const lay = () => { Object.entries({ x: -n.iw / 2, y: -n.ih / 2, width: n.iw, height: n.ih, rx: 5 / n.sc }).forEach(([a, v]) => { cr.setAttribute(a, v); bg.setAttribute(a, v); }); n.w = n.iw * n.sc; n.h = n.ih * n.sc * n.ky; ig.setAttribute('transform', `scale(${n.sc},${n.sc * n.ky})`);
      xb.setAttribute('transform', `translate(${n.w / 2},${-n.h / 2})`); rz.setAttribute('transform', `translate(${n.w / 2 - 6},${n.h / 2 - 6})`);
      fb.setAttribute('transform', `translate(${-n.w / 2 + 6},${-n.h / 2 + 6})`);
      if (n.fo) { Object.entries({ x: -n.w / 2, y: -n.h / 2, width: n.w, height: n.h }).forEach(([a, v]) => n.fo.setAttribute(a, v)); n.vw && n.vw.size(); }
      n.rl.forEach(([t, x, y]) => { t.setAttribute('x', (x - .5) * n.w); t.setAttribute('y', (y - .5) * n.h); }); };
    n.setSc = s => { n.sc = s; lay(); cx.upd(n); };
    n.mag = on => { gr.classList.toggle('pg-magd', on); ctl.setAttribute('display', on ? '' : 'none'); n.rl.forEach(([t]) => t.setAttribute('display', on ? '' : 'none'));
      if (on) { n.setSc(Math.max(n.sc, 400 / Math.max(n.iw, n.ih))); const b = new Image(); b.onload = () => n.sc > 1 && im.setAttribute('href', b.src); b.src = `${base}${n.thumb}&big=${big}`; }
      else { unlive(); n.setSc(1); im.setAttribute('href', n.small); } };
    const fb = el('g', { class: 'pg-fb', display: n.full ? '' : 'none' }, ctl); const hit = el('rect', { width: 26, height: 26, fill: 'transparent' }, fb); const ic = el('g', { class: 'pg-ic', transform: 'translate(1,1)' }, fb), tl = el('title', {}, fb); n.mode = 0;   // click: locked (static) <-> live viewer; live -> locked keeps the current pan/zoom as a movable view
    const setIc = md => { ic.textContent = ''; const live = md === 1; ic.setAttribute('transform', `translate(${live ? 10 : 1},1)`); hit.setAttribute('width', live ? 36 : 26); const c = '#eceff1', a = { fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
      el('rect', { x: 3, y: 11, width: 18, height: 11, rx: 2.5, ...a }, ic); el('circle', { cx: 12, cy: 15.6, r: 1.7, ...a }, ic); el('path', { d: 'M12 17v2.4', ...a }, ic);
      el('path', { d: live ? 'M4 9V5.5a6.5 6.5 0 0 0-13 0V7.5' : 'M7 11V7a5 5 0 0 1 10 0v4', ...a }, ic);   // live: shackle mirrored, attached on the right and swung open to the left
      tl.textContent = live ? 'Live: click to lock the current view' : 'Locked: click for the live viewer'; }; setIc(0);
    const setMode = md => { n.mode = md; setIc(md);
      if (!n.fo) { n.fo = el('foreignObject', {}, gr); gr.insertBefore(n.fo, ctl); n.host = document.createElement('div'); n.host.style.cssText = 'width:100%;height:100%;border-radius:5px;overflow:hidden;background:#0f0f0f;color:#fff;font:11px sans-serif;touch-action:none';
        n.fo.appendChild(n.host); n.vw = liveView(n, base, n.host, cx); lay(); }
      n.fo.style.pointerEvents = md === 1 ? '' : 'none'; };
    const unlive = () => { if (n.fo) { n.vw.kill(); n.vw = null; n.fo.remove(); n.fo = null; } n.mode = 0; n.ky = 1; setIc(0); };
    fb.onpointerdown = ev => ev.stopPropagation(); fb.onclick = () => setMode(n.mode === 1 ? 2 : 1);
    xb.onpointerdown = ev => ev.stopPropagation(); xb.onclick = () => n.mag(false);
    rz.onpointerdown = ev => { ev.stopPropagation(); rz.setPointerCapture(ev.pointerId); const x0 = ev.clientX, y0 = ev.clientY, w0 = n.w, h0 = n.h, px = n.px, py = n.py;   // Full mode: width and height follow the mouse independently; otherwise aspect is kept
      rz.onpointermove = e => { if (!e.buttons) { rz.onpointermove = rz.onpointerup = null; return; } const w = Math.max(n.iw, w0 + (e.clientX - x0) / cx.k()); n.sc = w / n.iw; if (n.mode) n.ky = Math.max(.2, (h0 + (e.clientY - y0) / cx.k()) / (n.ih * n.sc)); lay(); n.px = px + (n.w - w0) / 2; n.py = py + (n.h - h0) / 2; cx.upd(n); };   // top-left corner stays put
      rz.onpointerup = () => rz.onpointermove = rz.onpointerup = null; };
    pre.onload = () => { const s = TH / Math.max(pre.naturalWidth, pre.naturalHeight), w = Math.round(pre.naturalWidth * s), hh = Math.round(pre.naturalHeight * s); n.iw = w; n.ih = hh; n.small = pre.src;
      Object.entries({ x: -w / 2, y: -hh / 2, width: w, height: hh, href: pre.src }).forEach(([a, v]) => im.setAttribute(a, v));
      (n.rois || []).forEach(r => { el('polygon', { points: r.pts.map(([x, y]) => `${(x - .5) * w},${(y - .5) * hh}`).join(' '), class: 'pg-roi' }, ig);   // sample contours on a slide image; names shown when magnified
        const c = centroid(r.pts), t = el('text', { class: 'pg-rlab', display: 'none' }, gr); t.textContent = r.name; n.rl.push([t, c[0], c[1]]); });
      lay(); cx.upd(n); };
    pre.onerror = () => k++ < 5 && setTimeout(() => pre.src = `${base}${n.thumb}&r=${k}`, 1500 * k);
    pre.src = base + n.thumb; n.small = pre.src; lay();
  }

  const centroid = pts => { let a = 0, x = 0, y = 0; pts.forEach(([x1, y1], i) => { const [x2, y2] = pts[(i + 1) % pts.length], c = x1 * y2 - x2 * y1; a += c; x += (x1 + x2) * c; y += (y1 + y2) * c; });
    return a ? [x / (3 * a), y / (3 * a)] : pts[0]; };

  function layout(nodes, dur, vert, stack) {   // vert: rotated 90° CW; stack: node kind drawn as a column right of its parent (vert only)
    const th = n => n.kind === 'thumb', stk = n => vert && (th(n) || (stack && n.kind === stack));  // columns by longest path from a root; rows by DFS order of leaves
    const by = Object.fromEntries(nodes.map(n => [n.id, { ...n, kids: [], nst: undefined }]));
    nodes.forEach(n => n.parents.forEach(p => by[p] && by[p].kids.push(by[n.id])));
    const depth = {}, d = n => depth[n.id] ??= Math.max(-1, ...n.parents.filter(p => by[p]).map(p => d(by[p]))) + 1;
    Object.values(by).forEach(d);
    let row = 0; const seen = new Set();
    const place = n => {
      if (seen.has(n.id)) return n.y; seen.add(n.id);
      const ys = n.kids.filter(k => !stk(k)).map(place);
      n.y = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : row++; return n.y;
    };
    Object.values(by).filter(n => !n.parents.some(p => by[p])).forEach(place);
    // x: parent x + link length; with `dur`, length grows with log(storage days) (130..~300px), unknown stays COL
    const len = n => dur && n.days != null ? 130 + 55 * Math.log10(1 + n.days) : COL;
    Object.values(by).sort((a, b) => depth[a.id] - depth[b.id]).forEach(n => {
      const ps = n.parents.filter(p => by[p]); n.px = ps.length ? Math.max(...ps.map(p => by[p].px)) + len(n) : PAD; n.py = PAD + n.y * ROW; });
    if (vert) {   // rotate 90° CW: depth runs top→bottom, rows right→left
      const all = Object.values(by), tn = all.some(th), W = stack ? (tn ? 460 : 300) : 130;
      all.filter(n => !stk(n)).forEach(n => { const a = n.px; n.px = PAD + (row - 1 - n.y) * W; n.py = a; });
      all.filter(n => stk(n) && !th(n)).forEach(n => { const p = by[n.parents[0]]; if (!p) return; const i = (p.nst = (p.nst ?? -1) + 1); n.px = p.px + 195; n.py = p.py + 85 + i * (tn ? 110 : 60); });
      all.filter(th).forEach(n => { const p = by[n.parents[0]]; if (p) { n.px = p.kind === 'slide' ? p.px : p.px + 150; n.py = p.kind === 'slide' ? p.py + 115 : p.py; } });   // thumbnail right of its sample; slide image below its slide
    }
    return by;
  }

  function href(p) {  // protocol_url often lacks a scheme; only http(s) links are allowed
    const u = /^[a-z][a-z0-9+.-]*:/i.test(p) ? p : 'https://' + p; return /^https?:\/\//i.test(u) ? u : null;
  }

  function copy(txt, p) {  // tiny copy-to-clipboard button (clipboard API needs https; fall back to execCommand)
    const b = h('button', 'pg-copy', p); b.title = 'Copy'; b.textContent = '⧉';
    b.onclick = async ev => { ev.stopPropagation();
      try { await navigator.clipboard.writeText(txt); } catch (e) { const t = h('textarea', '', document.body); t.value = txt; t.select(); document.execCommand('copy'); t.remove(); }
      b.textContent = '✓'; setTimeout(() => b.textContent = '⧉', 900); };
    return b;
  }

  function modal(root, n) {
    const m = h('div', 'pg-modal', root), b = h('div', 'pg-box', m);
    const hd = h('div', 'pg-head', b), L = h('span', 'pg-hl', hd), R = h('span', 'pg-hr', hd);
    h('b', '', L).textContent = `${n.label || n.id} (${n.kind})`; copy(n.label || n.id, L);
    const u = n.protocol && href(n.protocol);
    if (u) { const a = h('a', 'pg-link', L); a.href = u; a.title = 'Protocol: ' + n.protocol; a.textContent = '🔗';
      a.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); window.open(u, '_blank', 'noopener,noreferrer'); }; copy(n.protocol, L); }
    if (n.uuid) { h('code', '', R).textContent = n.uuid; copy(n.uuid, R); }
    const x = h('button', 'pg-x', R); x.textContent = '×'; const close = () => { m.remove(); root.style.minHeight = ''; }; root.style.minHeight = '640px'; x.onclick = close; m.onclick = e => e.target === m && close();
    const sc = h('div', 'pg-scroll', b);
    if (n.term) {   // ontology term preview (OLS4 data) + on-demand embedded live page
      const t = n.term, d = h('div', 'pg-term', sc), l = u => { const a = h('a', '', d); a.href = u; a.textContent = u;
        a.onclick = ev => { ev.preventDefault(); window.open(u, '_blank', 'noopener,noreferrer'); }; return a; };
      h('h3', '', d).textContent = (t.label || n.sub.split(',')[0]) + '  ·  ' + t.id;
      t.definition.split('\n').filter(Boolean).forEach(x => h('p', '', d).textContent = x);
      if (t.synonyms.length) { const p = h('p', 'pg-syn', d); p.textContent = 'Synonyms: ' + t.synonyms.join(', '); }
      l(t.url); const bt = h('button', 'pg-live', d); bt.textContent = 'Show live page';
      bt.onclick = () => { bt.remove(); const f = h('iframe', '', d); f.src = t.url.replace('http:', 'https:'); f.referrerPolicy = 'no-referrer'; };
    } else if ((n.mapped && n.mapped.length) || n.desc || (n.contrib && n.contrib.length) || (n.files && n.files.length)) {   // cards, one per group
      const gr = h('div', 'pg-cards', sc), cards = {};
      const card = (g, wide) => { const d = h('div', 'pg-card' + (wide ? ' pg-wide' : ''), gr); h('h4', '', d).textContent = g; return d; };
      if (n.desc) {   // long paragraph: half-collapsed with fade, toggle to expand
        const d = card('Description', true), p = h('p', 'pg-desc pg-clip', d), bt = h('button', 'pg-more', d);
        p.textContent = n.desc; bt.textContent = 'Show more'; bt.onclick = () => bt.textContent = p.classList.toggle('pg-clip') ? 'Show more' : 'Show less';
      }
      (n.mapped || []).forEach(([g, k, v]) => { const c = cards[g] ??= card(g || 'Other');
        const r = h('div', 'pg-kv', c); h('span', '', r).textContent = k; h('b', '', r).textContent = v; });
      const fc = {};   // derived datasets: files grouped by top-level directory, scrollable cards
      (n.files || []).forEach(([g, p, sz, tip, url]) => (fc[g] ??= []).push([p, sz, tip, url]));
      Object.entries(fc).forEach(([g, rows]) => { const c = card(`${g} · ${rows.length}`); c.classList.add('pg-files');
        rows.forEach(([p, sz, tip, url]) => { const r = h('div', 'pg-kv', c); r.title = tip; const w = h('span', '', r);
          if (url) { const a = h('a', '', w); a.href = url; a.textContent = p; a.download = ''; a.onclick = ev => { ev.preventDefault(); window.open(url, '_blank', 'noopener,noreferrer'); }; } else w.textContent = p;
          h('b', '', r).textContent = sz; }); });
      if (n.contrib && n.contrib.length) {
        const d = card('Contributors', true), ps = h('div', 'pg-people', d);
        n.contrib.forEach(([nm, af, ro, em, oc]) => { const p = h('div', 'pg-person', ps);
          h('b', '', p).textContent = nm; if (ro) h('i', '', p).textContent = ro; if (af) h('span', '', p).textContent = af; if (em) h('span', '', p).textContent = em;
          if (/^[\d-]+X?$/.test(oc || '')) { const a = h('a', '', p), o = 'https://orcid.org/' + oc; a.href = o; a.textContent = 'ORCID ' + oc;
            a.onclick = ev => { ev.preventDefault(); window.open(o, '_blank', 'noopener,noreferrer'); }; } });
      }
    } else {
      const t = h('table', '', sc); Object.entries(n.meta).sort().forEach(([k, v]) => { const r = t.insertRow(); r.insertCell().textContent = k; r.insertCell().textContent = v; });
    }
  }

  function tip(root, n, ev) {  // compact created / modified summary on hover
    let d = root.querySelector('.pg-tip'); if (!d) d = h('div', 'pg-tip', root);
    d.innerHTML = ''; h('b', '', d).textContent = `${n.label || n.id} · ${n.kind}`;
    [['Created', n.audit.created], ['Modified', n.audit.modified]].forEach(([l, [w, who, em]]) => {
      const r = h('div', '', d); h('span', '', r).textContent = l; r.append(` ${w}`); if (who) r.append(` · ${who}`); if (em) r.append(` <${em}>`); });
    const r = root.getBoundingClientRect(); d.style.left = ev.clientX - r.left + 14 + 'px'; d.style.top = ev.clientY - r.top + 14 + 'px';
  }

  g.provGraph = function (root, data) {
    root.innerHTML = ''; root.classList.add('pg-root'); root.classList.toggle('pg-dark', !!data.dark); root.classList.toggle('pg-big', !!data.vertical);
    let fz = data.fz || 1; root.style.setProperty('--pg-z', fz);   // label font scale (A−/A+)
    const hiSet = new Set(data.chain), mode = data.mode || 'tree';
    const nodes = mode === 'chain' ? data.nodes.filter(n => hiSet.has(n.id)) : data.nodes;
    const by = layout(nodes, data.duration, data.vertical, data.stack), all = Object.values(by);
    all.forEach(n => { n.ox = n.px; n.oy = n.py; });   // laid-out position, for Reset
    const vp = h('div', 'pg-vp', root); if (data.height) vp.style.height = data.height + 'px';
    const svg = el('svg', {}, vp), world = el('g', {}, svg);
    let T = { x: 0, y: 0, k: 1 }, vis = null;   // vis: Set of nodes kept by shift-click pruning (null = all)
    const apply = () => { world.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`); all.forEach(n => n.vw && n.vw.size()); };
    const edgeD = (a, n) => {
      if (n.kind === 'thumb') {   // attach to the thumb's border on the side facing the parent (stays visible wherever the thumb is dragged)
        const dx = a.px - n.px, dy = a.py - n.py, L = Math.hypot(dx, dy) || 1, tx = (n.w / 2 + 3) / (Math.abs(dx) || 1e-9), ty = (n.h / 2 + 3) / (Math.abs(dy) || 1e-9), t = Math.min(tx, ty, 1);
        const ex = n.px + dx * t, ey = n.py + dy * t, sx = a.px - dx / L * 14, sy = a.py - dy / L * 14;
        if (tx < ty) { const mx = (sx + ex) / 2; return `M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}`; }
        const my = (sy + ey) / 2; return `M${sx},${sy} C${sx},${my} ${ex},${my} ${ex},${ey}`; }
      if (data.vertical && !(data.stack && n.kind === data.stack)) { const my = (a.py + n.py) / 2; return `M${a.px},${a.py + 14} C${a.px},${my} ${n.px},${my} ${n.px},${n.py - 14}`; }
      const mx = (a.px + n.px) / 2; return `M${a.px + 14},${a.py} C${mx},${a.py} ${mx},${n.py} ${n.px - 14},${n.py}`; };
    const edges = [];
    all.forEach(n => n.parents.forEach(p => { const a = by[p]; if (!a) return; const hi = hiSet.has(n.id) && hiSet.has(p);
      const e = el('path', { class: hi ? 'pg-edge pg-hi' : 'pg-edge' }, world);
      const hit = n.dur ? el('path', { class: 'pg-hit' }, world) : null;   // wide invisible path so thin edges are easy to hover
      if (hit) { const show = ev => { let d = root.querySelector('.pg-tip'); if (!d) d = h('div', 'pg-tip', root); d.textContent = 'Storage: ' + n.dur;
          const r = root.getBoundingClientRect(); d.style.left = ev.clientX - r.left + 12 + 'px'; d.style.top = ev.clientY - r.top + 12 + 'px'; };
        hit.addEventListener('pointerenter', show); hit.addEventListener('pointermove', show);
        hit.addEventListener('pointerleave', () => root.querySelector('.pg-tip')?.remove()); }
      edges.push({ a, n, e, hit }); }));
    const upd = n => { n.g.setAttribute('transform', `translate(${n.px},${n.py})`);
      edges.forEach(x => { if (x.a !== n && x.n !== n) return; const d = edgeD(x.a, x.n); x.e.setAttribute('d', d); x.hit && x.hit.setAttribute('d', d); }); };
    all.forEach(n => {
      const hi = hiSet.has(n.id), gr = n.g = el('g', { class: 'pg-node' }, world);
      if (n.kind === 'thumb') thumbImg(gr, n, data.base || '', { upd, k: () => T.k, front: g => world.appendChild(g), mpp: data.mpp }); else symbol(gr, n.kind, 0, 0, hi);
      if (n.abbr) { const a = el('text', { x: 0, y: 3, 'text-anchor': 'middle', class: 'pg-abbr' }, gr); a.textContent = n.abbr; }
      const t = el('text', { x: 0, y: 28, 'text-anchor': 'middle', 'font-weight': hi ? 700 : 400 }, gr); t.textContent = n.kind === 'thumb' ? '' : n.label || n.id;
      n.subEls = [];
      [...(n.kind === 'thumb' ? [] : n.lab ? [n.lab] : []), ...(n.kind === 'thumb' ? '' : n.sub || '').split('\n').filter(Boolean), ...(n.note ? ['\u0000' + n.note] : [])].forEach((ln, i) => {   // \0 marks the (italic) note line
        const nt = ln[0] === '\u0000', s2 = el('text', { x: 0, y: 28 + 12 * fz * (i + 1), 'text-anchor': 'middle', class: 'pg-sub' + (nt ? ' pg-note' : '') }, gr); n.subEls.push(s2); s2.textContent = nt ? ln.slice(1) : ln; });
      gr.addEventListener('pointerenter', () => { n.tipDone = false; clearTimeout(n.tt); n.tt = setTimeout(() => { n.tipDone = true; root.querySelector('.pg-tip')?.remove(); }, TIP_MS); });
      ['pointerenter', 'pointermove'].forEach(t => gr.addEventListener(t, ev => n.audit && !n.drag && !n.tipDone && tip(root, n, ev)));
      gr.addEventListener('pointerleave', () => clearTimeout(n.tt));
      gr.onpointerleave = () => root.querySelector('.pg-tip')?.remove();
      gr.addEventListener('pointerenter', () => { const s = new Set(), walk = m => { if (s.has(m)) return; s.add(m); m.kids.forEach(walk); }; walk(n);
        edges.forEach(x => x.e.classList.toggle('pg-glow', s.has(x.a))); });   // every edge leaving the hovered node or its descendants
      gr.addEventListener('pointerleave', () => edges.forEach(x => x.e.classList.remove('pg-glow')));
      upd(n);
      gr.onpointerdown = ev => {   // drag node; a click without movement opens the modal
        ev.stopPropagation(); root.querySelector('.pg-tip')?.remove(); n.sc > 1 && (world.appendChild(gr), n.vw && n.vw.draw()); gr.setPointerCapture(ev.pointerId);
        const x0 = ev.clientX, y0 = ev.clientY, px = n.px, py = n.py; let moved = false; n.drag = true;
        gr.onpointermove = e => { if (!e.buttons) { n.drag = false; gr.onpointermove = gr.onpointerup = null; return; } const dx = e.clientX - x0, dy = e.clientY - y0; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
          n.px = px + dx / T.k; n.py = py + dy / T.k; upd(n); };
        gr.onpointerup = e => { n.drag = false; gr.onpointermove = gr.onpointerup = null; moved || (e.shiftKey ? prune(n) : n.kind === 'thumb' ? n.sc > 1 || (n.mag(true), world.appendChild(gr)) : modal(root, n)); };
      };
    });
    vp.onwheel = ev => { ev.preventDefault(); const r = vp.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const k = Math.min(4, Math.max(0.15, T.k * Math.exp(-ev.deltaY * 0.0015)));
      T = { x: mx - (mx - T.x) * k / T.k, y: my - (my - T.y) * k / T.k, k }; apply(); };
    vp.onpointerdown = ev => { vp.setPointerCapture(ev.pointerId); const x0 = ev.clientX - T.x, y0 = ev.clientY - T.y; vp.classList.add('pg-pan');
      vp.onpointermove = e => { T.x = e.clientX - x0; T.y = e.clientY - y0; apply(); };
      vp.onpointerup = () => { vp.onpointermove = vp.onpointerup = null; vp.classList.remove('pg-pan'); }; };
    const fit = () => { const r = vp.getBoundingClientRect(), vs = all.filter(n => !vis || vis.has(n)), xs = vs.map(n => n.px), ys = vs.map(n => n.py);
      const w = Math.max(...xs) - Math.min(...xs) + 2 * PAD, hh = Math.max(...ys) - Math.min(...ys) + 2 * PAD;
      const k = Math.min(1, r.width / w, r.height / hh); T = { k, x: PAD * k - Math.min(...xs) * k, y: PAD * k - Math.min(...ys) * k }; apply(); };
    fit(); vp.ondblclick = fit;
    const vshow = () => { all.forEach(n => n.g.style.display = !vis || vis.has(n) ? '' : 'none');
      edges.forEach(x => { const d = !vis || (vis.has(x.a) && vis.has(x.n)) ? '' : 'none'; x.e.style.display = d; if (x.hit) x.hit.style.display = d; }); };
    const prune = n => { vis = new Set(); const w = m => { if (!vis.has(m)) { vis.add(m); m.kids.forEach(w); } }; w(n);
      const up = m => m.parents.forEach(p => { if (by[p] && !vis.has(by[p])) { vis.add(by[p]); up(by[p]); } }); up(n);   // ...and its ancestor lines up to the source
      root.querySelector('.pg-tip')?.remove(); vshow(); };   // keep n + descendants
    const bar = h('div', 'pg-bar', vp); bar.onpointerdown = bar.onwheel = ev => ev.stopPropagation();   // toolbar: fixed overlay, top left
    const btn = (t, tip, f) => { const b = h('button', '', bar); b.textContent = t; b.title = tip; b.onclick = f; };
    btn('Center', 'Fit the (pruned) graph in view', fit);
    btn('Reset', 'Restore pruned nodes and node moves, then center', () => { vis = null; vshow(); all.forEach(n => { n.px = n.ox; n.py = n.oy; n.mag ? n.mag(false) : upd(n); }); fit(); });
    btn('Optimize', 'Re-layout the visible (e.g. pruned) nodes compactly, then center', () => {
      const vs = all.filter(n => !vis || vis.has(n)), nb = layout(vs, data.duration, data.vertical, data.stack);
      vs.forEach(n => { n.px = nb[n.id].px; n.py = nb[n.id].py; upd(n); }); fit(); });
    const fs = d => { fz = Math.min(2.5, Math.max(0.6, fz * d)); root.style.setProperty('--pg-z', fz); data.fz = fz;
      all.forEach(n => n.subEls.forEach((s, i) => s.setAttribute('y', 28 + 12 * fz * (i + 1)))); };
    btn('\u2212', 'Smaller node labels', () => fs(1 / 1.15)); btn('+', 'Larger node labels', () => fs(1.15));
    const gp = h('div', 'pg-grip', root); gp.title = 'Drag to resize';   // vertical resize handle under the graph
    gp.onpointerdown = ev => { gp.setPointerCapture(ev.pointerId); const y0 = ev.clientY, h0 = vp.getBoundingClientRect().height;
      gp.onpointermove = e => vp.style.height = Math.max(200, h0 + e.clientY - y0) + 'px'; gp.onpointerup = () => gp.onpointermove = gp.onpointerup = null; };
    const lb = h('label', '', bar), cb = h('input', '', lb); cb.type = 'checkbox'; cb.checked = !!data.duration; lb.append(' Scale to storage duration');
    const dl = h('label', '', bar), dk = h('input', '', dl); dk.type = 'checkbox'; dk.checked = !!data.dark; dl.append(' Dark mode');
    dk.onchange = () => root.classList.toggle('pg-dark', dk.checked);
    cb.onchange = () => g.provGraph(root, { ...data, fz, duration: cb.checked, dark: root.classList.contains('pg-dark') });   // re-layout (node moves are reset)
    const cr = h('div', 'pg-credit', vp), ca = h('a', '', cr); if (data.credit === null) cr.remove();   // fixed overlay: unaffected by pan/zoom; credit:null hides it
    ca.href = 'https://docs.sennetconsortium.org/apis/'; ca.textContent = 'Data: SenNet / HuBMAP Consortium Entity API'; ca.title = 'Provenance and metadata retrieved via the SenNet Consortium APIs';
    ca.onclick = ev => { ev.preventDefault(); window.open(ca.href, '_blank', 'noopener,noreferrer'); }; cr.onpointerdown = ev => ev.stopPropagation(); cr.onwheel = ev => ev.stopPropagation();
    const lg = h('div', 'pg-legend', root);   // legend
    (data.legend || Object.keys(SYM).filter(k => !['other', 'project', 'datagroup', 'mouse', 'slide', 'sample'].includes(k))).forEach(k => { const s = el('svg', { width: 36, height: 28 }, h('span', '', lg)); symbol(s, k, 18, 14); lg.lastChild.append(k); });
    h('span', '', lg).textContent = '· wheel: zoom, drag: pan/move node, shift-click: keep only descendants, double-click: fit';
  };
})(window);
