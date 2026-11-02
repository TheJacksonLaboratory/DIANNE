import os
import pandas as pd
LEVELS = ['project', 'datagroup', 'mouse', 'block', 'slide', 'sample']

def getKFrame(meta, slide_to_samples, project='KOMP'):
    """One row per oid, one column per level. Build once, reuse for every query."""
    df = meta.assign(project=project, datagroup=meta['dataset'], mouse=meta['organism_id'], slide=meta.index)
    df['sample'] = df['slide'].map(slide_to_samples)
    return df.explode('sample').dropna(subset=['sample'])[LEVELS]

def getKChain(sample, frame):
    """Root-to-oid chain as {child_node: parent_node}."""
    row = frame[frame['sample'] == sample]
    assert len(row) == 1, f'{sample} not found or not unique'
    nodes = list(zip(LEVELS, row.iloc[0]))
    return dict(zip(nodes, [None] + nodes[:-1]))

def getKTree(chain, frame, level='mouse'):
    """Chain plus everything below the chain's node at `level` (e.g. 'datagroup', 'block')."""
    val = next(v for t, v in chain if t == level)
    sub = frame[frame[level] == val]
    tree = dict(chain)
    for p, c in zip(LEVELS[LEVELS.index(level):], LEVELS[LEVELS.index(level) + 1:]):
        tree.update({(c, ch): (p, pa) for pa, ch in sub[[p, c]].drop_duplicates().itertuples(index=False)})
    return tree

if __name__ == '__main__':

    projectDir = '/projects/activities/komp-histopath'
    dataPath = f'{projectDir}/results-STQ-KOMP-all/'
    all_samples = [s for s in os.listdir(dataPath) if not 'pipeline_info' in s]
    se = pd.Series(index=[s.split('.oid')[0] for s in all_samples], data=all_samples)
    slide_to_samples = se.groupby(level=0).agg(list).to_dict()
    all_slide_metadata = pd.read_csv(f'{projectDir}/USERS/domans/dev-komp/combined_cleaned_metadata.tsv', sep='\t', index_col=0).iloc[:]
    all_slide_metadata.index = all_slide_metadata.index.str.replace('.ndpi', '')
    all_slide_metadata['block'] = all_slide_metadata.index.copy()
    
    kompframe = getKFrame(all_slide_metadata, slide_to_samples)
    chain = getKChain('KOMP_C9066_5.oid2', kompframe)
    tree  = getKTree(chain, kompframe, level='mouse')
