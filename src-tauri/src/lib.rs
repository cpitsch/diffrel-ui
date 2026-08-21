#![warn(
    clippy::redundant_clone,
    // clippy::doc_markdown,
    clippy::perf,
    missing_debug_implementations,
    rust_2018_idioms
)]

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::{Arc, Mutex},
};

use diffrel::{
    distances::squared_bray_curtis_distance,
    effect_size::cliffs_delta,
    multiple_testing::check_significance_holm_bonferroni,
    permanova::{
        base::{encode_relation_counts, permanova},
        drilldown::drilldown,
        fast_euclidean::permanova as permanova_fast,
    },
    relation_extraction::{
        extract_e2e_relation_counts, extract_e2o_relation_counts, extract_o2e_relation_counts,
        extract_o2o_relation_counts, E2ERelationType, OcelRelationshipCounter, Qualifier,
        RelationshipCount,
    },
};

use process_mining::{
    core::event_data::object_centric::linked_ocel::{LinkedOCELAccess, SlimLinkedOCEL},
    core::process_models::object_centric::ocdfg::OCDirectlyFollowsGraph,
    Importable,
};
use serde::{Deserialize, Serialize};

use crate::helpers::{mean, median, std_dev};

mod helpers;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
enum RelationMode {
    /// Event to Object
    E2O,
    /// Object to Object
    O2O,
    /// Object to Event (reverse E2O relationships)
    O2E,
    /// Event to Event (eventually follows relations)
    E2E,
}

#[derive(Deserialize, Clone, Copy)]
enum DistanceMode {
    Euclidean,
    BrayCurtis,
}

/// Whether an E2E relationship pairs an event with only its immediately next shared-object event
/// (directly-follows) or with every later one (eventually-follows, the long-standing default).
/// Mirrors `diffrel::relation_extraction::E2ERelationType` — kept as its own type since that one
/// doesn't derive `Deserialize` and per-crate convention `diffrel` itself isn't edited here.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
enum FollowsMode {
    DirectlyFollows,
    EventuallyFollows,
}

impl From<FollowsMode> for E2ERelationType {
    fn from(mode: FollowsMode) -> Self {
        match mode {
            FollowsMode::DirectlyFollows => E2ERelationType::DirectlyFollows,
            FollowsMode::EventuallyFollows => E2ERelationType::EventuallyFollows,
        }
    }
}

/// Whether a shared event pair mediated by several object types produces one relation entry per
/// object type (`Single`) or one combined entry per event pair (`Grouped`, the long-standing
/// default — added purely to cut down arc count, at the cost of the overlay only being able to
/// color such an arc by one of its constituent object types). Mirrors
/// `diffrel::relation_extraction::extract_e2e_relation_counts`'s `merge_object_types: bool` — kept
/// as its own type for the same reason `FollowsMode` is: needs `Deserialize`, and `diffrel` itself
/// isn't edited here. Distinct from the unrelated `QualifierMode` below, which controls DF
/// backbone (skeleton) arcs, not E2E relations.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
enum E2EQualifierMode {
    Single,
    Grouped,
}

impl From<E2EQualifierMode> for bool {
    fn from(mode: E2EQualifierMode) -> Self {
        matches!(mode, E2EQualifierMode::Grouped)
    }
}

impl RelationMode {
    pub fn extract_counts<'a>(
        self,
        locel: &'a SlimLinkedOCEL,
        allowed_object_types: Option<&HashSet<&str>>,
        follows_mode: FollowsMode,
        qualifier_mode: E2EQualifierMode,
    ) -> OcelRelationshipCounter<'a> {
        match self {
            RelationMode::E2O => extract_e2o_relation_counts(locel),
            RelationMode::O2O => extract_o2o_relation_counts(locel),
            RelationMode::O2E => extract_o2e_relation_counts(locel),
            RelationMode::E2E => extract_e2e_relation_counts(
                locel,
                allowed_object_types,
                Some(follows_mode.into()),
                qualifier_mode.into(),
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            RelationMode::E2O => "E2O",
            RelationMode::O2O => "O2O",
            RelationMode::O2E => "O2E",
            RelationMode::E2E => "E2E",
        }
    }
}

/// Summary returned after loading an OCEL file. Used to display an overview in
/// the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogSummary {
    /// The number of events in this log.
    event_count: usize,
    /// The number of distinct event types in this log.
    event_type_count: usize,
    /// All event type names present in this log.
    event_types: Vec<String>,
    /// Number of distinct object types in this log.
    object_type_count: usize,
    /// All object type names present in this log.
    object_types: Vec<String>,
}

/// Per-log descriptive statistics for a specific (qualifier, object_type) relationship.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectTypeRelation {
    qualifier: String,
    object_type: String,
    median_log1: f64,
    median_log2: f64,
    mean_log1: f64,
    mean_log2: f64,
    std_log1: f64,
    std_log2: f64,
}

/// PERMANOVA result for one block (group key + mode) present in both logs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventTypeResult {
    /// Holm-Bonferroni corrected p-value.
    p_value: f64,
    /// Whether the result is statistically significant at the given alpha level.
    is_significant: bool,
    /// PERMANOVA pseudo-F statistic.
    pseudo_f: f64,
    /// Number of observations in log 1.
    n1: usize,
    /// Number of observations in log 2.
    n2: usize,
    /// One entry per distinct (qualifier, object_type) pair across both logs.
    object_type_relations: Vec<ObjectTypeRelation>,
    /// The relation mode for this block (e.g. "E2O").
    mode: String,
    /// The group key for this block (event type or object type name).
    group_key: String,
}

/// Westfall-Young drilldown result for one (qualifier, object_type) relation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DrilldownRelationResult {
    qualifier: String,
    object_type: String,
    p_value: f64,
    is_significant: bool,
    pseudo_f: f64,
    /// Cliff's delta effect size (-1..=1) between the two logs' per-event counts for this
    /// relation, independent of statistical significance (which is sensitive to sample size,
    /// not magnitude) — lets the frontend filter out negligible-but-significant differences.
    effect_size: f64,
}

/// Output of drilling down into a significant group key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DrilldownOutput {
    results: Vec<DrilldownRelationResult>,
}

/// Complete output of comparing two OCEL logs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComparisonOutput {
    /// Tested blocks, keyed by block ID, with PERMANOVA + Holm-Bonferroni results.
    results: HashMap<String, EventTypeResult>,
    /// Group keys appearing only in log 1 (no comparison possible).
    only_in_log1: Vec<String>,
    /// Group keys appearing only in log 2 (no comparison possible).
    only_in_log2: Vec<String>,
}

/// A single comparison block sent by the frontend.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlockParam {
    id: String,
    mode: RelationMode,
    group_key: String,
    target_types: Option<Vec<String>>,
}

/// One object type's activities and start/end terminals, discovered from a single log.
/// Directly-follows arcs no longer live here — see `ProcessModelSkeleton::edges`, which combines
/// object types into one arc instead of duplicating an arc per type.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DfgSkeleton {
    activities: HashMap<String, u32>,
    start_activities: Vec<String>,
    end_activities: Vec<String>,
}

/// One directly-follows arc, discovered jointly from both logs (walking each object's own event
/// trace, sorted by time, pairing only strictly adjacent events — same event-pairing primitive
/// diffrel's own E2E extraction uses, but restricted to adjacent pairs). `qualifier` is one or
/// more object types depending on `QUALIFIER_MODE` — kept as a set rather than a single type so
/// switching between one-arc-per-object-type and combined-object-type arcs later is a mode flip,
/// not a data-shape change. Kept only if its fan-out-relative frequency clears a threshold in at
/// least one log — see `discover_directly_follows_edges`. Counts are kept separate per log rather
/// than summed/averaged, so the arc's label can show the comparison directly.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DfgEdgeSkeleton {
    from: String,
    to: String,
    qualifier: Vec<String>,
    count_log1: u32,
    count_log2: u32,
}

/// Object-centric process model skeleton, discovered jointly from both logs: activities/terminals
/// keyed by object type (merged across both logs), plus one flat directly-follows edge list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessModelSkeleton {
    object_type_to_dfg: HashMap<String, DfgSkeleton>,
    edges: Vec<DfgEdgeSkeleton>,
}

/// App State
#[derive(Default)]
struct AppState {
    log1: Option<Arc<SlimLinkedOCEL>>,
    log2: Option<Arc<SlimLinkedOCEL>>,
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn load_log(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    path: String,
    log_index: u8,
) -> Result<LogSummary, String> {
    let slocel = SlimLinkedOCEL::import_from_path(&path).map_err(|e| e.to_string())?;

    let mut event_types: Vec<String> = slocel.get_ev_types().map(|et| et.to_string()).collect();
    event_types.sort();

    let mut object_types: Vec<String> = slocel.get_ob_types().map(|ot| ot.to_string()).collect();
    object_types.sort();

    let event_count = slocel.get_num_evs();
    let event_type_count = event_types.len();
    let object_type_count = object_types.len();

    let summary = LogSummary {
        event_count,
        event_type_count,
        event_types,
        object_type_count,
        object_types,
    };

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    match log_index {
        0 => guard.log1 = Some(Arc::new(slocel)),
        1 => guard.log2 = Some(Arc::new(slocel)),
        _ => return Err(format!("Invalid log_index {log_index}: must be 0 or 1")),
    }

    Ok(summary)
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "tauri command params mirror the frontend invoke() payload's fields directly"
)]
async fn run_mixed_comparison(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    blocks: Vec<BlockParam>,
    distance_mode: DistanceMode,
    num_permutations: usize,
    seed: Option<u64>,
    alpha: f64,
    allowed_object_types: Option<Vec<String>>,
    follows_mode: FollowsMode,
    qualifier_mode: E2EQualifierMode,
) -> Result<ComparisonOutput, String> {
    let (log1, log2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        (l1, l2)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let allowed: Option<HashSet<&str>> = allowed_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let allowed = allowed.as_ref();

        // Pre-extract counts for each mode used by at least one block
        let e2o = blocks.iter().any(|b| b.mode == RelationMode::E2O).then(|| {
            (
                RelationMode::E2O.extract_counts(&log1, allowed, follows_mode, qualifier_mode),
                RelationMode::E2O.extract_counts(&log2, allowed, follows_mode, qualifier_mode),
            )
        });
        let o2o = blocks.iter().any(|b| b.mode == RelationMode::O2O).then(|| {
            (
                RelationMode::O2O.extract_counts(&log1, allowed, follows_mode, qualifier_mode),
                RelationMode::O2O.extract_counts(&log2, allowed, follows_mode, qualifier_mode),
            )
        });
        let o2e = blocks.iter().any(|b| b.mode == RelationMode::O2E).then(|| {
            (
                RelationMode::O2E.extract_counts(&log1, allowed, follows_mode, qualifier_mode),
                RelationMode::O2E.extract_counts(&log2, allowed, follows_mode, qualifier_mode),
            )
        });
        let e2e = blocks.iter().any(|b| b.mode == RelationMode::E2E).then(|| {
            (
                RelationMode::E2E.extract_counts(&log1, allowed, follows_mode, qualifier_mode),
                RelationMode::E2E.extract_counts(&log2, allowed, follows_mode, qualifier_mode),
            )
        });

        struct BlockIntermediate {
            pseudo_f: f64,
            p_value: f64,
            n1: usize,
            n2: usize,
            object_type_relations: Vec<ObjectTypeRelation>,
            mode_str: String,
            group_key: String,
        }

        let mut only_in_log1: Vec<String> = Vec::new();
        let mut only_in_log2: Vec<String> = Vec::new();
        let mut intermediate: HashMap<String, BlockIntermediate> = HashMap::new();

        for block in &blocks {
            let (counts_1, counts_2) = match block.mode {
                RelationMode::E2O => e2o.as_ref().unwrap(),
                RelationMode::O2O => o2o.as_ref().unwrap(),
                RelationMode::O2E => o2e.as_ref().unwrap(),
                RelationMode::E2E => e2e.as_ref().unwrap(),
            };

            let in_log1 = counts_1.contains_key(block.group_key.as_str());
            let in_log2 = counts_2.contains_key(block.group_key.as_str());

            if !in_log2 {
                only_in_log1.push(block.group_key.clone());
                continue;
            }
            if !in_log1 {
                only_in_log2.push(block.group_key.clone());
                continue;
            }

            let rel_counts_1 = counts_1.get(block.group_key.as_str()).unwrap();
            let rel_counts_2 = counts_2.get(block.group_key.as_str()).unwrap();

            // Build feature space, optionally filtered by target_types
            let target_type_filter: Option<HashSet<&str>> = block
                .target_types
                .as_ref()
                .map(|tts| tts.iter().map(|s| s.as_str()).collect());

            let ordered_relation_types: Vec<(Qualifier<'_>, &str)> = {
                let all: HashSet<(Qualifier<'_>, &str)> = rel_counts_1
                    .iter()
                    .chain(rel_counts_2.iter())
                    .flat_map(|x| x.keys())
                    .cloned()
                    .collect();
                if let Some(ref filter) = target_type_filter {
                    all.into_iter().filter(|(_, t)| filter.contains(t)).collect()
                } else {
                    all.into_iter().collect()
                }
            };

            if ordered_relation_types.is_empty() {
                continue;
            }

            let n1 = rel_counts_1.len();
            let n2 = rel_counts_2.len();

            let sample_1 = encode_relation_counts(rel_counts_1, &ordered_relation_types);
            let sample_2 = encode_relation_counts(rel_counts_2, &ordered_relation_types);

            let res = match distance_mode {
                DistanceMode::Euclidean => {
                    permanova_fast(&sample_1, &sample_2, num_permutations, seed)
                }
                DistanceMode::BrayCurtis => {
                    permanova(&sample_1, &sample_2, squared_bray_curtis_distance, num_permutations, seed)
                }
            }
            .map_err(|e| e.to_string())?;

            let object_type_relations: Vec<ObjectTypeRelation> = ordered_relation_types
                .iter()
                .map(|(qualifier, object_type)| {
                    let key = (qualifier.clone(), *object_type);
                    let mut vals_1: Vec<f64> = rel_counts_1
                        .iter()
                        .map(|ev| *ev.get(&key).unwrap_or(&0) as f64)
                        .collect();
                    let mut vals_2: Vec<f64> = rel_counts_2
                        .iter()
                        .map(|ev| *ev.get(&key).unwrap_or(&0) as f64)
                        .collect();
                    let m1 = mean(&vals_1);
                    let m2 = mean(&vals_2);
                    ObjectTypeRelation {
                        qualifier: qualifier.to_string(),
                        object_type: object_type.to_string(),
                        median_log1: median(&mut vals_1),
                        median_log2: median(&mut vals_2),
                        mean_log1: m1,
                        mean_log2: m2,
                        std_log1: std_dev(&vals_1, m1),
                        std_log2: std_dev(&vals_2, m2),
                    }
                })
                .collect();

            intermediate.insert(
                block.id.clone(),
                BlockIntermediate {
                    pseudo_f: res.pseudo_f,
                    p_value: res.p_value,
                    n1,
                    n2,
                    object_type_relations,
                    mode_str: block.mode.as_str().to_owned(),
                    group_key: block.group_key.clone(),
                },
            );
        }

        // Apply Holm-Bonferroni correction across all blocks
        let significance: HashMap<String, (f64, bool)> = {
            let pvals: HashMap<&str, f64> = intermediate
                .iter()
                .map(|(k, b)| (k.as_str(), b.p_value))
                .collect();
            check_significance_holm_bonferroni(pvals, alpha)
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect()
        };

        let results: HashMap<String, EventTypeResult> = intermediate
            .into_iter()
            .map(|(key, b)| {
                let (p_value, is_significant) =
                    significance.get(&key).copied().unwrap_or((1.0, false));
                (
                    key,
                    EventTypeResult {
                        p_value,
                        is_significant,
                        pseudo_f: b.pseudo_f,
                        n1: b.n1,
                        n2: b.n2,
                        object_type_relations: b.object_type_relations,
                        mode: b.mode_str,
                        group_key: b.group_key,
                    },
                )
            })
            .collect();

        Ok(ComparisonOutput {
            results,
            only_in_log1,
            only_in_log2,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_dimensions(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    mode: RelationMode,
    group_key: String,
    allowed_object_types: Option<Vec<String>>,
    follows_mode: FollowsMode,
    qualifier_mode: E2EQualifierMode,
) -> Result<Vec<(String, String)>, String> {
    let (log1, log2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        (l1, l2)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let allowed: Option<HashSet<&str>> = allowed_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let allowed = allowed.as_ref();
        let counts_1 = mode.extract_counts(&log1, allowed, follows_mode, qualifier_mode);
        let counts_2 = mode.extract_counts(&log2, allowed, follows_mode, qualifier_mode);

        let all: HashSet<(Qualifier<'_>, &str)> = counts_1
            .get(group_key.as_str())
            .into_iter()
            .chain(counts_2.get(group_key.as_str()))
            .flat_map(|counts| counts.iter().flat_map(|c| c.keys()))
            .cloned()
            .collect();

        let mut result: Vec<(String, String)> = all
            .into_iter()
            .map(|(q, t)| (q.to_string(), t.to_owned()))
            .collect();
        result.sort();
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "tauri command params mirror the frontend invoke() payload's fields directly"
)]
async fn run_drilldown(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    group_key: String,
    mode: RelationMode,
    num_permutations: usize,
    alpha: f64,
    allowed_object_types: Option<Vec<String>>,
    follows_mode: FollowsMode,
    qualifier_mode: E2EQualifierMode,
) -> Result<DrilldownOutput, String> {
    let (log1, log2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        (l1, l2)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let allowed: Option<HashSet<&str>> = allowed_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let allowed = allowed.as_ref();
        let mut counts_1 = mode.extract_counts(&log1, allowed, follows_mode, qualifier_mode);
        let mut counts_2 = mode.extract_counts(&log2, allowed, follows_mode, qualifier_mode);

        let rel_counts_1 = counts_1
            .remove(group_key.as_str())
            .ok_or_else(|| format!("'{}' not in log 1", group_key))?;
        let rel_counts_2 = counts_2
            .remove(group_key.as_str())
            .ok_or_else(|| format!("'{}' not in log 2", group_key))?;

        drilldown_for_group(&rel_counts_1, &rel_counts_2, num_permutations, alpha)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shared by `run_drilldown` and `run_drilldown_batch`: runs the Westfall-Young drilldown plus
/// per-relation Cliff's delta for one group key's already-extracted relationship counts.
fn drilldown_for_group(
    rel_counts_1: &[RelationshipCount<'_>],
    rel_counts_2: &[RelationshipCount<'_>],
    num_permutations: usize,
    alpha: f64,
) -> Result<DrilldownOutput, String> {
    let ordered_relation_types: Vec<(Qualifier<'_>, &str)> = rel_counts_1
        .iter()
        .chain(rel_counts_2.iter())
        .flat_map(|x| x.keys())
        .collect::<HashSet<_>>()
        .into_iter()
        .cloned()
        .collect();

    if ordered_relation_types.is_empty() {
        return Ok(DrilldownOutput { results: vec![] });
    }

    let sample_1 = encode_relation_counts(rel_counts_1, &ordered_relation_types);
    let sample_2 = encode_relation_counts(rel_counts_2, &ordered_relation_types);

    let drill_results = drilldown(
        &sample_1,
        &sample_2,
        num_permutations,
        42,
        &ordered_relation_types,
    )
    .map_err(|e| e.to_string())?;

    let relation_index: HashMap<(Qualifier<'_>, &str), usize> = ordered_relation_types
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, key)| (key, i))
        .collect();

    let results = drill_results
        .into_iter()
        .map(|((q, ot), res)| {
            let effect_size = relation_index
                .get(&(q.clone(), ot))
                .map(|&idx| {
                    let col_1: Vec<f64> = sample_1.column(idx).iter().copied().collect();
                    let col_2: Vec<f64> = sample_2.column(idx).iter().copied().collect();
                    cliffs_delta(&col_1, &col_2)
                })
                .unwrap_or(0.0);

            DrilldownRelationResult {
                qualifier: q.to_string(),
                object_type: ot.to_string(),
                p_value: res.p_value,
                is_significant: res.p_value <= alpha,
                pseudo_f: res.pseudo_f,
                effect_size,
            }
        })
        .collect();

    Ok(DrilldownOutput { results })
}

/// Same as `run_drilldown`, but for many group keys at once, sharing a single extraction pass
/// per log instead of repeating it per key. `extract_e2e_relation_counts` in particular walks
/// every allowed object's full event trace pairing it with every later shared-object event
/// (eventually-follows) — re-running that once per significant event type, as calling
/// `run_drilldown` in a loop does, is the dominant cost once high-fan-out object types (ones
/// touching most events) are included in the filter.
#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "tauri command params mirror the frontend invoke() payload's fields directly"
)]
async fn run_drilldown_batch(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    group_keys: Vec<String>,
    mode: RelationMode,
    num_permutations: usize,
    alpha: f64,
    allowed_object_types: Option<Vec<String>>,
    follows_mode: FollowsMode,
    qualifier_mode: E2EQualifierMode,
) -> Result<HashMap<String, DrilldownOutput>, String> {
    let (log1, log2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        (l1, l2)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let allowed: Option<HashSet<&str>> = allowed_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let allowed = allowed.as_ref();
        let counts_1 = mode.extract_counts(&log1, allowed, follows_mode, qualifier_mode);
        let counts_2 = mode.extract_counts(&log2, allowed, follows_mode, qualifier_mode);

        group_keys
            .into_iter()
            .map(|group_key| {
                let empty = Vec::new();
                let rel_counts_1 = counts_1.get(group_key.as_str()).unwrap_or(&empty);
                let rel_counts_2 = counts_2.get(group_key.as_str()).unwrap_or(&empty);
                let output =
                    drilldown_for_group(rel_counts_1, rel_counts_2, num_permutations, alpha)?;
                Ok((group_key, output))
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn discover_process_model(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    allowed_object_types: Option<Vec<String>>,
) -> Result<ProcessModelSkeleton, String> {
    let (log1, log2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        (l1, l2)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let allowed: Option<HashSet<&str>> = allowed_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let allowed = allowed.as_ref();

        // Activities/start/end terminals: still a simple structural fact, not in conflict with
        // the joint/fan-out requirements below, so the external per-object-type DFG discovery
        // stays useful here — just run on both logs now and merged per object type.
        let mut object_type_to_dfg: HashMap<String, DfgSkeleton> = HashMap::new();
        for oc_dfg in [
            OCDirectlyFollowsGraph::create_from_ocel(log1.as_ref()),
            OCDirectlyFollowsGraph::create_from_ocel(log2.as_ref()),
        ] {
            for (object_type, dfg) in oc_dfg.object_type_to_dfg {
                if !allowed.is_none_or(|allowed| allowed.contains(object_type.as_str())) {
                    continue;
                }
                let entry = object_type_to_dfg.entry(object_type).or_insert_with(|| DfgSkeleton {
                    activities: HashMap::new(),
                    start_activities: Vec::new(),
                    end_activities: Vec::new(),
                });
                for (activity, count) in dfg.activities {
                    let existing = entry.activities.entry(activity).or_insert(0);
                    *existing = (*existing).max(count);
                }
                for act in dfg.start_activities {
                    if !entry.start_activities.contains(&act) {
                        entry.start_activities.push(act);
                    }
                }
                for act in dfg.end_activities {
                    if !entry.end_activities.contains(&act) {
                        entry.end_activities.push(act);
                    }
                }
            }
        }

        let edges = discover_directly_follows_edges(log1.as_ref(), log2.as_ref(), allowed);

        Ok(ProcessModelSkeleton { object_type_to_dfg, edges })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Controls how directly-follows edges are qualified. `Single` keeps one arc per (from, to,
/// single object type) — the standard per-object-type OC-DFG shape. `Combined` merges every
/// object type that jointly mediates the exact same (from, to) event-pair instance into one arc
/// with a combined qualifier set, matching how diffrel's own E2E extraction groups relationships.
/// `DfgEdgeSkeleton::qualifier` is a `Vec<String>` either way, so switching modes is a one-line
/// change, not a data-shape change.
#[derive(Clone, Copy, PartialEq, Eq)]
enum QualifierMode {
    Single,
    #[expect(dead_code, reason = "kept switchable per design; not wired to a caller yet")]
    Combined,
}

const QUALIFIER_MODE: QualifierMode = QualifierMode::Single;

/// Counts directly-follows edges (keyed by `(from_activity, to_activity, qualifier)`) and each
/// `(from_activity, qualifier)`'s total outgoing count, by walking each object's own event trace
/// (sorted by time), pairing only strictly adjacent events — the same event-pairing primitive
/// diffrel's own E2E extraction uses, but restricted to adjacent pairs (directly-follows, not
/// eventually-follows).
#[expect(clippy::type_complexity, reason = "internal aggregation map, not worth a named type yet")]
fn count_directly_follows_edges<'a>(
    locel: &'a SlimLinkedOCEL,
    allowed_object_types: Option<&HashSet<&str>>,
    mode: QualifierMode,
) -> (
    HashMap<(&'a str, &'a str, Vec<&'a str>), u32>,
    HashMap<(&'a str, Vec<&'a str>), u32>,
) {
    let mut edge_counts = HashMap::new();
    let mut fanout_counts = HashMap::new();

    match mode {
        QualifierMode::Single => {
            for obj in locel.get_all_obs() {
                let otype = locel.get_ob_type_of(&obj);
                if !allowed_object_types.is_none_or(|allowed| allowed.contains(otype)) {
                    continue;
                }
                let mut o2e: Vec<_> = locel.get_e2o_rev(obj).collect();
                o2e.sort_by_key(|ev| locel.get_ev_time(ev.1));
                for i in 0..o2e.len().saturating_sub(1) {
                    let from = locel.get_ev_type_of(*o2e[i].1);
                    let to = locel.get_ev_type_of(*o2e[i + 1].1);
                    let qualifier = vec![otype];
                    *edge_counts.entry((from, to, qualifier.clone())).or_insert(0u32) += 1;
                    *fanout_counts.entry((from, qualifier)).or_insert(0u32) += 1;
                }
            }
        }
        QualifierMode::Combined => {
            let mut paired_events: HashMap<(_, _), BTreeSet<&str>> = HashMap::new();
            for obj in locel.get_all_obs() {
                let otype = locel.get_ob_type_of(&obj);
                if !allowed_object_types.is_none_or(|allowed| allowed.contains(otype)) {
                    continue;
                }
                let mut o2e: Vec<_> = locel.get_e2o_rev(obj).collect();
                o2e.sort_by_key(|ev| locel.get_ev_time(ev.1));
                for i in 0..o2e.len().saturating_sub(1) {
                    let ev1 = *o2e[i].1;
                    let ev2 = *o2e[i + 1].1;
                    paired_events.entry((ev1, ev2)).or_default().insert(otype);
                }
            }
            for ((ev1, ev2), otypes) in paired_events {
                let from = locel.get_ev_type_of(ev1);
                let to = locel.get_ev_type_of(ev2);
                let qualifier: Vec<&str> = otypes.into_iter().collect();
                *edge_counts.entry((from, to, qualifier.clone())).or_insert(0u32) += 1;
                *fanout_counts.entry((from, qualifier)).or_insert(0u32) += 1;
            }
        }
    }

    (edge_counts, fanout_counts)
}

const MIN_FANOUT_RATIO: f64 = 0.05; // first-pass default, not yet exposed as a UI control

/// Joint DFG edges: union of both logs' directly-follows edges, kept if its fan-out-relative
/// frequency clears `MIN_FANOUT_RATIO` in at least one log (evaluated independently per log, then
/// OR'd — never averaged, so an edge common in one log but absent in the other still shows).
fn discover_directly_follows_edges<'a>(
    log1: &'a SlimLinkedOCEL,
    log2: &'a SlimLinkedOCEL,
    allowed_object_types: Option<&HashSet<&str>>,
) -> Vec<DfgEdgeSkeleton> {
    let (edges_1, fanout_1) = count_directly_follows_edges(log1, allowed_object_types, QUALIFIER_MODE);
    let (edges_2, fanout_2) = count_directly_follows_edges(log2, allowed_object_types, QUALIFIER_MODE);

    let all_keys: HashSet<_> = edges_1.keys().chain(edges_2.keys()).cloned().collect();

    all_keys
        .into_iter()
        .filter_map(|(from, to, qualifier)| {
            let count_1 = edges_1.get(&(from, to, qualifier.clone())).copied().unwrap_or(0);
            let count_2 = edges_2.get(&(from, to, qualifier.clone())).copied().unwrap_or(0);
            let total_1 = fanout_1.get(&(from, qualifier.clone())).copied().unwrap_or(0);
            let total_2 = fanout_2.get(&(from, qualifier.clone())).copied().unwrap_or(0);
            let ratio_1 = if total_1 > 0 { count_1 as f64 / total_1 as f64 } else { 0.0 };
            let ratio_2 = if total_2 > 0 { count_2 as f64 / total_2 as f64 } else { 0.0 };
            (ratio_1 >= MIN_FANOUT_RATIO || ratio_2 >= MIN_FANOUT_RATIO).then(|| DfgEdgeSkeleton {
                from: from.to_owned(),
                to: to.to_owned(),
                qualifier: qualifier.into_iter().map(str::to_owned).collect(),
                count_log1: count_1,
                count_log2: count_2,
            })
        })
        .collect()
}

/// Entrypoint
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(AppState::default())))
        .invoke_handler(tauri::generate_handler![
            load_log,
            run_mixed_comparison,
            get_dimensions,
            run_drilldown,
            run_drilldown_batch,
            discover_process_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
