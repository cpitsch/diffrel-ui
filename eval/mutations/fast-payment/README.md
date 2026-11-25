# Fast Payment Experiment
- This directory contains the files for the $L_{FP}$ experiment
- `order-management.cpn` is the CPNTools model with the files:
    - `event-handler.sml`
    - `log-initializer.sml`
    - `sim-utils.sml`
- `process.py` takes the generated csv files and creates corresponding `sqlite` 
  and `xml.gz` OCELs
    - The script can be run using `uv run process.py`
- `slurm_job.sh` is a definition of a SLURM job, but can also be used to understand
  how to run this experiment
