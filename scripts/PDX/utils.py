import os
import pandas as pd
import numpy as np
import zipfile
import xml.etree.ElementTree as ET
import s3fs
import boto3

ds = None
samples = None

def gurl(key, s3, bucket='my-store', ExpiresIn=3600):
    url = s3.generate_presigned_url('get_object', ExpiresIn=ExpiresIn,
                                    Params={'Bucket': bucket, 'Key': key.split(f'/{bucket}/')[1]})
    return url

fs = s3fs.S3FileSystem(
    key=os.environ['S3_ACCESS_KEY'],
    secret=os.environ['S3_SECRET_KEY'],
    endpoint_url=os.environ['S3_ENDPOINT'])

s3 = boto3.client('s3',
    endpoint_url=os.environ['S3_ENDPOINT'],
    aws_access_key_id=os.environ['S3_ACCESS_KEY'],
    aws_secret_access_key=os.environ['S3_SECRET_KEY'])

def load_pdx_metadata(ds, mpis, fs=None):
    def get_mpp(s):
        l = [v for v in s.split('|') if 'MPP' in v or 'mpp' in v]
        if len(l)>0:
            mpp = float(l[0].split(' = ')[1])
        else:
            mpp = np.nan
        return mpp

    if fs is None:
        se_mpp = pd.read_csv(mpis[ds][0], index_col=0)['image_descriptions'].apply(get_mpp)
    else:
        with fs.open(mpis[ds][0], 'r') as tempf:
            se_mpp = pd.read_csv(tempf, index_col=0)['image_descriptions'].apply(get_mpp)
    se_mpp.index = se_mpp.index.str[:-4]

    if fs is None:
        df = pd.read_excel(mpis[ds][1], sheet_name="Metadata", skiprows=1, header=[0, 1], index_col=0).dropna(axis=1, how="all")
    else:
        with fs.open(mpis[ds][1], 'rb') as tempf:
            # df = pd.read_excel(tempf, sheet_name="Metadata", skiprows=1, header=[0, 1], index_col=0).dropna(axis=1, how="all") # no engine avail
            df = read_xlsx_sheet(tempf, "Metadata").dropna(axis=1, how="all")

    df = df.droplevel(0, axis=1)
    df.index = df.index.str[:-4]
    df['MPP'] = se_mpp.reindex(df.index).fillna('NA')
    return df

bucket = 'dianne-store'
rpath = f'/{bucket}/results/PDX-histology-repository-metadata'
mpis = {'results.MDA.Dataset_breast_PT_PDX': [f'{rpath}/MDA.mda-breast-pt-pdx-svs-metadata.csv', f'{rpath}/MDA.Raso_Meric_Breast_Images_MDACC_standardized.xlsx'],
        'results.MDA.Dataset_PT_PDX_mouse_AMG': [f'{rpath}/MDA.mda_pt_pdx_mouse_amg-svs-metadata.csv', f'{rpath}/MDA.PDXimage032021_MDACClung2_BF_standardized V2.xlsx'],
        'results.MDA.Dataset_TC_PT_PDX': [f'{rpath}/MDA.mda_tc_pt_pdx-svs-metadata.csv', f'{rpath}/MDA.PDXNETimage_metadataMDACCbf_lung1_standardized.xlsx'],
        'results.BCM.Dataset_PDX_TIF': [f'{rpath}/BCM.bcm-pdx-tif-svs-metadata.csv', f'{rpath}/BCM.PDXNETimage_metadata_bcm_pdx_tif_standardized.xlsx'],
        'results.BCM.Dataset_PT_SVS': [f'{rpath}/BCM.bcm-pt-svs-svs-metadata.csv', f'{rpath}/BCM.PDXNETimage_metadata_bcm_pt_svs_standardized.xlsx'],
        'results.HCI.Dataset_PT_PDX': [f'{rpath}/HCI.hci-pt-pdx-svs-metadata.csv', f'{rpath}/HCI.PDXNETimage_metadata_HCI_20x_standardized.xlsx'],
        'results.JAX.Dataset_Quarantine': [f'{rpath}/JAX.jax-quarantine-svs-metadata.csv', f'{rpath}/JAX.PDXNETimage_metadata_jax_quarantine.xlsx'],
        'results.PDMR.Dataset_PDMR': [f'{rpath}/PDMR.pdmr-svs-metadata.csv',f'{rpath}/PDMR.PDXNETimage_metadata_pdmr_standardized.xlsx'],
        'results.PDMR.Dataset_WGD': [f'{rpath}/PDMR.pdmr-wgd-svs-metadata.csv', f'{rpath}/PDMR.PDXNETimage_metadata_pdmr_wgd_standardizedc.xlsx'],
        'results.PDMR.Dataset_XTLD': [f'{rpath}/PDMR.pdmr-xtld-svs-metadata.csv', f'{rpath}/PDMR.PDXNETimage_metadata_pdmr_xtld_standardized.xlsx'],
        'results.WISTAR.Dataset_PT_PDX': [f'{rpath}/WISTAR.wistar-pt-pdx-svs-metadata.csv', f'{rpath}/WISTAR.PDXNETimage_metadata_wistar_standardized.xlsx'],
        'results.WUSTL.Dataset_PDX': [f'{rpath}/WUSTL.wustl-svs-metadata.csv', f'{rpath}/WUSTL.PDXNETimage_metadata_wustl_all_standardized.RJM_220726.xlsx'],}

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def viewHistologyDataset(ds, bucket='dianne-store', func=None, height="800px"):
    dataPath = f'/results/{ds}/'
    samples = [d.split('/')[-1] for d in fs.ls(bucket + dataPath) if not 'pipeline' in d]
    imgs = {s: f'/{bucket}{dataPath}{s}/image.ome.tiff' for s in samples}
    imgs = {k:gurl(v, s3, bucket='dianne-store', ExpiresIn=3600) for k,v in imgs.items()}
    df_meta = load_pdx_metadata(ds, mpis, fs=fs)
    df_meta = df_meta.loc[[not v is None for v in df_meta.index]]
    metadata = df_meta.reindex(samples).fillna('NA').T.to_dict()
    drawings = func(samples, imgs, height=height, sample_metadata=metadata, fullscreen_on_load=False)[1]
    return drawings

def getDsSizes():
    dss = list(mpis.keys())
    bucket = 'dianne-store'
    ds_sizes = {}
    for ds in dss:
        dataPath = f'/results/{ds}/'
        samples = [d.split('/')[-1] for d in fs.ls(bucket + dataPath) if not 'pipeline' in d]
        ds_sizes[ds] = len(samples)
    return ds_sizes

def col_to_index(col_str):
    idx = 0
    for c in col_str:
        idx = idx * 26 + (ord(c) - ord('A') + 1)
    return idx - 1

def read_xlsx_sheet(fileobj, sheet_name):
    with zipfile.ZipFile(fileobj) as z:
        # map sheet name -> sheet file
        wb_xml = ET.fromstring(z.read('xl/workbook.xml'))
        rels_xml = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        rel_ns = {'r': 'http://schemas.openxmlformats.org/package/2006/relationships'}
        rid_to_target = {rel.get('Id'): rel.get('Target') for rel in rels_xml.findall('r:Relationship', rel_ns)}

        sheet_target = None
        for sheet in wb_xml.findall('.//m:sheet', NS):
            if sheet.get('name') == sheet_name:
                rid = sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
                sheet_target = rid_to_target[rid]
                break
        if sheet_target is None:
            raise ValueError(f"Sheet '{sheet_name}' not found")

        sheet_path = 'xl/' + sheet_target if not sheet_target.startswith('xl/') else sheet_target

        # shared strings (optional)
        shared_strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            ss_xml = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in ss_xml.findall('m:si', NS):
                text = ''.join(t.text or '' for t in si.findall('.//m:t', NS))
                shared_strings.append(text)

        sheet_xml = ET.fromstring(z.read(sheet_path))
        rows_data = {}
        max_col = 0
        for row in sheet_xml.findall('.//m:sheetData/m:row', NS):
            r = int(row.get('r'))
            row_cells = {}
            for c in row.findall('m:c', NS):
                ref = c.get('r')  # e.g. 'B3'
                col_letters = ''.join(ch for ch in ref if ch.isalpha())
                col_idx = col_to_index(col_letters)
                max_col = max(max_col, col_idx)
                cell_type = c.get('t')
                v = c.find('m:v', NS)
                is_ = c.find('m:is', NS)
                if v is not None:
                    val = v.text
                    if cell_type == 's':
                        val = shared_strings[int(val)]
                    else:
                        try:
                            val = float(val)
                            if val.is_integer():
                                val = int(val)
                        except ValueError:
                            pass
                elif is_ is not None:
                    val = ''.join(t.text or '' for t in is_.findall('.//m:t', NS))
                else:
                    val = None
                row_cells[col_idx] = val
            rows_data[r] = row_cells

        max_row = max(rows_data.keys())
        grid = []
        for r in range(1, max_row + 1):
            row_cells = rows_data.get(r, {})
            grid.append([row_cells.get(c) for c in range(max_col + 1)])
        df = pd.DataFrame(grid).set_index(0).iloc[1:]
        v = df.index[[0, 1]].values
        df = df.T.set_index(v.tolist()).T
        df.index.name = None
        return df

def viewSamples(samples=None, func=None):

    stqDataPath = '/spatial-pilot-stq'
    xeniumBundlesDir = '/spatial-pilot-xenium'
    XTRACT_DIR   = '/spatial-pilot-xtract'
    REGISTRY_CSV = f'{XTRACT_DIR}/reports/tissue_data_registry.csv'
    
    all_samples = [d.split('/')[-1] for d in fs.ls(bucket + stqDataPath) if not 'pipeline' in d]
    if not samples is None:
        samples = [s for s in samples if s in all_samples]
    else:
        sample = all_samples
    
    idm = '/opt/DIANNE/scripts/identity-matrix.csv'
    xenium_to_he_matrices = {sample: idm for sample in samples}
    
    species = {}
    mouse_cell_type = {}
    mouse_cell_type_broad = {}
    xenium_bundle_paths = {}
    for s in samples:
        xenium_bundle_paths.update({s: None})
        if '-CORE' in s:
            sid = s.split("-CORE")[0]
            xenium_bundle_paths.update({s: f'{xeniumBundlesDir}/{sid}/'})
    
            with fs.open(f'/{bucket}{xeniumBundlesDir}/{sid}/species.csv', 'r') as f:
                species.update({s: pd.Categorical(pd.read_csv(f, header=None)[0])})
            
            with fs.open(f'/{bucket}{xeniumBundlesDir}/{sid}/mouse_cell_type.csv', 'r') as f:
                mouse_cell_type.update({s: pd.Categorical(pd.read_csv(f, header=None)[0])})
                
            with fs.open(f'/{bucket}{xeniumBundlesDir}/{sid}/mouse_cell_type_broad.csv', 'r') as f:
                mouse_cell_type_broad.update({s: pd.Categorical(pd.read_csv(f, header=None)[0])})
    all_annotations = [species, mouse_cell_type, mouse_cell_type_broad]
    annotationsPalette = [{a: mcolors.to_hex(dianne.Set123(i)) for i, a in enumerate(labels[samples[0]].categories)} for labels in all_annotations]
    
    with fs.open(f'/{bucket}{REGISTRY_CSV}', 'r') as f:
        se_morph = XTRACT_DIR + '/' + pd.read_csv(f).set_index('sample_id')['Spatial Data Path'].str.replace('_sdata.zarr', '_xenium_explorer/morphology.ome.tif')
    
    secondary_images = {}
    for s in samples:
        if '-CORE' in s:
            found = se_morph[s.split('-CORE')[0]]
            if len(found)>1:
                found = found.iloc[0]
            secondary_images.update({s: found})
        else:
            secondary_images.update({s: f'{stqDataPath}/{s}/image.ome.tiff'})
    
    secondary_matrices = xenium_to_he_matrices.copy()
    secondary_images = {k:gurl(f'/{bucket}{v}', s3, bucket=bucket, ExpiresIn=3600) for k,v in secondary_images.items()}
    
    classifierPaths = 'classifiers/'
    dianne.setupClassifierPaths(classifierPaths)
    
    load_features = True
    
    if load_features:
        F = 1
        patch_size = 6 # number of tiles, in each dimension, to include in a patch (e.g. 8 means 8x8=64 tiles per patch)
        ts, mpp, tile_size = dianne.loadSTQParams(f'/{bucket}{stqDataPath}/{samples[0]}', F, fs=fs)
        fname = f'img.data.uni2-{F}.h5ad'
        ads, imgs, patchCoordinates, patchesCDFs, qs, ts, mpp, L, N = dianne_core.loadDataAndPreparePatches(samples, f'/{bucket}{stqDataPath}/', fname, L=None, ts=ts, mpp=mpp, N=patch_size, fs=fs)
        sizes = {s: ads[s].shape[0] for s in samples}
        print(f'Prepared {patchesCDFs.shape[0]} patches')
    
        runfn = dianne.makeRunFn(patchCoordinates, ads, samples, qs, ts, mpp, tile_size=tile_size, patch_size=patch_size, PCMA_alpha=0.8, alpha_img=0.5, multiplier=2)
        savefn = dianne.makeSaveFn(patchCoordinates, ads, samples, qs, ts, mpp, PCMA_alpha=0.8, tile_size=tile_size, patch_size=patch_size, body_overlap=0.25, classifierPaths=classifierPaths)
        loadfn = dianne.makeLoadFn(classifierPaths)
        listfn = dianne.makeListFn(classifierPaths)
    else:
        runfn, savefn, loadfn, listfn, sizes = None, None, None, None, None
        imgs = {s: f'/{bucket}{stqDataPath}/{s}/image.ome.tiff' for s in samples}
    
    imgs = {k:gurl(v, s3, bucket=bucket, ExpiresIn=3600) for k,v in imgs.items()}
    
    drawings = viewer.create_viewer(samples, secondary_images, height="800px", run_inference_fn=runfn, sample_sizes=sizes,
                                    xenium_mpp=0.2125, max_cells=20000, matrices=xenium_to_he_matrices, xenium_bundle_paths=xenium_bundle_paths,
                                    secondary_images=imgs, secondary_matrices=secondary_matrices, draw_on_secondary=True,
                                    annotations=all_annotations, category_colors=annotationsPalette,
                                    save_func=savefn, load_func=loadfn, list_names_func=listfn, s3=s3, s3_bucket=bucket)[1]
    return drawings
