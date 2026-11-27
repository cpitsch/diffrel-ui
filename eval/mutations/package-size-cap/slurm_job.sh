#!/usr/bin/zsh

### Job Parameters
#SBATCH --job-name=diffrel-package-size-cap
#SBATCH --time=1:00:00
#SBATCH --cpus-per-task=32
#SBATCH --partition=c23ms
#SBATCH --array=1-5
#SBATCH --output=stdout/%x-%a.txt

### Program Code
cd ~/diffrel/experiments/mutations/package-size-cap

LOGS_DIR="xml"
OUT_DIR="results"
DIFFREL_EXE="$HOME/diffrel/diffrel/target/release/diffrel-cli"
PERMUTATIONS=5000
ALPHA=0.05
SEED=42
FOLLOWS="directly"

mkdir -p "$OUT_DIR"

log1="$LOGS_DIR/baseline_${SLURM_ARRAY_TASK_ID}.xml.gz"
log2="$LOGS_DIR/package-size-cap_${SLURM_ARRAY_TASK_ID}.xml.gz"
out_file="$OUT_DIR/baseline_${SLURM_ARRAY_TASK_ID}_vs_package-size-cap_${SLURM_ARRAY_TASK_ID}.diffrel.json"

"$DIFFREL_EXE" --permutations "$PERMUTATIONS" --alpha "$ALPHA" --seed "$SEED" --follows "$FOLLOWS" --format "json" \
    "$log1" "$log2" > "$out_file" 2>&1
