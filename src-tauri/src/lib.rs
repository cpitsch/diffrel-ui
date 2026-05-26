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
    multiple_testing::check_significance_holm_bonferroni,
    permanova::{encode_relation_counts, permanova},
    permanova_drilldown::drilldown,
    relation_extraction::{
        OcelIndex, OcelRelationshipCounter, extract_e2o_relation_counts,
        extract_o2o_relation_counts, extract_o2e_relation_counts,
    },
};
use process_mining::{Importable, OCEL};
use serde::{Deserialize, Serialize};

// ── Relation mode ──────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone, Copy)]
enum RelationMode {
    E2O,
    O2O,
    O2E,
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

/// Summary returned after loading an OCEL file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogSummary {
    event_count: usize,
    event_type_count: usize,
    /// All event type names present in this log.
    event_types: Vec<String>,
    /// Number of distinct object types.
    object_type_count: usize,
    /// All object type names present in this log.
    object_types: Vec<String>,
    /// Number of distinct (event_type, qualifier, object_type) triples.
    e2o_relation_type_count: usize,
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

/// PERMANOVA result for one group key present in both logs and selected for testing.
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
    /// Tested group keys (in both logs and selected) with PERMANOVA + Holm-Bonferroni results.
    results: HashMap<String, EventTypeResult>,
    /// Group keys appearing only in log 1 (no comparison possible).
    only_in_log1: Vec<String>,
    /// Group keys appearing only in log 2 (no comparison possible).
    only_in_log2: Vec<String>,
}

// ── App State ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct AppState {
    log1: Option<Arc<OCEL>>,
    log2: Option<Arc<OCEL>>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n == 0 {
        return 0.0;
    }
    if n.is_multiple_of(2) {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    } else {
        values[n / 2]
    }
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

fn std_dev(values: &[f64], m: f64) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let variance = values.iter().map(|v| (v - m).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
    variance.sqrt()
}

fn extract_counts_for_mode<'a>(
    index: &OcelIndex<'a>,
    mode: RelationMode,
) -> OcelRelationshipCounter<'a> {
    match mode {
        RelationMode::E2O => extract_e2o_relation_counts(index),
        RelationMode::O2O => extract_o2o_relation_counts(index),
        RelationMode::O2E => extract_o2e_relation_counts(index),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn load_log(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    path: String,
    log_index: u8,
) -> Result<LogSummary, String> {
    let ocel = OCEL::import_from_path(&path).map_err(|e| e.to_string())?;

    let mut event_types: Vec<String> = ocel
        .event_types
        .iter()
        .map(|et| et.name.clone())
        .collect();
    event_types.sort();

    let mut object_types: Vec<String> = ocel
        .object_types
        .iter()
        .map(|ot| ot.name.clone())
        .collect();
    object_types.sort();

    let event_count = ocel.events.len();
    let event_type_count = event_types.len();
    let object_type_count = object_types.len();

    let e2o_relation_type_count = {
        let obj_type: HashMap<&str, &str> = ocel
            .objects
            .iter()
            .map(|o| (o.id.as_str(), o.object_type.as_str()))
            .collect();
        ocel.events
            .iter()
            .flat_map(|ev| {
                ev.relationships.iter().filter_map(|rel| {
                    obj_type
                        .get(rel.object_id.as_str())
                        .map(|&ot| (ev.event_type.as_str(), rel.qualifier.as_str(), ot))
                })
            })
            .collect::<HashSet<_>>()
            .len()
    };

    let summary = LogSummary {
        event_count,
        event_type_count,
        event_types,
        object_type_count,
        object_types,
        e2o_relation_type_count,
    };

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    match log_index {
        0 => guard.log1 = Some(Arc::new(ocel)),
        1 => guard.log2 = Some(Arc::new(ocel)),
        _ => return Err(format!("Invalid log_index {log_index}: must be 0 or 1")),
    }

    Ok(summary)
}

#[tauri::command]
async fn run_comparison(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    num_permutations: usize,
    seed: Option<u64>,
    alpha: f64,
    mode: RelationMode,
    selected_types: Option<Vec<String>>,
) -> Result<ComparisonOutput, String> {
    // Clone Arc handles out of state, releasing the lock immediately.
    let (log1, log2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        (l1, l2)
    }; // lock released here

    tauri::async_runtime::spawn_blocking(move || {
        let index_1 = OcelIndex::from(log1.as_ref());
        let index_2 = OcelIndex::from(log2.as_ref());
        let counts_1 = extract_counts_for_mode(&index_1, mode);
        let counts_2 = extract_counts_for_mode(&index_2, mode);

        let all_keys: HashSet<&str> =
            counts_1.keys().chain(counts_2.keys()).copied().collect();

        let mut only_in_log1: Vec<String> = Vec::new();
        let mut only_in_log2: Vec<String> = Vec::new();
        // (pseudo_f, p_value, n1, n2, object_type_relations)
        let mut intermediate: HashMap<String, (f64, f64, usize, usize, Vec<ObjectTypeRelation>)> =
            HashMap::new();

        for &key in &all_keys {
            let in_log1 = counts_1.contains_key(key);
            let in_log2 = counts_2.contains_key(key);

            if !in_log2 {
                only_in_log1.push(key.to_owned());
                continue;
            }
            if !in_log1 {
                only_in_log2.push(key.to_owned());
                continue;
            }

            // Skip if caller restricted to a subset of group keys
            if let Some(ref selected) = selected_types {
                if !selected.iter().any(|s| s == key) {
                    continue;
                }
            }

            let rel_counts_1 = counts_1.get(key).unwrap();
            let rel_counts_2 = counts_2.get(key).unwrap();

            // Merged feature set: union of all (qualifier, object_type) keys from both logs
            let ordered_relation_types: Vec<(&str, &str)> = rel_counts_1
                .iter()
                .chain(rel_counts_2.iter())
                .flat_map(|x| x.keys())
                .collect::<HashSet<_>>()
                .into_iter()
                .cloned()
                .collect();

            if ordered_relation_types.is_empty() {
                continue;
            }

            let n1 = rel_counts_1.len();
            let n2 = rel_counts_2.len();

            let sample_1 = encode_relation_counts(rel_counts_1, &ordered_relation_types);
            let sample_2 = encode_relation_counts(rel_counts_2, &ordered_relation_types);

            let res =
                permanova(&sample_1, &sample_2, num_permutations, seed).map_err(|e| e.to_string())?;

            let object_type_relations: Vec<ObjectTypeRelation> = ordered_relation_types
                .iter()
                .map(|&(qualifier, object_type)| {
                    let mut vals_1: Vec<f64> = rel_counts_1
                        .iter()
                        .map(|ev| *ev.get(&(qualifier, object_type)).unwrap_or(&0) as f64)
                        .collect();
                    let mut vals_2: Vec<f64> = rel_counts_2
                        .iter()
                        .map(|ev| *ev.get(&(qualifier, object_type)).unwrap_or(&0) as f64)
                        .collect();
                    let m1 = mean(&vals_1);
                    let m2 = mean(&vals_2);
                    ObjectTypeRelation {
                        qualifier: qualifier.to_owned(),
                        object_type: object_type.to_owned(),
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
                key.to_owned(),
                (res.pseudo_f, res.p_value, n1, n2, object_type_relations),
            );
        }

        // Apply Holm-Bonferroni correction; convert keys to owned Strings immediately
        let significance: HashMap<String, (f64, bool)> = {
            let pvals: HashMap<&str, f64> = intermediate
                .iter()
                .map(|(k, (_, p, _, _, _))| (k.as_str(), *p))
                .collect();
            check_significance_holm_bonferroni(pvals, alpha)
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect()
        };

        let results: HashMap<String, EventTypeResult> = intermediate
            .into_iter()
            .map(
                |(key, (pseudo_f, _, n1, n2, object_type_relations))| {
                    let (p_value, is_significant) = significance
                        .get(&key)
                        .copied()
                        .unwrap_or((1.0, false));
                    (
                        key,
                        EventTypeResult {
                            p_value,
                            is_significant,
                            pseudo_f,
                            n1,
                            n2,
                            object_type_relations,
                        },
                    )
                },
            )
            .collect();

        Ok(ComparisonOutput {
            results,
            only_in_log1,
            only_in_log2,
        })
    }) // end spawn_blocking
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
) -> Result<DrilldownOutput, String> {
    let (log1, log2) = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        let l1 = guard.log1.clone().ok_or("Log 1 not loaded")?;
        let l2 = guard.log2.clone().ok_or("Log 2 not loaded")?;
        (l1, l2)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let index_1 = OcelIndex::from(log1.as_ref());
        let index_2 = OcelIndex::from(log2.as_ref());
        let mut counts_1 = extract_counts_for_mode(&index_1, mode);
        let mut counts_2 = extract_counts_for_mode(&index_2, mode);

        let rel_counts_1 = counts_1
            .remove(group_key.as_str())
            .ok_or_else(|| format!("'{}' not in log 1", group_key))?;
        let rel_counts_2 = counts_2
            .remove(group_key.as_str())
            .ok_or_else(|| format!("'{}' not in log 2", group_key))?;

        let ordered_relation_types: Vec<(&str, &str)> = rel_counts_1
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

// ── Entry ─────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(AppState::default())))
        .invoke_handler(tauri::generate_handler![
            load_log,
            run_comparison,
            run_drilldown
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
