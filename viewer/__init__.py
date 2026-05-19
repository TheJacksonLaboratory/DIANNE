from .viewer import create_viewer, set_overlay_points, clear_overlay_points
from .utils import viewSTQ

__all__ = ['create_viewer', 'set_overlay_points', 'clear_overlay_points', 'viewSTQ']


# def __getattr__(name):
# 	if name in {'getTilesInContour', 'preparePatchesFromStrokes', 'visualizePatches'}:
# 		from .utils import getTilesInContour, preparePatchesFromStrokes, visualizePatches

# 		exports = {
# 			'getTilesInContour': getTilesInContour,
# 			'preparePatchesFromStrokes': preparePatchesFromStrokes,
# 			'visualizePatches': visualizePatches,
# 		}
# 		return exports[name]
# 	raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
