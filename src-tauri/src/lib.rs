#![warn(
    clippy::redundant_clone,
    // clippy::doc_markdown,
    clippy::perf,
    missing_debug_implementations,
    rust_2018_idioms
)]

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use diffrel::{
    distances::squared_bray_curtis_distance,
    multiple_testing::check_significance_holm_bonferroni,
    permanova::{
        base::{encode_relation_counts, permanova},
        drilldown::drilldown,
        fast_euclidean::permanova as permanova_fast,
    },
    relation_extraction::{
        extract_e2e_relation_counts, extract_e2o_relation_counts, extract_o2e_relation_counts,
        extract_o2o_relation_counts, OcelRelationshipCounter, Qualifier,
    },
};

use process_mining::{
    core::event_data::object_centric::linked_ocel::{LinkedOCELAccess, SlimLinkedOCEL},
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

impl RelationMode {
    pub fn extract_counts<'a>(
        self,
        locel: &'a SlimLinkedOCEL,
        allowed_object_types: Option<&HashSet<&str>>,
    ) -> OcelRelationshipCounter<'a> {
        match self {
            RelationMode::E2O => extract_e2o_relation_counts(locel),
            RelationMode::O2O => extract_o2o_relation_counts(locel),
            RelationMode::O2E => extract_o2e_relation_counts(locel),
            RelationMode::E2E => extract_e2e_relation_counts(locel, allowed_object_types),
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
async fn run_mixed_comparison(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    blocks: Vec<BlockParam>,
    distance_mode: DistanceMode,
    num_permutations: usize,
    seed: Option<u64>,
    alpha: f64,
    allowed_object_types: Option<Vec<String>>,
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
            (RelationMode::E2O.extract_counts(&log1, allowed), RelationMode::E2O.extract_counts(&log2, allowed))
        });
        let o2o = blocks.iter().any(|b| b.mode == RelationMode::O2O).then(|| {
            (RelationMode::O2O.extract_counts(&log1, allowed), RelationMode::O2O.extract_counts(&log2, allowed))
        });
        let o2e = blocks.iter().any(|b| b.mode == RelationMode::O2E).then(|| {
            (RelationMode::O2E.extract_counts(&log1, allowed), RelationMode::O2E.extract_counts(&log2, allowed))
        });
        let e2e = blocks.iter().any(|b| b.mode == RelationMode::E2E).then(|| {
            (RelationMode::E2E.extract_counts(&log1, allowed), RelationMode::E2E.extract_counts(&log2, allowed))
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
        let counts_1 = mode.extract_counts(&log1, allowed);
        let counts_2 = mode.extract_counts(&log2, allowed);

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
async fn run_drilldown(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    group_key: String,
    mode: RelationMode,
    num_permutations: usize,
    alpha: f64,
    allowed_object_types: Option<Vec<String>>,
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
        let mut counts_1 = mode.extract_counts(&log1, allowed);
        let mut counts_2 = mode.extract_counts(&log2, allowed);

        let rel_counts_1 = counts_1
            .remove(group_key.as_str())
            .ok_or_else(|| format!("'{}' not in log 1", group_key))?;
        let rel_counts_2 = counts_2
            .remove(group_key.as_str())
            .ok_or_else(|| format!("'{}' not in log 2", group_key))?;

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

        let sample_1 = encode_relation_counts(&rel_counts_1, &ordered_relation_types);
        let sample_2 = encode_relation_counts(&rel_counts_2, &ordered_relation_types);

        let drill_results = drilldown(
            &sample_1,
            &sample_2,
            num_permutations,
            42,
            &ordered_relation_types,
        )
        .map_err(|e| e.to_string())?;

        let results = drill_results
            .into_iter()
            .map(|((q, ot), res)| DrilldownRelationResult {
                qualifier: q.to_string(),
                object_type: ot.to_string(),
                p_value: res.p_value,
                is_significant: res.p_value <= alpha,
                pseudo_f: res.pseudo_f,
            })
            .collect();

        Ok(DrilldownOutput { results })
    })
    .await
    .map_err(|e| e.to_string())?
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
            run_drilldown
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
