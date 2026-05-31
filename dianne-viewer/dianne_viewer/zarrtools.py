"""
zarr_structure.py
-----------------
Read the complete structure of any zarr.zip (or zarr directory) and
optionally recreate it with custom data.

Compatible with zarr v2 (2.x) AND zarr v3 (3.x).

Public API
----------
    spec  = read_zarr_structure("cells.zarr.zip")
    print_zarr_structure(spec)                        # human-readable tree
    spec_to_json(spec, "cells_structure.json")        # save to JSON
    recreate_zarr_structure(spec, "new.zarr.zip")     # empty clone
    recreate_zarr_structure(spec, "new.zarr.zip",     # custom data
                            array_factory=my_fn)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import numpy as np
import zarr

# ── detect zarr major version once ───────────────────────────────────────────
_ZARR_V3 = int(zarr.__version__.split(".")[0]) >= 3


# ── store helpers ─────────────────────────────────────────────────────────────

def _open_store(path: str | Path, mode: str = "r"):
    p = Path(path)
    is_zip = p.suffix == ".zip" or p.suffixes[-2:] == [".zarr", ".zip"]

    if _ZARR_V3:
        if is_zip:
            return zarr.storage.ZipStore(str(p), mode=mode)
        else:
            return zarr.storage.LocalStore(str(p), mode=mode)
    else:
        # zarr v2
        if is_zip:
            return zarr.ZipStore(str(p), mode=mode)
        else:
            return zarr.DirectoryStore(str(p))


# ── zarr-version-agnostic accessors ──────────────────────────────────────────

def _zarr_format(obj) -> int:
    """Return the zarr format version (2 or 3) for a Group or Array."""
    # v3: obj.metadata.zarr_format
    if hasattr(obj, "metadata") and hasattr(obj.metadata, "zarr_format"):
        return int(obj.metadata.zarr_format)
    # v2 always 2
    return int(getattr(obj, "_version", 2))


def _group_name(group) -> str:
    """Return the path/name of a group, works for v2 and v3."""
    return getattr(group, "name", None) or getattr(group, "path", None) or "/"


def _iter_members(group):
    """
    Yield (name, item) for every direct child of a group.
    v3 uses group.members(); v2 uses group.items().
    """
    if _ZARR_V3:
        yield from group.members()
    else:
        yield from group.items()


def _set_attrs(node, attrs: dict):
    """Write attributes in a version-agnostic way."""
    if not attrs:
        return
    if _ZARR_V3 and hasattr(node, "update_attributes"):
        node.update_attributes(attrs)
    else:
        node.attrs.update(attrs)


# ── codec / compressor serialisation ─────────────────────────────────────────

# Blosc shuffle mode int → human-readable label
_BLOSC_SHUFFLE = {0: "NOSHUFFLE", 1: "SHUFFLE", 2: "BITSHUFFLE"}


def _codec_spec(codec) -> dict:
    """Turn any codec/compressor object into a plain serialisable dict."""
    name = type(codec).__name__
    cfg: dict = {}

    # numcodecs objects (zarr v2) expose get_config()
    if hasattr(codec, "get_config"):
        try:
            cfg = codec.get_config()
        except Exception:
            pass
    # zarr v3 codec dataclass objects use __dict__
    elif hasattr(codec, "__dict__"):
        cfg = vars(codec).copy()
        cfg = {k: (v.value if hasattr(v, "value") else v) for k, v in cfg.items()}

    # ── Blosc: expand every field with a human-readable description ──
    if name == "Blosc" and cfg:
        shuffle_int = int(cfg.get("shuffle", 1))
        cfg = {
            "id":            cfg.get("id", "blosc"),
            "cname":         cfg.get("cname", "lz4"),      # inner algorithm: lz4, zstd, blosclz, lz4hc, zlib
            "clevel":        int(cfg.get("clevel", 5)),    # compression level 0 (off) – 9 (max)
            "shuffle":       shuffle_int,                   # raw int kept for reconstruction
            "shuffle_label": _BLOSC_SHUFFLE.get(shuffle_int, str(shuffle_int)),  # NOSHUFFLE/SHUFFLE/BITSHUFFLE
            "blocksize":     int(cfg.get("blocksize", 0)), # bytes per block; 0 = auto
        }

    return {"codec_class": name, "config": cfg}


# ── per-node spec builders ────────────────────────────────────────────────────

def _array_spec(arr: zarr.Array) -> dict:
    """Capture every structural detail of a zarr array (v2 + v3)."""
    zfmt = _zarr_format(arr)

    chunks = list(arr.chunks)

    codecs: list[dict] = []
    compressor: dict | None = None
    filters: list[dict] | None = None
    separator: str = "/"
    order: str = "C"
    dimension_names: list | None = None

    if zfmt >= 3 and hasattr(arr, "metadata"):
        meta = arr.metadata
        codecs = [_codec_spec(c) for c in getattr(meta, "codecs", [])]
        dimension_names = (
            list(meta.dimension_names)
            if getattr(meta, "dimension_names", None)
            else None
        )
        cke = getattr(meta, "chunk_key_encoding", None)
        if cke is not None:
            separator = getattr(cke, "separator", "/")
        order = getattr(meta, "order", "C")
    else:
        # zarr v2 — read from arr.metadata (ArrayV2Metadata) to avoid deprecation warnings
        meta2 = getattr(arr, "metadata", arr)
        if getattr(meta2, "compressor", None) is not None:
            compressor = _codec_spec(meta2.compressor)
        if getattr(meta2, "filters", None):
            filters = [_codec_spec(f) for f in meta2.filters]
        order = getattr(meta2, "order", getattr(arr, "order", "C"))
        separator = getattr(meta2, "dimension_separator", ".")

    fv = arr.fill_value
    if hasattr(fv, "item"):
        fv = fv.item()

    return {
        "node_type": "array",
        "zarr_format": zfmt,
        "shape": list(arr.shape),
        "chunks": chunks,
        "dtype": str(arr.dtype),
        "fill_value": fv,
        "order": order,
        "dimension_names": dimension_names,
        "chunk_key_separator": separator,
        # v3
        "codecs": codecs,
        # v2
        "compressor": compressor,
        "filters": filters,
        # user metadata
        "attrs": dict(arr.attrs),
        # informational (not needed for recreation)
        "ndim": arr.ndim,
        "size": int(arr.size),
        "nbytes": int(arr.nbytes),
        "nchunks": int(arr.nchunks),
        "nchunks_initialized": int(arr.nchunks_initialized),
    }


def _walk_group(group: zarr.Group) -> dict:
    """Recursively collect the spec for a group and all its descendants."""
    node: dict[str, Any] = {
        "node_type": "group",
        "zarr_format": _zarr_format(group),
        "path": _group_name(group),
        "attrs": dict(group.attrs),
        "children": {},
    }

    for name, item in _iter_members(group):
        if isinstance(item, zarr.Array):
            child = _array_spec(item)
            child["path"] = f"{node['path'].rstrip('/')}/{name}"
        elif isinstance(item, zarr.Group):
            child = _walk_group(item)
        else:
            child = {"node_type": "unknown", "type_str": str(type(item))}

        node["children"][name] = child

    return node


# ── public: reader ────────────────────────────────────────────────────────────

def read_zarr_structure(path: str | Path) -> dict:
    """
    Iteratively walk every key and level of a zarr store and return a
    complete structural spec — shapes, dtypes, chunks, codecs/compressors,
    fill values, attributes, dimension names, … — with enough detail to
    recreate an identical layout with different data.

    Works with zarr v2 and v3, ZipStore or directory store.

    Parameters
    ----------
    path : str | Path
        .zarr.zip file or zarr directory.

    Returns
    -------
    dict
        store_type  – ZipStore | DirectoryStore | …
        zarr_format – 2 or 3
        root_attrs  – dict of root-level attributes
        tree        – recursive dict; groups have 'children', arrays have
                      shape/chunks/dtype/codecs/attrs/…
    """
    store = _open_store(path, mode="r")
    root = zarr.open_group(store, mode="r")

    spec = {
        "store_type": type(store).__name__,
        "zarr_format": _zarr_format(root),
        "root_attrs": dict(root.attrs),
        "tree": _walk_group(root),
    }

    store.close()
    return spec


# ── public: pretty printer ────────────────────────────────────────────────────

def _fmt_codec(c: dict) -> str:
    """Format a single codec dict into a compact human-readable string."""
    name = c["codec_class"]
    cfg  = c.get("config", {})
    if name == "Blosc":
        return (
            f"Blosc(cname={cfg.get('cname','?')}"
            f" clevel={cfg.get('clevel','?')}"
            f" shuffle={cfg.get('shuffle_label', cfg.get('shuffle','?'))})"
        )
    # generic: show non-trivial config keys
    detail = {k: v for k, v in cfg.items() if k not in ("id",) and v not in (None, "", 0, False)}
    if detail:
        kv = " ".join(f"{k}={v}" for k, v in detail.items())
        return f"{name}({kv})"
    return name


def print_zarr_structure(
    spec: dict,
    _node: dict | None = None,
    _indent: int = 0,
) -> None:
    """Print a human-readable tree of the zarr structure to stdout."""
    if _node is None:
        _node = spec["tree"]
        print(f"zarr v{spec['zarr_format']}  [{spec['store_type']}]")
        print(f"/  (root)  attrs={spec['root_attrs']}")

    pad = "  " * _indent
    for name, child in _node.get("children", {}).items():
        if child["node_type"] == "array":
            # collect all codecs (v3) or compressor+filters (v2)
            codec_list = [_fmt_codec(c) for c in child.get("codecs", [])]
            if not codec_list and child.get("compressor"):
                codec_list = [_fmt_codec(child["compressor"])]
            if child.get("filters"):
                codec_list += [_fmt_codec(f) for f in child["filters"]]
            codec_str = ", ".join(codec_list) if codec_list else "none"

            attrs_str = f"  attrs={child['attrs']}" if child.get("attrs") else ""
            print(
                f"{pad}├─ {name}  array"
                f"  shape={child['shape']}"
                f"  chunks={child['chunks']}"
                f"  dtype={child['dtype']}"
                f"  fill={child['fill_value']}"
                f"  [{codec_str}]"
                f"{attrs_str}"
            )
        elif child["node_type"] == "group":
            attrs_str = f"  attrs={child['attrs']}" if child.get("attrs") else ""
            print(f"{pad}├─ {name}/  group{attrs_str}")
            print_zarr_structure(spec, _node=child, _indent=_indent + 1)
        else:
            print(f"{pad}├─ {name}  (unknown node type)")


# ── public: JSON export ───────────────────────────────────────────────────────

def spec_to_json(spec: dict, path: str | Path | None = None) -> str:
    """
    Serialise the spec to a JSON string.
    Handles numpy scalars, arrays, and tuples automatically.
    Optionally writes to file if `path` is given.
    """
    def _default(obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, tuple):
            return list(obj)
        raise TypeError(f"Not JSON serialisable: {type(obj)!r}")

    text = json.dumps(spec, indent=2, default=_default)
    if path is not None:
        Path(path).write_text(text, encoding="utf-8")
    return text


# ── public: recreation ────────────────────────────────────────────────────────

def recreate_zarr_structure(
    spec: dict,
    output_path: str | Path,
    array_factory: Callable | None = None,
    overwrite: bool = True,
) -> zarr.Group:
    """
    Recreate an identical zarr hierarchy with custom data.

    Parameters
    ----------
    spec : dict
        Returned by `read_zarr_structure`.
    output_path : str | Path
        .zarr.zip or directory path for the new store.
    array_factory : callable or None
        ``fn(path, shape, dtype, chunks) -> np.ndarray``
        Defaults to np.zeros.
    overwrite : bool
        Overwrite an existing store.

    Returns
    -------
    zarr.Group  (root of the new store)
    """
    if array_factory is None:
        def array_factory(path, shape, dtype, chunks):
            return np.zeros(shape, dtype=dtype)

    store = _open_store(output_path, mode="w")
    root = zarr.open_group(store, mode="w")
    _set_attrs(root, spec.get("root_attrs", {}))

    def _build(group: zarr.Group, node: dict):
        _set_attrs(group, node.get("attrs", {}))
        for name, child in node.get("children", {}).items():

            if child["node_type"] == "array":
                shape  = tuple(child["shape"])
                chunks = tuple(child["chunks"])
                dtype  = np.dtype(child["dtype"])
                data   = array_factory(child.get("path", name), shape, dtype, chunks)

                if _ZARR_V3:
                    arr = group.create_array(
                        name=name,
                        shape=shape,
                        chunks=chunks,
                        dtype=dtype,
                        fill_value=child.get("fill_value", 0),
                        overwrite=overwrite,
                    )
                else:
                    import numcodecs
                    comp = None
                    if child.get("compressor"):
                        comp = numcodecs.get_codec(child["compressor"]["config"])
                    filts = None
                    if child.get("filters"):
                        filts = [numcodecs.get_codec(f["config"]) for f in child["filters"]]
                    arr = group.create_dataset(
                        name=name,
                        shape=shape,
                        chunks=chunks,
                        dtype=dtype,
                        compressor=comp,
                        filters=filts,
                        fill_value=child.get("fill_value", 0),
                        order=child.get("order", "C"),
                        overwrite=overwrite,
                    )

                arr[:] = data
                _set_attrs(arr, child.get("attrs", {}))

            elif child["node_type"] == "group":
                sub = group.require_group(name)
                _build(sub, child)

    _build(root, spec["tree"])
    store.close()
    return root


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else "cells.zarr.zip"
    print(f"\nReading: {path}\n")
    spec = read_zarr_structure(path)
    print_zarr_structure(spec)

    json_out = str(path).replace(".zip", "_structure.json")
    spec_to_json(spec, json_out)
    print(f"\nSpec saved → {json_out}")