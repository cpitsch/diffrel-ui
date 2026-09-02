import { useState } from "react";
import {
  Box,
  Button,
  Flex,
  SegmentedControl,
  Slider,
  Switch,
  Text,
  TextField,
} from "@radix-ui/themes";
import type { DistanceMode } from "../types";

const PERM_SNAP_POINTS = [100, 250, 500, 1000, 2500, 5000, 10000];

function nearestSnapIndex(perm: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PERM_SNAP_POINTS.length; i++) {
    const dist = Math.abs(Math.log(perm) - Math.log(PERM_SNAP_POINTS[i]));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

const ALPHA_SNAP_POINTS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1.0];

function nearestAlphaSnapIndex(alpha: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ALPHA_SNAP_POINTS.length; i++) {
    const dist = Math.abs(Math.log(alpha) - Math.log(ALPHA_SNAP_POINTS[i]));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function fmtAlpha(v: number): string {
  return parseFloat(v.toFixed(4)).toString();
}

export const STAT_PARAMS_DEFAULTS = { numPermutations: 2500, alpha: 0.05, useSeed: false };

export interface StatParamsFieldsProps {
  numPermutations: number;
  onNumPermutationsChange: (n: number) => void;
  alpha: number;
  onAlphaChange: (a: number) => void;
  useSeed: boolean;
  onUseSeedChange: (v: boolean) => void;
  seed: string;
  onSeedChange: (v: string) => void;
  distanceMode: DistanceMode;
  onDistanceModeChange: (m: DistanceMode) => void;
  /** Disables just the Reset button (e.g. while a comparison/discovery request is in flight). */
  disabled?: boolean;
}

/** Shared "Parameters" config block (permutations, alpha, seed, distance function) — backed by
 *  state lifted to App.tsx so the Relations view (ComparisonSettings.tsx, alongside its own "Run
 *  comparison" button) and the Process model view (alongside "Discover process model") read/write
 *  the exact same values instead of each keeping an independent copy. */
export function StatParamsFields({
  numPermutations,
  onNumPermutationsChange,
  alpha,
  onAlphaChange,
  useSeed,
  onUseSeedChange,
  seed,
  onSeedChange,
  distanceMode,
  onDistanceModeChange,
  disabled,
}: StatParamsFieldsProps) {
  const [permText, setPermText] = useState(String(numPermutations));
  const [alphaText, setAlphaText] = useState(fmtAlpha(alpha));

  function handleReset() {
    onNumPermutationsChange(STAT_PARAMS_DEFAULTS.numPermutations);
    setPermText(String(STAT_PARAMS_DEFAULTS.numPermutations));
    onAlphaChange(STAT_PARAMS_DEFAULTS.alpha);
    setAlphaText(fmtAlpha(STAT_PARAMS_DEFAULTS.alpha));
    onUseSeedChange(STAT_PARAMS_DEFAULTS.useSeed);
  }

  return (
    <Flex direction="column" gap="3">
      <Flex justify="between" align="center">
        <Text size="2" weight="medium" style={{ color: "#6b7280" }}>
          Parameters
        </Text>
        <Button type="button" size="1" variant="soft" onClick={handleReset} disabled={disabled}>
          Reset
        </Button>
      </Flex>

      {/* Permutations */}
      <Box>
        <Flex justify="between" align="baseline" mb="1">
          <Text size="1" weight="medium">
            Permutations
          </Text>
          <TextField.Root
            size="1"
            inputMode="numeric"
            value={permText}
            onChange={(e) => {
              setPermText(e.target.value);
              const parsed = parseInt(e.target.value, 10);
              if (!isNaN(parsed) && parsed > 0) onNumPermutationsChange(parsed);
            }}
            onBlur={() => setPermText(String(numPermutations))}
            style={{ width: 72, textAlign: "right", paddingRight: 8 }}
          />
        </Flex>
        <Slider
          value={[nearestSnapIndex(numPermutations)]}
          onValueChange={([v]) => {
            const perm = PERM_SNAP_POINTS[v];
            onNumPermutationsChange(perm);
            setPermText(String(perm));
          }}
          min={0}
          max={PERM_SNAP_POINTS.length - 1}
          step={1}
          size="1"
        />
      </Box>

      {/* Alpha */}
      <Box>
        <Flex justify="between" align="baseline" mb="1">
          <Text size="1" weight="medium">
            Alpha (α)
          </Text>
          <TextField.Root
            size="1"
            inputMode="decimal"
            value={alphaText}
            onChange={(e) => {
              setAlphaText(e.target.value);
              const parsed = parseFloat(e.target.value);
              if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) onAlphaChange(parsed);
            }}
            onBlur={() => setAlphaText(fmtAlpha(alpha))}
            style={{ width: 72, textAlign: "right", paddingRight: 8 }}
          />
        </Flex>
        <Slider
          value={[nearestAlphaSnapIndex(alpha)]}
          onValueChange={([v]) => {
            const a = ALPHA_SNAP_POINTS[v];
            onAlphaChange(a);
            setAlphaText(fmtAlpha(a));
          }}
          min={0}
          max={ALPHA_SNAP_POINTS.length - 1}
          step={1}
          size="1"
        />
      </Box>

      <Flex align="center" gap="2" asChild>
        <label>
          <Switch size="1" checked={useSeed} onCheckedChange={onUseSeedChange} />
          <Text size="2">Fixed seed</Text>
        </label>
      </Flex>

      <div
        style={{
          maxHeight: useSeed ? "3rem" : 0,
          opacity: useSeed ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.2s ease, opacity 0.15s ease",
        }}
      >
        <TextField.Root
          size="2"
          inputMode="numeric"
          value={seed}
          onChange={(e) => onSeedChange(e.target.value)}
        />
      </div>

      <details>
        <summary>
          <Text size="1" weight="medium" style={{ cursor: "pointer" }}>
            Advanced settings
          </Text>
        </summary>
        <Box mt="2">
          <Text size="1" weight="medium" mb="1" style={{ display: "block" }}>
            Distance function
          </Text>
          <SegmentedControl.Root
            size="1"
            value={distanceMode}
            onValueChange={(v) => onDistanceModeChange(v as DistanceMode)}
          >
            <SegmentedControl.Item value="Euclidean">Euclidean</SegmentedControl.Item>
            <SegmentedControl.Item value="BrayCurtis">Bray-Curtis</SegmentedControl.Item>
          </SegmentedControl.Root>
        </Box>
      </details>
    </Flex>
  );
}
