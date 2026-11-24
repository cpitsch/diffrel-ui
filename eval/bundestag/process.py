# /// script
# requires-python = ">=3.14"
# dependencies = [
#     "polars>=1.44.1",
#     "r4pm[polars]>=0.6.2",
# ]
# ///

# Produces:
# - out/gesetzgebung_government_enriched2.json and
# - out/gesetzgebung_coalition_shortcut_enriched2.json.

from ast import literal_eval
from datetime import date, datetime
from pathlib import Path

import polars as pl
import r4pm

OCEL = dict[str, pl.DataFrame]

COALITION_BREAKUP_DATE_P20 = date(2024, 11, 6)
COALITION_BEFORE_BREAKUP_P20 = {"SPD", "BÜNDNIS 90/DIE GRÜNEN", "FDP"}
COALITION_AFTER_BREAKUP_P20 = {"SPD", "BÜNDNIS 90/DIE GRÜNEN"}
FILTERING_MIN_OCCURRENCES = 20

OUT_DIR = "out"
OUT_FILENAME_GOVERNMENT = "gesetzgebung_government.json"
OUT_FILENAME_COALITION = "gesetzgebung_coalition.json"


def filter_ocel_object_ids(ocel: OCEL, oids: list[str]) -> OCEL:
    """Helper function to keep only the objects in `oids`, and clean up related
    relationships and resulting orphans"""
    # Filter objects
    objects = ocel["objects"].filter(pl.col("ocel:oid").is_in(oids))

    # Filter O2O relationships
    o2o = ocel["o2o"].filter(
        (pl.col("ocel:oid").is_in(oids)) & (pl.col("ocel:oid_2").is_in(oids))
    )

    # Filter E2O relationships and Events
    relations = ocel["relations"].filter(pl.col("ocel:oid").is_in(oids))
    eids_to_keep = relations["ocel:eid"].unique().to_list()

    events = ocel["events"].filter(pl.col("ocel:eid").is_in(eids_to_keep))

    # Filter Object changes
    object_changes = ocel["object_changes"].filter(pl.col("ocel:oid").is_in(oids))

    return {
        "objects": objects,
        "o2o": o2o,
        "relations": relations,
        "events": events,
        "object_changes": object_changes,
    }


def filter_gesetzgebung_verkuendet(ocel: OCEL) -> OCEL:
    """Filter the ocel to only the `Verkündet` `Gesetzgebung` objects (declared laws)"""
    oids_to_keep = (
        ocel["objects"]
        .filter(
            (pl.col("ocel:type") == "Gesetzgebung")
            & (pl.col("beratungsstand") == "Verkündet")
        )["ocel:oid"]
        .unique()
        .to_list()
    )

    return filter_ocel_object_ids(ocel, oids_to_keep)


def _introduction_dates(ocel: OCEL):
    """Get a mapping of Gesetzgebung object id to the day it was introduced"""
    dates = (
        ocel["relations"]
        .group_by("ocel:oid")
        .agg(pl.col("ocel:timestamp").min().alias("IntroductionDate"))
    )
    return dict(zip(dates["ocel:oid"].to_list(), dates["IntroductionDate"].to_list()))


def _classify_initiative_period_20(initiative: list[str], introduction_date: datetime):
    """Classify an initiative as either proposed by the government, coalition, or neither
    (other). In period 20, this is more difficult since there way a coalition breakup."""

    if initiative == ["Bundesregierung"]:
        return "government"

    coalition = COALITION_BEFORE_BREAKUP_P20
    if introduction_date.date() >= COALITION_BREAKUP_DATE_P20:
        coalition = COALITION_AFTER_BREAKUP_P20

    parties: set[str] = set()
    for entry in initiative:
        entry = entry.strip()
        for prefix in ("Fraktion der ", "Fraktion von ", "Fraktion "):
            if entry.startswith(prefix):
                entry = entry[len(prefix) :]
                break
        parties.add(entry.strip().upper())

    if parties and parties.issubset({p.upper() for p in coalition}):
        return "coalition_shortcut"
    return "other"


def split_by_initiative_period_20(ocel: OCEL) -> tuple[OCEL, OCEL, pl.DataFrame]:
    """Split the OCEL in two halves, one containing the initiatives proposed by the government,
    and one containing those proposed by the coalition"""
    objs = ocel["objects"]
    introduced = _introduction_dates(ocel)

    oids = objs["ocel:oid"].to_list()
    initiatives = [literal_eval(v) for v in objs["initiative"].to_list()]

    groups = []
    for oid, init in zip(oids, initiatives):
        if oid not in introduced:
            raise ValueError(
                f"Gesetzgebung object with no events: {oid}. Cannot determine introduction date"
            )
        groups.append(_classify_initiative_period_20(init, introduced[oid]))

    class_df = pl.DataFrame({"ocel:oid": oids, "group": groups})

    gov_ids = class_df.filter(pl.col("group") == "government")["ocel:oid"].to_list()
    shortcut_ids = class_df.filter(pl.col("group") == "coalition_shortcut")[
        "ocel:oid"
    ].to_list()

    print(f"Proposed by government: {len(gov_ids)}")
    print(f"Proposed by coalition: {len(shortcut_ids)}")

    government_log = filter_ocel_object_ids(ocel, gov_ids)
    shortcut_log = filter_ocel_object_ids(ocel, shortcut_ids)

    return government_log, shortcut_log, class_df


def filter_activities(ocel: OCEL, activities: list[str]) -> OCEL:
    """Filter ocel to only retain specific event types"""
    events = ocel["events"].filter(pl.col("ocel:activity").is_in(activities))
    eids = events["ocel:eid"].to_list()
    relations = ocel["relations"].filter(pl.col("ocel:eid").is_in(eids))
    # TODO: Why dont i filter orphaned objects here? it just never happens?

    return {
        "objects": ocel["objects"],
        "o2o": ocel["o2o"],
        "object_changes": ocel["object_changes"],
        "events": events,
        "relations": relations,
    }


def _frequent_co_occurring_types(
    ocel: OCEL, all_seed_oids: list[str], seed_type: str, min_occurrences: int
) -> set[str]:
    """We focus on Gesetzgebung objects. Identify other object types that commonly co-occur
    with Gesetzgebung objects"""
    relations = ocel["relations"]
    seed_eids = set(
        relations.filter(pl.col("ocel:oid").is_in(all_seed_oids))["ocel:eid"].to_list()
    )
    other_side = relations.filter(pl.col("ocel:eid").is_in(seed_eids)).filter(
        ~pl.col("ocel:oid").is_in(all_seed_oids)
    )
    type_counts = other_side["ocel:type"].value_counts()
    keep_types = set(
        type_counts.filter(pl.col("count") >= min_occurrences)["ocel:type"].to_list()
    )
    keep_types.discard(seed_type)  # same-type exclusion, regardless of its count
    return keep_types


def extract_multitype_context_log(
    ocel: OCEL, seed_oids: list[str], keep_types: set[str]
) -> OCEL:
    """
    Filter the ocel to contain only the objects from `seed_oids` and those with an object
    type in `keep_types` which are directly related to an object from `seed_oids` (both
    having an E2O relationship with the same event)
    """
    relations = ocel["relations"]

    seed_eids = set(
        relations.filter(pl.col("ocel:oid").is_in(seed_oids))["ocel:eid"].to_list()
    )
    context_relations_raw = relations.filter(pl.col("ocel:eid").is_in(seed_eids))

    other_side = context_relations_raw.filter(
        ~pl.col("ocel:oid").is_in(seed_oids) & pl.col("ocel:type").is_in(keep_types)
    )
    final_oids = set(seed_oids) | set(other_side["ocel:oid"].unique().to_list())

    relations_final = context_relations_raw.filter(pl.col("ocel:oid").is_in(final_oids))
    final_eids = set(relations_final["ocel:eid"].unique().to_list())

    objects = ocel["objects"].filter(pl.col("ocel:oid").is_in(final_oids))
    events = ocel["events"].filter(pl.col("ocel:eid").is_in(final_eids))

    o2o = ocel["o2o"]
    if o2o is not None and o2o.height:
        o2o = o2o.filter(
            pl.col("ocel:oid").is_in(final_oids)
            & pl.col("ocel:oid_2").is_in(final_oids)
        )

    object_changes = ocel["object_changes"]
    if object_changes is not None and object_changes.height:
        object_changes = object_changes.filter(pl.col("ocel:oid").is_in(final_oids))

    return {
        "objects": objects,
        "events": events,
        "relations": relations_final,
        "o2o": o2o,
        "object_changes": object_changes,
    }


if __name__ == "__main__":
    if not Path(OUT_DIR).exists():
        Path(OUT_DIR).mkdir(parents=True)

    # Log from:
    # https://zenodo.org/records/16811928/files/Period20_procedure_steps_all_additional_event_types_filtered.json?download=1
    ocel = r4pm.df.import_ocel(
        "Period20_procedure_steps_all_additional_event_types_filtered.json"
    )

    filtered = filter_gesetzgebung_verkuendet(ocel)

    government, shortcut, class_df = split_by_initiative_period_20(filtered)

    gov_oids = government["objects"]["ocel:oid"].to_list()
    shortcut_oids = shortcut["objects"]["ocel:oid"].to_list()

    keep_types = _frequent_co_occurring_types(
        ocel,
        gov_oids + shortcut_oids,
        seed_type="Gesetzgebung",
        min_occurrences=FILTERING_MIN_OCCURRENCES,
    )
    print(f"Non-Gesetzgebung object types retained: {keep_types}")

    top_n_activities = (
        filtered["events"]["ocel:activity"]
        .value_counts()
        .sort(by="count", descending=True)
        .head(15)["ocel:activity"]
        .to_list()
    )

    r4pm.df.export_ocel(
        filter_activities(
            extract_multitype_context_log(ocel, gov_oids, keep_types), top_n_activities
        ),
        f"{OUT_DIR}/{OUT_FILENAME_GOVERNMENT}",
    )
    r4pm.df.export_ocel(
        filter_activities(
            extract_multitype_context_log(ocel, shortcut_oids, keep_types),
            top_n_activities,
        ),
        f"{OUT_DIR}/{OUT_FILENAME_COALITION}",
    )
