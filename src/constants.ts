import type { DistanceMode, E2EQualifierMode, FollowsMode } from "./types";

/** Default statistical parameters, shared by the Relations view's StatParamsFields and the
 *  Process model view (which has no settings UI of its own yet). */
export const DEFAULT_NUM_PERMUTATIONS = 2500;
export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_USE_SEED = false;
/** Text-field default for the (unchecked-by-default) seed input. */
export const DEFAULT_SEED_TEXT = "42";
export const DEFAULT_DISTANCE_MODE: DistanceMode = "BrayCurtis";

/** Was a user-toggleable SegmentedControl in ComparisonSettings ("E2E follows relation");
 *  removed once it became clear it wasn't earning its keep as a real user choice, same
 *  reasoning as the Process model's now-removed "Overlay relation"/"Qualifier grouping"
 *  controls. Every call site now fixes both to the same values below. */
export const DEFAULT_FOLLOWS_MODE: FollowsMode = "EventuallyFollows";
export const DEFAULT_QUALIFIER_MODE: E2EQualifierMode = "Single";
