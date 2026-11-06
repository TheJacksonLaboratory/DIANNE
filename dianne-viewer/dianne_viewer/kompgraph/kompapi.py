"""KOMP provenance helpers: project > datagroup > mouse > block > slide > sample chain/tree, as provgraph JSON.
`frame` = getKFrame(...) output (one row per sample, one column per level)."""
import pandas as pd

LEVELS = ['project', 'datagroup', 'mouse', 'block', 'slide', 'sample']
_KIND = {**{l: l for l in LEVELS}, 'thumb': 'thumb', 'slidepic': 'thumb'}  # level -> provgraph.js symbol key


def getKFrame(meta, slide_to_samples, project='KOMP'):
    """One row per sample, one column per level. Build once, reuse for every query."""
    df = meta.assign(project=project, datagroup=meta['dataset'], mouse=meta['organism_id'], slide=meta.index)
    df['sample'] = df['slide'].map(slide_to_samples)
    return df.explode('sample').dropna(subset=['sample'])[LEVELS]


def getKChain(sample, frame):
    """Root-to-sample chain as {child_node: parent_node}."""
    row = frame[frame['sample'] == sample]
    assert len(row) == 1, f'{sample} not found or not unique'
    nodes = list(zip(LEVELS, row.iloc[0]))
    return dict(zip(nodes, [None] + nodes[:-1]))


def getKTree(chain, frame, level='mouse'):
    """Chain plus everything below the chain's node at `level`."""
    val = next(v for t, v in chain if t == level)
    sub = frame[frame[level] == val]
    tree = dict(chain)
    for p, c in zip(LEVELS[LEVELS.index(level):], LEVELS[LEVELS.index(level) + 1:]):
        tree.update({(c, ch): (p, pa) for pa, ch in sub[[p, c]].drop_duplicates().itertuples(index=False)})
    return tree


_nid = lambda n: f'{n[0]}:{n[1]}'


def node(n, parent, sample_meta=None):
    """provgraph node. The metadata modal shows `sample_meta` (sample_metadata of the queried sample) as a card on the mouse node; other levels show level/id only."""
    mp = [['Mouse', str(k), str(v)] for k, v in (sample_meta or {}).items()] if n[0] == 'mouse' else []
    return dict(id=_nid(n), label=str(n[1]), kind=_KIND[n[0]], type=n[0], parents=[_nid(parent)] if parent else [], note='', dur=None, days=None,
                protocol='', desc='', contrib=[], files=[], mapped=mp, uuid='', sub='\n'.join(str((sample_meta or {}).get(k, '')) for k in ('gene', 'allele')) if n[0] == 'mouse' else n[0], abbr='', term=None, meta={'level': n[0], 'id': str(n[1])})


def graph(sample, frame, sample_metadata=None, level='mouse', thumbs=None, slidepics=None, rois=None, fulls=None):
    """Payload for the viewer: tree nodes + ids of the chain to highlight (bold). `thumbs(sample)` -> thumbnail URL or None; samples with a URL get a thumbnail node linked to them. `slidepics(sample)` likewise: one slide image per slide, from its first sample that has one.
    `fulls(sample)` -> True if the sample has an image.ome.tiff (enables the live Full view on its thumbnail).
    `rois(sample)` -> [[x, y], ...] contour (0-1 coords on the slide image) or None; contours of a slide's samples ride along on its image node."""
    chain = getKChain(sample, frame); tree = getKTree(chain, frame, level)
    sm = sample_metadata or {}; ex = [dict(node(('thumb', n[1]), n), thumb=u, sample=str(n[1]), full=bool(fulls and fulls(n[1]))) for n in tree if n[0] == 'sample' and thumbs and (u := thumbs(n[1]))]
    pics = {}
    for n, p in tree.items():
        if n[0] == 'sample' and p not in pics and slidepics and (u := slidepics(n[1])): pics[p] = u
    ex += [dict(node(('slidepic', p[1]), p), thumb=u, rois=[dict(name=str(c[1]), pts=r) for c, q in tree.items() if q == p and c[0] == 'sample' and rois and (r := rois(c[1]))]) for p, u in pics.items()]
    return dict(target=_nid(('sample', sample)), chain=[_nid(n) for n in chain], legend=LEVELS, credit=None, vertical=True, stack='sample',
                nodes=[node(n, p, sm.get(sample)) for n, p in tree.items()] + ex)
