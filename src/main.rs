//! Full E2O/O2O/O2E/E2E PERMANOVA comparison between two OCELs, with multiple-testing
//! correction and Westfall-Young drilldown on every significant result.
//!
//! Meant for baseline "no difference expected" checks: the interactive process-model
//! view's layout isn't useful there, just which tests came back significant and which
//! specific relations drove it.

use std::{
    collections::{HashMap, HashSet},
    hash::Hash,
    path::PathBuf,
};

use clap::{Parser, ValueEnum};
use serde::Serialize;

use diffrel::{
    dependency_components::{
        compute_dependency_components, compute_divergent_pairs, singleton_components,
    },
    distances::squared_bray_curtis_distance,
    effect_size::cliffs_delta,
    multiple_testing::{check_significance_benjamini_hochberg, check_significance_holm_bonferroni},
    permanova::{
        base::{encode_relation_counts, restricted_permanova},
        drilldown::drilldown,
        fast_euclidean::permanova as permanova_fast,
        PermAnovaResult,
    },
    relation_extraction::{
        extract_e2e_relation_counts, extract_e2o_relation_counts, extract_o2e_relation_counts,
        extract_o2o_relation_counts, E2ERelationType, OcelEventRelationshipCounter,
        OcelObjectRelationshipCounter, Qualifier, RelationshipCount,
    },
};
use process_mining::{
    core::event_data::object_centric::linked_ocel::{LinkedOCELAccess, SlimLinkedOCEL},
    Importable,
};

/// Full E2O/O2O/O2E/E2E PERMANOVA comparison between two OCELs.
#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// Path to the first OCEL (.xml, .xml.gz, .json, .json.gz, .sqlite, .db)
    log1: PathBuf,
    /// Path to the second OCEL
    log2: PathBuf,

    /// Number of permutations for each PERMANOVA test
    #[arg(long, default_value_t = 1000)]
    permutations: usize,

    /// Significance level, applied after multiple-testing correction
    #[arg(long, default_value_t = 0.05)]
    alpha: f64,

    /// Permutation seed. A drilldown on a significant block reuses this same seed, so
    /// fixing it (the default) makes a whole run reproducible.
    #[arg(long, default_value_t = 42)]
    seed: u64,

    /// Distance measure for the PERMANOVA tests
    #[arg(long, value_enum, default_value_t = Distance::BrayCurtis)]
    distance: Distance,

    /// Multiple-testing correction, applied jointly across all E2O/O2O/O2E/E2E tests
    #[arg(long, value_enum, default_value_t = Correction::Holm)]
    correction: Correction,

    /// Whether an E2E relation counts every eventually-following shared-object event, or
    /// only the directly-next one
    #[arg(long, value_enum, default_value_t = Follows::Eventually)]
    follows: Follows,

    /// Whether an E2E pair mediated by several object types produces one relation per
    /// object type ("single") or one combined relation ("grouped")
    #[arg(long, value_enum, default_value_t = QualifierMode::Single)]
    qualifier: QualifierMode,

    /// Row-grouping scheme for the permutation. `executions` uses divergence-pruned
    /// connected components (van Detten et al., ICPM 2024) — the correct choice when
    /// the log contains pseudo-replication. `singletons` recovers free permutation
    /// over rows. Panics on `--distance euclidean --grouping executions` (the fast
    /// Euclidean path does not yet support restricted permutation).
    #[arg(long, value_enum, default_value_t = Grouping::Executions)]
    grouping: Grouping,

    /// Restrict which object types may mediate an E2E relation (comma-separated). Also
    /// restricts which object types get O2O/O2E blocks. Default: no restriction.
    #[arg(long, value_delimiter = ',')]
    object_types: Vec<String>,

    /// Output format. `json` writes a single pretty-printed JSON object to stdout and
    /// nothing else, for scripting with e.g. `jq`.
    #[arg(long, value_enum, default_value_t = Format::Text)]
    format: Format,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Distance {
    BrayCurtis,
    Euclidean,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Correction {
    Holm,
    Bh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Follows {
    Directly,
    Eventually,
}

impl From<Follows> for E2ERelationType {
    fn from(f: Follows) -> Self {
        match f {
            Follows::Directly => E2ERelationType::DirectlyFollows,
            Follows::Eventually => E2ERelationType::EventuallyFollows,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize)]
#[serde(rename_all = "kebab-case")]
enum QualifierMode {
    Single,
    Grouped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Grouping {
    Executions,
    Singletons,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Format {
    Text,
    Json,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Mode {
    E2o,
    O2o,
    O2e,
    E2e,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::E2o => "E2O",
            Mode::O2o => "O2O",
            Mode::O2e => "O2E",
            Mode::E2e => "E2E",
        }
    }
}

/// One (mode, group_key) block that was actually tested.
struct Block<'a> {
    mode: Mode,
    group_key: &'a str,
    id: String,
    result: PermAnovaResult,
    n1: usize,
    n2: usize,
    ordered_relation_types: Vec<(Qualifier<'a>, &'a str)>,
    /// Per-row component ids in log 1, aligned with the encoded sample rows.
    /// Kept alongside the result so drilldown can reuse the same restricted-
    /// permutation scheme as the original test.
    component_ids_1: Vec<usize>,
    /// Per-row component ids in log 2, aligned with the encoded sample rows.
    component_ids_2: Vec<usize>,
}

/// One relation-type row from drilling down on a significant block, alongside its
/// Cliff's delta effect size. Produced by [`compute_drilldowns`] and consumed by both
/// the text and JSON renderers.
type DrilldownRow<'a> = (Qualifier<'a>, &'a str, PermAnovaResult, f64);

#[derive(Serialize)]
struct RunOutput<'a> {
    log1: LogInfo,
    log2: LogInfo,
    params: RunParams,
    blocks: Vec<BlockOutput<'a>>,
    skipped: Vec<SkippedOutput<'a>>,
    type_diffs: TypeDiffs<'a>,
    summary: Summary,
}

#[derive(Serialize)]
struct LogInfo {
    path: String,
    num_events: usize,
    num_event_types: usize,
    num_objects: usize,
    num_object_types: usize,
}

#[derive(Serialize)]
struct RunParams {
    permutations: usize,
    alpha: f64,
    seed: u64,
    distance: Distance,
    correction: Correction,
    follows: Follows,
    qualifier: QualifierMode,
    grouping: Grouping,
    /// Empty = no restriction, mirroring the CLI's own default for `--object-types`.
    object_types: Vec<String>,
}

#[derive(Serialize)]
struct BlockOutput<'a> {
    id: &'a str,
    mode: &'static str,
    group_key: &'a str,
    n1: usize,
    n2: usize,
    pseudo_f: f64,
    p_value: f64,
    significant: bool,
    drilldown: Vec<RelationOutput<'a>>,
    drilldown_error: Option<String>,
}

#[derive(Serialize)]
struct RelationOutput<'a> {
    qualifier: String,
    target: &'a str,
    pseudo_f: f64,
    p_value: f64,
    significant: bool,
    cliffs_delta: f64,
}

#[derive(Serialize)]
struct SkippedOutput<'a> {
    mode: &'static str,
    group_key: &'a str,
    reason: &'a str,
}

#[derive(Serialize)]
struct TypeDiffs<'a> {
    event_types_only_in_log1: Vec<&'a str>,
    event_types_only_in_log2: Vec<&'a str>,
    object_types_only_in_log1: Vec<&'a str>,
    object_types_only_in_log2: Vec<&'a str>,
}

#[derive(Serialize)]
struct Summary {
    total_blocks: usize,
    significant_blocks: usize,
    alpha: f64,
    correction: Correction,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let log1 = SlimLinkedOCEL::import_from_path(&args.log1)
        .map_err(|e| format!("failed to load {}: {e}", args.log1.display()))?;
    let log2 = SlimLinkedOCEL::import_from_path(&args.log2)
        .map_err(|e| format!("failed to load {}: {e}", args.log2.display()))?;

    let components_1 = match args.grouping {
        Grouping::Executions => compute_dependency_components(&log1),
        Grouping::Singletons => singleton_components(&log1),
    };
    let components_2 = match args.grouping {
        Grouping::Executions => compute_dependency_components(&log2),
        Grouping::Singletons => singleton_components(&log2),
    };

    let divergent_pairs_1 = compute_divergent_pairs(&log1);
    let divergent_pairs_2 = compute_divergent_pairs(&log2);

    let ev_types_1: HashSet<&str> = log1.get_ev_types().collect();
    let ev_types_2: HashSet<&str> = log2.get_ev_types().collect();
    let mut event_types: Vec<&str> = ev_types_1.intersection(&ev_types_2).copied().collect();
    event_types.sort_unstable();

    let ob_types_1: HashSet<&str> = log1.get_ob_types().collect();
    let ob_types_2: HashSet<&str> = log2.get_ob_types().collect();
    let mut object_types: Vec<&str> = ob_types_1.intersection(&ob_types_2).copied().collect();
    object_types.sort_unstable();

    let allowed_object_types: Option<HashSet<&str>> = if args.object_types.is_empty() {
        None
    } else {
        let allowed: HashSet<&str> = args.object_types.iter().map(String::as_str).collect();
        object_types.retain(|t| allowed.contains(t));
        Some(allowed)
    };

    let merge_object_types = args.qualifier == QualifierMode::Grouped;
    let e2e_type: E2ERelationType = args.follows.into();

    if args.format == Format::Text {
        println!("diffrel-cli: full E2O/O2O/O2E/E2E comparison\n");
        println!(
            "  log 1: {} ({} events, {} event types, {} objects, {} object types)",
            args.log1.display(),
            log1.get_num_evs(),
            ev_types_1.len(),
            log1.get_num_obs(),
            ob_types_1.len()
        );
        println!(
            "  log 2: {} ({} events, {} event types, {} objects, {} object types)",
            args.log2.display(),
            log2.get_num_evs(),
            ev_types_2.len(),
            log2.get_num_obs(),
            ob_types_2.len()
        );
        println!(
            "  distance: {:?}   permutations: {}   alpha: {}   correction: {:?}   seed: {}",
            args.distance, args.permutations, args.alpha, args.correction, args.seed
        );
        println!(
            "  E2E follows: {:?}   E2E qualifier: {:?}",
            args.follows, args.qualifier
        );

        let num_components_1 = components_1
            .events
            .values()
            .chain(components_1.objects.values())
            .copied()
            .collect::<HashSet<_>>()
            .len();
        let num_components_2 = components_2
            .events
            .values()
            .chain(components_2.objects.values())
            .copied()
            .collect::<HashSet<_>>()
            .len();
        println!(
            "  grouping: {:?}   log 1 components: {}   log 2 components: {}",
            args.grouping, num_components_1, num_components_2
        );

        let mut div_1: Vec<_> = divergent_pairs_1.iter().collect();
        div_1.sort();
        println!(
            "  log 1 divergent (event, object) pairs ({}):{}",
            divergent_pairs_1.len(),
            if div_1.is_empty() { " none" } else { "" }
        );
        for (et, ot) in &div_1 {
            println!("    ({et}, {ot})");
        }
        let mut div_2: Vec<_> = divergent_pairs_2.iter().collect();
        div_2.sort();
        println!(
            "  log 2 divergent (event, object) pairs ({}):{}",
            divergent_pairs_2.len(),
            if div_2.is_empty() { " none" } else { "" }
        );
        for (et, ot) in &div_2 {
            println!("    ({et}, {ot})");
        }
    }

    let only_in_log1_evt = sorted_diff(&ev_types_1, &ev_types_2);
    let only_in_log2_evt = sorted_diff(&ev_types_2, &ev_types_1);
    let only_in_log1_obt = sorted_diff(&ob_types_1, &ob_types_2);
    let only_in_log2_obt = sorted_diff(&ob_types_2, &ob_types_1);

    // Extract relation counts once per mode, shared across every group key.
    let e2o_1 = extract_e2o_relation_counts(&log1);
    let e2o_2 = extract_e2o_relation_counts(&log2);
    let o2o_1 = extract_o2o_relation_counts(&log1);
    let o2o_2 = extract_o2o_relation_counts(&log2);
    let o2e_1 = extract_o2e_relation_counts(&log1);
    let o2e_2 = extract_o2e_relation_counts(&log2);
    let e2e_1 = extract_e2e_relation_counts(
        &log1,
        allowed_object_types.as_ref(),
        Some(e2e_type),
        merge_object_types,
    );
    let e2e_2 = extract_e2e_relation_counts(
        &log2,
        allowed_object_types.as_ref(),
        Some(e2e_type),
        merge_object_types,
    );

    let mut blocks: Vec<Block<'_>> = Vec::new();
    let mut skipped: Vec<(Mode, &str, String)> = Vec::new();

    test_blocks(
        Mode::E2o, &e2o_1.0, &e2o_2.0, &components_1.events, &components_2.events,
        &event_types, args.distance, args.grouping, args.permutations, args.seed,
        &mut blocks, &mut skipped,
    );
    test_blocks(
        Mode::E2e, &e2e_1.0, &e2e_2.0, &components_1.events, &components_2.events,
        &event_types, args.distance, args.grouping, args.permutations, args.seed,
        &mut blocks, &mut skipped,
    );
    test_blocks(
        Mode::O2o, &o2o_1.0, &o2o_2.0, &components_1.objects, &components_2.objects,
        &object_types, args.distance, args.grouping, args.permutations, args.seed,
        &mut blocks, &mut skipped,
    );
    test_blocks(
        Mode::O2e, &o2e_1.0, &o2e_2.0, &components_1.objects, &components_2.objects,
        &object_types, args.distance, args.grouping, args.permutations, args.seed,
        &mut blocks, &mut skipped,
    );

    // Ids are collected into their own Vec so `significance`'s borrowed keys don't tie up
    // `blocks` itself, which still needs to be sorted (mutably borrowed) below.
    let ids: Vec<String> = blocks.iter().map(|b| b.id.clone()).collect();
    let pvals: HashMap<&str, f64> = ids
        .iter()
        .zip(&blocks)
        .map(|(id, b)| (id.as_str(), b.result.p_value))
        .collect();
    let significance: HashMap<&str, (f64, bool)> = match args.correction {
        Correction::Holm => check_significance_holm_bonferroni(pvals, args.alpha),
        Correction::Bh => check_significance_benjamini_hochberg(pvals, args.alpha),
    };
    let is_significant = |id: &str| significance.get(id).map(|&(_, sig)| sig).unwrap_or(false);

    // Most interesting first: significant blocks, then ascending p-value.
    blocks.sort_by(|a, b| {
        is_significant(&b.id)
            .cmp(&is_significant(&a.id))
            .then_with(|| a.result.p_value.total_cmp(&b.result.p_value))
    });

    let n_sig = blocks.iter().filter(|b| is_significant(&b.id)).count();

    // Computed once regardless of format: both the text and JSON renderers below need
    // the per-block drilldown rows for every significant block.
    let drilldowns = compute_drilldowns(
        &blocks, is_significant, &e2o_1, &e2o_2, &o2o_1, &o2o_2, &o2e_1, &o2e_2, &e2e_1, &e2e_2,
        &args,
    );

    match args.format {
        Format::Text => {
            let id_width = blocks.iter().map(|b| b.id.len()).max().unwrap_or(5).max(5);
            println!("\n=== Results ({} blocks tested) ===", blocks.len());
            println!(
                "{:<id_width$}  {:>6}  {:>6}  {:>12}  {:>10}  {:>3}",
                "BLOCK", "n1", "n2", "pseudo-F", "p", "sig", id_width = id_width
            );
            for b in &blocks {
                println!(
                    "{:<id_width$}  {:>6}  {:>6}  {:>12.4}  {:>10.4}  {:>3}",
                    b.id,
                    b.n1,
                    b.n2,
                    b.result.pseudo_f,
                    b.result.p_value,
                    if is_significant(&b.id) { "*" } else { "" },
                    id_width = id_width
                );
            }

            println!(
                "\n{n_sig} / {} blocks significant at alpha={} ({:?} correction).",
                blocks.len(),
                args.alpha,
                args.correction
            );

            println!("\n=== Drilldown ===");
            if n_sig == 0 {
                println!("(no significant blocks - nothing to drill into)");
            }
            for (b, drill) in &drilldowns {
                let rows = match drill {
                    Ok(rows) => rows,
                    Err(e) => {
                        println!("\n{} (p={:.4}): drilldown failed: {e}", b.id, b.result.p_value);
                        continue;
                    }
                };

                println!(
                    "\n--- {} (p={:.4}, n1={}, n2={}) ---",
                    b.id, b.result.p_value, b.n1, b.n2
                );
                for (qualifier, target, res, effect_size) in rows {
                    let sig_mark = if res.p_value <= args.alpha { "*" } else { "" };
                    println!(
                        "  {:<20} -> {:<20}  p={:>7.4}{:<1}  pseudo-F={:>10.4}  cliffs_delta={:>7.3}",
                        qualifier.to_string(),
                        target,
                        res.p_value,
                        sig_mark,
                        res.pseudo_f,
                        effect_size
                    );
                }
            }

            if !skipped.is_empty() {
                println!("\n=== Skipped blocks ({}) ===", skipped.len());
                for (mode, group_key, reason) in &skipped {
                    println!("  {}::{group_key}: {reason}", mode.as_str());
                }
            }

            if !only_in_log1_evt.is_empty() || !only_in_log2_evt.is_empty() {
                println!("\nEvent types only in log 1: {only_in_log1_evt:?}");
                println!("Event types only in log 2: {only_in_log2_evt:?}");
            }
            if !only_in_log1_obt.is_empty() || !only_in_log2_obt.is_empty() {
                println!("Object types only in log 1: {only_in_log1_obt:?}");
                println!("Object types only in log 2: {only_in_log2_obt:?}");
            }
        }
        Format::Json => {
            let drilldown_by_id: HashMap<&str, &Result<Vec<DrilldownRow<'_>>, String>> =
                drilldowns.iter().map(|(b, d)| (b.id.as_str(), d)).collect();

            let block_outputs: Vec<BlockOutput<'_>> = blocks
                .iter()
                .map(|b| {
                    let (drilldown, drilldown_error) = match drilldown_by_id.get(b.id.as_str()) {
                        Some(Ok(rows)) => (
                            rows.iter()
                                .map(|(qualifier, target, res, effect_size)| RelationOutput {
                                    qualifier: qualifier.to_string(),
                                    target,
                                    pseudo_f: res.pseudo_f,
                                    p_value: res.p_value,
                                    significant: res.p_value <= args.alpha,
                                    cliffs_delta: *effect_size,
                                })
                                .collect(),
                            None,
                        ),
                        Some(Err(e)) => (Vec::new(), Some(e.clone())),
                        None => (Vec::new(), None),
                    };
                    BlockOutput {
                        id: &b.id,
                        mode: b.mode.as_str(),
                        group_key: b.group_key,
                        n1: b.n1,
                        n2: b.n2,
                        pseudo_f: b.result.pseudo_f,
                        p_value: b.result.p_value,
                        significant: is_significant(&b.id),
                        drilldown,
                        drilldown_error,
                    }
                })
                .collect();

            let skipped_outputs: Vec<SkippedOutput<'_>> = skipped
                .iter()
                .map(|(mode, group_key, reason)| SkippedOutput {
                    mode: mode.as_str(),
                    group_key,
                    reason,
                })
                .collect();

            let output = RunOutput {
                log1: LogInfo {
                    path: args.log1.display().to_string(),
                    num_events: log1.get_num_evs(),
                    num_event_types: ev_types_1.len(),
                    num_objects: log1.get_num_obs(),
                    num_object_types: ob_types_1.len(),
                },
                log2: LogInfo {
                    path: args.log2.display().to_string(),
                    num_events: log2.get_num_evs(),
                    num_event_types: ev_types_2.len(),
                    num_objects: log2.get_num_obs(),
                    num_object_types: ob_types_2.len(),
                },
                params: RunParams {
                    permutations: args.permutations,
                    alpha: args.alpha,
                    seed: args.seed,
                    distance: args.distance,
                    correction: args.correction,
                    follows: args.follows,
                    qualifier: args.qualifier,
                    grouping: args.grouping,
                    object_types: args.object_types.clone(),
                },
                blocks: block_outputs,
                skipped: skipped_outputs,
                type_diffs: TypeDiffs {
                    event_types_only_in_log1: only_in_log1_evt,
                    event_types_only_in_log2: only_in_log2_evt,
                    object_types_only_in_log1: only_in_log1_obt,
                    object_types_only_in_log2: only_in_log2_obt,
                },
                summary: Summary {
                    total_blocks: blocks.len(),
                    significant_blocks: n_sig,
                    alpha: args.alpha,
                    correction: args.correction,
                },
            };

            serde_json::to_writer_pretty(std::io::stdout(), &output)?;
            println!();
        }
    }

    Ok(())
}

/// Runs the drilldown for every significant block, without printing anything. Returns
/// results in the same order as `blocks`, restricted to blocks `is_significant` accepts.
///
/// Re-derives the encoded samples for each block rather than keeping them all in memory
/// from the first pass - only the (typically few) significant blocks pay for this.
/// Dispatch is inlined per mode because the four counter maps have different `T` (event
/// vs object index) types.
#[allow(clippy::too_many_arguments)]
fn compute_drilldowns<'a, E, O>(
    blocks: &'a [Block<'a>],
    is_significant: impl Fn(&str) -> bool,
    e2o_1: &OcelEventRelationshipCounter<'a, E>,
    e2o_2: &OcelEventRelationshipCounter<'a, E>,
    o2o_1: &OcelObjectRelationshipCounter<'a, O>,
    o2o_2: &OcelObjectRelationshipCounter<'a, O>,
    o2e_1: &OcelObjectRelationshipCounter<'a, O>,
    o2e_2: &OcelObjectRelationshipCounter<'a, O>,
    e2e_1: &OcelEventRelationshipCounter<'a, E>,
    e2e_2: &OcelEventRelationshipCounter<'a, E>,
    args: &Args,
) -> Vec<(&'a Block<'a>, Result<Vec<DrilldownRow<'a>>, String>)> {
    blocks
        .iter()
        .filter(|b| is_significant(&b.id))
        .map(|b| {
            let (sample_1, sample_2) = match b.mode {
                Mode::E2o => (
                    encode_relation_counts(&e2o_1.0[b.group_key], &b.ordered_relation_types),
                    encode_relation_counts(&e2o_2.0[b.group_key], &b.ordered_relation_types),
                ),
                Mode::O2o => (
                    encode_relation_counts(&o2o_1.0[b.group_key], &b.ordered_relation_types),
                    encode_relation_counts(&o2o_2.0[b.group_key], &b.ordered_relation_types),
                ),
                Mode::O2e => (
                    encode_relation_counts(&o2e_1.0[b.group_key], &b.ordered_relation_types),
                    encode_relation_counts(&o2e_2.0[b.group_key], &b.ordered_relation_types),
                ),
                Mode::E2e => (
                    encode_relation_counts(&e2e_1.0[b.group_key], &b.ordered_relation_types),
                    encode_relation_counts(&e2e_2.0[b.group_key], &b.ordered_relation_types),
                ),
            };

            let drill = match drilldown(
                &sample_1,
                &sample_2,
                &b.component_ids_1,
                &b.component_ids_2,
                args.permutations,
                args.seed,
                &b.ordered_relation_types,
            ) {
                Ok(d) => d,
                Err(e) => return (b, Err(e.to_string())),
            };

            let relation_index: HashMap<(Qualifier<'_>, &str), usize> = b
                .ordered_relation_types
                .iter()
                .cloned()
                .enumerate()
                .map(|(i, key)| (key, i))
                .collect();

            let mut rows: Vec<DrilldownRow<'a>> = drill
                .into_iter()
                .map(|((qualifier, target), res)| {
                    let effect_size = relation_index
                        .get(&(qualifier.clone(), target))
                        .map(|&idx| {
                            let col_1: Vec<f64> = sample_1.column(idx).iter().copied().collect();
                            let col_2: Vec<f64> = sample_2.column(idx).iter().copied().collect();
                            cliffs_delta(&col_1, &col_2)
                        })
                        .unwrap_or(0.0);
                    (qualifier, target, res, effect_size)
                })
                .collect();
            rows.sort_by(|a, b| a.2.p_value.total_cmp(&b.2.p_value));

            (b, Ok(rows))
        })
        .collect()
}

fn sorted_diff<'a>(a: &HashSet<&'a str>, b: &HashSet<&'a str>) -> Vec<&'a str> {
    let mut v: Vec<&str> = a.difference(b).copied().collect();
    v.sort_unstable();
    v
}

/// Runs a PERMANOVA test for every `group_key` present in both `counts_1` and
/// `counts_2`, appending successes to `blocks` and failures/omissions to `skipped`.
///
/// Generic over the row-identity type `T` (event or object index) so a single
/// function serves E2O/E2E (event rows) and O2O/O2E (object rows).
#[allow(clippy::too_many_arguments)]
fn test_blocks<'a, T>(
    mode: Mode,
    counts_1: &HashMap<&'a str, Vec<(T, RelationshipCount<'a>)>>,
    counts_2: &HashMap<&'a str, Vec<(T, RelationshipCount<'a>)>>,
    components_1: &HashMap<T, usize>,
    components_2: &HashMap<T, usize>,
    group_keys: &[&'a str],
    distance: Distance,
    grouping: Grouping,
    permutations: usize,
    seed: u64,
    blocks: &mut Vec<Block<'a>>,
    skipped: &mut Vec<(Mode, &'a str, String)>,
) where
    T: Eq + Hash + Copy,
{
    for &group_key in group_keys {
        let (Some(rel_counts_1), Some(rel_counts_2)) = (counts_1.get(group_key), counts_2.get(group_key)) else {
            skipped.push((mode, group_key, "not present in both logs' extraction".to_owned()));
            continue;
        };

        let ordered_relation_types: Vec<(Qualifier<'a>, &'a str)> = rel_counts_1
            .iter()
            .chain(rel_counts_2.iter())
            .flat_map(|(_, x)| x.keys())
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        if ordered_relation_types.is_empty() {
            skipped.push((mode, group_key, "no relations observed".to_owned()));
            continue;
        }

        let n1 = rel_counts_1.len();
        let n2 = rel_counts_2.len();

        let sample_1 = encode_relation_counts(rel_counts_1, &ordered_relation_types);
        let sample_2 = encode_relation_counts(rel_counts_2, &ordered_relation_types);

        let component_ids_1: Vec<usize> =
            rel_counts_1.iter().map(|(t, _)| components_1[t]).collect();
        let component_ids_2: Vec<usize> =
            rel_counts_2.iter().map(|(t, _)| components_2[t]).collect();

        let res = match (distance, grouping) {
            (Distance::Euclidean, Grouping::Executions) => {
                todo!("fast euclidean does not yet support restricted permutation")
            }
            (Distance::Euclidean, Grouping::Singletons) => {
                permanova_fast(&sample_1, &sample_2, permutations, Some(seed))
            }
            (Distance::BrayCurtis, _) => restricted_permanova(
                &sample_1,
                &sample_2,
                &component_ids_1,
                &component_ids_2,
                squared_bray_curtis_distance,
                permutations,
                Some(seed),
            ),
        };

        match res {
            Ok(result) => blocks.push(Block {
                mode,
                group_key,
                id: format!("{}::{group_key}", mode.as_str()),
                result,
                n1,
                n2,
                ordered_relation_types,
                component_ids_1,
                component_ids_2,
            }),
            Err(e) => skipped.push((mode, group_key, e.to_string())),
        }
    }
}
