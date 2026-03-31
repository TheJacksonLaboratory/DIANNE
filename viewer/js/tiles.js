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

function createTiles(tileLayer, baseUrl, meta, viewport, sampleName = null) {
  let currentMeta = meta;
  let activeSample = sampleName;
  const TILE      = meta.tile_size;   // 512
  const MAX_CACHED = 200;
  const PREFETCH   = 1;               // tiles outside viewport to prefetch

  // cache: key "L-R-C" → { img, lastUsed, loading }
  const cache   = new Map();
  // in-flight AbortControllers: key "L-R-C" → AbortController
  const inflight = new Map();

  let currentLevel = meta.n_levels - 1;
  let fallbackLevel = currentLevel; // keep visible until new level is ready
  let frameRequested = false;
  let pendingTransform = null;

  // ── level selection ────────────────────────────────────────────────────────
  // Pick the finest level whose downsampled pixel is still >= 1 screen pixel.
  // i.e. we want  TILE * scale / downsample  to be reasonably sized.
  function bestLevel(scale) {
    for (let i = 0; i < currentMeta.n_levels; i++) {
      if (scale >= 1 / currentMeta.levels[i].downsample) return i;
    }
    return currentMeta.n_levels - 1;
  }

  // ── visible tile range ─────────────────────────────────────────────────────
  function visibleRange(level, transform, pad) {
    const { scale, ox, oy } = transform;
    const lm  = currentMeta.levels[level];
    const l0  = currentMeta.levels[0];
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
    const lm        = currentMeta.levels[level];
    const l0        = currentMeta.levels[0];
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
    const ready = newLevelReady(transform);
    for (const [k, entry] of cache) {
      const [l, r, c] = k.split('-').map(Number);
      positionTile(entry.img, l, r, c, transform);
      // show current level always; show fallback level only until current is ready
      if (l === currentLevel) {
        entry.img.style.display = 'block';
      } else if (l === fallbackLevel) {
        entry.img.style.display = ready ? 'none' : 'block';
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
  function fetchTile(level, row, col) {
    const k = key(level, row, col);
    if (cache.has(k) || inflight.has(k)) return;

    const ctrl = new AbortController();
    inflight.set(k, ctrl);

    const sampleQuery = activeSample == null ? '' : `&sample=${encodeURIComponent(activeSample)}`;
    const url = `${baseUrl}/tile?level=${level}&row=${row}&col=${col}${sampleQuery}`;
    fetch(url, { signal: ctrl.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(blob => {
        inflight.delete(k);
        const img      = document.createElement('img');
        img.src        = URL.createObjectURL(blob);
        img.draggable  = false;
        positionTile(img, level, row, col, viewport.getTransform());
        img.style.display = (level === currentLevel) ? 'block' : 'none';
        tileLayer.appendChild(img);
        cache.set(k, { img, lastUsed: Date.now() });
        evict(viewport.getTransform());

        // If current level became ready, hide fallback immediately.
        if (newLevelReady(viewport.getTransform())) {
          repositionAll(viewport.getTransform());
        }
      })
      .catch(() => { inflight.delete(k); });   // aborted or failed — silent
  }

  // ── abort inflight requests not in the visible+prefetch set ───────────────
  function abortStale(requestedKeys) {
    for (const [k, ctrl] of inflight) {
      if (!requestedKeys.has(k)) {
        ctrl.abort();
        inflight.delete(k);
      }
    }
  }

  // ── LRU eviction ──────────────────────────────────────────────────────────
  function evict(transform) {
    if (cache.size <= MAX_CACHED) return;

    // Protect visible tiles of current and fallback levels from eviction.
    const protectedKeys = new Set();
    const currentVis = visibleRange(currentLevel, transform, 0);
    for (let r = currentVis.r0; r <= currentVis.r1; r++) {
      for (let c = currentVis.c0; c <= currentVis.c1; c++) {
        protectedKeys.add(key(currentLevel, r, c));
      }
    }
    if (fallbackLevel !== currentLevel) {
      const fallbackVis = visibleRange(fallbackLevel, transform, 0);
      for (let r = fallbackVis.r0; r <= fallbackVis.r1; r++) {
        for (let c = fallbackVis.c0; c <= fallbackVis.c1; c++) {
          protectedKeys.add(key(fallbackLevel, r, c));
        }
      }
    }

    const sorted = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let needRemove = cache.size - MAX_CACHED;
    for (const [k, entry] of sorted) {
      if (needRemove <= 0) break;
      if (protectedKeys.has(k)) continue;
      if (entry.img.parentElement === tileLayer) tileLayer.removeChild(entry.img);
      URL.revokeObjectURL(entry.img.src);
      cache.delete(k);
      needRemove -= 1;
    }
  }

  function chooseFallbackLevel(transform, targetLevel) {
    // Prefer nearest cached level with at least one visible tile present.
    for (let d = 1; d < currentMeta.n_levels; d++) {
      const lower = targetLevel - d;
      const upper = targetLevel + d;
      if (lower >= 0 && hasVisibleCachedTile(lower, transform)) return lower;
      if (upper < currentMeta.n_levels && hasVisibleCachedTile(upper, transform)) return upper;
    }
    return fallbackLevel;
  }

  function clearCache() {
    for (const [, entry] of cache) {
      if (entry.img.parentElement === tileLayer) tileLayer.removeChild(entry.img);
      URL.revokeObjectURL(entry.img.src);
    }
    cache.clear();
    for (const [, ctrl] of inflight) {
      ctrl.abort();
    }
    inflight.clear();
  }

  function setMeta(nextMeta) {
    currentMeta = nextMeta;
    currentLevel = currentMeta.n_levels - 1;
    fallbackLevel = currentLevel;
    clearCache();
    scheduleUpdate(viewport.getTransform());
  }

  function setSample(nextSample) {
    activeSample = nextSample;
    clearCache();
    scheduleUpdate(viewport.getTransform());
  }

  function hasVisibleCachedTile(level, transform) {
    const vis = visibleRange(level, transform, 0);
    for (let r = vis.r0; r <= vis.r1; r++) {
      for (let c = vis.c0; c <= vis.c1; c++) {
        if (cache.has(key(level, r, c))) return true;
      }
    }
    return false;
  }

  // ── main update — called on every viewport change ─────────────────────────
  function update(transform) {
    const newLevel = bestLevel(transform.scale);

    if (newLevel !== currentLevel) {
      fallbackLevel = chooseFallbackLevel(transform, newLevel);
      currentLevel = newLevel;
    }

    // touch last-used for visible cached tiles
    const vis = visibleRange(currentLevel, transform, 0);
    for (let r = vis.r0; r <= vis.r1; r++) {
      for (let c = vis.c0; c <= vis.c1; c++) {
        const k = key(currentLevel, r, c);
        if (cache.has(k)) cache.get(k).lastUsed = Date.now();
      }
    }

    repositionAll(transform);

    // Fetch visible tiles + prefetch border and keep exactly those inflight.
    const requestedKeys = new Set();
    const all = visibleRange(currentLevel, transform, PREFETCH);
    for (let r = all.r0; r <= all.r1; r++) {
      for (let c = all.c0; c <= all.c1; c++) {
        const k = key(currentLevel, r, c);
        requestedKeys.add(k);
        fetchTile(currentLevel, r, c);
      }
    }
    abortStale(requestedKeys);
    evict(transform);
  }

  function scheduleUpdate(transform) {
    pendingTransform = transform;
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      if (pendingTransform) {
        update(pendingTransform);
        pendingTransform = null;
      }
    });
  }

  // wire into viewport
  viewport.onChange(scheduleUpdate);
  scheduleUpdate(viewport.getTransform());

  return {
    update: scheduleUpdate,
    setLevel: l => { currentLevel = l; },
    setMeta,
    setSample,
  };
}