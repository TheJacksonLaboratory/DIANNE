// Provenance graph viewer: provGraph(rootEl, {nodes, chain, target, mode}) ; mode = 'chain' | 'tree'
(function (g) {
  const NS = 'http://www.w3.org/2000/svg', TIP_MS = 5000, COL = 170, ROW = 56, PAD = 40;
  const SYM = { source: ['circle', '#e6b800'], organ: ['diamond', '#d62728'], block: ['square', '#f78fb3'],
    section: ['rect', '#f78fb3'], suspension: ['circle', '#1f77b4'], dataset: ['circle', '#2ca02c'], other: ['circle', '#999'] };
  const el = (t, a = {}, p) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); p && p.appendChild(e); return e; };
  const h = (t, c, p) => { const e = document.createElement(t); if (c) e.className = c; p && p.appendChild(e); return e; };

  function symbol(p, kind, x, y, hi) {
    const [s, fill] = SYM[kind] || SYM.other, a = { fill, class: hi ? 'pg-sym pg-hi' : 'pg-sym' };
    if (s === 'circle') el('circle', { cx: x, cy: y, r: 11, ...a }, p);
    else if (s === 'square') el('rect', { x: x - 10, y: y - 10, width: 20, height: 20, ...a }, p);
    else if (s === 'rect') el('rect', { x: x - 15, y: y - 8, width: 30, height: 16, ...a }, p);
    else el('polygon', { points: `${x},${y - 14} ${x + 12},${y} ${x},${y + 14} ${x - 12},${y}`, ...a }, p);
  }

  function layout(nodes, dur) {  // columns by longest path from a root; rows by DFS order of leaves
    const by = Object.fromEntries(nodes.map(n => [n.id, { ...n, kids: [] }]));
    nodes.forEach(n => n.parents.forEach(p => by[p] && by[p].kids.push(by[n.id])));
    const depth = {}, d = n => depth[n.id] ??= Math.max(-1, ...n.parents.filter(p => by[p]).map(p => d(by[p]))) + 1;
    Object.values(by).forEach(d);
    let row = 0; const seen = new Set();
    const place = n => {
      if (seen.has(n.id)) return n.y; seen.add(n.id);
      const ys = n.kids.map(place);
      n.y = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : row++; return n.y;
    };
    Object.values(by).filter(n => !n.parents.some(p => by[p])).forEach(place);
    // x: parent x + link length; with `dur`, length grows with log(storage days) (130..~300px), unknown stays COL
    const len = n => dur && n.days != null ? 130 + 55 * Math.log10(1 + n.days) : COL;
    Object.values(by).sort((a, b) => depth[a.id] - depth[b.id]).forEach(n => {
      const ps = n.parents.filter(p => by[p]); n.px = ps.length ? Math.max(...ps.map(p => by[p].px)) + len(n) : PAD; n.py = PAD + n.y * ROW; });
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
    h('b', '', L).textContent = `${n.id} (${n.kind})`; copy(n.id, L);
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
    d.innerHTML = ''; h('b', '', d).textContent = `${n.id} · ${n.kind}`;
    [['Created', n.audit.created], ['Modified', n.audit.modified]].forEach(([l, [w, who, em]]) => {
      const r = h('div', '', d); h('span', '', r).textContent = l; r.append(` ${w}`); if (who) r.append(` · ${who}`); if (em) r.append(` <${em}>`); });
    const r = root.getBoundingClientRect(); d.style.left = ev.clientX - r.left + 14 + 'px'; d.style.top = ev.clientY - r.top + 14 + 'px';
  }

  g.provGraph = function (root, data) {
    root.innerHTML = ''; root.classList.add('pg-root'); root.classList.toggle('pg-dark', !!data.dark);
    const hiSet = new Set(data.chain), mode = data.mode || 'tree';
    const nodes = mode === 'chain' ? data.nodes.filter(n => hiSet.has(n.id)) : data.nodes;
    const by = layout(nodes, data.duration), all = Object.values(by);
    all.forEach(n => { n.ox = n.px; n.oy = n.py; });   // laid-out position, for Reset
    const vp = h('div', 'pg-vp', root); if (data.height) vp.style.height = data.height + 'px';
    const svg = el('svg', {}, vp), world = el('g', {}, svg);
    let T = { x: 0, y: 0, k: 1 }, vis = null;   // vis: Set of nodes kept by shift-click pruning (null = all)
    const apply = () => world.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);
    const edgeD = (a, n) => { const mx = (a.px + n.px) / 2; return `M${a.px + 14},${a.py} C${mx},${a.py} ${mx},${n.py} ${n.px - 14},${n.py}`; };
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
      symbol(gr, n.kind, 0, 0, hi);
      if (n.abbr) { const a = el('text', { x: 0, y: 3, 'text-anchor': 'middle', class: 'pg-abbr' }, gr); a.textContent = n.abbr; }
      const t = el('text', { x: 0, y: 28, 'text-anchor': 'middle', 'font-weight': hi ? 700 : 400 }, gr); t.textContent = n.id;
      [...(n.sub || '').split('\n').filter(Boolean), ...(n.note ? ['\u0000' + n.note] : [])].forEach((ln, i) => {   // \0 marks the (italic) note line
        const nt = ln[0] === '\u0000', s2 = el('text', { x: 0, y: 40 + 12 * i, 'text-anchor': 'middle', class: 'pg-sub' + (nt ? ' pg-note' : '') }, gr); s2.textContent = nt ? ln.slice(1) : ln; });
      gr.addEventListener('pointerenter', () => { n.tipDone = false; clearTimeout(n.tt); n.tt = setTimeout(() => { n.tipDone = true; root.querySelector('.pg-tip')?.remove(); }, TIP_MS); });
      ['pointerenter', 'pointermove'].forEach(t => gr.addEventListener(t, ev => n.audit && !n.drag && !n.tipDone && tip(root, n, ev)));
      gr.addEventListener('pointerleave', () => clearTimeout(n.tt));
      gr.onpointerleave = () => root.querySelector('.pg-tip')?.remove();
      gr.addEventListener('pointerenter', () => { const s = new Set(), walk = m => { if (s.has(m)) return; s.add(m); m.kids.forEach(walk); }; walk(n);
        edges.forEach(x => x.e.classList.toggle('pg-glow', s.has(x.a))); });   // every edge leaving the hovered node or its descendants
      gr.addEventListener('pointerleave', () => edges.forEach(x => x.e.classList.remove('pg-glow')));
      upd(n);
      gr.onpointerdown = ev => {   // drag node; a click without movement opens the modal
        ev.stopPropagation(); root.querySelector('.pg-tip')?.remove(); gr.setPointerCapture(ev.pointerId);
        const x0 = ev.clientX, y0 = ev.clientY, px = n.px, py = n.py; let moved = false; n.drag = true;
        gr.onpointermove = e => { const dx = e.clientX - x0, dy = e.clientY - y0; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
          n.px = px + dx / T.k; n.py = py + dy / T.k; upd(n); };
        gr.onpointerup = e => { n.drag = false; gr.onpointermove = gr.onpointerup = null; moved || (e.shiftKey ? prune(n) : modal(root, n)); };
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
    btn('Reset', 'Restore pruned nodes and node moves, then center', () => { vis = null; vshow(); all.forEach(n => { n.px = n.ox; n.py = n.oy; upd(n); }); fit(); });
    const gp = h('div', 'pg-grip', root); gp.title = 'Drag to resize';   // vertical resize handle under the graph
    gp.onpointerdown = ev => { gp.setPointerCapture(ev.pointerId); const y0 = ev.clientY, h0 = vp.getBoundingClientRect().height;
      gp.onpointermove = e => vp.style.height = Math.max(200, h0 + e.clientY - y0) + 'px'; gp.onpointerup = () => gp.onpointermove = gp.onpointerup = null; };
    const lb = h('label', '', bar), cb = h('input', '', lb); cb.type = 'checkbox'; cb.checked = !!data.duration; lb.append(' Scale to storage duration');
    const dl = h('label', '', bar), dk = h('input', '', dl); dk.type = 'checkbox'; dk.checked = !!data.dark; dl.append(' Dark mode');
    dk.onchange = () => root.classList.toggle('pg-dark', dk.checked);
    cb.onchange = () => g.provGraph(root, { ...data, duration: cb.checked, dark: root.classList.contains('pg-dark') });   // re-layout (node moves are reset)
    const cr = h('div', 'pg-credit', vp), ca = h('a', '', cr);   // fixed overlay: unaffected by pan/zoom
    ca.href = 'https://docs.sennetconsortium.org/apis/'; ca.textContent = 'Data: SenNet / HuBMAP Consortium Entity API'; ca.title = 'Provenance and metadata retrieved via the SenNet Consortium APIs';
    ca.onclick = ev => { ev.preventDefault(); window.open(ca.href, '_blank', 'noopener,noreferrer'); }; cr.onpointerdown = ev => ev.stopPropagation(); cr.onwheel = ev => ev.stopPropagation();
    const lg = h('div', 'pg-legend', root);   // legend
    Object.entries(SYM).filter(([k]) => k !== 'other').forEach(([k]) => { const s = el('svg', { width: 36, height: 28 }, h('span', '', lg)); symbol(s, k, 18, 14); lg.lastChild.append(k); });
    h('span', '', lg).textContent = '· wheel: zoom, drag: pan/move node, shift-click: keep only descendants, double-click: fit';
  };
})(window);
