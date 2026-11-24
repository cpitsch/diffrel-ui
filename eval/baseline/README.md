# Baseline Experiment
- This directory contains the files for the baseline experiment
- `order-management.cpn` is the CPNTools model with the files:
    - `event-handler.sml`
    - `log-initializer.sml`
    - `sim-utils.sml`
    - The only change to the [original CPN model](https://ocel-standard.org/event-logs/simulations/order-management/data/order-management-model.zip)
      is at the top of `sim-utils.sml`and serves to make the model random to create
      multiple different logs.
        - Sometimes, the logs were identical, so this was added to fix it
- `process.py` takes the generated csv files and creates corresponding `sqlite` 
  and `xml.gz` OCELs
    - The script can be run using `uv run process.py`
- `generate_baselines.ps1` is a simple helper script that runs `process.py` when
  you press any key. This is just to make the manual process of log generation more
  bearable :D
- `sanity-check.py` is a quick sanity check to ensure that only full logs have
  been exported and, e.g., that `process.py` wasnt executed too early or the CPNTools
  simulation failed
    - Can be run using uv: `uv run sanity-check.py` (and only checks the xml files)
- `slurm_job.sh` is a definition of a SLURM job, but can also be used to understand
  how to run this experiment
