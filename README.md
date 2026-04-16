
# DIANNE: Segmentation-free localization of histology differential attributes

## About

DIANNE provides four complementary workflows for weakly-supervised training of spatial classifiers on histology and molecular imaging data. The histology interactive workflow enables real-time labeling and retraining on whole slide images (WSIs) via an active learning algorithm for rapid human-in-the-loop curation. The histology static workflow supports weakly supervised learning from image-level annotations (e.g. H&E, IHC, or mIF slides). The molecular interactive workflow allows real-time annotation with molecular data overlaid on histology patches, making it easy to incorporate both morphology and molecular markers into classifier training. Finally, the molecular static workflow extends this to spatial transcriptomics data (e.g. Visium, Xenium), linking molecular features such as genes, pathways, or cell types to histology image patches. Once trained, classifiers are deployed for spatial inference across whole slide images in under 30 seconds per slide.


## Input data requirements

All DIANNE workflows operate on standardized, processed WSIs. Raw slides are prepared through one of two preprocessing pipelines. In practice, users simply run STQ or MIE on their slides and point DIANNE to the output directory — no additional data preparation is required.

+ STQ https://github.com/TheJacksonLaboratory/STQ — normalizes H&E and IHC slides, generates tile grids, and extracts tile-level imaging features via histopathology foundation models (CTransPath, MoCoV3, UNI/UNI2, InceptionV3, or CONCH).
+ MIE https://github.com/TheJacksonLaboratory/spatial-omics-tools — extends STQ with support for mIF WSIs, extracting tile-level imaging features via the KRONOS spatial proteomics foundation model.


## Graphical user interface (GUI)

<div style="text-align: center; width: 800px; margin: 0 auto;">
  <img src="docs/Guided-GUI.jpeg" width="800"/>
  <p style="text-align: left;"><em><b>Figure 1. Guided labelling GUI.</b> Patches proposed by the algorithm are presented to the user one at a time, and labelled as positive or negative using the corresponding buttons. Patches are drawn from all loaded whole slide images simultaneously and pooled for model training.</em></p>
</div>

<br>

<div style="text-align: center; width: 800px; margin: 0 auto;">
  <img src="docs/Freehand-GUI.jpeg" width="800"/>
  <p style="text-align: left;"><em><b>Figure 2. Freehand labelling GUI.</b> The user navigates a single whole slide image by clicking on the thumbnail on the left and then by zooming and panning the user draws positive or negative contours to label regions of interest based on their own visual judgment. Annotations from all slides are accumulated and pooled for model training.</em></p>
</div>


## Running DIANNE workflows

**Clone DIANNE repository**

    workdir="/path/to/workdir/"
    cd $workdir

    git clone https://github.com/TheJacksonLaboratory/DIANNE.git

**Set up Python and Jupyter environment**

<details open><summary>Option A (click to expand). Use local environment. Create conda environment, and install packages into it, launch Jupyter server</summary><p>

```bash
conda create --name dianne python=3.10 -y
conda activate dianne
conda install -y -c conda-forge jupyter ipywidgets ipykernel "notebook>=7" numpy numba pandas pyarrow scanpy scipy scikit-image scikit-learn matplotlib tifffile imagecodecs tqdm opencv zarr fsspec

jupyter notebook
```

</p></details>
<br>

<details closed><summary>Option B (click to expand). Allocate an HPC node. Use an existing copy of the singularity container. If not available, pull from quay.io, launch Jupyter server</summary><p>

```bash
module load singularity
container="/projects/chuang-lab/USERS/domans/containers/annotator_v2.0.0.sif"

if [ ! -f "$container" ]; then
    echo "Container not found, pulling from registry..."
    singularity pull oras://quay.io/jaxcompsci/annotator:v2.0.0 &&\
    container="annotator_v2.0.0.sif"
fi

singularity exec "$container" jupyter notebook --no-browser --port=$(shuf -i10000-11999 -n1) --ip=$(hostname -i) --notebook-dir "$workdir"
```

</p></details>
<br>

<details closed><summary>Option C (click to expand). Launch Jupyter server via script below</summary><p>

```bash
cd scripts/
launch-jupyter.sh
```

</p></details>
<br>

**Navigate to Jupyter**

Copy the Jupyter server URL and paste into a browser (e.g., Google Chrome, preferred) and navigate to a demo notebook at `./scripts` directory.
