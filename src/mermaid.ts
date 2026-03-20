import { buildColorMap } from './objectTypeColors';
import type { ComparisonOutput, EventTypePresence } from './types';

/** Replace non-alphanumeric chars so the string is a valid Mermaid node ID. */
function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}

/** Convert HSL values to a hex string. Mermaid classDef rejects CSS functions like hsl(). */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Parse an hsl(...) string from the palette into [h, s, l]. */
function parseHsl(hsl: string): [number, number, number] {
  const m = hsl.match(/hsl\(\s*(\d+)[^,]*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/);
  if (!m) return [0, 0, 90];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Convert a palette hsl string to a fill hex and a darkened stroke hex. */
function hslToFillStroke(hsl: string): [string, string] {
  const [h, s, l] = parseHsl(hsl);
  return [hslToHex(h, s, l), hslToHex(h, s, Math.max(0, l - 15))];
}

function evtFill(presence: EventTypePresence, isSignificant: boolean | null): string {
  if (presence !== 'both' || isSignificant === null) return '#e5e7eb';
  return isSignificant ? '#fecaca' : '#bbf7d0';
}
function evtStroke(presence: EventTypePresence, isSignificant: boolean | null): string {
  if (presence !== 'both' || isSignificant === null) return '#d1d5db';
  return isSignificant ? '#f87171' : '#6ee7b7';
}

export function buildMermaidSubgraph(
  eventType: string,
  result: import('./types').EventTypeResult,
  colorMap: Record<string, string>,
): string {
  const lines: string[] = [
    '%%{init: {"theme": "neutral"}}%%',
    'flowchart TD',
  ];
  const classDefs: Map<string, string> = new Map();

  const evtId = `evt_${sanitizeId(eventType)}`;
  const sig = result.isSignificant;
  const evtClass = sig ? 'evtSig' : 'evtNotSig';
  classDefs.set(evtClass, `fill:${evtFill('both', sig)},stroke:${evtStroke('both', sig)},color:#000`);

  const pLabel = result.pValue < 0.00005 ? '&lt; 0.0001' : result.pValue.toFixed(4);
  lines.push(
    `    ${evtId}["<b>${eventType}</b><br/><i>p</i> = ${pLabel}<br/><i>n</i> = ${result.n1} / ${result.n2}"]`,
  );

  for (const rel of result.objectTypeRelations) {
    const objId = `obj_${sanitizeId(eventType)}__${sanitizeId(rel.qualifier)}__${sanitizeId(rel.objectType)}`;
    const [fill, stroke] = hslToFillStroke(colorMap[rel.objectType] ?? 'hsl(0,0%,90%)');
    const otClass = `ot_${sanitizeId(rel.objectType)}`;
    classDefs.set(otClass, `fill:${fill},stroke:${stroke},color:#000`);

    const med1 = Number.isInteger(rel.medianLog1) ? rel.medianLog1 : rel.medianLog1.toFixed(1);
    const med2 = Number.isInteger(rel.medianLog2) ? rel.medianLog2 : rel.medianLog2.toFixed(1);
    lines.push(`    ${objId}("<b>${rel.objectType}</b><br/>μ₁ = ${rel.meanLog1.toFixed(2)}<i>±${rel.stdLog1.toFixed(2)}</i><br/>μ₂ = ${rel.meanLog2.toFixed(2)}<i>±${rel.stdLog2.toFixed(2)}</i>")`);
    lines.push(`    ${evtId} -->|${rel.qualifier}| ${objId}`);
  }

  lines.push('');
  for (const [name, style] of classDefs) {
    lines.push(`    classDef ${name} ${style}`);
  }
  lines.push('');
  lines.push(`    class ${evtId} ${evtClass}`);
  for (const rel of result.objectTypeRelations) {
    const objId = `obj_${sanitizeId(eventType)}__${sanitizeId(rel.qualifier)}__${sanitizeId(rel.objectType)}`;
    lines.push(`    class ${objId} ot_${sanitizeId(rel.objectType)}`);
  }

  return lines.join('\n');
}

export function buildMermaidDiagram(
  comparison: ComparisonOutput,
  log1EventTypes: string[],
  log2EventTypes: string[],
): string {
  const { results, onlyInLog1, onlyInLog2 } = comparison;

  const allObjectTypes = Object.values(results).flatMap((r) =>
    r.objectTypeRelations.map((rel) => rel.objectType),
  );
  const colorMap = buildColorMap(allObjectTypes);

  const allEventTypes = new Set([...log1EventTypes, ...log2EventTypes]);

  const lines: string[] = [
    '%%{init: {"theme": "neutral"}}%%',
    'flowchart TD',
  ];

  const classDefs: Map<string, string> = new Map(); // className → style string

  for (const eventType of allEventTypes) {
    let presence: EventTypePresence;
    if (onlyInLog1.includes(eventType)) presence = 'onlyInLog1';
    else if (onlyInLog2.includes(eventType)) presence = 'onlyInLog2';
    else presence = 'both';

    if (presence !== 'both') continue; // mirror SHOW_SINGLE_LOG_EVENT_TYPES = false

    const result = results[eventType] ?? null;
    if (result === null) continue; // mirror SHOW_NOT_TESTED_EVENT_TYPES = false

    const evtId = `evt_${sanitizeId(eventType)}`;
    const sig = result.isSignificant;
    const fill = evtFill(presence, sig);
    const stroke = evtStroke(presence, sig);
    const evtClass = sig ? 'evtSig' : 'evtNotSig';
    classDefs.set(evtClass, `fill:${fill},stroke:${stroke},color:#000`);

    const pLabel = result.pValue < 0.00005
      ? '&lt; 0.0001'
      : result.pValue.toFixed(4);
    lines.push(
      `    ${evtId}["<b>${eventType}</b><br/><i>p</i> = ${pLabel}<br/><i>n</i> = ${result.n1} / ${result.n2}"]`,
    );

    for (const rel of result.objectTypeRelations) {
      const objId = `obj_${sanitizeId(eventType)}__${sanitizeId(rel.qualifier)}__${sanitizeId(rel.objectType)}`;
      const [fill, stroke] = hslToFillStroke(colorMap[rel.objectType] ?? 'hsl(0,0%,90%)');
      const otClass = `ot_${sanitizeId(rel.objectType)}`;
      classDefs.set(otClass, `fill:${fill},stroke:${stroke},color:#000`);

      const med1 = Number.isInteger(rel.medianLog1) ? rel.medianLog1 : rel.medianLog1.toFixed(1);
      const med2 = Number.isInteger(rel.medianLog2) ? rel.medianLog2 : rel.medianLog2.toFixed(1);
      lines.push(
        `    ${objId}("<b>${rel.objectType}</b><br/>μ₁ = ${rel.meanLog1.toFixed(2)}<i>±${rel.stdLog1.toFixed(2)}</i><br/>μ₂ = ${rel.meanLog2.toFixed(2)}<i>±${rel.stdLog2.toFixed(2)}</i>")`,
      );
      lines.push(
        `    ${evtId} -->|${rel.qualifier}| ${objId}`,
      );
    }
  }

  // Emit classDefs and class assignments
  lines.push('');
  for (const [name, style] of classDefs) {
    lines.push(`    classDef ${name} ${style}`);
  }
  lines.push('');
  for (const eventType of allEventTypes) {
    if (onlyInLog1.includes(eventType) || onlyInLog2.includes(eventType)) continue;
    const result = results[eventType] ?? null;
    if (result === null) continue;
    const evtId = `evt_${sanitizeId(eventType)}`;
    const evtClass = result.isSignificant ? 'evtSig' : 'evtNotSig';
    lines.push(`    class ${evtId} ${evtClass}`);
    for (const rel of result.objectTypeRelations) {
      const objId = `obj_${sanitizeId(eventType)}__${sanitizeId(rel.qualifier)}__${sanitizeId(rel.objectType)}`;
      lines.push(`    class ${objId} ot_${sanitizeId(rel.objectType)}`);
    }
  }

  return lines.join('\n');
}
