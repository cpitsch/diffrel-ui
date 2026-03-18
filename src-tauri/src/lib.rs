use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use diffrel::{
    multiple_testing::check_significance_holm_bonferroni,
    per_relation::extract_e2o_relation_counts,
    permanova::{encode_relation_counts, permanova},
};
use process_mining::core::event_data::object_centric::{ocel_xml::import_ocel_xml_path, OCEL};
use serde::Serialize;

// ── DTOs ──────────────────────────────────────────────────────────────────────

/// Summary returned after loading an OCEL file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogSummary {
    event_count: usize,
    event_type_count: usize,
    /// All event type names present in this log.
    event_types: Vec<String>,
}

/// Median count of a specific (qualifier, object_type) relationship per log.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectTypeRelation {
    qualifier: String,
    object_type: String,
    /// Median relationship count per event in log 1.
    median_log1: f64,
    /// Median relationship count per event in log 2.
    median_log2: f64,
}

/// PERMANOVA result for one event type present in both logs and selected for testing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventTypeResult {
    /// Holm-Bonferroni corrected p-value.
    p_value: f64,
    /// Whether the result is statistically significant at the given alpha level.
    is_significant: bool,
    /// PERMANOVA pseudo-F statistic.
    pseudo_f: f64,
    /// Number of events of this type in log 1.
    n1: usize,
    /// Number of events of this type in log 2.
    n2: usize,
    /// One entry per distinct (qualifier, object_type) pair across both logs.
    object_type_relations: Vec<ObjectTypeRelation>,
}

/// Complete output of comparing two OCEL logs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComparisonOutput {
    /// Tested event types (in both logs and selected) with PERMANOVA + Holm-Bonferroni results.
    results: HashMap<String, EventTypeResult>,
    /// Event types appearing only in log 1 (no comparison possible).
    only_in_log1: Vec<String>,
    /// Event types appearing only in log 2 (no comparison possible).
    only_in_log2: Vec<String>,
}

// ── App State ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct AppState {
    log1: Option<OCEL>,
    log2: Option<OCEL>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn median(values: &mut Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 0 {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    } else {
        values[n / 2]
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn load_log(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    path: String,
    log_index: u8,
) -> Result<LogSummary, String> {
    let ocel = import_ocel_xml_path(&path).map_err(|e| e.to_string())?;

    let counts = extract_e2o_relation_counts(&ocel);
    let mut event_types: Vec<String> = counts.keys().map(|s| s.to_string()).collect();
    event_types.sort();
    let event_type_count = event_types.len();
    let event_count = ocel.events.len();

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    match log_index {
        0 => guard.log1 = Some(ocel),
        1 => guard.log2 = Some(ocel),
        _ => return Err(format!("Invalid log_index {log_index}: must be 0 or 1")),
    }

    Ok(LogSummary {
        event_count,
        event_type_count,
        event_types,
    })
}

#[tauri::command]
async fn run_comparison(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    num_permutations: usize,
    seed: Option<u64>,
    alpha: f64,
    selected_event_types: Option<Vec<String>>,
) -> Result<ComparisonOutput, String> {
    // Move the Arc into a blocking thread so the heavy PERMANOVA computation
    // doesn't block the async runtime or the UI message loop.
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let log1 = guard.log1.as_ref().ok_or("Log 1 not loaded")?;
    let log2 = guard.log2.as_ref().ok_or("Log 2 not loaded")?;

    let counts_1 = extract_e2o_relation_counts(log1);
    let counts_2 = extract_e2o_relation_counts(log2);

    let all_event_types: HashSet<&str> =
        counts_1.keys().chain(counts_2.keys()).copied().collect();

    let mut only_in_log1: Vec<String> = Vec::new();
    let mut only_in_log2: Vec<String> = Vec::new();
    // (pseudo_f, p_value, n1, n2, object_type_relations)
    let mut intermediate: HashMap<String, (f64, f64, usize, usize, Vec<ObjectTypeRelation>)> = HashMap::new();

    for &event_type in &all_event_types {
        let in_log1 = counts_1.contains_key(event_type);
        let in_log2 = counts_2.contains_key(event_type);

        if !in_log2 {
            only_in_log1.push(event_type.to_owned());
            continue;
        }
        if !in_log1 {
            only_in_log2.push(event_type.to_owned());
            continue;
        }

        // Skip if caller restricted to a subset of event types
        if let Some(ref selected) = selected_event_types {
            if !selected.iter().any(|s| s == event_type) {
                continue;
            }
        }

        let rel_counts_1 = counts_1.get(event_type).unwrap();
        let rel_counts_2 = counts_2.get(event_type).unwrap();

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
            permanova(sample_1, sample_2, num_permutations, seed).map_err(|e| e.to_string())?;

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
                ObjectTypeRelation {
                    qualifier: qualifier.to_owned(),
                    object_type: object_type.to_owned(),
                    median_log1: median(&mut vals_1),
                    median_log2: median(&mut vals_2),
                }
            })
            .collect();

        intermediate.insert(
            event_type.to_owned(),
            (res.pseudo_f, res.p_value, n1, n2, object_type_relations),
        );
    }

    // Debug: print raw p-values before correction
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
        .map(|(event_type, (pseudo_f, _, n1, n2, object_type_relations))| {
            let (p_value, is_significant) =
                significance.get(&event_type).copied().unwrap_or((1.0, false));
            (
                event_type,
                EventTypeResult {
                    p_value,
                    is_significant,
                    pseudo_f,
                    n1,
                    n2,
                    object_type_relations,
                },
            )
        })
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

// ── Entry ─────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(AppState::default())))
        .invoke_handler(tauri::generate_handler![load_log, run_comparison])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
