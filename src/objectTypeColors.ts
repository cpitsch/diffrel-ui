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

/**
 * Builds a stable mapping from object type name → color.
 * Each unique object type gets a consistent color based on its sorted position
 * in the full set, so the same object type always receives the same color
 * regardless of which event types it appears with.
 */
export function buildColorMap(allObjectTypes: string[]): Record<string, string> {
  const sorted = [...new Set(allObjectTypes)].sort();
  return Object.fromEntries(
    sorted.map((ot, i) => [ot, PALETTE[i % PALETTE.length]])
  );
}
