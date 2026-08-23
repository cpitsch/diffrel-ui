// Adapted from https://github.com/aarkue/propel (packages/components/src/viewer/viewer-config.tsx)
// Copyright (c) 2026 aarkue, licensed MIT OR Apache-2.0.
//
// Diffrel adaptation: propel resolves activity colors via a pluggable `useColorOf("activity")`
// hook backed by `colorForKey`/`colorForSeed`; we call the underlying hash directly instead — see
// `../../../../../colorHash` for why no Context/Provider is used. Fill/stroke tiers are derived
// here with `mix()` (opaque hex) rather than propel's alpha-suffix trick (`base+"26"`/`base+"cc"`),
// matching how `objectTypeColors.ts` derives its own hash-based tiers so both color axes stay
// visually consistent.
import { colorForSeed } from "../../../../../colorHash";
import { mix } from "./colors";

/** Deterministic per-activity identity color (a single base hex); the same activity name always
 *  yields the same color, independent of what else is on screen. */
export function activityColor(activity: string): string {
  return colorForSeed(`activity:${activity}`);
}

/** Pale, opaque fill tone for an activity's identity color — legible under dark label text. */
export function activityFillColor(activity: string): string {
  return mix(activityColor(activity), "#ffffff", 0.85);
}

/** Saturated, opaque tone for an activity's identity color — legible as a thin border or small dot. */
export function activityStrokeColor(activity: string): string {
  return mix(activityColor(activity), "#ffffff", 0.15);
}
