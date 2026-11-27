#!/usr/bin/env bash
set -euo pipefail

cargo build --release --manifest-path ~/diffrel/diffrel/Cargo.toml

cd ~/diffrel/diffrel-ui/eval/mutations

for m in fast-payment out-of-stock-probability package-size-cap second-salesperson; do
    mkdir -p "$m/results/slurm"
    (cd "$m" && sbatch slurm_job.sh)
done
