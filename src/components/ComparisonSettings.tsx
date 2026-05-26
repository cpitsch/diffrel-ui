import { Ring } from "ldrs/react";
import "ldrs/react/Ring.css";
import { useState } from "react";
import {
  Box,
  Button,
  Flex,
  Slider,
  Switch,
  Text,
  TextField,
} from "@radix-ui/themes";
import type { RunComparisonParams } from "../tauriCommands";
import type { RelationMode } from "../types";

interface ComparisonSettingsProps {
  onRun: (params: RunComparisonParams) => void;
  disabled: boolean;
  isPending: boolean;
  mode: RelationMode;
  selectedTypes: string[] | null;
}

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

const DEFAULTS = { numPermutations: 1000, alpha: 0.05, useSeed: false };

export function ComparisonSettings({
  onRun,
  disabled,
  isPending,
  mode,
  selectedTypes,
}: ComparisonSettingsProps) {
  const [numPermutations, setNumPermutations] = useState(
    DEFAULTS.numPermutations,
  );
  const [permText, setPermText] = useState(String(DEFAULTS.numPermutations));
  const [alpha, setAlpha] = useState(DEFAULTS.alpha);
  const [alphaText, setAlphaText] = useState(fmtAlpha(DEFAULTS.alpha));
  const [useSeed, setUseSeed] = useState(DEFAULTS.useSeed);
  const [seed, setSeed] = useState("42");

  function handleReset() {
    setNumPermutations(DEFAULTS.numPermutations);
    setPermText(String(DEFAULTS.numPermutations));
    setAlpha(DEFAULTS.alpha);
    setAlphaText(fmtAlpha(DEFAULTS.alpha));
    setUseSeed(DEFAULTS.useSeed);
  }

  function handleSubmit(e: React.SubmitEvent) {
    e.preventDefault();
    const parsedSeed = parseInt(seed, 10);
    if (useSeed && isNaN(parsedSeed)) return;
    onRun({
      numPermutations,
      alpha,
      seed: useSeed ? parsedSeed : null,
      mode,
      selectedTypes,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <Flex justify="between" align="center" mb="2">
        <Text size="2" weight="medium" style={{ color: "#6b7280" }}>
          Parameters
        </Text>
        <Button
          type="button"
          size="1"
          variant="soft"
          onClick={handleReset}
          disabled={isPending}
        >
          Reset
        </Button>
      </Flex>
      <Flex direction="column" gap="3">
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
                if (!isNaN(parsed) && parsed > 0) setNumPermutations(parsed);
              }}
              onBlur={() => setPermText(String(numPermutations))}
              style={{ width: 72, textAlign: "right", paddingRight: 8 }}
            />
          </Flex>
          <Slider
            value={[nearestSnapIndex(numPermutations)]}
            onValueChange={([v]) => {
              const perm = PERM_SNAP_POINTS[v];
              setNumPermutations(perm);
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
                if (!isNaN(parsed) && parsed >= 0 && parsed <= 1)
                  setAlpha(parsed);
              }}
              onBlur={() => setAlphaText(fmtAlpha(alpha))}
              style={{ width: 72, textAlign: "right", paddingRight: 8 }}
            />
          </Flex>
          <Slider
            value={[nearestAlphaSnapIndex(alpha)]}
            onValueChange={([v]) => {
              const a = ALPHA_SNAP_POINTS[v];
              setAlpha(a);
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
            <Switch size="1" checked={useSeed} onCheckedChange={setUseSeed} />
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
            onChange={(e) => setSeed(e.target.value)}
          />
        </div>

        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: "#fff",
            paddingBottom: "1rem",
            paddingTop: "0.25rem",
            marginTop: "0.25rem",
          }}
        >
          <Button
            type="submit"
            disabled={disabled || isPending}
            size="2"
            style={{ width: "100%" }}
          >
            {isPending && (
              <Ring size="16" stroke="2" speed="2" color="currentColor" />
            )}
            {isPending ? "Running…" : "Run comparison"}
          </Button>

          {selectedTypes === null && (
            <Text size="1" color="gray" style={{ marginLeft: "1em" }}>
              Select at least one{" "}
              {mode === "E2O" ? "event type" : "object type"}.
            </Text>
          )}
        </div>
      </Flex>
    </form>
  );
}
