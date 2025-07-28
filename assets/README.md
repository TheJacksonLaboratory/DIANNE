
# Singularity container preparation

The container is publicly available, and can be downloaded with command

    singularity pull oras://quay.io/jaxcompsci/annotator:v2.0.0

To modify or re-build the container (takes ~7 min):

    run-build.sh

To upload the container to quay.io

    singularity remote login -u <user> docker://quay.io

    singularity push annotator-base.sif oras://quay.io/jaxcompsci/annotator:v2.0.0
