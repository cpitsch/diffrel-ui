// Adapted from https://github.com/aarkue/propel (packages/components/src/viewer/viewer-config.tsx)
// Copyright (c) 2026 aarkue, licensed MIT OR Apache-2.0.
//
// Diffrel adaptation: only the deterministic hash -> OKLCH color primitive is vendored here
// (colorForSeed, via hashStr/oklchToHex). Upstream also defines a pluggable ColorResolver /
// ViewerConfig / context-provider system for host-overridable colors — deliberately not adopted:
// the color prop-chains in this app are shallow (1-2 hops to direct consumers), several callers
// (mermaid.ts, ocdfg/toReactFlow.ts) are plain functions rather than components, and the
// "easy to switch, easy to undo" goal is already covered by this app's existing flag-based toggle
// convention (see USE_HASH_COLORS in objectTypeColors.ts) without a second color-plumbing idiom.
// Scope-prefixed seeds ("activity:X", "objectType:X") are each caller's own convention, not baked
// in here.

// Tuned so typical activity/object-type names spread to distinct colors instead of clustering.
const HASH_SEED = 0x0101cedc;

function hashStr(s: string): number {
  let h = HASH_SEED;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const gammaEncode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const toByteHex = (x: number) =>
  Math.max(0, Math.min(255, Math.round(x * 255)))
    .toString(16)
    .padStart(2, "0");

// OKLCH -> sRGB hex (Ottosson). OKLCH is perceptually uniform so colors spread evenly across
// seeds. Out-of-gamut channels clamp.
function oklchToHex(L: number, C: number, hueDeg: number): string {
  const hr = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = gammaEncode(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = gammaEncode(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = gammaEncode(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return `#${toByteHex(r)}${toByteHex(g)}${toByteHex(bl)}`;
}

const L_TIERS = [0.62, 0.7, 0.55];
const C_TIERS = [0.15, 0.11];

/** Deterministic hex color for a seed string (e.g. "activity:Create Order",
 *  "objectType:Order") — the same string always yields the same color, independent of what else
 *  is currently visible/filtered (unlike a positional palette index). */
export function colorForSeed(seed: string): string {
  let h = hashStr(seed);
  // Avalanche so seeds differing only in their last char don't collapse to the same color.
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  h >>>= 0;
  return oklchToHex(L_TIERS[(h >>> 9) % 3], C_TIERS[(h >>> 12) % 2], h % 360);
}
