
## Integration for model run from GUI

### Goal

Allow the JS viewer GUI to trigger training + inference directly, without manually running a notebook cell after flushing strokes.

### Best approach

Use the existing viewer HTTP server as the bridge:

1. JS sends a request to a fixed endpoint (for example: `POST /run_inference`).
2. Python server executes a pre-registered callback function.
3. Callback runs the existing pipeline (`getClassifierForFromStrokes`, `inferProb`, `interpolatePoints`).
4. Server returns overlay points (`xi`, `yi`, `pi`, style metadata).
5. JS applies overlay immediately via existing overlay API.

This keeps all heavy computation in Python while preserving the current frontend model.

### Why this is preferred

- Works with current architecture (viewer server + JS fetch).
- No unsafe arbitrary code execution from browser.
- Keeps data/model dependencies in Python notebook/runtime.
- Easy to add progress, locking, and errors in one place.

### Backward compatibility (required)

Keep the existing flush flow intact while introducing the new endpoint.

Current flow remains supported:

1. User draws annotations.
2. User clicks flush (`/strokes`).
3. User runs notebook cell manually.
4. User calls `set_overlay_points(...)`.

New flow is additive:

1. User draws annotations.
2. User clicks `Run` in toolbar (`/run_inference`).
3. Server reads same strokes data already used by flush.
4. Server returns overlay payload.
5. Viewer updates overlay.

### Proposed API shape

`create_viewer(..., run_inference_fn=None)`

- `run_inference_fn`: optional Python callable
- If `None`: behavior is unchanged (flush-only/manual notebook run)
- If provided: `/run_inference` is enabled and a toolbar `Run` action can call it

Callback contract suggestion:

```python
def run_inference_fn(*, strokes_by_sample, active_sample):
		# run training + inference
		# return dict with overlay payload
		return {
				"sample": active_sample,
				"xi": xi,
				"yi": yi,
				"pi": pi,
				"delta": 224,
				"alpha": 0.5,
				"color_low": "#FFA500",
				"color_high": "#0000FF",
		}
```

Endpoint response suggestion:

```json
{
	"ok": true,
	"sample": "JDC-WP-012-w-STQ",
	"overlay": {
		"xi": [..],
		"yi": [..],
		"pi": [..],
		"style": {
			"delta": 224,
			"alpha": 0.5,
			"colorLow": "#FFA500",
			"colorHigh": "#0000FF"
		}
	}
}
```

### Operational safeguards

- Add a per-viewer lock so only one run is active at a time.
- Return structured errors (`ok: false`, `error: "..."`) for UI display.
- Keep timeout configuration explicit for long runs.
- Keep `/strokes` endpoint unchanged for full compatibility.

### Implementation checklist

1. Python API
- Add optional `run_inference_fn=None` to `create_viewer(...)`.
- Store callback on server instance (for example: `server.run_inference_fn`).
- Do not change existing return values or flush endpoints.

2. Server endpoint
- Add `POST /run_inference` route.
- Request body should include at least `active_sample` (optional if server tracks it).
- Inside endpoint:
	- read `strokes_by_sample` from server state
	- call `run_inference_fn(strokes_by_sample=..., active_sample=...)`
	- validate returned payload schema
	- return `{ok:true, overlay:{...}}` or `{ok:false, error:"..."}`

3. Concurrency guard
- Add a boolean/lock (for example: `_run_inference_lock`) on server.
- If another run is active, return a non-fatal busy response.
- Ensure lock release in `finally` blocks.

4. Frontend toolbar
- Add `Run` button near flush controls.
- On click:
	- disable button
	- show running status in viewer status bar
	- call `/run_inference`
	- on success, call `window.setActiveSample(sample)` if needed
	- call `window.ivSetOverlayPoints(points, style)`
	- re-enable button

5. Overlay payload mapping
- Normalize callback output to one JS-ready shape:
	- either arrays (`xi`, `yi`, `pi`) or point list (`[{xi, yi, pi}, ...]`)
	- style keys in camelCase for JS (`colorLow`, `colorHigh`)

6. Error UX
- Surface Python exceptions as concise messages in status bar.
- Keep detailed tracebacks server-side only.
- Do not clear existing overlay on failed run.

7. Backward compatibility verification
- Confirm old flow still works unchanged:
	- draw -> flush -> notebook inference -> `set_overlay_points(...)`
- Confirm new flow works when `run_inference_fn` is provided.
- Confirm `Run` button is hidden/disabled when callback is not provided.

8. Minimal acceptance tests
- Single sample, no Xenium: run from GUI returns overlay.
- Multi-sample with mixed XE/HE: run on active sample updates correct sample.
- Busy-click behavior: second click while running handled gracefully.
- Exception in callback: user sees clean error, viewer remains interactive.

