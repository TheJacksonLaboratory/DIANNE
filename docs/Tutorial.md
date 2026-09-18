# DIANNE Viewer — Testing & Tutorial Guide

This guide walks a new user through the functional surface of the DIANNE viewer
(the Jupyter-embedded whole-slide image annotation, classifier-training and 
inference tool).
It is written for users with varying backgrounds — software developers
validating a release, pathologists reviewing annotation workflows, and
scientists using the tool for the first time — and can be followed top to
bottom as a self-guided tutorial or used as a manual regression checklist
before a release.

**Prerequisites:** a running DIANNE viewer instance (e.g. `create_viewer()`
called in a Jupyter notebook) with at least one sample loaded that has:
annotation drawing enabled, a `run_inference` enabled (STQ output provided), and — where
available — Xenium transcript/cell overlays and a multichannel (IF) image, so
that every section below can be exercised. Sections that depend on optional
data (Xenium, multichannel) are marked accordingly and may be skipped if the
active sample does not provide that modality.

Tip: the **▷ Demo** button in the footer launches an interactive, self-narrating
tour of every control referenced below — worth running once before manual
testing to get oriented.

---

## 1. Basic app navigation

1.1 **Orient to the layout.** Open the viewer and identify its four regions:
the main image canvas, the toolbar (left, grouped into rows of tools), the
sample panel (right, tabbed Samples / Metadata / Annotations), and the status
bar (bottom, coordinates / network / performance / current user).
*Expected:* all four regions render without console errors; the current
logged-in user is shown in the status bar.

1.2 **Run the guided tour.** Click **▷ Demo** in the footer and step through
it with **Next →**, confirming each spotlighted control matches its
description. Press **Esc** partway through to confirm the tour stops cleanly.

1.3 **Fullscreen mode.** Click the fullscreen (⛶) button. Confirm the viewer
expands to fill the browser viewport. Press **Esc** (or click again) to
return to the embedded notebook view.

1.4 **Status bar diagnostics.** Pan/zoom the image and confirm the coordinate
readout under the cursor updates live; watch the network gauges (↑ pending
requests, ↓ throughput) react while tiles load; hover the performance gauge
to see rolling render/tile timing stats.

1.5 **About dialog.** Click **ⓘ About** and confirm version, license, and
copyright information are shown, then close it via the **Close** button, a
click outside the dialog, and **Esc** — all three should dismiss it.

---

## 2. Interaction with whole slide image

2.1 **Pan and zoom.** With the default pan tool (✥) active, drag to pan and
scroll to zoom at several pyramid levels. Confirm tiles sharpen as you zoom in
and that double-clicking anywhere resets to the full-slide view.

2.2 **Scale bar accuracy.** Zoom to a few different levels and confirm the
scale bar's unit (µm/mm/cm) and length update to stay legible and
proportionate to the current zoom.

2.3 **Ruler measurement.** Select the ruler tool, click-drag across a
recognizable feature, and confirm a distance is reported in physical units.
Press **Esc** to remove the ruler.

2.4 **Tile cache behavior under load.** Rapidly pan across a large area of
the slide, then return to the starting view. Confirm previously visited tiles
reappear quickly (from cache) and that the network gauge shows no repeated
re-fetching of the same tiles within the cache limit set in Settings.

---

## 3. Metadata interaction

3.1 **Samples tab.** Open the Samples tab and click a sample thumbnail to
activate it. Click the already-active thumbnail again at a specific location
and confirm the main viewer pans to that location. Confirm the XE/HE badge
correctly reflects whether Xenium overlays are available for that sample.

3.2 **Metadata table — sort and filter.** Switch to the Metadata tab. Click a
column header to sort ascending/descending, then use the filter bar (numeric
range, categorical dropdown, or free text depending on column type) to narrow
the sample list. Confirm the Samples tab thumbnail list is filtered
correspondingly.

3.3 **Column value distribution.** Hover a metadata column header (other than
Sample) and confirm a pie chart of that column's value breakdown (counts and
percentages) appears.

3.4 **Row hover and navigation.** Hover a metadata row to preview its
thumbnail and full metadata; click the row and confirm the viewer jumps to
that sample.

---

## 4. Named annotations

4.1 **Draw a freehand annotation.** Select the `draw` (annot_draw) tool and
draw a closed freehand shape. Confirm it appears immediately in the
Annotations tab as an unclassified library annotation with a live area
readout.

4.2 **Draw a polygon annotation.** Select the polygon tool, click to place
several vertices around a feature, and press **Enter** to close it into a new
annotation.

4.3 **Classify and annotate.** In the Annotations tab, assign a class name to
the new annotation (typing a new one or picking an existing one), add a note,
and confirm the class color swatch is applied both in the list and on the
canvas shape.

4.4 **Vertex editing, split, erase, grow.** Select the annotation, then in
turn: drag/insert/delete a vertex (Vertex edit), draw a line across the shape
to split it into two annotations (Split), and use the disk brushes to trim
(Erase) and expand (Grow) the outline. Confirm each geometry edit is undoable
independently of the draw+/draw− stroke history via the annotation-edit undo
button.

4.5 **Lasso multi-select and bulk actions.** Use the lasso tool to select
several annotations at once, confirm they are checked in the Annotations tab,
then exercise a bulk action (e.g. Delete, or Copy-to-positive) across the
selection.

4.6 **Review status workflow.** Push an annotation's status through
draft → proposed → reviewed. Confirm that editing the geometry of a
`reviewed` annotation prompts a confirmation before unlocking it (reverting
its status to `edited`).

4.7 **Delete a multi-piece annotation.** Draw an annotation containing a hole
(ring + inner cut-out sharing one group), then delete it from the list.
Confirm both pieces are removed together, not just one.

4.8 **GeoJSON export.** Export annotations for the active sample via the
export button and confirm the downloaded file is valid GeoJSON, openable in
QuPath or any GeoJSON-aware tool.

4.9 **GeoJSON import.** Click **⤒ GeoJSON**, choose a valid Polygon/
MultiPolygon GeoJSON file (e.g. one previously exported, or one produced by
QuPath), and confirm every feature is added to the library as an annotation,
with multi-ring features (holes) imported as a single grouped annotation.
Confirm the class is taken from the feature's properties when present, and
falls back to `imported` when absent, keeping imported shapes visually and
searchably distinct from freehand-drawn ones. Then confirm the error paths:
selecting a non-JSON file reports that it is not valid JSON, and a
well-formed GeoJSON file with no Polygon/MultiPolygon features reports that
no importable features were found.

---

## 5. Binary annotations and classifiers

5.1 **Positive/negative stroke drawing.** Select draw+ (positive) and draw a
few strokes over a region of interest; switch to draw− (negative) and stroke
over background/excluded tissue. Confirm strokes remain locked to the image
when zooming.

5.2 **Brush mode and parameters.** Toggle between Line and Disk brush modes
and confirm the width/radius slider's range and effect change accordingly
(screen pixels for Line, image pixels for Disk). Adjust the smoothing slider
and confirm newly drawn strokes are visibly smoother/rougher.

5.3 **Independent undo histories.** Draw several positive strokes, then
several negative strokes, and confirm Undo only removes strokes for the
currently active draw mode (draw+ and draw− have separate histories).

5.4 **Save and load a classifier.** Train a classifier (see Section 7), then
use **💾 Save** to persist it under a name, and **📂 Load** to confirm it can
be retrieved by that name — including the "no saved classifiers" case when
none exist yet.

5.5 **Clear annotations.** Test **Clear sample** (removes binary strokes for
the active sample only) and **Clear all** (removes them across every
sample), confirming both require confirmation and that the action is
irreversible as stated.

---

## 6. Guided search

6.1 **Run a search cycle.** With at least a few positive/negative strokes
drawn, click **Search**. Confirm the classifier retrains and the viewer
navigates to an uncurated, informative patch for review.

6.2 **Iterate the active-learning loop.** On the proposed patch, attempt to
draw both a positive and a negative contour where applicable — i.e. if the
patch contains recognizable examples of both the target and the background
class — then run **Search** again, and confirm a different (not previously
shown) patch is proposed each time, demonstrating the active-learning
selection is making progress rather than repeating.

---

## 7. Heatmap inference and temporary contours

7.1 **Run inference.** Click **▶ Run inference** and confirm it 
trains a classifier, and renders a probability heatmap over the active
sample, with a progress indicator during training.

7.2 **Heatmap appearance controls.** Adjust overlay opacity, and the
low-/high-probability colors, confirming the heatmap recolors and fades live.

7.3 **Preview probability contours.** Enable the contour preview (👀) and
confirm contours are extracted at the current threshold/sigma/min-area
(Settings). If no contours are found at the current settings, confirm the
button pulses red as an affordance to loosen the threshold.

7.4 **Select and convert contours.** Double-click a previewed contour to
highlight it; confirm Delete removes only that one and Esc clears the
highlight. Click **Add** with nothing highlighted to confirm all previewed
contours convert to library annotations, then repeat with one highlighted to
confirm only that one converts.

7.5 **Run subtile inference (GPU only).** If CUDA is available and enabled in
Settings, click **Run subtile** and confirm finer-grained, tile-subdivided
predictions render. Confirm the button is hidden/disabled when no CUDA device
is present on the server.

---

## 8. Cell segmentations interaction

*(Requires a sample with Xenium cell-segmentation data.)*

8.1 **Enable the cell overlay.** Turn on cell segmentation display and
confirm cell boundary polygons (or dots, above the count threshold set in
Settings) render aligned to the underlying image.

8.2 **Category coloring.** Open the cell category panel, confirm categories
are listed with assigned colors, and toggle visibility of individual
categories, confirming only the matching cells appear/disappear.

8.3 **Hover and click inspection.** Hover a segmented cell and confirm a tooltip
surfaces its identifying attributes (e.g. cell ID, category). Click near center 
of any cell to have it highlighted.

8.4 **Rendering fallback at scale.** Zoom out until the cell count exceeds
the dot-rendering threshold configured in Settings, and confirm cells switch
from full boundary polygons to simplified dots without a perceptible frame
rate drop.

---

## 9. Xenium transcripts interactions

*(Requires a sample with Xenium transcript data.)*

9.1 **Enable the transcript overlay.** Turn on the transcript layer and
confirm per-gene colored points render, tiled and cached as you pan/zoom.

9.2 **Gene panel filtering.** Open the gene panel, search/filter for a
specific gene, and confirm only points for the selected gene(s) render on
the canvas. Confirm control/unassigned/deprecated/negative probe genes are
excluded by default.

9.3 **Hover inspection.** Hover a transcript point and confirm a tooltip
identifies the gene.

9.4 **Context switch.** Change the active sample and confirm the transcript
layer's cache is cleared and rebuilt for the new sample rather than showing
stale points from the previous one.

---

## 10. Visium spot overlay

*(Requires a sample with Visium spatial gene-expression data.)*

10.1 **Open the gene panel.** Click **Genes** in the toolbar and confirm a
searchable, single-selection gene list opens, populated from the genes
available for the active sample.

10.2 **Select a gene and render spots.** Search for and select a gene.
Confirm semi-transparent spots render at their spatial locations, colored on
a low→high gradient scaled to that gene's value range across the visible
spots.

10.3 **Opacity and color-scale controls.** Adjust the opacity slider and the
Low/High color pickers, confirming the spot overlay updates live without
re-fetching data.

10.4 **Gene switch and caching.** Select a second gene, then switch back to
the first, and confirm the second selection re-renders instantly (served from
cache) rather than re-fetching from the server.

10.5 **Pan/zoom alignment.** Pan and zoom the main image and confirm spots
stay registered to their correct image-space locations, with only the spots
inside (plus a small margin around) the current viewport being drawn.

10.6 **Context switch.** Switch to a different sample and confirm the gene
list and rendered spots update to that sample's data — or the overlay clears
if the new sample has no Visium data.

---

## 11. Multiplex IF channels adjustment

*(Requires a multichannel image sample.)*

10.1 **Channel panel basics.** Open channel compositing and confirm every
channel in the image is listed with a name and enable/disable checkbox.

10.2 **Per-channel color and range.** Assign a distinct color to two or more
channels, then adjust each channel's intensity range via its dual-range
slider, confirming the composite image updates live and the low/high handles
cannot cross.

10.3 **Composite correctness.** Enable three or more channels simultaneously
and confirm the resulting composite is the expected additive blend (spot-check
a known co-localization region if reference imagery is available).

10.4 **Secondary channel opacity.** If a secondary (e.g. IF-over-H&E) layer is
configured, adjust its opacity slider and toggle its tile fetching off, then
back on, confirming network requests for that layer stop and resume
accordingly.

10.5 **Manual/automatic alignment.** Use **Align** to place two anchor points
and confirm the secondary layer shifts to match; then Option/Alt-click the
same button and confirm automatic (SIFT + phase correlation) alignment
converges to a comparable result.

---

## 12. Settings adjustment

11.1 **Open and navigate.** Click the gear icon and confirm the panel opens
over the toolbar with sections for Navigation, Tile Cache, Cell Overlay,
Inference Loader, Subtile Inference, Probability Contours, Patch Overlay, and
Annotation Contours. Close it via the ✕ and by clicking outside the panel.

11.2 **Live effect of a setting.** Change scroll/zoom speed under Navigation
and confirm the pan tool's responsiveness changes immediately without a page
reload.

11.3 **Persistence across sessions.** Change a non-default value (e.g. tile
cache size), reload the notebook/page, and confirm the value persists (it is
saved to the browser and synced to a per-user server-side file).

11.4 **Reset to defaults.** Click **Reset to defaults** and confirm every
setting reverts to its built-in value and the saved values are cleared.

11.5 **Auto-simplify on draw/export.** Enable annotation auto-simplification
with a visible tolerance, draw a deliberately jagged shape, and confirm the
stored contour is smoother than the raw pointer path while remaining
recognizably the same shape.

---

## 13. Collaborative space for annotations sharing

12.1 **Active-user indicator.** With a second browser session (or a
teammate) open on the same sample, confirm the blinking green active-user dot
appears next to the tools, and that hovering it identifies the other user.
Confirm it disappears once that user switches away or their session goes
stale (idle beyond the lock's expiry window, 1 hour).

12.2 **Attribution on creation.** Draw a new annotation and confirm its
creator icon (purple) shows the current logged-in user and timestamp when
hovered.

12.3 **Attribution on edit.** Have a second user edit an annotation created
by the first, and confirm the last-editor icon (light blue) now shows the
second user, while the creator icon still shows the first.

12.4 **Concurrent-edit lock.** Have one user set an annotation's status to
`reviewed`. Confirm a second user attempting to edit its geometry is prompted
to confirm before it unlocks (and its status reverts to `edited`).

12.5 **Unsaved-changes indicator.** Make an unsaved annotation change on a
sample, switch to the Samples tab, and confirm an orange badge appears on
that sample's thumbnail; save, and confirm the badge clears.

---
