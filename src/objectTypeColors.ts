// Pastel palette: HSL with L ≈ 90%, S ≈ 75–85%, hues evenly spread.
// Avoids hue 0° (red) and 145° (green) which are used for event node significance.
const PALETTE = [
  "hsl(210, 80%, 90%)", // blue
  "hsl(35,  90%, 88%)", // amber
  "hsl(270, 75%, 91%)", // purple
  "hsl(185, 75%, 88%)", // cyan
  "hsl(315, 75%, 90%)", // pink
  "hsl(55,  80%, 87%)", // yellow
  "hsl(245, 75%, 91%)", // indigo
  "hsl(20,  85%, 89%)", // orange
  "hsl(295, 70%, 90%)", // violet
  "hsl(170, 70%, 88%)", // teal
  "hsl(80,  70%, 87%)", // lime
  "hsl(230, 80%, 91%)", // periwinkle
];

function assignFromPalette(
  allObjectTypes: string[],
  palette: string[],
): Record<string, string> {
  const sorted = [...new Set(allObjectTypes)].sort();
  return Object.fromEntries(
    sorted.map((ot, i) => [ot, palette[i % palette.length]]),
  );
}

/**
 * Builds a stable mapping from object type name → color.
 * Each unique object type gets a consistent color based on its sorted position
 * in the full set, so the same object type always receives the same color
 * regardless of which event types it appears with.
 */
export function buildColorMap(
  allObjectTypes: string[],
): Record<string, string> {
  return assignFromPalette(allObjectTypes, PALETTE);
}

// Same hues as PALETTE, darker and more saturated — legible as a thin stroke on a white canvas,
// where the pastel fill tone reads as barely-there. Index-aligned with PALETTE so a given object
// type maps to "the same color" in both palettes, just a fill-appropriate vs. stroke-appropriate
// shade of it.
const STROKE_PALETTE = [
  "hsl(210, 70%, 55%)", // blue
  "hsl(35,  80%, 48%)", // amber
  "hsl(270, 60%, 58%)", // purple
  "hsl(185, 65%, 38%)", // cyan
  "hsl(315, 60%, 55%)", // pink
  "hsl(55,  75%, 40%)", // yellow
  "hsl(245, 60%, 60%)", // indigo
  "hsl(20,  75%, 48%)", // orange
  "hsl(295, 55%, 55%)", // violet
  "hsl(170, 60%, 33%)", // teal
  "hsl(80,  55%, 35%)", // lime
  "hsl(230, 65%, 58%)", // periwinkle
];

/** Stroke-appropriate counterpart to {@link buildColorMap}: darker/saturated version of the same
 *  per-object-type hues, for arcs and other thin-line/small-shape uses where the pastel fill
 *  palette would be nearly invisible. */
export function buildStrokeColorMap(
  allObjectTypes: string[],
): Record<string, string> {
  return assignFromPalette(allObjectTypes, STROKE_PALETTE);
}
