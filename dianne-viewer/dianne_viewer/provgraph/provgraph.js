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

  let uid = 0; const TH = 96;   // thumbnail node size (1 in)
  function thumbImg(gr, n, base, cx) {   // thumbnail node sized to the image's aspect (longest side TH); click magnifies it in place (resizable by the corner handle, edges stay attached); retries while the server is still opening the sample
    gr.classList.add('pg-thumb'); const ig = el('g', {}, gr), big = 1024, cid = 'pgc' + (++uid), cp = el('clipPath', { id: cid }, el('defs', {}, gr)), cr = el('rect', {}, cp); n.iw = n.ih = n.w = n.h = TH; n.sc = 1; n.rl = [];   // rounded-corner clip: the image fills the frame, corner pixels are cut
    const bg = el('rect', { x: -TH / 2, y: -TH / 2, width: TH, height: TH, rx: 5, fill: 'none', stroke: SYM[n.type === 'slidepic' ? 'slide' : 'sample'][1], 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, ig);   // frame = color of the parent node (sample green / slide light blue)
    const im = n.im = el('image', { x: -TH / 2, y: -TH / 2, width: TH, height: TH, preserveAspectRatio: 'none', 'clip-path': `url(#${cid})` }, ig), pre = new Image(); let k = 0; ig.appendChild(bg);   // frame drawn on top of the (clipped) image, exact same size: no gap
    const ctl = el('g', { class: 'pg-ctl', display: 'none' }, gr), xb = el('g', { class: 'pg-x' }, ctl), rz = el('g', { class: 'pg-rz' }, ctl);   // close (top right) and resize (bottom right) handles
    el('circle', { r: 9, fill: '#222', stroke: '#fff' }, xb); el('path', { d: 'M-3.5,-3.5L3.5,3.5M3.5,-3.5L-3.5,3.5', stroke: '#fff', 'stroke-width': 1.6 }, xb);
    el('path', { d: 'M10,-10L10,10L-10,10Z', fill: '#fff', stroke: '#222', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, rz);
    const lay = () => { Object.entries({ x: -n.iw / 2, y: -n.ih / 2, width: n.iw, height: n.ih, rx: 5 / n.sc }).forEach(([a, v]) => { cr.setAttribute(a, v); bg.setAttribute(a, v); }); n.w = n.iw * n.sc; n.h = n.ih * n.sc; ig.setAttribute('transform', `scale(${n.sc})`);
      xb.setAttribute('transform', `translate(${n.w / 2},${-n.h / 2})`); rz.setAttribute('transform', `translate(${n.w / 2 - 6},${n.h / 2 - 6})`);
      n.rl.forEach(([t, x, y]) => { t.setAttribute('x', (x - .5) * n.w); t.setAttribute('y', (y - .5) * n.h); }); };
    n.setSc = s => { n.sc = s; lay(); cx.upd(n); };
    n.mag = on => { gr.classList.toggle('pg-magd', on); ctl.setAttribute('display', on ? '' : 'none'); n.rl.forEach(([t]) => t.setAttribute('display', on ? '' : 'none'));
      if (on) { n.setSc(Math.max(n.sc, 400 / Math.max(n.iw, n.ih))); const b = new Image(); b.onload = () => n.sc > 1 && im.setAttribute('href', b.src); b.src = `${base}${n.thumb}&big=${big}`; }
      else { n.setSc(1); im.setAttribute('href', n.small); } };
    xb.onpointerdown = ev => ev.stopPropagation(); xb.onclick = () => n.mag(false);
    rz.onpointerdown = ev => { ev.stopPropagation(); rz.setPointerCapture(ev.pointerId); const x0 = ev.clientX, w0 = n.w, h0 = n.h, px = n.px, py = n.py;
      rz.onpointermove = e => { const s = Math.max(1, (w0 + (e.clientX - x0) / cx.k()) / n.iw); n.sc = s; lay(); n.px = px + (n.w - w0) / 2; n.py = py + (n.h - h0) / 2; cx.upd(n); };   // top-left corner stays put
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
    const apply = () => world.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);
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
      if (n.kind === 'thumb') thumbImg(gr, n, data.base || '', { upd, k: () => T.k }); else symbol(gr, n.kind, 0, 0, hi);
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
        ev.stopPropagation(); root.querySelector('.pg-tip')?.remove(); n.sc > 1 && world.appendChild(gr); gr.setPointerCapture(ev.pointerId);
        const x0 = ev.clientX, y0 = ev.clientY, px = n.px, py = n.py; let moved = false; n.drag = true;
        gr.onpointermove = e => { const dx = e.clientX - x0, dy = e.clientY - y0; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
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
