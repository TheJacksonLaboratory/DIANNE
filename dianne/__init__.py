from .annotation import jumpStart, runAnnotation, inspectAnnotatedPatches, loadPatch
from .combineCDF import getDiscreteCombinedCDFofAllFeatures as PCMA
from .stqutils import loadAd, preparePatchesWSI, getPatchRepresentation, inferProb, showProbImg, trainClassifier
from .utils import findMyJupyterServer, setupClassifierPaths, loadDataAndPreparePatches, loadDataAndPreparePatchesStatic, setNotebookWidth
from .interpolation import interpolate_points as interpolatePoints
from .mask import makeProbMask, extractContoursForQuPath, viewContoursOnImage
from .download import downloadZIPFromZenodo
from .selection import runSelection, viewSelection
from .colors import Set123

__version__ = "0.1.0"
