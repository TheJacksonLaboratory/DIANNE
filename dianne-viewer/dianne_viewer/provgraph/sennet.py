"""SenNet provenance helpers: fetch entities from the public Entity API and build graph JSON."""
import json, re, textwrap, requests
from datetime import date, timedelta
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor

API = 'https://entity.api.sennetconsortium.org'
_cache = {}


def _get(path, token=None):
    r = requests.get(f'{API}/{path}', headers={'Authorization': f'Bearer {token}'} if token else {}, timeout=60)
    r.raise_for_status()
    return r.json()


def entity(sid, token=None):
    """Full entity record by SenNet id (cached)."""
    if sid not in _cache:
        _cache[sid] = _get(f'entities/{sid}', token)
    return _cache[sid]


def kind(e):
    """Node symbol key: source|organ|block|section|suspension|dataset|other."""
    t = e['entity_type']
    if t == 'Sample':
        c = (e.get('sample_category') or '').lower()
        return c if c in ('organ', 'block', 'section', 'suspension') else 'other'
    return {'Source': 'source', 'Dataset': 'dataset'}.get(t, 'other')


def parents(e):
    ps = e.get('direct_ancestors') or ([e['direct_ancestor']] if e.get('direct_ancestor') else [])
    return [p['sennet_id'] for p in ps]


def _flat(d, pre=''):
    """Flatten nested dicts/lists to {dotted.key: str} rows for the metadata table."""
    out = {}
    for k, v in d.items():
        k = f'{pre}{k}'
        if isinstance(v, dict): out.update(_flat(v, k + '.'))
        elif isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            for i, x in enumerate(v): out.update(_flat(x, f'{k}[{i}].'))
        elif v not in (None, '', [], {}): out[k] = json.dumps(v) if isinstance(v, (list, dict)) else str(v)
    return out


_SKIP = {'direct_ancestors', 'direct_ancestor', 'origin_samples', 'sources', 'source', 'ingest_metadata', 'status_history'}
_PRE = ('created', 'last_modified', 'source_mapped_metadata', 'protocol_url', 'uuid')  # shown elsewhere (tooltip / modal link / grouped table)


def _when(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(int(ms) / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M UTC') if ms else ''


def _audit(e):
    """Compact created / last-modified summary for the hover tooltip: [when, who, email]."""
    g = lambda t, u: [_when(e.get(f'{t}_timestamp')), e.get(f'{u}_user_displayname', ''), e.get(f'{u}_user_email', '')]
    return dict(created=g('created', 'created_by'), modified=g('last_modified', 'last_modified'))


def _mapped(m):
    """source_mapped_metadata -> [[group, key_display, value_display], ...] sorted by group."""
    return sorted([v.get('group_display', ''), v.get('key_display', k), v.get('value_display', '')] for k, v in (m or {}).items())


_CEDAR_DROP = {'Source ID', 'Sample ID', 'Metadata Schema ID', 'Contributors Path', 'Preparation Protocol DOI'}  # duplicate sennet_id / schema uuid / file path / protocol (header link)
# per entity kind: (default card, ((card, keywords in lower-cased label), ...)); cards are shown in this order
_CEDAR = {'section': ('Sample', (('Storage', ('storage',)), ('Preparation', ('preparation', 'processing', 'rehydrat')),
                                 ('Quality & notes', ('histolog', 'quality', 'notes')))),
          'source': ('Animal', (('Life events', ('date', 'death', 'deceased', 'euthan', 'lifespan', 'embryo')),   # non-human sources
                                ('Housing & diet', ('bedding', 'cage', 'rack', 'light', 'room', 'water', 'diet')))),
          'suspension': ('Suspension', (('Preparation', ('preparation', 'processing')), ('Storage', ('storage',)),
                                        ('Quality & notes', ('quality', 'notes')))),
          'block': ('Block', (('Preparation', ('preparation', 'processing')), ('Storage', ('storage',)),
                              ('Quality & notes', ('histolog', 'quality', 'notes')))),
          'dataset': ('Assay', (('Acquisition', ('acquisition', 'tile', 'tiled', 'scan')),
                                ('Preparation', ('preparation', 'stain', 'storage'))))}


def _cedar(m, k):
    """Flat cedar_mapped_metadata {label: value} -> [[card, label, value], ...]; cards by keyword, empty values hidden."""
    d, gs = _CEDAR[k]; order = [d] + [n for n, _ in gs]
    g = lambda l: next((n for n, ws in gs if any(w in l.lower() for w in ws)), d)
    def val(l, v):  # some submitters left Excel date serials (e.g. 45820) in date fields
        v = str(v).strip()
        return str(date(1899, 12, 30) + timedelta(int(v))) if l.lower().startswith('date') and re.fullmatch(r'\d{5}', v) else v
    return sorted(([g(l.strip()), l.strip(), val(l, v)] for l, v in (m or {}).items() if v not in (None, '', [], {}) and l not in _CEDAR_DROP),
                  key=lambda r: order.index(r[0]))


def _rui(r):
    """Blocks with a CCF 3D registration (rui_location, mostly human) -> rows for a '3D registration' card."""
    if not r: return []
    p = r.get('placement') or {}; n3 = lambda o, a: ', '.join(format(round(p.get(f'{x}_{a}', 0), 1), 'g') for x in 'xyz')
    d = ' × '.join(format(r[f'{x}_dimension'], 'g') for x in 'xyz' if f'{x}_dimension' in r)
    ann = ', '.join(a.rsplit('/', 1)[-1] for a in r.get('ccf_annotations') or [] if a != 'all')
    rows = [('Reference organ', ' '.join((p.get('target') or '').replace('#primary', '').split('/')[-2:])),
            (f"Position ({p.get('translation_units', 'mm')})", n3(p, 'translation') if p else ''),
            (f"Rotation ({p.get('rotation_units', 'deg')}, {p.get('rotation_order', '')})", n3(p, 'rotation') if p else ''),
            ('Scale', n3(p, 'scaling') if p else ''),
            (f"Size ({r.get('dimension_units', 'mm')})", d + (f" (slice {r['slice_thickness']:g})" if r.get('slice_thickness') else '')),
            ('Annotations', ann), ('Registered', ' · '.join(x for x in (r.get('creation_date'), r.get('creator')) if x))]
    return [['3D registration', k, v] for k, v in rows if v]


def _contrib(cs):
    """Dataset contributors -> [[name, affiliation, roles, email, orcid], ...]; roles from the is_* Yes/No flags."""
    role = lambda c: ', '.join('PI' if k == 'is_principal_investigator' else k[3:].replace('_', ' ').title()
                               for k, v in c.items() if k.startswith('is_') and str(v).lower() == 'yes')
    return [[c.get('display_name') or ' '.join(filter(None, (c.get('first_name'), c.get('last_name'))))] +
            [c.get('affiliation', ''), role(c), c.get('email', ''), c.get('orcid', '')] for c in cs or []]


# Dataset type (text before ' [' so derived e.g. 'Histology [Image Pyramid]' match too) -> short text drawn inside the node disk.
# Add new types here; unlisted types get no text.
DATASET_ABBR = {'Xenium': 'XE', 'Histology': 'HE', 'PhenoCycler': 'PC'}
_ASSETS = 'https://assets.api.sennetconsortium.org'


_UNITS = {'s': 1 / 86400, 'sec': 1 / 86400, 'second': 1 / 86400, 'min': 1 / 1440, 'minute': 1 / 1440, 'h': 1 / 24, 'hr': 1 / 24, 'hour': 1 / 24,
          'd': 1, 'day': 1, 'w': 7, 'wk': 7, 'week': 7, 'mo': 30.44, 'month': 30.44, 'y': 365.25, 'yr': 365.25, 'year': 365.25}


def _storage(e):
    """('16 day', 16.0) from cedar 'Source Storage Duration' (or '... Time'), else the raw value/unit metadata; (None, None) if absent."""
    c, m = e.get('cedar_mapped_metadata') or {}, e.get('metadata') or {}
    t = next((str(v) for k, v in c.items() if k.strip().lower() in ('source storage duration', 'source storage time') and v), '')
    if not t:
        for w in ('duration', 'time'):
            if m.get(f'source_storage_{w}_value'): t = f"{m[f'source_storage_{w}_value']} {m.get(f'source_storage_{w}_unit', '')}".strip(); break
    r = re.fullmatch(r'~?\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+?)s?', t.strip())
    return (t, float(r[1]) * _UNITS[r[2].lower()]) if r and r[2].lower() in _UNITS else (t or None, None)


def _size(n):
    for u in ('B', 'KB', 'MB', 'GB', 'TB'):
        if n < 1024 or u == 'TB': return f'{n:.0f} {u}' if u == 'B' else f'{n:.1f} {u}'
        n /= 1024


def _files(fs, uuid):
    """Dataset `files` -> [[card (top-level dir), path inside it, size, tooltip, download url], ...] sorted by path."""
    out = []
    for f in fs or []:
        top, _, rest = f.get('rel_path', '').partition('/')
        out.append([top if rest else 'Files', rest or top, _size(f.get('size') or 0), f"{f.get('rel_path', '')}\n{f.get('description', '')}".strip(),
                    f"{_ASSETS}/{uuid}/{quote(f['rel_path'])}" if uuid and f.get('rel_path') else ''])
    return sorted(out)


def _sub(e, mp):
    """Source caption under the id: '{source_type}, {description}'; falls back to Sex, Age from mapped metadata if no description."""
    d = e.get('description') or ', '.join(v for c in ('Sex', 'Age') for _, k, v in mp if k == c)
    return textwrap.fill(', '.join(x for x in (e.get('source_type'), d) if x), 30)


_OLS = 'https://www.ebi.ac.uk/ols4/api/ontologies/{}/terms?iri='
_terms = {}


def term(code):
    """Ontology term preview for e.g. 'UBERON:0001987' via EBI OLS4 (the OBO PURL redirects there): {id, url, label, definition, synonyms}."""
    m = re.fullmatch(r'([A-Za-z]+):(\d+)', code or '')
    if not m: return None
    if code not in _terms:
        iri = f'http://purl.obolibrary.org/obo/{m[1]}_{m[2]}'; t = {}
        try:
            r = requests.get(_OLS.format(m[1].lower()) + requests.utils.quote(iri, safe=''), timeout=30); r.raise_for_status()
            t = r.json()['_embedded']['terms'][0]
        except Exception: pass  # preview is optional: fall back to the link only
        _terms[code] = dict(id=code, url=iri, label=t.get('label', ''), definition='\n'.join(t.get('description') or []), synonyms=t.get('synonyms') or [])
    return _terms[code]


def _organ_sub(e):
    """Organ caption: '{organ_hierarchy},\\n({description})'."""
    h, d = e.get('organ_hierarchy', ''), e.get('description')
    return f'{h},\n({d})' if h and d else h or (f'({d})' if d else '')


def node(e):
    """Graph node: id, kind, parents, tooltip audit, protocol link, grouped `mapped` rows and flat `meta` table."""
    k = kind(e); mp = _mapped(e.get('source_mapped_metadata')) or (_cedar(e.get('cedar_mapped_metadata'), k) if k in _CEDAR else []); skip = _SKIP | ({'metadata'} if k == 'source' else set())  # source: mapped metadata replaces raw metadata
    mp = mp + (_rui(e.get('rui_location')) if k == 'block' else [])
    note = ' '.join(str((e.get('cedar_mapped_metadata') or {}).get('Notes') or '').split()) if k in ('section', 'suspension', 'block') else ''
    note = '' if note == e.get('description') else note[:16] + '…' if len(note) > 17 else note  # caption: <=17 chars; full note stays in the cards
    return dict(id=e['sennet_id'], kind=k, type=e['entity_type'], parents=parents(e), audit=_audit(e), note=note, dur=_storage(e)[0], days=_storage(e)[1],
                protocol=e.get('protocol_url') or (e.get('cedar_mapped_metadata') or {}).get('Preparation Protocol DOI', ''),
                desc=e.get('description') or '' if k == 'dataset' else '', contrib=_contrib(e.get('contributors')) if k == 'dataset' else [], files=_files(e.get('files'), e.get('uuid')) if k == 'dataset' else [], mapped=mp, uuid=e.get('uuid', ''), sub=_sub(e, mp) if k == 'source' else _organ_sub(e) if k == 'organ' else textwrap.fill(e.get('description') or '', 30) if k in ('section', 'suspension', 'block') else e.get('dataset_type') or '' if k == 'dataset' else '',
                abbr=DATASET_ABBR.get((e.get('dataset_type') or '').split(' [')[0], '') if k == 'dataset' else '',
                term=term(e.get('organ')) if k == 'organ' else None,
                meta=_flat({x: v for x, v in e.items() if x not in skip and not x.startswith(_PRE)}))


def _fetch(ids, token=None):
    with ThreadPoolExecutor(8) as ex:
        return list(ex.map(lambda i: entity(i, token), ids))


def chain(sid, token=None):
    """Provenance from dataset/entity `sid` up to its source: list of nodes."""
    ids = [sid] + [a['sennet_id'] for a in _get(f'ancestors/{sid}', token)]
    return [node(e) for e in _fetch(ids, token)]


def tree(sid, token=None):
    """Full tree: every entity descending from the source of `sid` (plus the source itself)."""
    src = next(n['id'] for n in chain(sid, token) if n['kind'] == 'source')
    ids = [src] + [d['sennet_id'] for d in _get(f'descendants/{src}', token)]
    return [node(e) for e in _fetch(ids, token)]


def ometiff_url(sid, token=None):
    """Download URL of the processed OME-TIFF of dataset `sid`, or None.
    Looks in the dataset's own files first (derived datasets), then in its descendant datasets (so a raw dataset id works too)."""
    def find(e):
        for f in sorted(e.get('files') or [], key=lambda f: f.get('rel_path', '')):
            if f.get('rel_path', '').lower().endswith(('.ome.tif', '.ome.tiff')): return f"{_ASSETS}/{e['uuid']}/{quote(f['rel_path'])}"
    u = find(entity(sid, token))
    if u: return u
    for d in _get(f'descendants/{sid}', token):
        if d.get('entity_type') == 'Dataset' and (u := find(entity(d['sennet_id'], token))): return u


def graph(sid, token=None):
    """Payload for the viewer: full tree nodes + ids of the chain to highlight."""
    c = chain(sid, token); t = tree(sid, token)
    return dict(target=sid, chain=[n['id'] for n in c], nodes=t)


def show(data, mode='tree', height=480):
    """Display the viewer in a notebook; mode='chain' shows only the provenance chain, 'tree' the full tree.
    The 'Scale to storage duration' checkbox in the widget lengthens each node's upstream link with its source storage duration (log scale, qualitative).
    height: graph area height in px."""
    import os, uuid
    from IPython.display import HTML, display
    d = os.path.dirname(os.path.abspath(__file__)); rd = lambda f: open(os.path.join(d, f)).read()
    i = 'pg' + uuid.uuid4().hex[:8]
    js = json.dumps(dict(data, mode=mode, height=int(height))).replace('</', '<\\/')  # keep metadata from closing the script tag
    display(HTML(f'<style>{rd("provgraph.css")}</style><div id="{i}"></div><script>{rd("provgraph.js")}\n'
                 f'provGraph(document.getElementById("{i}"), {js});</script>'))
