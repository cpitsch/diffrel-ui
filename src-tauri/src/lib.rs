#![warn(
    clippy::redundant_clone,
    // clippy::doc_markdown,
    clippy::perf,
    missing_debug_implementations,
    rust_2018_idioms
)]

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    hash::Hash,
    sync::{Arc, Mutex},
};

use diffrel::{
    dependency_components::{compute_dependency_components, DependencyComponents},
    execution::{
        config::{ComparisonConfig, Grouping as LibGrouping},
        drilldown_for_instance,
        export::ComparisonResultExport,
        instance::{ComparisonInstance, RelationMode as LibRelationMode},
        result::{
            ComparisonInstanceResult, ComparisonResult, DrilldownResult as LibDrilldownResult,
            SkipReason, SkippedInstanceResult, TestResult,
        },
        run_instance, RawInstanceResult,
    },
    multiple_testing::check_significance_holm_bonferroni,
    permanova::Distance as LibDistance,
    relation_extraction::{
        compute_ordered_relation_types, extract_e2e_relation_counts, extract_e2o_relation_counts,
        extract_o2e_relation_counts, extract_o2o_relation_counts, E2ERelationType,
        RelationshipCount,
    },
};

use process_mining::{
    core::event_data::object_centric::linked_ocel::{
        slim_linked_ocel::{EventIndex, ObjectIndex},
        LinkedOCELAccess, SlimLinkedOCEL,
    },
    core::process_models::object_centric::ocdfg::discover_ocdfg,
    Importable,
};

/// Divergence-pruned components for a `SlimLinkedOCEL`, spelled out because struct fields can't
/// use `impl Trait` — needed once for the cached-components fields on `AppState`.
type SlocelComponents = DependencyComponents<EventIndex, ObjectIndex>;
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

impl From<RelationMode> for LibRelationMode {
    fn from(mode: RelationMode) -> Self {
        match mode {
            RelationMode::E2O => LibRelationMode::E2O,
            RelationMode::O2O => LibRelationMode::O2O,
            RelationMode::O2E => LibRelationMode::O2E,
            RelationMode::E2E => LibRelationMode::E2E,
        }
    }
}

#[derive(Deserialize, Clone, Copy)]
enum DistanceMode {
    Euclidean,
    BrayCurtis,
}

impl From<DistanceMode> for LibDistance {
    fn from(mode: DistanceMode) -> Self {
        match mode {
            DistanceMode::BrayCurtis => LibDistance::BrayCurtis,
            DistanceMode::Euclidean => LibDistance::Euclidean,
        }
    }
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
///
/// `Grouped` is no longer wired to anything — the frontend has hardcoded `DEFAULT_QUALIFIER_MODE =
/// "Single"` for a while (`constants.ts`) with no live UI control left, and `diffrel`'s own
/// `execution` module dropped support for it entirely (always behaves as `Single`/`merge_object_
/// types: false`). Kept as a command parameter only so the existing frontend payload shape doesn't
/// need to change; the value itself is ignored.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
enum E2EQualifierMode {
    Single,
    Grouped,
}

impl RelationMode {
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
    /// The permutation seed actually used for this comparison — the caller's `seed` if one was
    /// given, otherwise the value this call generated in its place. Surfaced so a "no seed"
    /// run can still be reproduced later (e.g. re-entered as an explicit seed, or recorded in an
    /// exported result) and so a triggered drilldown can reuse the same seed as its comparison.
    seed_used: u64,
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
/// Directly-follows arcs no longer live here — see `ProcessModelDfg::edges`, which combines
/// object types into one arc instead of duplicating an arc per type.
#[derive(Serialize, Deserialize)]
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
/// not a data-shape change. Unfiltered — every edge found in either log is included; the frontend
/// applies a user-adjustable fan-out-ratio threshold itself (mirroring how the effect-size overlay
/// threshold works), rather than the backend baking in a fixed cutoff. Counts are kept separate
/// per log rather than summed/averaged, so the arc's label can show the comparison directly.
/// No `fanout_log1`/`fanout_log2` here (a from-activity's total outgoing count for this
/// qualifier, the ratio's denominator) — deliberately dropped: it was always exactly the sum of
/// `count_log1`/`count_log2` across every edge sharing this `(from, qualifier)`, so identical
/// values were duplicated across every edge from the same source, fully derivable from data
/// already here. The frontend computes it itself (once per DFG, not per filter change).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DfgEdgeSkeleton {
    from: String,
    to: String,
    qualifier: Vec<String>,
    count_log1: u32,
    count_log2: u32,
}

/// Object-centric process model DFG, discovered jointly from both logs: activities/terminals
/// keyed by object type (merged across both logs), plus one flat directly-follows edge list.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessModelDfg {
    object_type_to_dfg: HashMap<String, DfgSkeleton>,
    edges: Vec<DfgEdgeSkeleton>,
}

/// App State
#[derive(Default)]
struct AppState {
    log1: Option<Arc<SlimLinkedOCEL>>,
    log2: Option<Arc<SlimLinkedOCEL>>,
    /// Cached divergence-pruned components for each loaded log — computed once at load time
    /// (via `compute_dependency_components`, a whole-log walk + union-find that's tens of seconds
    /// on 17k-event logs) so every subsequent compare/drilldown reuses them. `diffrel::execution`'s
    /// own `run_comparison`/`drilldown_for_instances` recompute components internally instead
    /// (deliberately, for their simpler "just hand me raw logs" callers) — this crate uses the
    /// lower-level `run_instance`/`drilldown_for_instance` building blocks instead specifically so
    /// this cache stays effective.
    components_1: Option<Arc<SlocelComponents>>,
    components_2: Option<Arc<SlocelComponents>>,
    /// The config and (accumulating) result of the last `run_mixed_comparison` call, kept around
    /// so a later, separate export command can package them without needing the comparison
    /// re-run. `last_result`'s per-instance `drilldown` fields start `None` and get filled in by
    /// `run_drilldown`/`run_drilldown_batch` as the user triggers them (or, for the process-model
    /// view, all at once right after the comparison, since it batches every significant drilldown
    /// eagerly) — so by the time export is requested, this reflects whatever's actually been
    /// computed so far, regardless of which view or how much time has passed.
    last_config: Option<ComparisonConfig>,
    last_result: Option<ComparisonResult>,
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

    // Pre-compute divergence-pruned components once here so every subsequent
    // compare/drilldown reuses them (see `SlocelComponents` docstring on `AppState`).
    let components = Arc::new(compute_dependency_components(&slocel));

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    match log_index {
        0 => {
            guard.log1 = Some(Arc::new(slocel));
            guard.components_1 = Some(components);
        }
        1 => {
            guard.log2 = Some(Arc::new(slocel));
            guard.components_2 = Some(components);
        }
        _ => return Err(format!("Invalid log_index {log_index}: must be 0 or 1")),
    }

    Ok(summary)
}

/// One block's outcome after testing. Wraps `diffrel::execution::SkipReason` directly rather than
/// re-enumerating its cases, plus the success case extended with the descriptive stats `diffrel`
/// deliberately doesn't compute (UI-only concern, not part of the statistical library).
enum BlockOutcome {
    Skipped(SkipReason),
    Ok(BlockIntermediate),
}

struct BlockIntermediate {
    /// Carries mode/group_key/target_types together so both `EventTypeResult` (via `mode_str`/
    /// `group_key` below) and a `ComparisonInstanceResult` (for `AppState.last_result`) can be
    /// built from one value instead of reconstructing it twice.
    instance: ComparisonInstance,
    pseudo_f: f64,
    p_value: f64,
    n1: usize,
    n2: usize,
    object_type_relations: Vec<ObjectTypeRelation>,
    mode_str: String,
    group_key: String,
}

/// Runs the actual PERMANOVA test for one block via `diffrel::execution::run_instance` (using
/// this app's cached components, not `run_instance`'s own per-call recomputation), then computes
/// the per-relation descriptive stats `run_instance` itself doesn't produce. Generic over the
/// row-key type `T` (event or object index) so a single function serves E2O/E2E (event rows) and
/// O2O/O2E (object rows).
fn process_block<'a, T>(
    block: &BlockParam,
    counts_1: &HashMap<&'a str, Vec<(T, RelationshipCount<'a>)>>,
    counts_2: &HashMap<&'a str, Vec<(T, RelationshipCount<'a>)>>,
    components_1: &HashMap<T, usize>,
    components_2: &HashMap<T, usize>,
    seed: u64,
    config: &ComparisonConfig,
) -> Result<BlockOutcome, String>
where
    T: Eq + Hash + Copy,
{
    let instance = ComparisonInstance {
        mode: block.mode.into(),
        group_key: block.group_key.clone(),
        target_types: block.target_types.clone(),
    };

    let outcome = run_instance(
        &instance,
        counts_1,
        counts_2,
        Some((components_1, components_2)),
        seed,
        config,
    );

    let (n1, n2, pseudo_f, p_value) = match outcome {
        RawInstanceResult::Skipped(SkipReason::TestFailed(e)) => return Err(e.to_string()),
        RawInstanceResult::Skipped(reason) => return Ok(BlockOutcome::Skipped(reason)),
        RawInstanceResult::Result { n1, n2, pseudo_f, p_value } => (n1, n2, pseudo_f, p_value),
    };

    let rel_counts_1 = &counts_1[block.group_key.as_str()];
    let rel_counts_2 = &counts_2[block.group_key.as_str()];

    let target_type_filter: Option<HashSet<&str>> = block
        .target_types
        .as_ref()
        .map(|tts| tts.iter().map(|s| s.as_str()).collect());

    let ordered_relation_types =
        compute_ordered_relation_types(rel_counts_1, rel_counts_2, target_type_filter.as_ref());

    let object_type_relations: Vec<ObjectTypeRelation> = ordered_relation_types
        .iter()
        .map(|(qualifier, object_type)| {
            let key = (qualifier.clone(), *object_type);
            let mut vals_1: Vec<f64> = rel_counts_1
                .iter()
                .map(|(_, ev)| *ev.get(&key).unwrap_or(&0) as f64)
                .collect();
            let mut vals_2: Vec<f64> = rel_counts_2
                .iter()
                .map(|(_, ev)| *ev.get(&key).unwrap_or(&0) as f64)
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

    Ok(BlockOutcome::Ok(BlockIntermediate {
        instance,
        pseudo_f,
        p_value,
        n1,
        n2,
        object_type_relations,
        mode_str: block.mode.as_str().to_owned(),
        group_key: block.group_key.clone(),
    }))
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
    let _ = qualifier_mode; // no longer wired to anything, see `E2EQualifierMode`'s doc comment

    let (log1, log2, components_1, components_2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        let c1 = guard.components_1.clone().ok_or("Log 1 components missing")?;
        let c2 = guard.components_2.clone().ok_or("Log 2 components missing")?;
        (l1, l2, c1, c2)
    };

    // Resolve once, up front: if the caller didn't pin a seed, generate one here (not inside
    // `diffrel` — see `feedback-diffrel-clean-boundary`) so every block in this comparison uses
    // the same seed, and so it can be echoed back to the frontend for reproducibility/export.
    // `u32` range, not the full `u64` `permutation_seed` accepts: JS numbers only round-trip
    // integers up to 2^53 exactly, so a `u64` value could get silently rounded on the frontend.
    let seed_used: u64 = seed.unwrap_or_else(|| rand::random::<u32>() as u64);

    let config = ComparisonConfig {
        permutations: num_permutations,
        alpha,
        seed: Some(seed_used),
        distance: distance_mode.into(),
        grouping: LibGrouping::Executions,
        follows: follows_mode.into(),
        e2e_object_types: allowed_object_types.clone(),
    };
    let config_for_state = config.clone();

    let (output, result) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(ComparisonOutput, ComparisonResult), String> {
        let allowed: Option<HashSet<&str>> = allowed_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let allowed = allowed.as_ref();

        // Pre-extract counts for each mode used by at least one block. Row-key type differs by
        // mode (EventRepr for E2*, ObjectRepr for O2*), so the four bindings are concrete types
        // rather than a single unified counter.
        let e2o = blocks
            .iter()
            .any(|b| b.mode == RelationMode::E2O)
            .then(|| (extract_e2o_relation_counts(log1.as_ref()), extract_e2o_relation_counts(log2.as_ref())));
        let o2o = blocks
            .iter()
            .any(|b| b.mode == RelationMode::O2O)
            .then(|| (extract_o2o_relation_counts(log1.as_ref()), extract_o2o_relation_counts(log2.as_ref())));
        let o2e = blocks
            .iter()
            .any(|b| b.mode == RelationMode::O2E)
            .then(|| (extract_o2e_relation_counts(log1.as_ref()), extract_o2e_relation_counts(log2.as_ref())));
        let e2e = blocks.iter().any(|b| b.mode == RelationMode::E2E).then(|| {
            (
                extract_e2e_relation_counts(log1.as_ref(), allowed, Some(follows_mode.into()), false),
                extract_e2e_relation_counts(log2.as_ref(), allowed, Some(follows_mode.into()), false),
            )
        });

        let mut only_in_log1: Vec<String> = Vec::new();
        let mut only_in_log2: Vec<String> = Vec::new();
        let mut skipped: Vec<SkippedInstanceResult> = Vec::new();
        let mut intermediate: HashMap<String, BlockIntermediate> = HashMap::new();

        for block in &blocks {
            let outcome = match block.mode {
                RelationMode::E2O => {
                    let (c1, c2) = e2o.as_ref().unwrap();
                    process_block(
                        block, c1, c2,
                        &components_1.events, &components_2.events,
                        seed_used, &config,
                    )?
                }
                RelationMode::E2E => {
                    let (c1, c2) = e2e.as_ref().unwrap();
                    process_block(
                        block, c1, c2,
                        &components_1.events, &components_2.events,
                        seed_used, &config,
                    )?
                }
                RelationMode::O2O => {
                    let (c1, c2) = o2o.as_ref().unwrap();
                    process_block(
                        block, c1, c2,
                        &components_1.objects, &components_2.objects,
                        seed_used, &config,
                    )?
                }
                RelationMode::O2E => {
                    let (c1, c2) = o2e.as_ref().unwrap();
                    process_block(
                        block, c1, c2,
                        &components_1.objects, &components_2.objects,
                        seed_used, &config,
                    )?
                }
            };

            match outcome {
                BlockOutcome::Skipped(reason) => {
                    match &reason {
                        SkipReason::OnlyInLogOne => only_in_log1.push(block.group_key.clone()),
                        SkipReason::OnlyInLogTwo => only_in_log2.push(block.group_key.clone()),
                        SkipReason::NoRelationsObserved | SkipReason::TestFailed(_) => {}
                    }
                    skipped.push(SkippedInstanceResult {
                        instance: ComparisonInstance {
                            mode: block.mode.into(),
                            group_key: block.group_key.clone(),
                            target_types: block.target_types.clone(),
                        },
                        reason,
                    });
                }
                BlockOutcome::Ok(interm) => {
                    intermediate.insert(block.id.clone(), interm);
                }
            }
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

        let mut comparison_instance_results = Vec::with_capacity(intermediate.len());
        let results: HashMap<String, EventTypeResult> = intermediate
            .into_iter()
            .map(|(key, b)| {
                let (p_value, is_significant) =
                    significance.get(&key).copied().unwrap_or((1.0, false));
                comparison_instance_results.push(ComparisonInstanceResult {
                    instance: b.instance,
                    n1: b.n1,
                    n2: b.n2,
                    test: TestResult {
                        pseudo_f: b.pseudo_f,
                        p_value,
                        significant: is_significant,
                    },
                    effect_size: None,
                    drilldown: None,
                });
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

        Ok((
            ComparisonOutput {
                results,
                only_in_log1,
                only_in_log2,
                seed_used,
            },
            ComparisonResult {
                results: comparison_instance_results,
                skipped,
                seed_used,
            },
        ))
    })
    .await
    .map_err(|e| e.to_string())??;

    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.last_config = Some(config_for_state);
        guard.last_result = Some(result);
    }

    Ok(output)
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
    let _ = qualifier_mode; // no longer wired to anything, see `E2EQualifierMode`'s doc comment
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

        fn dims_of<T>(
            counts_1: &HashMap<&str, Vec<(T, RelationshipCount<'_>)>>,
            counts_2: &HashMap<&str, Vec<(T, RelationshipCount<'_>)>>,
            group_key: &str,
        ) -> Vec<(String, String)> {
            let empty = Vec::new();
            let c1 = counts_1.get(group_key).unwrap_or(&empty);
            let c2 = counts_2.get(group_key).unwrap_or(&empty);
            let mut result: Vec<(String, String)> = compute_ordered_relation_types(c1, c2, None)
                .into_iter()
                .map(|(q, t)| (q.to_string(), t.to_owned()))
                .collect();
            result.sort();
            result
        }

        let result = match mode {
            RelationMode::E2O => {
                let c1 = extract_e2o_relation_counts(log1.as_ref());
                let c2 = extract_e2o_relation_counts(log2.as_ref());
                dims_of(&c1, &c2, group_key.as_str())
            }
            RelationMode::E2E => {
                let c1 = extract_e2e_relation_counts(log1.as_ref(), allowed, Some(follows_mode.into()), false);
                let c2 = extract_e2e_relation_counts(log2.as_ref(), allowed, Some(follows_mode.into()), false);
                dims_of(&c1, &c2, group_key.as_str())
            }
            RelationMode::O2O => {
                let c1 = extract_o2o_relation_counts(log1.as_ref());
                let c2 = extract_o2o_relation_counts(log2.as_ref());
                dims_of(&c1, &c2, group_key.as_str())
            }
            RelationMode::O2E => {
                let c1 = extract_o2e_relation_counts(log1.as_ref());
                let c2 = extract_o2e_relation_counts(log2.as_ref());
                dims_of(&c1, &c2, group_key.as_str())
            }
        };
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes a freshly computed drilldown result into `AppState.last_result`'s matching instance, so
/// a later export reflects it. A silent no-op if no comparison has been run yet, or if this
/// instance isn't present in the cached result (e.g. a stale request against a since-replaced
/// comparison) — a drilldown result with nowhere to attach isn't an error for this call itself.
fn store_drilldown_result(
    state: &Arc<Mutex<AppState>>,
    instance: &ComparisonInstance,
    result: &LibDrilldownResult,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(last_result) = &mut guard.last_result {
        if let Some(entry) = last_result.results.iter_mut().find(|r| &r.instance == instance) {
            entry.drilldown = Some(result.clone());
        }
    }
    Ok(())
}

/// Converts `diffrel::execution`'s drilldown outcome into this app's own DTO. Shared by
/// `run_drilldown` and `run_drilldown_batch`.
fn to_drilldown_output(result: LibDrilldownResult) -> Result<DrilldownOutput, String> {
    let relations = result.map_err(|e| e.to_string())?;
    Ok(DrilldownOutput {
        results: relations
            .into_iter()
            .map(|r| DrilldownRelationResult {
                qualifier: r.qualifier,
                object_type: r.target,
                p_value: r.test.p_value,
                is_significant: r.test.significant,
                pseudo_f: r.test.pseudo_f,
                effect_size: r.effect_size,
            })
            .collect(),
    })
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
    seed: u64,
    alpha: f64,
    allowed_object_types: Option<Vec<String>>,
    follows_mode: FollowsMode,
    qualifier_mode: E2EQualifierMode,
) -> Result<DrilldownOutput, String> {
    let _ = qualifier_mode; // no longer wired to anything, see `E2EQualifierMode`'s doc comment
    let (log1, log2, components_1, components_2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        let c1 = guard.components_1.clone().ok_or("Log 1 components missing")?;
        let c2 = guard.components_2.clone().ok_or("Log 2 components missing")?;
        (l1, l2, c1, c2)
    };

    let config = ComparisonConfig {
        permutations: num_permutations,
        alpha,
        seed: Some(seed),
        // `distance` is irrelevant here — `drilldown_for_instance` always runs its own
        // per-dimension Westfall-Young test regardless of this setting.
        distance: LibDistance::BrayCurtis,
        grouping: LibGrouping::Executions,
        follows: follows_mode.into(),
        e2e_object_types: allowed_object_types.clone(),
    };

    let (output, instance, result) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(DrilldownOutput, ComparisonInstance, LibDrilldownResult), String> {
        let allowed: Option<HashSet<&str>> = allowed_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let allowed = allowed.as_ref();

        let instance = ComparisonInstance {
            mode: mode.into(),
            group_key: group_key.clone(),
            target_types: None,
        };

        // Row-key type differs by mode (EventRepr vs ObjectRepr), so extraction and the
        // drilldown call are both in the mode-specific arm.
        let result = match mode {
            RelationMode::E2O => {
                let c1 = extract_e2o_relation_counts(log1.as_ref());
                let c2 = extract_e2o_relation_counts(log2.as_ref());
                drilldown_for_instance(&instance, &c1.0, &c2.0, Some((&components_1.events, &components_2.events)), &config, seed)
            }
            RelationMode::E2E => {
                let c1 = extract_e2e_relation_counts(log1.as_ref(), allowed, Some(follows_mode.into()), false);
                let c2 = extract_e2e_relation_counts(log2.as_ref(), allowed, Some(follows_mode.into()), false);
                drilldown_for_instance(&instance, &c1.0, &c2.0, Some((&components_1.events, &components_2.events)), &config, seed)
            }
            RelationMode::O2O => {
                let c1 = extract_o2o_relation_counts(log1.as_ref());
                let c2 = extract_o2o_relation_counts(log2.as_ref());
                drilldown_for_instance(&instance, &c1.0, &c2.0, Some((&components_1.objects, &components_2.objects)), &config, seed)
            }
            RelationMode::O2E => {
                let c1 = extract_o2e_relation_counts(log1.as_ref());
                let c2 = extract_o2e_relation_counts(log2.as_ref());
                drilldown_for_instance(&instance, &c1.0, &c2.0, Some((&components_1.objects, &components_2.objects)), &config, seed)
            }
        };

        let output = to_drilldown_output(result.clone())?;
        Ok((output, instance, result))
    })
    .await
    .map_err(|e| e.to_string())??;

    store_drilldown_result(state.inner(), &instance, &result)?;

    Ok(output)
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
    seed: u64,
    alpha: f64,
    allowed_object_types: Option<Vec<String>>,
    follows_mode: FollowsMode,
    qualifier_mode: E2EQualifierMode,
) -> Result<HashMap<String, DrilldownOutput>, String> {
    let _ = qualifier_mode; // no longer wired to anything, see `E2EQualifierMode`'s doc comment
    let (log1, log2, components_1, components_2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        let c1 = guard.components_1.clone().ok_or("Log 1 components missing")?;
        let c2 = guard.components_2.clone().ok_or("Log 2 components missing")?;
        (l1, l2, c1, c2)
    };

    let config = ComparisonConfig {
        permutations: num_permutations,
        alpha,
        seed: Some(seed),
        distance: LibDistance::BrayCurtis,
        grouping: LibGrouping::Executions,
        follows: follows_mode.into(),
        e2e_object_types: allowed_object_types.clone(),
    };

    #[expect(clippy::type_complexity, reason = "internal aggregation tuple, not worth a named type yet")]
    let (outputs, for_state) = tauri::async_runtime::spawn_blocking(move || -> Result<
        (HashMap<String, DrilldownOutput>, Vec<(ComparisonInstance, LibDrilldownResult)>),
        String,
    > {
        let allowed: Option<HashSet<&str>> = allowed_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let allowed = allowed.as_ref();

        // Helper: given already-extracted counters + the right component slot, iterate group_keys
        // and drill each. Generic over row-key type so it serves all four modes. Returns the
        // instance + raw library result alongside the DTO so the caller can also update
        // `AppState.last_result` with it.
        fn iter_keys<T>(
            group_keys: Vec<String>,
            mode: RelationMode,
            counts_1: &HashMap<&str, Vec<(T, RelationshipCount<'_>)>>,
            counts_2: &HashMap<&str, Vec<(T, RelationshipCount<'_>)>>,
            components_1: &HashMap<T, usize>,
            components_2: &HashMap<T, usize>,
            config: &ComparisonConfig,
            seed: u64,
        ) -> Result<Vec<(String, DrilldownOutput, ComparisonInstance, LibDrilldownResult)>, String>
        where
            T: Eq + Hash + Copy,
        {
            group_keys
                .into_iter()
                .map(|group_key| {
                    let instance = ComparisonInstance {
                        mode: mode.into(),
                        group_key: group_key.clone(),
                        target_types: None,
                    };
                    let result = drilldown_for_instance(
                        &instance, counts_1, counts_2,
                        Some((components_1, components_2)),
                        config, seed,
                    );
                    let output = to_drilldown_output(result.clone())?;
                    Ok((group_key, output, instance, result))
                })
                .collect()
        }

        let items = match mode {
            RelationMode::E2O => {
                let c1 = extract_e2o_relation_counts(log1.as_ref());
                let c2 = extract_e2o_relation_counts(log2.as_ref());
                iter_keys(group_keys, mode, &c1, &c2,
                    &components_1.events, &components_2.events,
                    &config, seed)
            }
            RelationMode::E2E => {
                let c1 = extract_e2e_relation_counts(log1.as_ref(), allowed, Some(follows_mode.into()), false);
                let c2 = extract_e2e_relation_counts(log2.as_ref(), allowed, Some(follows_mode.into()), false);
                iter_keys(group_keys, mode, &c1, &c2,
                    &components_1.events, &components_2.events,
                    &config, seed)
            }
            RelationMode::O2O => {
                let c1 = extract_o2o_relation_counts(log1.as_ref());
                let c2 = extract_o2o_relation_counts(log2.as_ref());
                iter_keys(group_keys, mode, &c1, &c2,
                    &components_1.objects, &components_2.objects,
                    &config, seed)
            }
            RelationMode::O2E => {
                let c1 = extract_o2e_relation_counts(log1.as_ref());
                let c2 = extract_o2e_relation_counts(log2.as_ref());
                iter_keys(group_keys, mode, &c1, &c2,
                    &components_1.objects, &components_2.objects,
                    &config, seed)
            }
        }?;

        let mut outputs = HashMap::with_capacity(items.len());
        let mut for_state = Vec::with_capacity(items.len());
        for (group_key, output, instance, result) in items {
            outputs.insert(group_key, output);
            for_state.push((instance, result));
        }
        Ok((outputs, for_state))
    })
    .await
    .map_err(|e| e.to_string())??;

    for (instance, result) in &for_state {
        store_drilldown_result(state.inner(), instance, result)?;
    }

    Ok(outputs)
}

/// Shared by `discover_process_model` and `export_comparison_result` — both need the same
/// object-centric process-model topology, just triggered at different times.
fn build_process_model_dfg(
    log1: &SlimLinkedOCEL,
    log2: &SlimLinkedOCEL,
    allowed: Option<&HashSet<&str>>,
) -> ProcessModelDfg {
    // Activities/start/end terminals: still a simple structural fact, not in conflict with
    // the joint/fan-out requirements below, so the external per-object-type DFG discovery
    // stays useful here — just run on both logs now and merged per object type.
    let mut object_type_to_dfg: HashMap<String, DfgSkeleton> = HashMap::new();
    for oc_dfg in [
        discover_ocdfg(log1),
        discover_ocdfg(log2),
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
            for (act, _) in dfg.start_activities {
                if !entry.start_activities.contains(&act) {
                    entry.start_activities.push(act);
                }
            }
            for (act, _) in dfg.end_activities {
                if !entry.end_activities.contains(&act) {
                    entry.end_activities.push(act);
                }
            }
        }
    }

    let edges = discover_directly_follows_edges(log1, log2, allowed);

    ProcessModelDfg { object_type_to_dfg, edges }
}

#[tauri::command]
async fn discover_process_model(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    allowed_object_types: Option<Vec<String>>,
) -> Result<ProcessModelDfg, String> {
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
        Ok(build_process_model_dfg(log1.as_ref(), log2.as_ref(), allowed.as_ref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A `ComparisonResultExport` (diffrel's own document shape, snake_case) plus this app's
/// process-model-specific additions, namespaced under `processModel` — see `execution::export`'s
/// doc comment and the schema's own `additionalProperties: true` at the top level for why a
/// sibling field here is fine for a plain consumer of the base document to ignore. Namespaced
/// (rather than `dfg`/`layout` as flat siblings) so it's visible in the shape itself that
/// these two specifically are the Tauri-owned addition, as opposed to two arbitrary extras sitting
/// among diffrel's own fields — and so a future `diffrel` field can never collide with one of
/// these by name.
#[derive(Serialize, Deserialize)]
struct ExportedComparisonResult {
    #[serde(flatten)]
    export: ComparisonResultExport,
    #[serde(rename = "processModel")]
    process_model: ProcessModelExtras,
}

/// `layout` (canvas node positions + edge routing) is opaque to Rust — a `ProcessModelLayout` on
/// the TS side, which this crate has no reason to understand the internals of (it references a
/// vendored, TS-only `EdgeRouting` type). `export_comparison_result` never populates it: the live
/// canvas state it describes only exists in the frontend, added via a plain object spread just
/// before the file is written (`saveComparisonResultExport`) — no serde involved at that step at
/// all. `import_comparison_result` is the one place this field matters: a previously-written file
/// genuinely has `layout` in its bytes, and without declaring the field here, serde's default
/// "ignore unknown keys" deserialization would silently drop it on the way back in.
#[derive(Serialize, Deserialize)]
struct ProcessModelExtras {
    dfg: ProcessModelDfg,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    layout: Option<serde_json::Value>,
}

/// Packages the last `run_mixed_comparison` result (plus every drilldown computed since, via
/// `run_drilldown`/`run_drilldown_batch` mutating `AppState.last_result` in place) into an
/// exportable document. Errors if no comparison has been run yet in this session.
#[tauri::command]
async fn export_comparison_result(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    log_1_path: Option<String>,
    log_2_path: Option<String>,
) -> Result<ExportedComparisonResult, String> {
    let (log1, log2, config, result) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let log1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let log2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        let config = guard.last_config.clone().ok_or("No comparison has been run yet")?;
        let result = guard.last_result.clone().ok_or("No comparison has been run yet")?;
        (log1, log2, config, result)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let allowed: Option<HashSet<&str>> = config
            .e2e_object_types
            .as_ref()
            .map(|v| v.iter().map(String::as_str).collect());
        let dfg = build_process_model_dfg(log1.as_ref(), log2.as_ref(), allowed.as_ref());
        let export = ComparisonResultExport::new(result, &config, log1.as_ref(), log_1_path, log2.as_ref(), log_2_path);
        Ok(ExportedComparisonResult { export, process_model: ProcessModelExtras { dfg, layout: None } })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Parses a file previously written by `export_comparison_result` (plus `layout`, added by the
/// frontend before saving into `processModel.layout` — see `ProcessModelExtras`). Real
/// `serde_json` deserialization, not frontend shape-checking — fails with a precise "missing/
/// mismatched field X" error rather than surfacing as an `undefined` somewhere deep in rendering.
/// Doesn't touch `AppState` or take a `state` param: importing an already-computed result doesn't
/// need the logs, cached comparison, or anything else live in this session — it's a pure parse.
#[tauri::command]
fn import_comparison_result(contents: String) -> Result<ExportedComparisonResult, String> {
    serde_json::from_str(&contents).map_err(|e| e.to_string())
}

// `viz_layout::GraphSpec`/`GraphLayout` deliberately keep their own plain snake_case field names
// (no `#[serde(rename_all = "camelCase")]`, unlike every other command's DTOs in this file) —
// matches how propel's own TS-side spec builder addresses this same crate, and keeps the vendored
// TS glue (`vendor/rust-layout/index.ts`) and this crate both byte-for-byte upstream-identical.
#[tauri::command]
fn layout_graph(spec: viz_layout::GraphSpec) -> Result<viz_layout::GraphLayout, String> {
    viz_layout::layout_graph(spec)
}

#[tauri::command]
fn reroute_graph(spec: viz_layout::GraphSpec) -> Result<viz_layout::GraphLayout, String> {
    viz_layout::reroute_graph(spec)
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

/// Counts directly-follows edges, keyed by `(from_activity, to_activity, qualifier)`, by walking
/// each object's own event trace (sorted by time), pairing only strictly adjacent events — the
/// same event-pairing primitive diffrel's own E2E extraction uses, but restricted to adjacent
/// pairs (directly-follows, not eventually-follows).
fn count_directly_follows_edges<'a>(
    locel: &'a SlimLinkedOCEL,
    allowed_object_types: Option<&HashSet<&str>>,
    mode: QualifierMode,
) -> HashMap<(&'a str, &'a str, Vec<&'a str>), u32> {
    let mut edge_counts = HashMap::new();

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
                    *edge_counts.entry((from, to, qualifier)).or_insert(0u32) += 1;
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
                *edge_counts.entry((from, to, qualifier)).or_insert(0u32) += 1;
            }
        }
    }

    edge_counts
}

/// Joint DFG edges: union of both logs' directly-follows edges. Returned unfiltered, with each
/// edge's raw count per log — the frontend computes the fan-out ratio (grouping by `(from,
/// qualifier)` and summing `countLogN`) and applies its own user-adjustable threshold (see
/// `DfgEdgeSkeleton`'s doc comment).
fn discover_directly_follows_edges<'a>(
    log1: &'a SlimLinkedOCEL,
    log2: &'a SlimLinkedOCEL,
    allowed_object_types: Option<&HashSet<&str>>,
) -> Vec<DfgEdgeSkeleton> {
    let edges_1 = count_directly_follows_edges(log1, allowed_object_types, QUALIFIER_MODE);
    let edges_2 = count_directly_follows_edges(log2, allowed_object_types, QUALIFIER_MODE);

    let all_keys: HashSet<_> = edges_1.keys().chain(edges_2.keys()).cloned().collect();

    all_keys
        .into_iter()
        .map(|(from, to, qualifier)| {
            let count_1 = edges_1.get(&(from, to, qualifier.clone())).copied().unwrap_or(0);
            let count_2 = edges_2.get(&(from, to, qualifier.clone())).copied().unwrap_or(0);
            DfgEdgeSkeleton {
                from: from.to_owned(),
                to: to.to_owned(),
                qualifier: qualifier.into_iter().map(str::to_owned).collect(),
                count_log1: count_1,
                count_log2: count_2,
            }
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
            discover_process_model,
            export_comparison_result,
            import_comparison_result,
            layout_graph,
            reroute_graph
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
