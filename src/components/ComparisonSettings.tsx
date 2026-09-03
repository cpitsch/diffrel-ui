import { Ring } from "ldrs/react";
import "ldrs/react/Ring.css";
import { Button, Flex } from "@radix-ui/themes";
import type { DistanceMode, E2EQualifierMode, FollowsMode } from "../types";
import { StatParamsFields } from "./StatParamsFields";
import { DEFAULT_FOLLOWS_MODE, DEFAULT_QUALIFIER_MODE } from "../constants";

export interface StatParams {
  numPermutations: number;
  alpha: number;
  seed: number | null;
  distanceMode: DistanceMode;
  followsMode: FollowsMode;
  /** Only affects E2E blocks. */
  qualifierMode: E2EQualifierMode;
}

interface ComparisonSettingsProps {
  onRun: (params: StatParams) => void;
  disabled: boolean;
  isPending: boolean;
  distanceMode: DistanceMode;
  onDistanceModeChange: (m: DistanceMode) => void;
  numPermutations: number;
  onNumPermutationsChange: (n: number) => void;
  alpha: number;
  onAlphaChange: (a: number) => void;
  useSeed: boolean;
  onUseSeedChange: (v: boolean) => void;
  seed: string;
  onSeedChange: (v: string) => void;
}

export function ComparisonSettings({
  onRun,
  disabled,
  isPending,
  distanceMode,
  onDistanceModeChange,
  numPermutations,
  onNumPermutationsChange,
  alpha,
  onAlphaChange,
  useSeed,
  onUseSeedChange,
  seed,
  onSeedChange,
}: ComparisonSettingsProps) {
  function handleSubmit(e: React.SubmitEvent) {
    e.preventDefault();
    const parsedSeed = parseInt(seed, 10);
    if (useSeed && isNaN(parsedSeed)) return;
    onRun({
      numPermutations,
      alpha,
      seed: useSeed ? parsedSeed : null,
      distanceMode,
      // No UI control for either of these in the Relations view. `followsMode` is fixed to the
      // prior default. `qualifierMode` used to default to "Grouped" (one combined relation per
      // event pair) purely to cut down arc count — since dropped in favor of "Single" (one
      // relation, and one statistical test, per object type), matching the Process model's
      // default; the alpha threshold above handles decluttering instead.
      followsMode: DEFAULT_FOLLOWS_MODE,
      qualifierMode: DEFAULT_QUALIFIER_MODE,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <Flex direction="column" gap="3">
        <StatParamsFields
          numPermutations={numPermutations}
          onNumPermutationsChange={onNumPermutationsChange}
          alpha={alpha}
          onAlphaChange={onAlphaChange}
          useSeed={useSeed}
          onUseSeedChange={onUseSeedChange}
          seed={seed}
          onSeedChange={onSeedChange}
          distanceMode={distanceMode}
          onDistanceModeChange={onDistanceModeChange}
          disabled={isPending}
        />

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
        </div>
      </Flex>
    </form>
  );
}
