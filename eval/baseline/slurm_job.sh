#!/usr/bin/zsh

### Job Parameters
#SBATCH --job-name=diffrel-baseline
#SBATCH --time=1:00:00
#SBATCH --cpus-per-task=32
#SBATCH --partition=c23ms
#SBATCH --array=0-19
#SBATCH --output=results/slurm/%x-%a.txt

### Program Code
cd ~/diffrel/diffrel-ui/eval/baseline

LOGS_DIR="xml"
OUT_DIR="results"
DIFFREL_EXE="$HOME/diffrel/diffrel/target/release/diffrel-cli"
PERMUTATIONS=5000
ALPHA=0.05
SEED=42
FOLLOWS="directly"

# 1v2, 3v4, 5v6, ...
n1=$((2 * SLURM_ARRAY_TASK_ID + 1))
n2=$((2 * SLURM_ARRAY_TASK_ID + 2))

mkdir -p "$OUT_DIR"

log1="$LOGS_DIR/baseline_${n1}.xml.gz"
log2="$LOGS_DIR/baseline_${n2}.xml.gz"
out_file="$OUT_DIR/baseline_${n1}_vs_baseline_${n2}.diffrel.json"

"$DIFFREL_EXE" --permutations "$PERMUTATIONS" --alpha "$ALPHA" --seed "$SEED" --follows "$FOLLOWS" --format "json" \
    "$log1" "$log2" > "$out_file"
