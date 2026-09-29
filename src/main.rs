//! Full E2O/O2O/O2E/E2E PERMANOVA comparison between two OCELs, with Holm-Bonferroni
//! multiple-testing correction and Westfall-Young drilldown on every significant result.
//!
//! Meant for baseline "no difference expected" checks: the interactive process-model
//! view's layout isn't useful there, just which tests came back significant and which
//! specific relations drove it.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use clap::{Parser, ValueEnum};

use diffrel::{
    dependency_components::{compute_dependency_components, compute_divergent_pairs, singleton_components},
    execution::{
        config::{ComparisonConfig, Grouping as LibGrouping},
        drilldown_for_instances,
        export::ComparisonResultExport,
        instance::{ComparisonInstance, RelationMode},
        result::{ComparisonInstanceResult, ComparisonResult},
        run_comparison,
    },
    permanova::Distance as LibDistance,
    relation_extraction::E2ERelationType,
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

    /// Whether an E2E relation counts every eventually-following shared-object event, or
    /// only the directly-next one
    #[arg(long, value_enum, default_value_t = Follows::Eventually)]
    follows: Follows,

    /// Row-grouping scheme for the permutation. `executions` uses divergence-pruned
    /// connected components (van Detten et al., ICPM 2024) — the correct choice when
    /// the log contains pseudo-replication. `singletons` recovers free permutation
    /// over rows.
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Distance {
    BrayCurtis,
    Euclidean,
}

impl From<Distance> for LibDistance {
    fn from(d: Distance) -> Self {
        match d {
            Distance::BrayCurtis => LibDistance::BrayCurtis,
            Distance::Euclidean => LibDistance::Euclidean,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Grouping {
    Executions,
    Singletons,
}

impl From<Grouping> for LibGrouping {
    fn from(g: Grouping) -> Self {
        match g {
            Grouping::Executions => LibGrouping::Executions,
            Grouping::Singletons => LibGrouping::Singletons,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Format {
    Text,
    Json,
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

    if args.format == Format::Text {
        let ev_types_1: HashSet<&str> = log1.get_ev_types().collect();
        let ev_types_2: HashSet<&str> = log2.get_ev_types().collect();
        let ob_types_1: HashSet<&str> = log1.get_ob_types().collect();
        let ob_types_2: HashSet<&str> = log2.get_ob_types().collect();

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
            "  distance: {:?}   permutations: {}   alpha: {}   seed: {}",
            args.distance, args.permutations, args.alpha, args.seed
        );
        println!("  E2E follows: {:?}", args.follows);
        println!("  grouping: {:?}", args.grouping);

        let components_1 = match args.grouping {
            Grouping::Executions => compute_dependency_components(&log1),
            Grouping::Singletons => singleton_components(&log1),
        };
        let components_2 = match args.grouping {
            Grouping::Executions => compute_dependency_components(&log2),
            Grouping::Singletons => singleton_components(&log2),
        };
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
            "  log 1 components: {}   log 2 components: {}",
            num_components_1, num_components_2
        );

        let divergent_pairs_1 = compute_divergent_pairs(&log1);
        let divergent_pairs_2 = compute_divergent_pairs(&log2);
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

    let config = ComparisonConfig {
        permutations: args.permutations,
        alpha: args.alpha,
        seed: Some(args.seed),
        distance: args.distance.into(),
        grouping: args.grouping.into(),
        follows: args.follows.into(),
        e2e_object_types: if args.object_types.is_empty() {
            None
        } else {
            Some(args.object_types.clone())
        },
    };

    let mut instances = ComparisonInstance::all(&log1, &log2);
    if !args.object_types.is_empty() {
        let allowed: HashSet<&str> = args.object_types.iter().map(String::as_str).collect();
        instances.retain(|i| {
            !matches!(i.mode, RelationMode::O2O | RelationMode::O2E)
                || allowed.contains(i.group_key.as_str())
        });
    }

    let comparison = run_comparison(&log1, &log2, &instances, &config);

    let mut results = comparison.results;
    results.sort_by(|a, b| {
        b.test
            .significant
            .cmp(&a.test.significant)
            .then_with(|| a.test.p_value.total_cmp(&b.test.p_value))
    });

    let significant_instances: Vec<ComparisonInstance> = results
        .iter()
        .filter(|r| r.test.significant)
        .map(|r| r.instance.clone())
        .collect();

    let mut drilldown_by_key: HashMap<(RelationMode, String), _> = drilldown_for_instances(
        &log1,
        &log2,
        &significant_instances,
        &config,
        comparison.seed_used,
    )
    .into_iter()
    .map(|(instance, res)| ((instance.mode, instance.group_key), res))
    .collect();

    let results: Vec<ComparisonInstanceResult> = results
        .into_iter()
        .map(|mut r| {
            if r.test.significant {
                let key = (r.instance.mode, r.instance.group_key.clone());
                r.drilldown = drilldown_by_key.remove(&key);
            }
            r
        })
        .collect();

    match args.format {
        Format::Text => {
            let n_sig = results.iter().filter(|r| r.test.significant).count();
            let id_of = |r: &ComparisonInstanceResult| {
                format!("{:?}::{}", r.instance.mode, r.instance.group_key)
            };
            let id_width = results.iter().map(|r| id_of(r).len()).max().unwrap_or(5).max(5);

            println!("\n=== Results ({} instances tested) ===", results.len());
            println!(
                "{:<id_width$}  {:>6}  {:>6}  {:>12}  {:>10}  {:>3}",
                "BLOCK", "n1", "n2", "pseudo-F", "p", "sig", id_width = id_width
            );
            for r in &results {
                println!(
                    "{:<id_width$}  {:>6}  {:>6}  {:>12.4}  {:>10.4}  {:>3}",
                    id_of(r),
                    r.n1,
                    r.n2,
                    r.test.pseudo_f,
                    r.test.p_value,
                    if r.test.significant { "*" } else { "" },
                    id_width = id_width
                );
            }

            println!(
                "\n{n_sig} / {} instances significant at alpha={} (Holm-Bonferroni correction).",
                results.len(),
                args.alpha
            );

            println!("\n=== Drilldown ===");
            if n_sig == 0 {
                println!("(no significant instances - nothing to drill into)");
            }
            for r in &results {
                let Some(drill) = &r.drilldown else {
                    continue;
                };
                match drill {
                    Err(e) => println!("\n{} (p={:.4}): drilldown failed: {e}", id_of(r), r.test.p_value),
                    Ok(rows) => {
                        println!(
                            "\n--- {} (p={:.4}, n1={}, n2={}) ---",
                            id_of(r),
                            r.test.p_value,
                            r.n1,
                            r.n2
                        );
                        let mut sorted_rows: Vec<_> = rows.iter().collect();
                        sorted_rows.sort_by(|a, b| a.test.p_value.total_cmp(&b.test.p_value));
                        for row in sorted_rows {
                            let sig_mark = if row.test.significant { "*" } else { "" };
                            println!(
                                "  {:<20} -> {:<20}  p={:>7.4}{:<1}  pseudo-F={:>10.4}  cliffs_delta={:>7.3}",
                                row.qualifier, row.target, row.test.p_value, sig_mark, row.test.pseudo_f, row.effect_size
                            );
                        }
                    }
                }
            }

            if !comparison.skipped.is_empty() {
                println!("\n=== Skipped instances ({}) ===", comparison.skipped.len());
                for s in &comparison.skipped {
                    println!("  {:?}::{}: {:?}", s.instance.mode, s.instance.group_key, s.reason);
                }
            }

            let ev_types_1: HashSet<&str> = log1.get_ev_types().collect();
            let ev_types_2: HashSet<&str> = log2.get_ev_types().collect();
            let ob_types_1: HashSet<&str> = log1.get_ob_types().collect();
            let ob_types_2: HashSet<&str> = log2.get_ob_types().collect();
            let only_in_log1_evt = sorted_diff(&ev_types_1, &ev_types_2);
            let only_in_log2_evt = sorted_diff(&ev_types_2, &ev_types_1);
            let only_in_log1_obt = sorted_diff(&ob_types_1, &ob_types_2);
            let only_in_log2_obt = sorted_diff(&ob_types_2, &ob_types_1);

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
            let result = ComparisonResult {
                results,
                skipped: comparison.skipped,
                seed_used: comparison.seed_used,
            };
            let output = ComparisonResultExport::new(
                result,
                &config,
                &log1,
                Some(args.log1.display().to_string()),
                &log2,
                Some(args.log2.display().to_string()),
            );
            serde_json::to_writer_pretty(std::io::stdout(), &output)?;
            println!();
        }
    }

    Ok(())
}

fn sorted_diff<'a>(a: &HashSet<&'a str>, b: &HashSet<&'a str>) -> Vec<&'a str> {
    let mut v: Vec<&str> = a.difference(b).copied().collect();
    v.sort_unstable();
    v
}
