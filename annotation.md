# DIANNE annotation tools — user reference

Quick reference for the histology annotation workflow in the DIANNE viewer:
drawing, editing, organizing, and exporting contour annotations on
whole-slide images.

## Two kinds of annotations

- **Library annotations** — named, freely-classified contours a pathologist
  draws and curates. Managed in the **Annotations** tab (left ribbon). Scoped
  to the active slide only.
- **Positive / negative** — two fixed, always-present classes consumed
  downstream by the notebook's Python kernel (e.g. for ML training data).
  Drawn with the original `draw+` / `draw-` toolbar tools, unchanged from
  before.

Each open slide has its own independent set of both.

## Left ribbon tabs

1. **Samples** — list of open slides. Each row shows a small badge when the
   slide has unsaved changes (dirty, ●) and the annotation count.
2. **Metadata table** — per-sample metadata, plus a read-only **Annotations**
   column summarizing library/positive/negative counts for each row.
3. **Annotations** — the library annotation list for the active slide:
   - Search by label/class/status; sort by label, class, date, or area.
   - Click a row → pans/zooms the viewer to that annotation and highlights
     it; clicking a contour on canvas selects the matching row (bidirectional).
   - Inline rename, class, and status editing; per-row delete (confirms first).
   - Checkbox multi-select → bulk delete or export selection.
   - Per-row visibility toggle (👁).
   - Running summary of counts and total area per class, plus positive/negative
     counts, shown at the top of the tab.
   - "Copy → pos" / "Copy → neg" buttons promote a library annotation into
     the positive/negative sets (see Promotion below).

## Drawing tools (toolbar)

Existing tools (unchanged):
- `✥` pan/zoom
- `draw+` / `draw-` — positive/negative line & disk (eraser) strokes

New tools, in their own toolbar row:
- `⬡` **Polygon** — click to place vertices; press `✓` (Finish) or `Enter`
  to close the loop; `Esc` cancels the in-progress polygon.
- `✏` **Freehand brush** — click-drag to sketch a closed contour freehand.
- `✥ (vertex edit)` **Vertex editing** — select an annotation, then drag its
  vertices directly on canvas to reshape it.
- `📏` **Ruler** — click once to set the start point, move the mouse to see
  a live rubber-band line, click again to finalize. Only one ruler
  measurement exists at a time — starting a new one replaces the old.
  `Esc` removes the active/most recent ruler line.
- `↩︎` / `↪︎` **Undo / redo** — covers geometry-mutating operations only
  (draw, boolean op, vertex edit, delete). Renames, class/status changes,
  and promotions are not undoable — they're explicit actions.
- `⤓ GeoJSON` — export annotations for the active slide to a
  QuPath-compatible GeoJSON file.

Boolean operations (union / subtract / intersect) work between contours and
across the rings of a single annotation (e.g. subtracting a hole), for both
library and positive/negative annotations alike.

## Holes in contours

An annotation can have holes: one outer ring plus zero or more inner rings
sharing the same `group_id`, following GeoJSON polygon-with-holes
conventions. Use a boolean **subtract** to carve a hole into an existing
contour (e.g. to exclude an artifact or necrotic region).

## Promotion workflow

- **Library → positive/negative**: "Copy → pos/neg" duplicates a library
  annotation as an independent snapshot. Editing one afterward never affects
  the other.
- **Positive/negative → library**: from the positive/negative view, save a
  contour back to the library as a new, independent entry. It's tagged with
  `derived_from` for provenance but behaves as an ordinary library annotation
  from then on.

Both directions are explicit, user-triggered actions — nothing is promoted
automatically.

## Review & lock workflow

Status progresses `draft` → `ready_for_review` → `reviewed`, with a 4th
status, `edited`, for audit purposes.

- Setting status to `ready_for_review` or `reviewed` locks the annotation's
  geometry (🔒 in the Annotations tab) — no further vertex edits, boolean
  ops, or erasing until reverted to `draft`. Attempting a locked edit shows
  a message in the status bar.
- Metadata (label, class, notes) stays editable even when locked. Editing
  it while locked automatically reverts status to `edited` and unlocks the
  geometry again.
- Applies uniformly to library, positive, and negative annotations.

## Save, autosave & dirty state

- Each slide tracks its own dirty state independently.
- Autosaves every 1 minute (per slide, if dirty), on manual save, and
  automatically when you switch away from a slide.
- This is separate from — and does not replace — the existing named
  "Save classifier" (💾) button, which continues to work as before for
  ML-facing snapshots.

## Logging

The transient status bar behaves exactly as before. Every message shown
there is also appended to a persistent history log, flushed to disk
roughly once a minute, so the session's full history survives a crash or
close.

## Minimap overlay

The existing thumbnail/minimap (used for quick navigation) now also shows
annotation positions for the active slide: small annotations as dots, large
ones as simplified outlines matching their shape. Hidden annotations don't
appear on the minimap either.

## Units

- If the slide has microns-per-pixel (mpp) metadata: area is shown in mm²,
  lengths in µm/mm.
- Otherwise: area in megapixels (px² / 1,000,000), lengths in pixels.

Applied consistently across the Annotations tab, tooltips, and the ruler.

## Export

Use the `⤓ GeoJSON` toolbar button to export QuPath-compatible GeoJSON for
the active slide, or use multi-select in the Annotations tab to export a
specific subset.

## Not included in this pass

- A global annotation library view spanning all open slides (the existing
  cross-slide positive/negative view is unaffected and unchanged).
- Pressure sensitivity for the freehand brush.
