// Adapted from https://github.com/aarkue/propel (packages/components/src/graph-edit/routing.ts)
// Copyright (c) 2026 aarkue, licensed MIT OR Apache-2.0.
/** Only `polylinePointAt` is needed here (edge-label placement for the SVG renderer); the rest of
 *  upstream's routing.ts (on-screen edge clipping/shortening) isn't used by this app's export path. */

export type Pt = { x: number; y: number };

/** The point at arc-length fraction `frac` (clamped to 0..1) along a polyline. */
export function polylinePointAt(pts: Pt[], frac: number): Pt {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  let total = 0;
  const segs: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const s = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(s);
    total += s;
  }
  let target = total * Math.min(1, Math.max(0, frac));
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const t = segs[i] === 0 ? 0 : target / segs[i];
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    target -= segs[i];
  }
  return pts[pts.length - 1];
}
