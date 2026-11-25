# /// script
# requires-python = ">=3.14"
# dependencies = [
#     "polars>=1.44.1",
#     "r4pm[polars]>=0.6.2",
# ]
# ///

import sys
from pathlib import Path

import polars as pl
from r4pm.df import import_ocel

EXPECTED_ORDERS = 2000


def main() -> None:
    files = sorted(Path("xml").glob("*.xml.gz"))
    if not files:
        print("No .xml.gz files under xml/", file=sys.stderr)
        sys.exit(2)

    fails = 0
    for log_path in files:
        log = import_ocel(log_path.as_posix())
        n_events = log["events"].height
        n_orders = log["objects"].filter(pl.col("ocel:type") == "orders").height

        if n_events == 0:
            print(f"{log_path.stem}... FAIL (empty: 0 events)")
            fails += 1
        elif n_orders != EXPECTED_ORDERS:
            print(f"{log_path.stem}... FAIL ({n_orders} orders, expected {EXPECTED_ORDERS})")
            fails += 1
        else:
            print(f"{log_path.stem}... ok")

    print(f"\n{len(files) - fails} / {len(files)} passed.")
    sys.exit(0 if fails == 0 else 1)


if __name__ == "__main__":
    main()
