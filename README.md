
# Interactive image annotator of spatial differential attributes

## Annotation with STQ and PCMA

Run positive, negative, or uncertain label annotation of image patches.

The function facilitates the annotation of image patches as positive, negative, or uncertain.
It initializes the random seed for reproducibility and sets the figure size for plots. The function 
creates several buttons for user interaction and a widget to display the output.

The nested showOne function displays an image patch and updates the classifier based on 
user desigantion annotations. It identifies curated positive, negative, 
and uncertain patches and calculates the uncurated patches. If the number of curated 
positive and negative patches meets the minimum requirement, the function trains a logistic 
regression classifier using the CDFs of the curated patches. If an augmentation 
function is provided, it augments the positive patches before training. The classifier 
predicts the labels of the uncurated patches and suggests a patch for curation based on the predictions.
If the randomness parameter is set, the function randomly selects a patch for curation if a chance
if above the set randomness threshold. The function displays the suggested patch for curation.


## Spatial SAMPLER inference

Use PCMA-trained classifier to run spatial inference of the learnt differential attributes.


## How to run the annotator

Clone this repository:

    workdir="/path/to/workdir/"
    cd $workdir

    git clone https://github.com/TheJacksonLaboratory/DIANNE.git

Get a copy of the container, ~2GB, and launch Jupyter server:
> Internally at JAX one can use this copy of the container: `/projects/chuang-lab/USERS/domans/containers/annotator_v1.0.0.sif`

    module load singularity
    singularity pull oras://quay.io/jaxcompsci/annotator:v1.0.0

    singularity exec annotator_v1.0.0.sif jupyter notebook --no-browser --port=$(shuf -i10000-11999 -n1) --ip=$(hostname -i) --notebook-dir "$workdir"

Copy the server URL and paste into a browser (e.g., Google Chrome, preferred)

Open a demo notebook at `./notebooks`
