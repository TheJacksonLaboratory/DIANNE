/**
 * tiles.js
 *
 * Tile cache, fetcher, and renderer.
 * Listens to viewport.onChange and keeps the tile layer in sync.
 *
 * Responsibilities:
 *   - choose the right pyramid level for current scale
 *   - compute which tiles are visible (+ 1-tile prefetch border)
 *   - fetch missing tiles, abort stale requests
 *   - position fetched <img> elements in the tile layer div
 *   - evict LRU tiles when cache exceeds MAX_CACHED
 *
 * Exposes:
 *   tiles.update(transform)   called by viewport.onChange
 *   tiles.setLevel(n)         force a specific level (optional override)
 */

function createTiles(tileLayer, baseUrl, meta, viewport) {
  const TILE      = meta.tile_size;   // 512
  const MAX_CACHED = 200;
  const PREFETCH   = 1;               // tiles outside viewport to prefetch

  // cache: key "L-R-C" → { img, lastUsed, loading }
  const cache   = new Map();
  // in-flight AbortControllers: key "L-R-C" → AbortController
  const inflight = new Map();

  let currentLevel = meta.n_levels - 1;
  let prevLevel    = null;   // keep visible until new level is ready
  let frameRequested = false;

  // ── level selection ────────────────────────────────────────────────────────
  // Pick the finest level whose downsampled pixel is still >= 1 screen pixel.
  // i.e. we want  TILE * scale / downsample  to be reasonably sized.
  function bestLevel(scale) {
    for (let i = 0; i < meta.n_levels; i++) {
      if (scale >= 1 / meta.levels[i].downsample) return i;
    }
    return meta.n_levels - 1;
  }

  // ── visible tile range ─────────────────────────────────────────────────────
  function visibleRange(level, transform, pad) {
    const { scale, ox, oy } = transform;
    const lm  = meta.levels[level];
    const l0  = meta.levels[0];
    const cw  = tileLayer.parentElement.clientWidth;
    const ch  = tileLayer.parentElement.clientHeight;

    const x0 = Math.max(0, (-ox / scale) / (l0.width  / lm.width));
    const y0 = Math.max(0, (-oy / scale) / (l0.height / lm.height));
    const x1 = Math.min(lm.width,  ((cw - ox) / scale) / (l0.width  / lm.width));
    const y1 = Math.min(lm.height, ((ch - oy) / scale) / (l0.height / lm.height));

    return {
      c0: Math.max(0,               Math.floor(x0 / TILE) - pad),
      r0: Math.max(0,               Math.floor(y0 / TILE) - pad),
      c1: Math.min(lm.n_tiles_x - 1, Math.floor(x1 / TILE) + pad),
      r1: Math.min(lm.n_tiles_y - 1, Math.floor(y1 / TILE) + pad),
    };
  }

  // ── tile key ───────────────────────────────────────────────────────────────
  const key = (l, r, c) => `${l}-${r}-${c}`;

  // ── position a tile img in the layer ──────────────────────────────────────
  // Tiles are positioned in level-0 image space scaled to screen space.
  function positionTile(img, level, row, col, transform) {
    const { scale, ox, oy } = transform;
    const lm        = meta.levels[level];
    const l0        = meta.levels[0];
    const downsample = l0.width / lm.width;

    const imgX   = col * TILE * downsample;
    const imgY   = row * TILE * downsample;
    const screenX = imgX * scale + ox;
    const screenY = imgY * scale + oy;
    const screenW = TILE * downsample * scale;

    img.style.position  = 'absolute';
    img.style.left      = screenX + 'px';
    img.style.top       = screenY + 'px';
    img.style.width     = screenW + 'px';
    img.style.height    = screenW + 'px';
    img.style.imageRendering = 'pixelated';
  }

  // ── reposition all cached tiles (called after every pan/zoom) ─────────────
  function repositionAll(transform) {
    for (const [k, entry] of cache) {
      const [l, r, c] = k.split('-').map(Number);
      positionTile(entry.img, l, r, c, transform);
      // show current level always; show prev level only until current is ready
      if (l === currentLevel) {
        entry.img.style.display = 'block';
      } else if (l === prevLevel) {
        entry.img.style.display = newLevelReady(transform) ? 'none' : 'block';
      } else {
        entry.img.style.display = 'none';
      }
    }
  }

  // true when every visible tile at currentLevel is already in cache
  function newLevelReady(transform) {
    const vis = visibleRange(currentLevel, transform, 0);
    for (let r = vis.r0; r <= vis.r1; r++)
      for (let c = vis.c0; c <= vis.c1; c++)
        if (!cache.has(key(currentLevel, r, c))) return false;
    return true;
  }

  // ── fetch one tile ─────────────────────────────────────────────────────────
  function fetchTile(level, row, col, transform) {
    const k = key(level, row, col);
    if (cache.has(k) || inflight.has(k)) return;

    const ctrl = new AbortController();
    inflight.set(k, ctrl);

    const url = `${baseUrl}/tile?level=${level}&row=${row}&col=${col}`;
    fetch(url, { signal: ctrl.signal })
      .then(r => r.blob())
      .then(blob => {
        inflight.delete(k);
        const img      = document.createElement('img');
        img.src        = URL.createObjectURL(blob);
        img.draggable  = false;
        positionTile(img, level, row, col, viewport.getTransform());
        img.style.display = (level === currentLevel) ? 'block' : 'none';
        tileLayer.appendChild(img);
        cache.set(k, { img, lastUsed: Date.now() });
        evict();
      })
      .catch(() => { inflight.delete(k); });   // aborted or failed — silent
  }

  // ── abort inflight requests not in the visible+prefetch set ───────────────
  function abortStale(visibleKeys) {
    for (const [k, ctrl] of inflight) {
      if (!visibleKeys.has(k)) {
        ctrl.abort();
        inflight.delete(k);
      }
    }
  }

  // ── LRU eviction ──────────────────────────────────────────────────────────
  function evict() {
    if (cache.size <= MAX_CACHED) return;
    const sorted = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = sorted.slice(0, cache.size - MAX_CACHED);
    for (const [k, entry] of toRemove) {
      tileLayer.removeChild(entry.img);
      URL.revokeObjectURL(entry.img.src);
      cache.delete(k);
    }
  }

  // ── main update — called on every viewport change ─────────────────────────
  function update(transform) {
    const newLevel = bestLevel(transform.scale);

    if (newLevel !== currentLevel) {
      for (const [k, ctrl] of inflight) {
        if (k.startsWith(currentLevel + '-')) { ctrl.abort(); inflight.delete(k); }
      }
      prevLevel    = currentLevel;
      currentLevel = newLevel;
    }

    // touch last-used for visible cached tiles
    const vis   = visibleRange(currentLevel, transform, 0);
    const visKeys = new Set();
    for (let r = vis.r0; r <= vis.r1; r++) {
      for (let c = vis.c0; c <= vis.c1; c++) {
        const k = key(currentLevel, r, c);
        visKeys.add(k);
        if (cache.has(k)) cache.get(k).lastUsed = Date.now();
      }
    }

    repositionAll(transform);
    abortStale(visKeys);

    // fetch visible tiles (immediate) then prefetch border
    const all = visibleRange(currentLevel, transform, PREFETCH);
    for (let r = all.r0; r <= all.r1; r++) {
      for (let c = all.c0; c <= all.c1; c++) {
        fetchTile(currentLevel, r, c, transform);
      }
    }
  }

  // wire into viewport
  viewport.onChange(update);

  return { update, setLevel: l => { currentLevel = l; } };
}