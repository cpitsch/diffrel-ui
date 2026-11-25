# /// script
# requires-python = ">=3.14"
# dependencies = [
#     "pandas>=3.0.3",
#     "polars>=1.44.1",
#     "r4pm[polars]>=0.6.2",
# ]
# ///


import glob
import os
import sqlite3
from pathlib import Path

import pandas as pd
from r4pm.df import export_ocel, import_ocel

NAME = "baseline"


def build_sqlite(sql_path: str) -> None:
    """
    Processing adapted from the notebook provided on the ocel-standard site.
    """
    eventTypeTableFilenames = [
        fn
        for fn in glob.glob("event_*.csv")
        if not fn == "event_map_type.csv" and not fn == "event_object.csv"
    ]
    objectTypeTableFilenames = [
        fn
        for fn in glob.glob("object_*.csv")
        if not fn == "object_map_type.csv" and not fn == "object_object.csv"
    ]

    TABLES = dict()

    TABLES["event"] = pd.read_csv("event.csv", sep=";")
    TABLES["event_map_type"] = pd.read_csv("event_map_type.csv", sep=";")
    TABLES["event_object"] = pd.read_csv("event_object.csv", sep=";")
    TABLES["object"] = pd.read_csv("object.csv", sep=";")
    TABLES["object_object"] = pd.read_csv("object_object.csv", sep=";")
    TABLES["object_map_type"] = pd.read_csv("object_map_type.csv", sep=";")

    for fn in eventTypeTableFilenames:
        table_name = fn.split(".")[0]
        table = pd.read_csv(fn, sep=";")
        TABLES[table_name] = table

    for fn in objectTypeTableFilenames:
        table_name = fn.split(".")[0]
        table = pd.read_csv(fn, sep=";")
        TABLES[table_name] = table

    if os.path.exists(sql_path):
        os.remove(sql_path)

    conn = sqlite3.connect(sql_path)
    for tn, df in TABLES.items():
        df.to_sql(tn, conn, index=False)
    conn.close()


def sqlite_to_xmlgz(sql_path: str, xml_path: str) -> None:
    log = import_ocel(sql_path)
    export_ocel(log, xml_path)


def cleanup_csvs() -> None:
    for fn in glob.glob("event*.csv") + glob.glob("object*.csv"):
        os.remove(fn)


def next_index(sqlite_dir: Path, xml_dir: Path) -> int:
    i = 1
    while (sqlite_dir / f"{NAME}_{i}.sqlite").exists() or (
        xml_dir / f"{NAME}_{i}.xml.gz"
    ).exists():
        i += 1
    return i


def main():
    sqlite_dir = Path("sqlite")
    xml_dir = Path("xml")
    sqlite_dir.mkdir(exist_ok=True)
    xml_dir.mkdir(exist_ok=True)

    i = next_index(sqlite_dir, xml_dir)
    sql_path = str(sqlite_dir / f"{NAME}_{i}.sqlite")
    xml_path = str(xml_dir / f"{NAME}_{i}.xml.gz")

    build_sqlite(sql_path)
    sqlite_to_xmlgz(sql_path, xml_path)
    cleanup_csvs()
    print(f"[ok] {NAME}_{i}: {sql_path} + {xml_path}")


if __name__ == "__main__":
    main()
