"""RGB pyramids from DICOM-WSI (DICOMweb) and OME-Zarr v3 (OMERO / NGFF), served through PyramidImage.

Paths:  "DICOM:/{study_uid}/{series_uid}"   (server: env DIANNE_DICOMWEB_URL, default NCI IDC proxy)
        "ZARR:/https://host/x.zarr/0"      (URL or local path of one multiscale image group)
Optional deps (imported lazily): wsidicom + dicomweb-client (DICOM), tensorstore (ZARR).
"""
import json
import os
import warnings
import numpy as np
from .tiff import PyramidImage

DICOMWEB_URL = "https://proxy.imaging.datacommons.cancer.gov/current/viewer-only-no-downloads-see-tinyurl-dot-com-slash-3j3d9jyp/dicomWeb"

warnings.filterwarnings('ignore', message='No bulk data URI handler', category=UserWarning)  # harmless pydicom notice


def split_prefix(path):
    """Return ('ZARR'|'DICOM', rest) if *path* carries a source prefix, else (None, path)."""
    p = str(path)
    for pre in ('ZARR', 'DICOM'):
        if p[:len(pre) + 1].upper() == pre + ':':
            rest = p[len(pre) + 1:]
            if pre == 'ZARR' and rest.lstrip('/').lower().startswith(('http://', 'https://')):
                rest = rest.lstrip('/')   # "ZARR:/https://…" -> "https://…"; local paths keep their leading '/'
            return pre, rest
    return None, p


class _Level:
    """Lazy (H, W, 3) uint8 array: slicing triggers a region read via reader(y0, y1, x0, x1)."""
    dtype = np.dtype('uint8')
    ndim = 3

    def __init__(self, h, w, reader, tile):
        self.shape, self.chunks, self._read = (h, w, 3), (tile, tile, 3), reader

    def __getitem__(self, key):
        if not isinstance(key, tuple):
            key = (key,)
        key = (tuple(key) + (slice(None),) * 3)[:3]
        (y0, y1, _), (x0, x1, _) = (k.indices(n) for k, n in zip(key[:2], self.shape[:2]))
        return self._read(y0, y1, x0, x1)[:, :, key[2]]

    def __array__(self, dtype=None, copy=None):
        a = self[:]
        return a if dtype is None else a.astype(dtype)


class _LazyRGBImage(PyramidImage):
    def __init__(self, path, sizes, readers):
        z = {str(i): _Level(h, w, r, self.TILE) for i, ((w, h), r) in enumerate(zip(sizes, readers))}
        super().__init__(path, _zarr_store=z)


class DicomImage(_LazyRGBImage):
    def __init__(self, path):
        from wsidicom import WsiDicom, WsiDicomWebClient
        from dicomweb_client.api import DICOMwebClient
        parts = [s for s in str(path).strip('/').split('/') if s]
        if len(parts) != 2:
            raise ValueError(f"DICOM path must be 'DICOM:/<study_uid>/<series_uid>', got {path!r}")
        client = WsiDicomWebClient(DICOMwebClient(os.environ.get('DIANNE_DICOMWEB_URL', DICOMWEB_URL)))
        self.slide = WsiDicom.open_web(client, *parts)
        lvls = list(self.slide.levels)
        def mk(lvl):
            def read(y0, y1, x0, x1):
                if y1 <= y0 or x1 <= x0:
                    return np.zeros((max(y1 - y0, 0), max(x1 - x0, 0), 3), np.uint8)
                a = self.slide.read_region((x0, y0), lvl.level, (x1 - x0, y1 - y0))  # x, y in this level's pixels
                return np.asarray(a.convert('RGB'))
            return read
        super().__init__(f'DICOM:/{parts[0]}/{parts[1]}', [(l.size.width, l.size.height) for l in lvls], [mk(l) for l in lvls])


class OmeZarrImage(_LazyRGBImage):
    def __init__(self, path):
        import tensorstore as ts
        base = str(path).rstrip('/')
        kv = ({'driver': 'http', 'base_url': base} if base.lower().startswith(('http://', 'https://'))
              else {'driver': 'file', 'path': base + '/'})
        res = ts.KvStore.open({**kv, **({'base_url': base + '/'} if kv['driver'] == 'http' else {})}).result().read('zarr.json').result()
        if res.state != 'value':
            raise ValueError(f'{base}/zarr.json not found (only OME-Zarr v3 image groups are supported)')
        ms = json.loads(bytes(res.value))['attributes']['ome']['multiscales'][0]
        axes = [a['name'] for a in ms['axes']]
        if not {'c', 'y', 'x'} <= set(axes):
            raise ValueError(f'OME-Zarr axes {axes} lack c/y/x')
        arrs = [ts.open({'driver': 'zarr3', 'kvstore': {**kv, **({'base_url': f"{base}/{d['path']}"} if kv['driver'] == 'http'
                                                              else {'path': f"{base}/{d['path']}/"})}}).result() for d in ms['datasets']]
        ci, yi, xi = axes.index('c'), axes.index('y'), axes.index('x')
        if arrs[0].shape[ci] != 3 or arrs[0].dtype.numpy_dtype != np.uint8:
            raise ValueError(f'only 3-channel uint8 RGB OME-Zarr is supported (shape {arrs[0].shape}, dtype {arrs[0].dtype})')
        def mk(arr):
            def read(y0, y1, x0, x1):
                idx = [0] * len(axes)   # t, z (and anything else) fixed at 0
                idx[ci], idx[yi], idx[xi] = slice(0, 3), slice(y0, y1), slice(x0, x1)
                sub = arr[tuple(idx)].read().result()
                rest = [a for a in axes if a in ('c', 'y', 'x')]   # remaining axes keep file order
                return np.ascontiguousarray(np.transpose(sub, [rest.index('y'), rest.index('x'), rest.index('c')]))
            return read
        super().__init__('ZARR:' + base, [(a.shape[xi], a.shape[yi]) for a in arrs], [mk(a) for a in arrs])
