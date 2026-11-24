# Bundestag Experiment
- `process.py` splits and filters the Bundestag log [from Zenodo](https://zenodo.org/records/16811928/files/Period20_procedure_steps_all_additional_event_types_filtered.json?download=1) as described in the paper, into:
    - `out/gesetzgebung_government.json`
    - `out/gesetzgebung_coalition.json`

## Comparison
- Comparison is done using the DiffRel UI and:
    - Log 1 = government ("out/gesetzgebung_government.json")
    - Log 2 = coalition ("out/gesetzgebung_coalition.json")
    - Seed 42
    - Default settings
        - All object types
        - 5000 permutations
        - Alpha 0.05
