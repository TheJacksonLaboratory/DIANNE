#!/bin/bash
# launch-DIANNE.sh --time <N>h --gpu|--cpu
set -euo pipefail
SB=run-jupyter-notebook.sb
DEVICE=cpu TIME=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --time)  TIME="$2"; shift 2 ;;
        --time=*) TIME="${1#*=}"; shift ;;
        --gpu)   DEVICE=gpu; shift ;;
        --cpu)   DEVICE=cpu; shift ;;
        *) echo "Usage: $0 [--time Nh] [--gpu|--cpu]"; exit 1 ;;
    esac
done

if [[ "$DEVICE" == gpu ]]; then
    : "${TIME:=1h}"
    PART=gpu_a100 QOS=gpu_inference GRES=(--gres=gpu:1) NV=--nv
    CONTAINER=/projects/chuang-lab/USERS/domans/containers/mtimm-python.sif
else
    : "${TIME:=8h}"
    PART=compute QOS=batch GRES=() NV=
    CONTAINER=/projects/chuang-lab/USERS/domans/containers/scanpy-seurat-v3.sif
fi
[[ "$TIME" =~ ^[0-9]+$ ]] && TIME="${TIME}:00:00" || TIME="${TIME%h}:00:00"

echo "Launching $DEVICE notebook (time $TIME)..."
> err_jupyter.err 2>/dev/null || { touch err_jupyter.err; chmod 600 err_jupyter.err; }

JOBID=$(sbatch --parsable --time="$TIME" --partition="$PART" --qos="$QOS" "${GRES[@]+"${GRES[@]}"}" \
    --export="ALL,CONTAINER=$CONTAINER,NV_FLAG=$NV" "$SB")
echo "Submitted job $JOBID"

for i in $(seq 1 600); do
    state=$(squeue -j "$JOBID" -h -o "%T" 2>/dev/null) || true
    if [ -z "$state" ]; then
        final=$(sacct -j "$JOBID" -n -o State --parsable2 2>/dev/null | head -1) || true
        printf "\r\033[KJob %s left the queue (%s)\n" "$JOBID" "${final:-unknown}"
        exit 1
    fi
    printf "\r\033[K%2ds [job %s: %s] " "$i" "$JOBID" "$state"
    sleep 1
    url=$(grep http err_jupyter.err 2>/dev/null | grep -v ']' | grep -v 127 | tail -1) || true
    [ -n "$url" ] && { printf "\r\033[K%s\n" "$url"; exit 0; }
done
printf "\r\033[KServer could not start (job %s: %s)\n" "$JOBID" "$state"