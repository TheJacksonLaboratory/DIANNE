/**
 * sample_ribbon.js
 *
 * Builds and manages the left-hand sample thumbnail ribbon, including:
 *   - per-sample thumbnail cards with lazy loading
 *   - viewport-rectangle overlay canvases on thumbnails
 *   - hover tooltip showing SAMPLE_METADATA (if provided)
 *   - click-to-switch and click-inside-thumb-to-pan behavior
 *
 * Exposes:
 *   createSampleRibbon({
 *     samplesRibbon, root, viewport,
 *     SAMPLES, SAMPLE_META, SAMPLE_XENIUM_META, SAMPLE_CELLS_META,
 *     SAMPLE_MAPPING, SAMPLE_METADATA,
 *     BASE_URL,
 *     ACTIVE_SAMPLE_REF,
 *     setActiveSampleFn,
 *   })
 *   → { buildSampleRibbon, updateThumbOverlays }
 */
function createSampleRibbon({
  samplesRibbon, root, viewport,
  SAMPLES, SAMPLE_META, SAMPLE_XENIUM_META, SAMPLE_CELLS_META,
  SAMPLE_MAPPING, SAMPLE_METADATA,
  BASE_URL,
  ACTIVE_SAMPLE_REF,
  setActiveSampleFn,
}) {
  // per-sample thumbnail overlay canvases (keyed by sample name)
  const thumbCanvases = {};

  // ── Tooltip for sample metadata ────────────────────────────────────────────
  const _hasAnyMeta = SAMPLES.some(s => {
    const m = SAMPLE_METADATA[s];
    return m && Object.keys(m).length > 0;
  });

  let _tooltip = null;
  if (_hasAnyMeta) {
    _tooltip = document.createElement('div');
    _tooltip.style.cssText = [
      'position:fixed', 'pointer-events:none', 'display:none', 'z-index:2147483648',
      'background:rgba(0,0,0,0.85)', 'color:#ddd', 'font:11px monospace',
      'border:1px solid #444', 'border-radius:6px', 'padding:6px 8px',
      'max-height:260px', 'overflow-y:auto',
      'box-shadow:0 4px 12px rgba(0,0,0,0.7)',
    ].join(';');
    document.body.appendChild(_tooltip);
  }

  function _buildTooltipContent(sampleName) {
    const meta = SAMPLE_METADATA[sampleName];
    if (!meta || !Object.keys(meta).length) return '';
    const rows = Object.entries(meta).map(([k, v]) =>
      `<tr>
        <td style="color:#888;padding:1px 8px 1px 0;white-space:nowrap;font-weight:bold;">${k}</td>
        <td style="color:#eee;padding:1px 0;word-break:break-all;">${v}</td>
      </tr>`
    ).join('');
    return `<table style="border-collapse:collapse;min-width:160px;">${rows}</table>`;
  }

  // ── Coord helpers for thumbnail viewport rect ──────────────────────────────
  function _imgToThumbPx(imgX, imgY, sampleMeta, thumbLevel, containerW) {
    const THUMB_SIZE = 256;
    const lMeta = sampleMeta.levels[thumbLevel];
    const l0    = sampleMeta.levels[0];
    const ts    = Math.min(THUMB_SIZE / lMeta.width, THUMB_SIZE / lMeta.height);
    const newW  = Math.round(lMeta.width  * ts);
    const newH  = Math.round(lMeta.height * ts);
    const offX  = Math.floor((THUMB_SIZE - newW) / 2);
    const offY  = Math.floor((THUMB_SIZE - newH) / 2);
    const lvlX  = imgX * lMeta.width  / l0.width;
    const lvlY  = imgY * lMeta.height / l0.height;
    return {
      x: (lvlX * ts + offX) * containerW / THUMB_SIZE,
      y: (lvlY * ts + offY) * containerW / THUMB_SIZE,
    };
  }

  function _thumbImageArea(sampleMeta, thumbLevel, containerW) {
    const THUMB_SIZE = 256;
    const lMeta = sampleMeta.levels[thumbLevel];
    const ts    = Math.min(THUMB_SIZE / lMeta.width, THUMB_SIZE / lMeta.height);
    const newW  = Math.round(lMeta.width  * ts);
    const newH  = Math.round(lMeta.height * ts);
    const offX  = Math.floor((THUMB_SIZE - newW) / 2);
    const offY  = Math.floor((THUMB_SIZE - newH) / 2);
    return {
      x0: offX * containerW / THUMB_SIZE,
      y0: offY * containerW / THUMB_SIZE,
      x1: (offX + newW) * containerW / THUMB_SIZE,
      y1: (offY + newH) * containerW / THUMB_SIZE,
    };
  }

  function updateThumbOverlays() {
    for (const [sampleName, canvas] of Object.entries(thumbCanvases)) {
      const ctx2 = canvas.getContext('2d');
      ctx2.clearRect(0, 0, canvas.width, canvas.height);
      if (sampleName !== ACTIVE_SAMPLE_REF()) continue;

      const m = SAMPLE_META[sampleName];
      const thumbLevel = Math.max(0, Number(m.n_levels) - 1);
      const containerW = canvas.width;
      const area = _thumbImageArea(m, thumbLevel, containerW);

      const vpW = root.clientWidth;
      const vpH = root.clientHeight;
      const tl  = viewport.toImageSpace(0, 0);
      const br  = viewport.toImageSpace(vpW, vpH);

      const p0 = _imgToThumbPx(tl.x, tl.y, m, thumbLevel, containerW);
      const p1 = _imgToThumbPx(br.x, br.y, m, thumbLevel, containerW);

      const cx0 = Math.max(p0.x, area.x0);
      const cy0 = Math.max(p0.y, area.y0);
      const cx1 = Math.min(p1.x, area.x1);
      const cy1 = Math.min(p1.y, area.y1);
      if (cx0 >= cx1 || cy0 >= cy1) continue;

      ctx2.save();
      ctx2.beginPath();
      ctx2.rect(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
      ctx2.clip();
      ctx2.strokeStyle = 'rgba(255,55,55,0.92)';
      ctx2.lineWidth = 1.5;
      ctx2.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      ctx2.restore();
    }
  }

  function buildSampleRibbon() {
    samplesRibbon.innerHTML = '';
    let thumbObserver = null;
    if ('IntersectionObserver' in window) {
      thumbObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const wrap = entry.target;
          const img = wrap.querySelector('img[data-thumb-src]');
          if (!img || img.dataset.thumbLoaded === '1') {
            observer.unobserve(wrap);
            continue;
          }
          img.src = img.dataset.thumbSrc;
          img.dataset.thumbLoaded = '1';
          observer.unobserve(wrap);
        }
      }, {
        root: samplesRibbon,
        rootMargin: '120px 0px',
        threshold: 0.01,
      });
    }

    const legend = document.createElement('div');
    legend.style.cssText = [
      'display:flex', 'gap:6px', 'align-items:center', 'flex-wrap:wrap',
      'padding:2px 0 6px 0', 'border-bottom:1px solid #2f2f2f',
      'margin-bottom:2px',
    ].join(';');
    samplesRibbon.appendChild(legend);

    for (const sampleName of SAMPLES) {
      const hasXe = !!(SAMPLE_XENIUM_META[sampleName] || SAMPLE_CELLS_META[sampleName]);
      const card = document.createElement('button');
      card.dataset.sampleCard = 'true';
      card.dataset.sampleName = sampleName;
      card.type = 'button';
      card.style.cssText = [
        'width:100%', 'text-align:left', 'cursor:pointer',
        'border:1px solid #4a4a4a', 'border-radius:6px',
        'background:#1d1d1d', 'color:#e6e6e6', 'padding:6px',
        'display:flex', 'flex-direction:column', 'gap:6px',
      ].join(';');

      const thumbWrap = document.createElement('div');
      thumbWrap.style.cssText = [
        'width:100%', 'aspect-ratio:1/1', 'overflow:hidden',
        'position:relative', 'border-radius:4px', 'background:#0f0f0f',
        'border:1px solid #303030',
      ].join(';');
      const m = SAMPLE_META[sampleName];
      console.log(`Sample ${sampleName} has ${m.n_levels} levels`);
      const thumbLevel = Math.max(0, Number(m.n_levels) - 1);
      console.log(`Using thumbnail level ${thumbLevel} for sample ${sampleName}`);
      const img = document.createElement('img');
      img.alt = sampleName;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center center;display:block;';
      img.dataset.thumbSrc = BASE_URL + '/thumb?sample=' + encodeURIComponent(sampleName)
        + '&level=' + thumbLevel + '&size=256';
      img.dataset.thumbLoaded = '0';
      if (!thumbObserver) {
        img.src = img.dataset.thumbSrc;
        img.dataset.thumbLoaded = '1';
      }
      thumbWrap.appendChild(img);
      if (thumbObserver) thumbObserver.observe(thumbWrap);

      // Overlay canvas for viewport rectangle
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width  = 1;
      thumbCanvas.height = 1;
      thumbCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;';
      thumbWrap.appendChild(thumbCanvas);

      const resizeThumbCanvas = () => {
        const w = thumbWrap.clientWidth;
        if (w > 0 && (thumbCanvas.width !== w || thumbCanvas.height !== w)) {
          thumbCanvas.width  = w;
          thumbCanvas.height = w;
          updateThumbOverlays();
        }
      };
      new ResizeObserver(resizeThumbCanvas).observe(thumbWrap);
      thumbCanvases[sampleName] = thumbCanvas;

      const label = document.createElement('div');
      label.textContent = sampleName;
      label.style.cssText = [
        'font:12px monospace', 'line-height:1.3',
        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      ].join(';');

      if (SAMPLE_MAPPING[sampleName]) {
        const sublabel = document.createElement('div');
        sublabel.textContent = '(' + SAMPLE_MAPPING[sampleName] + ')';
        sublabel.style.cssText = [
          'font:11px monospace', 'line-height:1.3', 'color:#aaa',
          'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
        ].join(';');
        label.appendChild(sublabel);
      }

      const badge = document.createElement('div');
      badge.textContent = hasXe ? 'XE' : 'HE';
      badge.title = hasXe ? 'Xenium overlays available' : 'H&E image only';
      badge.style.cssText = [
        'font:10px monospace', 'align-self:flex-start',
        'padding:1px 6px', 'border-radius:999px',
        'border:1px solid ' + (hasXe ? '#1f7a3a' : '#555'),
        'color:' + (hasXe ? '#8cffb1' : '#bdbdbd'),
        'background:' + (hasXe ? 'rgba(31,122,58,0.2)' : 'rgba(80,80,80,0.25)'),
      ].join(';');

      card.appendChild(thumbWrap);
      card.appendChild(label);
      card.appendChild(badge);

      // ── Hover tooltip (only when this sample has metadata) ─────────────────
      const sampleMeta = SAMPLE_METADATA[sampleName];
      const hasMeta = sampleMeta && Object.keys(sampleMeta).length > 0;
      if (_tooltip && hasMeta) {
        const tooltipContent = _buildTooltipContent(sampleName);
        card.addEventListener('mouseenter', () => {
          _tooltip.innerHTML = tooltipContent;
          _tooltip.style.display = 'block';
        });
        card.addEventListener('mousemove', e => {
          const MARGIN = 12;
          let tx = e.clientX + MARGIN;
          let ty = e.clientY + MARGIN;
          // Keep tooltip on-screen
          const tw = _tooltip.offsetWidth  || 200;
          const th = _tooltip.offsetHeight || 100;
          if (tx + tw > window.innerWidth)  tx = e.clientX - tw - MARGIN;
          if (ty + th > window.innerHeight) ty = e.clientY - th - MARGIN;
          _tooltip.style.left = tx + 'px';
          _tooltip.style.top  = ty + 'px';
        });
        card.addEventListener('mouseleave', () => {
          _tooltip.style.display = 'none';
        });
      }

      // ── Click handler ──────────────────────────────────────────────────────
      card.addEventListener('click', e => {
        const thumbRect = thumbWrap.getBoundingClientRect();
        const inThumb = (e.clientX >= thumbRect.left && e.clientX <= thumbRect.right &&
                         e.clientY >= thumbRect.top  && e.clientY <= thumbRect.bottom);

        const wasSampleAlreadyActive = (sampleName === ACTIVE_SAMPLE_REF());
        setActiveSampleFn(sampleName);

        if (inThumb && wasSampleAlreadyActive) {
          const clickX = e.clientX - thumbRect.left;
          const clickY = e.clientY - thumbRect.top;
          const containerW = thumbRect.width;
          const THUMB_SIZE = 256;
          const lMeta = m.levels[thumbLevel];
          const l0    = m.levels[0];
          const ts    = Math.min(THUMB_SIZE / lMeta.width, THUMB_SIZE / lMeta.height);
          const newW  = Math.round(lMeta.width  * ts);
          const newH  = Math.round(lMeta.height * ts);
          const offX  = Math.floor((THUMB_SIZE - newW) / 2);
          const offY  = Math.floor((THUMB_SIZE - newH) / 2);
          const jpegX = clickX * THUMB_SIZE / containerW;
          const jpegY = clickY * THUMB_SIZE / containerW;
          const lvlX  = (jpegX - offX) / ts;
          const lvlY  = (jpegY - offY) / ts;
          const imgX  = Math.max(0, Math.min(l0.width,  lvlX * l0.width  / lMeta.width));
          const imgY  = Math.max(0, Math.min(l0.height, lvlY * l0.height / lMeta.height));

          const t   = viewport.getTransform();
          const vpW = root.clientWidth;
          const vpH = root.clientHeight;
          const newOx = vpW / 2 - imgX * t.scale;
          const newOy = vpH / 2 - imgY * t.scale;
          viewport.panBy(newOx - t.ox, newOy - t.oy);
        }
      });

      samplesRibbon.appendChild(card);
    }
    setActiveSampleFn(ACTIVE_SAMPLE_REF());
  }

  /**
   * Show only the given samples in the ribbon (hide others).
   * Called by metadata_panel when filters change.
   * @param {string[]} samples — array of sample names to show
   */
  function setVisibleSamples(samples) {
    const s = new Set(samples);
    for (const card of samplesRibbon.querySelectorAll('[data-sample-card]')) {
      card.style.display = s.has(card.dataset.sampleName) ? '' : 'none';
    }
  }

  return { buildSampleRibbon, updateThumbOverlays, setVisibleSamples };
}
