/**
 * demo.js
 *
 * Guided walkthrough / tour for the DIANNE viewer.
 *
 * Exposes:
 *   createDemo()  → { start, stop }
 *
 * Each UI element to tour is described in DEMO_STEPS below.
 * Add, remove, or reorder entries freely — the rest of the code adapts.
 * Elements whose selector is not found in the DOM are silently skipped.
 */

// ─────────────────────────────────────────────────────────────────────────────
// DEMO_STEPS  —  vertical list of all tour stops.
// Fields:
//   selector  CSS selector targeting the element to highlight (data-demo-id="…" or #id)
//   title     Short heading shown in the description panel
//   text      Explanation shown to the user
//   activate  optional () => void, run right before resolving `selector` — used
//             to click the Samples/Metadata/Annotations tab that owns a target
//             hidden (display:none) inside an inactive tab
// ─────────────────────────────────────────────────────────────────────────────
function _clickTab(name) {
  const btn = document.querySelector('[data-demo-id="tab-' + name + '"]');
  if (btn) btn.click();
}

// Selects a viewer tool (pan / annot_draw / draw_positive / draw_negative / …)
// so the row of controls that only shows up for that tool becomes visible.
function _clickTool(name) {
  const btn = document.querySelector('[data-demo-id="tool-' + name.replace(/_/g, '-') + '"]');
  if (btn) btn.click();
}

// Opens the Settings panel (idempotent — only clicks the gear if it's closed).
function _openSettings() {
  const panel = document.querySelector('[data-demo-id="settings-panel"]');
  const btn   = document.querySelector('[data-demo-id="settings-btn"]');
  if (btn && panel && panel.style.display === 'none') btn.click();
}

// Closes the Settings panel (idempotent) — used once the tour moves past the
// settings section, so the panel doesn't sit open over later steps.
function _closeSettings() {
  const panel = document.querySelector('[data-demo-id="settings-panel"]');
  const btn   = document.querySelector('[data-demo-id="settings-close-btn"]');
  if (btn && panel && panel.style.display !== 'none') btn.click();
}

// The active-user dot is normally only shown by toolbar.js's own polling
// when another user is genuinely active on this sample — force it on for
// the demo step so the tour can show it even when no one else is around,
// and mark it so we know to put it back afterwards.
function _forceActiveUserDot() {
  const dot = document.querySelector('[data-demo-id="active-user-dot"]');
  if (dot && dot.style.display === 'none') {
    dot.dataset.demoForced = '1';
    dot.style.display = 'block';
    dot.title = '(demo) Shown here as a preview — no other user is actually active on this sample right now.';
  }
}
function _unforceActiveUserDot() {
  const dot = document.querySelector('[data-demo-id="active-user-dot"]');
  if (dot && dot.dataset.demoForced) {
    delete dot.dataset.demoForced;
    dot.style.display = 'none';
    dot.title = '';
  }
}

const DEMO_STEPS = [
  // ── Sample panel: Samples / Metadata / Annotations tabs ──────────────────
  {
    selector: '#iv-samples',
    title: 'Sample panel',
    text: 'A tabbed panel with three views: Samples (thumbnail list), Metadata (sortable table), and Annotations (per-sample annotation manager).',
  },
  {
    selector: '[data-demo-id="tab-samples"]',
    title: 'Samples tab',
    activate: () => _clickTab('samples'),
    text: 'Click a thumbnail to make it active; click again on the already-active sample to pan the main view to wherever you clicked in the thumbnail.',
  },
  {
    selector: '[data-sample-card]',
    title: 'Sample thumbnail',
    activate: () => _clickTab('samples'),
    text: 'Each card shows a thumbnail with a live viewport-rectangle overlay (where you currently are in the active sample) and a mini preview of drawn annotations. XE/HE badge shows whether Xenium overlays are available; hovering shows per-sample metadata. An orange badge appears when the sample has unsaved annotation changes.',
  },
  {
    selector: '[data-demo-id="active-user-dot"]',
    title: 'Active-user indicator',
    activate: () => _forceActiveUserDot(),
    text: 'A blinking green dot lights up next to the tools when another user is also viewing/editing this same sample right now. Hover it to see who. (Shown here for preview — forced on for the tour since no one else happens to be active right now.)',
  },
  {
    selector: '[data-demo-id="tab-metadata"]',
    title: 'Metadata tab',
    activate: () => { _unforceActiveUserDot(); _clickTab('metadata'); },
    text: 'A sortable table of every sample’s metadata columns. Click a column header to sort; hover a row for a thumbnail + full metadata preview; click a row to jump to that sample.',
  },
  {
    selector: '[data-demo-id="metadata-filter-bar"]',
    title: 'Metadata filters',
    activate: () => _clickTab('metadata'),
    text: 'One filter control per metadata column — a numeric range for numeric columns, a dropdown for low-cardinality categorical columns, or free text otherwise. Filtering here also narrows which thumbnails show in the Samples tab.',
  },
  {
    selector: '[data-demo-id="metadata-table"]',
    title: 'Column value chart',
    activate: () => _clickTab('metadata'),
    text: 'Hover any column header (other than Sample) to see a pie chart breakdown of that column’s values across all samples, with counts and percentages.',
  },
  {
    selector: '[data-demo-id="tab-annotations"]',
    title: 'Annotations tab',
    activate: () => _clickTab('annotations'),
    text: 'Shows the sample ribbon side by side with a full manager for the active sample’s library annotations: search, sort, bulk actions, and per-row editing.',
  },
  {
    selector: '[data-demo-id="annot-tab-toolbar"]',
    title: 'Search & sort',
    activate: () => _clickTab('annotations'),
    text: 'Filter the annotation list by label/class/status text, and sort by label, class, date, or area (click the arrow to flip direction).',
  },
  {
    selector: '[data-demo-id="annot-tab-bulk-row"]',
    title: 'Bulk selection & actions',
    activate: () => _clickTab('annotations'),
    text: 'All/Invert/None select helpers, one-click select-by-status or select-by-class, then Delete/Simplify/Export/Save and Copy-to-positive/negative — all applied to whatever is currently checked.',
  },
  {
    selector: '[data-demo-id="annot-tab-list"]',
    title: 'Annotation rows',
    activate: () => _clickTab('annotations'),
    text: 'Each row lets you rename, change class (with an auto-assigned color swatch), add notes, toggle visibility, delete, or promote to a positive/negative stroke. Selecting a row here highlights the matching shape on the canvas, and vice versa — including double-click-to-select on a contour.',
  },
  // The following steps drill into a single annotation row — they only
  // appear when the active sample actually has a library annotation to show.
  {
    selector: '[data-demo-id="annot-row-checkbox"]',
    title: 'Row: checkbox',
    activate: () => _clickTab('annotations'),
    text: 'Checks this annotation into the current bulk-selection set, so the All/Invert/None helpers and the Delete/Simplify/Export/Save/Copy/visibility actions above apply to it too.',
  },
  {
    selector: '[data-demo-id="annot-row-class"]',
    title: 'Row: class',
    activate: () => _clickTab('annotations'),
    text: 'Type a class name or pick one from the dropdown of classes already used on this sample. If several rows are checked, changing one offers to apply the new class to all of them.',
  },
  {
    selector: '[data-demo-id="annot-row-color"]',
    title: 'Row: class color',
    activate: () => _clickTab('annotations'),
    text: 'Per-class color swatch. Recoloring it updates every annotation of that class on the canvas, the minimap preview, and this list — not just this one row.',
  },
  {
    selector: '[data-demo-id="annot-row-notes"]',
    title: 'Row: notes',
    activate: () => _clickTab('annotations'),
    text: 'Free-text label/notes for this specific annotation.',
  },
  {
    selector: '[data-demo-id="annot-row-creator"]',
    title: 'Row: creator',
    activate: () => _clickTab('annotations'),
    text: 'Purple icon — hover to see who first created this annotation and when.',
  },
  {
    selector: '[data-demo-id="annot-row-editor"]',
    title: 'Row: last editor',
    activate: () => _clickTab('annotations'),
    text: 'Light-blue icon — hover to see who most recently edited this annotation and when. May differ from the creator.',
  },
  {
    selector: '[data-demo-id="annot-row-visibility"]',
    title: 'Row: visibility',
    activate: () => _clickTab('annotations'),
    text: 'Hides or shows just this annotation on the canvas without deleting it. If this row is part of the checked set, the toggle applies to every checked row at once.',
  },
  {
    selector: '[data-demo-id="annot-row-delete"]',
    title: 'Row: delete',
    activate: () => _clickTab('annotations'),
    text: 'Deletes this annotation — and every sibling ring/hole that shares its group (e.g. a shape with a hole cut out of it), so a multi-piece annotation always deletes as one unit.',
  },
  {
    selector: '[data-demo-id="annot-row-status"]',
    title: 'Row: status, promote, area',
    activate: () => _clickTab('annotations'),
    text: 'Push-button review status (draft/proposed/edited/reviewed — editing a reviewed annotation asks to confirm first), one-click Copy to a positive/negative stroke, and a live area readout in physical units.',
  },

  // ── Core navigation & drawing tools ────────────────────────────────────
  {
    selector: '[data-demo-id="scale-bar"]',
    title: 'Scale bar',
    text: 'A physical length reference (µm/mm/cm) for the current zoom level, redrawn live as you pan and zoom. Only shown when the image’s microns-per-pixel value is known.',
  },
  {
    selector: '[data-demo-id="tool-pan"]',
    title: '✥  Pan / zoom',
    activate: () => _clickTool('pan'),
    text: 'The default navigation tool. Drag to pan, scroll to zoom, double-click anywhere to reset to the full-view. No annotations are drawn while this tool is active.',
  },
  {
    selector: '[data-demo-id="tool-annot-draw"]',
    title: 'draw  Named annotations',
    activate: () => _clickTool('annot_draw'),
    text: 'Freehand/disk brush that creates a persistent, editable "unclassified" annotation in the library — unlike draw+/draw− strokes, these get a class, notes, and appear in the Annotations tab.',
  },
  {
    selector: '[data-demo-id="tool-draw-positive"]',
    title: 'draw+  Positive draw',
    activate: () => _clickTool('draw_positive'),
    text: 'Draw freehand positive contours that mark regions of interest — typically tumour or cell-type you want to detect. Strokes are stored in image space and stay locked when you zoom.',
  },
  {
    selector: '[data-demo-id="tool-draw-negative"]',
    title: 'draw−  Negative draw',
    activate: () => _clickTool('draw_negative'),
    text: 'Draw negative contours to mark background or tissue you want the classifier to exclude. Using both positive and negative strokes improves classifier quality.',
  },
  {
    selector: '[data-demo-id="brush-mode-btn"]',
    title: 'Brush mode toggle (line ↔ disk)',
    activate: () => _clickTool('draw_positive'),
    text: 'Switches between Line mode (thin freehand stroke, good for outlines) and Disk mode (large swept-disk brush, good for quickly painting big regions). The slider to the right controls line width or disk radius depending on the active mode. Only shown while draw+/draw− is active.',
  },
  {
    selector: '[data-demo-id="color-picker"]',
    title: 'Stroke color',
    activate: () => _clickTool('draw_positive'),
    text: 'Sets the display color of strokes drawn with the current tool. Only affects how contours are visualised; the positive/negative type is determined by the active draw tool, not the color.',
  },
  {
    selector: '[data-demo-id="width-slider"]',
    title: 'Width / radius slider',
    activate: () => _clickTool('draw_positive'),
    text: 'In Line mode: controls stroke width in screen pixels (1–50 px). In Disk mode: controls the disk radius in image pixels (50–10 000 px). Adjust before drawing; existing strokes are not affected.',
  },
  {
    selector: '[data-demo-id="smooth-slider"]',
    title: 'Smoothing slider',
    activate: () => _clickTool('draw_positive'),
    text: 'Adjusts how much the raw pointer path is smoothed before storing. 0 = no smoothing (jagged). 1 = heavy smoothing (rounded). Default 0.35 works well for most cases.',
  },
  {
    selector: '[data-demo-id="undo-btn"]',
    title: '↩  Undo',
    activate: () => _clickTool('draw_positive'),
    text: 'Removes the last stroke (or disk-brush group) for the current draw mode. Undo is per-mode: switching between draw+ and draw− gives independent undo histories.',
  },
  // The ruler/polygon/lasso/vertex-edit/split/erase/grow row is hidden for
  // the default pan tool and for draw+/draw− — it only shows up once "draw"
  // (annot_draw) or one of its own tools is selected.
  {
    selector: '[data-demo-id="tool-ruler"]',
    title: '📏  Ruler',
    activate: () => _clickTool('annot_draw'),
    text: 'Single-measurement tool: click-drag to measure a distance in image units. Esc removes the ruler.',
  },
  {
    selector: '[data-demo-id="tool-annot-polygon"]',
    title: '△  Polygon',
    activate: () => _clickTool('annot_draw'),
    text: 'Click to place vertices, Enter to close the shape into a new library annotation.',
  },
  {
    selector: '[data-demo-id="tool-annot-lasso"]',
    title: '➰  Lasso select',
    activate: () => _clickTool('annot_draw'),
    text: 'Drag a freehand area to select every annotation it touches — they get checked in the Annotations tab so bulk actions apply to them. The drawn area stays until you draw a new one, switch tools, or press Esc.',
  },
  {
    selector: '[data-demo-id="tool-annot-vertex-edit"]',
    title: '*  Vertex edit',
    activate: () => _clickTool('annot_draw'),
    text: 'Drag, insert, or delete individual vertices of the selected annotation for precise outline touch-ups.',
  },
  {
    selector: '[data-demo-id="tool-annot-split"]',
    title: '✂  Split',
    activate: () => _clickTool('annot_draw'),
    text: 'Draw a line fully across the selected annotation to divide it into two separate annotations.',
  },
  {
    selector: '[data-demo-id="tool-annot-erase"]',
    title: '⊖  Erase',
    activate: () => _clickTool('annot_draw'),
    text: 'Chomp area out of the selected annotation with an adjustable disk — useful for trimming an outline without redrawing it.',
  },
  {
    selector: '[data-demo-id="tool-annot-grow"]',
    title: '⊕  Grow',
    activate: () => _clickTool('annot_draw'),
    text: 'Add area onto the selected annotation with an adjustable disk — the complement of Erase.',
  },
  {
    selector: '[data-demo-id="annot-undo-btn"]',
    title: '↩︎  Undo (annotation edit)',
    activate: () => _clickTool('annot_draw'),
    text: 'Undoes the last geometry edit (vertex/split/erase/grow) made to a library annotation. This history is separate from the draw+/draw− undo above.',
  },
  {
    selector: '[data-demo-id="annot-export-btn"]',
    title: '⤓ GeoJSON  Export',
    activate: () => _clickTool('annot_draw'),
    text: 'Exports all library annotations for the active sample to a QuPath-compatible GeoJSON file.',
  },
  {
    selector: '[data-demo-id="flush-btn"]',
    title: '⬇  Send strokes to Python API',
    text: 'Transfers all annotations for all samples from the browser to the Python kernel. Click this before calling run_inference() in Jupyter calls for reading strokes from Python code.',
  },
  {
    selector: '[data-demo-id="toggle-annot-btn"]',
    title: '👀  Toggle annotation visibility',
    text: 'Hides or shows all drawn contours without deleting them. While hidden the drawing cursor is still visible and new strokes can be added. The overlay and tiles are unaffected.',
  },
  {
    selector: '[data-demo-id="align-btn"]',
    title: 'Align',
    text: 'Manually align a secondary image channel by picking two anchor points. Hold Option/Alt and click for automatic alignment (SIFT + phase correlation).',
  },
  {
    selector: '[data-demo-id="run-inference-btn"]',
    title: '▶  Run inference',
    text: 'Flushes current strokes, trains the classifier, runs inference on the active sample, and renders the probability heatmap. Only available when a run_inference function was passed to create_viewer().',
  },
  {
    selector: '[data-demo-id="search-btn"]',
    title: 'Search',
    text: 'Retrains the classifier and proposes an uncurated patch for you to review — an active-learning shortcut for finding informative regions to annotate next.',
  },
  {
    selector: '[data-demo-id="run-subtile-inference-btn"]',
    title: 'Run subtile',
    text: 'Trains the classifier and runs GPU-accelerated subtile inference on the active sample for finer-grained predictions. Only shown when CUDA is available and enabled in Settings.',
  },
  {
    selector: '[data-demo-id="mono-options-btn"]',
    title: '2D Options',
    text: 'Colourmap/palette display options for monochannel (2D) images.',
  },
  {
    selector: '[data-demo-id="sec-ch-btn"]',
    title: 'Secondary channel',
    text: 'Controls for the secondary image channel: opacity and enabling/disabling its tile fetching.',
  },
  {
    selector: '[data-demo-id="channel-panel"]',
    title: 'Channel compositing',
    text: 'For multichannel images: pick which channels to show and how to composite/color them.',
  },
  // Add Save and Load buttons demo here
  {
    selector: '[data-demo-id="save-btn"]',
    title: '💾  Save annotations',
    text: 'Saves all current annotations to a file. This allows you to preserve your work and reload it later.',
  },
  {
    selector: '[data-demo-id="load-btn"]',
    title: '📂  Load annotations',
    text: 'Loads annotations from a previously saved file. This allows you to continue working from where you left off.',
  },
  {
    selector: '#iv-alpha',
    title: 'Overlay opacity',
    text: 'Controls the transparency of the probability heatmap rendered after running the classifier. 0 = fully transparent, 1 = fully opaque.',
  },
  {
    selector: '#iv-low',
    title: 'Low-probability color',
    text: 'The heatmap color assigned to cells with classifier probability ≈ 0 (background / negative class).',
  },
  {
    selector: '#iv-high',
    title: 'High-probability color',
    text: 'The heatmap color assigned to cells with classifier probability ≈ 1 (target / positive class). Colors between Low and High are linearly interpolated.',
  },
  {
    selector: '#iv-contour-show',
    title: '👀  Preview probability contours',
    text: 'Extracts contours from the probability heatmap at the threshold/sigma/min-area set in Settings. Double-click a contour to highlight it (Delete removes just that one, Esc clears the highlight); with nothing highlighted, "Add" converts every previewed contour, otherwise just the highlighted one. If no contours are found, this button pulses red — try lowering probContourMinArea/Sigma in Settings.',
  },
  {
    selector: '#iv-contour-add',
    title: 'Add contours as annotations',
    text: 'Converts the currently previewed probability contours into real, editable library annotations (all of them, or only the one highlighted by double-click).',
  },
  {
    selector: '[data-demo-id="settings-btn"]',
    title: '⚙  Settings',
    text: 'Opens the viewer settings panel, toured next. Values persist to your browser and sync to a per-user file server-side, so they follow you between sessions.',
  },
  {
    selector: '[data-demo-id="settings-panel"]',
    title: 'Settings panel',
    activate: () => _openSettings(),
    text: 'Grouped into sections covering navigation, caching, overlays, and inference. Every control updates live; close with the ✕ or by clicking outside the panel.',
  },
  {
    selector: '[data-demo-id="settings-section-navigation"]',
    title: 'Settings: Navigation',
    activate: () => _openSettings(),
    text: 'Scroll/zoom speed, and the pyramid level-switch threshold that trades off sharper tiles against fewer network requests.',
  },
  {
    selector: '[data-demo-id="settings-section-tile-cache"]',
    title: 'Settings: Tile Cache',
    activate: () => _openSettings(),
    text: 'Max cached tiles, prefetch border around the viewport, render quality (pixelated vs. smooth), and JPEG tile compression quality.',
  },
  {
    selector: '[data-demo-id="settings-section-cell-overlay"]',
    title: 'Settings: Cell Overlay',
    activate: () => _openSettings(),
    text: 'Max cached cell tiles, and the cell-count threshold above which cells render as dots instead of full boundary polygons for performance.',
  },
  {
    selector: '[data-demo-id="settings-section-inference-loader"]',
    title: 'Settings: Inference Loader',
    activate: () => _openSettings(),
    text: 'Tunes the progress-bar animation speed (ms per cell) shown while inference is running, to match actual server wall-clock time.',
  },
  {
    selector: '[data-demo-id="settings-section-subtile-inference"]',
    title: 'Settings: Subtile Inference',
    activate: () => _openSettings(),
    text: 'Enables the "Run subtile" toolbar button for finer-grained GPU inference. Disabled automatically when the server has no CUDA device.',
  },
  {
    selector: '[data-demo-id="settings-section-probability-contours"]',
    title: 'Settings: Probability Contours',
    activate: () => _openSettings(),
    text: 'Probability threshold, Gaussian blur sigma, and minimum area used by the eye (preview) and Add contour buttons on the heatmap overlay.',
  },
  {
    selector: '[data-demo-id="settings-section-patch-overlay"]',
    title: 'Settings: Patch Overlay',
    activate: () => _openSettings(),
    text: 'Fill opacity for the Tiles overlay rectangles.',
  },
  {
    selector: '[data-demo-id="settings-section-annotation-contours"]',
    title: 'Settings: Annotation Contours',
    activate: () => _openSettings(),
    text: 'Auto-simplify newly drawn library annotations (and/or again at export time), with separate on-screen and image-space tolerance controls.',
  },
  {
    selector: '[data-demo-id="settings-reset-btn"]',
    title: 'Settings: Reset to defaults',
    activate: () => _openSettings(),
    text: 'Restores every setting above to its built-in default and clears your saved values.',
  },
  {
    selector: '[data-demo-id="fs-btn"]',
    title: '⛶  Fullscreen',
    activate: () => _closeSettings(),
    text: 'Expands the viewer to fill the entire browser viewport for a larger working area. Click again (or press Esc) to return to the notebook view.',
  },
  {
    selector: '#iv-status-coord',
    title: 'Status bar: coordinates',
    text: 'Live image-space x/y coordinates under the cursor, updated as you move over the slide.',
  },
  {
    selector: '#iv-status-net',
    title: 'Status bar: network gauges',
    text: '↑ shows pending tile requests in flight; ↓ shows data received over the last 60 seconds — a quick read on whether the viewer is waiting on the network.',
  },
  {
    selector: '#iv-status-perf',
    title: 'Status bar: performance',
    text: 'Rolling client-side performance stats (render/tile timings) for diagnosing slowness.',
  },
  {
    selector: '#iv-status-user',
    title: 'Status bar: current user',
    text: 'Shows who you’re logged in as. Annotations you create or edit this session are attributed to this user.',
  },
  {
    selector: '[data-demo-id="clear-all-btn"]',
    title: 'Clear all annotations',
    text: 'Removes all binary annotations across every sample in one go. A confirmation dialog is shown first. This action cannot be undone.',
  },
  {
    selector: '[data-demo-id="clear-sample-btn"]',
    title: 'Clear sample',
    text: 'Removes all binary annotations for the currently active sample only. A confirmation dialog is shown before deleting.',
  },
  {
    selector: '[data-demo-id="about-btn"]',
    title: 'About DIANNE',
    text: 'Shows version information, license, and copyright for the DIANNE viewer. You are here!',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
function createDemo() {
  let active      = false;
  let currentStep = 0;

  // ── spotlight ──────────────────────────────────────────────────────────────
  // A fixed-position box placed over the target element.
  // box-shadow with a huge spread creates the "dark overlay with a hole" effect.
  const spotlight = document.createElement('div');
  spotlight.style.cssText = [
    'position:fixed', 'z-index:2147483640', 'pointer-events:none',
    'border-radius:6px', 'transition:left 0.2s ease,top 0.2s ease,width 0.2s ease,height 0.2s ease',
    'box-shadow:0 0 0 9999px rgba(0,0,0,0.72)',
    'border:2px solid rgba(83,217,255,0.85)',
    'outline:2px solid rgba(83,217,255,0.35)',
    'outline-offset:2px',
  ].join(';');

  // ── description panel ──────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'z-index:2147483641',
    'min-width:280px', 'max-width:400px',
    'background:#1b1b1b', 'color:#eee',
    'border-radius:8px', 'border:1px solid #3a3a3a',
    'box-shadow:0 6px 24px rgba(0,0,0,0.75)',
    'padding:14px 16px',
    'font:13px/1.55 monospace',
    'transition:top 0.2s ease,left 0.2s ease',
  ].join(';');

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <span style="font-weight:700;color:#53d9ff;font-size:13px" data-demo-title></span>
      <span style="color:#666;font-size:11px" data-demo-counter></span>
    </div>
    <div style="margin-bottom:14px;white-space:normal;color:#ccc" data-demo-text></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button data-demo-stop
        style="padding:5px 10px;border-radius:6px;border:1px solid #555;
               background:#333;color:#bbb;cursor:pointer;font:12px monospace">
        Stop (Esc)
      </button>
      <button data-demo-next
        style="padding:5px 14px;border-radius:6px;border:none;
               background:#1f8cff;color:#fff;cursor:pointer;font:12px monospace">
        Next →
      </button>
    </div>
  `;

  const titleEl   = panel.querySelector('[data-demo-title]');
  const textEl    = panel.querySelector('[data-demo-text]');
  const counterEl = panel.querySelector('[data-demo-counter]');
  const nextBtn   = panel.querySelector('[data-demo-next]');
  const stopBtn   = panel.querySelector('[data-demo-stop]');

  nextBtn.addEventListener('click', advance);
  stopBtn.addEventListener('click', stop);

  // ── helpers ────────────────────────────────────────────────────────────────
  // Elements that exist in the DOM but are display:none (a conditional
  // toolbar button, a tab panel that hasn't been switched to yet, the
  // blinking active-user dot when no one else is active, …) report a
  // zero-size rect; treat those as "not there" instead of highlighting a
  // collapsed box in the top-left corner of the screen.
  function _resolve(selector) {
    try {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return null;
      return el;
    } catch (_) { return null; }
  }

  function _activate(step) {
    if (typeof step.activate === 'function') { try { step.activate(); } catch (_) {} }
  }

  // Find the first step index at or after `from` where the target exists in DOM.
  function _nextVisible(from) {
    for (let i = from; i < DEMO_STEPS.length; i++) {
      _activate(DEMO_STEPS[i]);
      if (_resolve(DEMO_STEPS[i].selector)) return i;
    }
    return -1; // none found → tour is done
  }

  function _positionPanel(targetRect) {
    const vw     = window.innerWidth;
    const vh     = window.innerHeight;
    const margin = 14;
    // Force layout so offsetWidth/Height are current
    panel.style.visibility = 'hidden';
    panel.style.left = '0px';
    panel.style.top  = '0px';
    document.body.appendChild(panel); // ensure in DOM for measurement
    const pw = panel.offsetWidth  || 320;
    const ph = panel.offsetHeight || 140;
    panel.style.visibility = '';

    // Prefer below; fall back above; then centre vertically
    let top;
    if (targetRect.bottom + ph + margin <= vh) {
      top = targetRect.bottom + margin;
    } else if (targetRect.top - ph - margin >= 0) {
      top = targetRect.top - ph - margin;
    } else {
      top = Math.max(8, Math.min(targetRect.top, vh - ph - 8));
    }

    // Centre horizontally over the element; clamp to viewport
    let left = targetRect.left + targetRect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, vw - pw - 8));

    panel.style.top  = top  + 'px';
    panel.style.left = left + 'px';
  }

  function _showStep(stepIndex) {
    const s  = DEMO_STEPS[stepIndex];
    _activate(s);
    const el = _resolve(s.selector);

    titleEl.textContent   = s.title;
    textEl.textContent    = s.text;
    counterEl.textContent = (stepIndex + 1) + ' / ' + DEMO_STEPS.length;
    nextBtn.textContent   = (stepIndex === DEMO_STEPS.length - 1) ? 'Finish ✓' : 'Next →';

    if (el) {
      // Target may sit inside a scrollable container (Settings panel,
      // annotation list, metadata table, …) and be currently scrolled out
      // of view — bring it into view before measuring so the spotlight
      // lands on something actually visible.
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = el.getBoundingClientRect();
      const pad  = 6;
      spotlight.style.display = 'block';
      spotlight.style.left    = (rect.left   - pad) + 'px';
      spotlight.style.top     = (rect.top    - pad) + 'px';
      spotlight.style.width   = (rect.width  + pad * 2) + 'px';
      spotlight.style.height  = (rect.height + pad * 2) + 'px';
      _positionPanel(rect);
    } else {
      // Element not in DOM — centre panel
      spotlight.style.display = 'none';
      panel.style.top         = '40%';
      panel.style.left        = '50%';
      panel.style.transform   = 'translate(-50%,-50%)';
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function advance() {
    if (!active) return;
    if (currentStep >= DEMO_STEPS.length - 1) { stop(); return; }
    const next = _nextVisible(currentStep + 1);
    if (next === -1) { stop(); return; }
    currentStep = next;
    _showStep(currentStep);
  }

  function start() {
    if (active) { stop(); return; }
    active = true;
    currentStep = _nextVisible(0);
    if (currentStep === -1) { active = false; return; }
    document.body.appendChild(spotlight);
    document.body.appendChild(panel);
    document.addEventListener('keydown', _onKey);
    _showStep(currentStep);
  }

  function stop() {
    if (!active) return;
    active = false;
    _unforceActiveUserDot();
    spotlight.remove();
    panel.remove();
    document.removeEventListener('keydown', _onKey);
  }

  function _onKey(e) {
    if (e.key === 'Escape' || e.key === 'Esc') { stop(); return; }
    if (e.key === 'Enter') { e.preventDefault(); advance(); }
  }

  return { start, stop };
}
