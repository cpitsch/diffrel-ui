import { useState } from "react";
import { Box, Button, Flex, Switch, Text, TextField } from "@radix-ui/themes";
import type { RunComparisonParams } from "../tauriCommands";

interface ComparisonSettingsProps {
  onRun: (params: RunComparisonParams) => void;
  disabled: boolean;
  isPending: boolean;
  selectedEventTypes: string[] | null;
}

export function ComparisonSettings({
  onRun,
  disabled,
  isPending,
  selectedEventTypes,
}: ComparisonSettingsProps) {
  const [numPermutations, setNumPermutations] = useState("1000");
  const [alpha, setAlpha] = useState("0.05");
  const [useSeed, setUseSeed] = useState(false);
  const [seed, setSeed] = useState("42");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedPermutations = parseInt(numPermutations, 10);
    const parsedAlpha = parseFloat(alpha);
    const parsedSeed = parseInt(seed, 10);
    if (isNaN(parsedPermutations) || isNaN(parsedAlpha)) return;
    if (useSeed && isNaN(parsedSeed)) return;
    onRun({
      numPermutations: parsedPermutations,
      alpha: parsedAlpha,
      seed: useSeed ? parsedSeed : null,
      selectedEventTypes,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <Flex direction="column" gap="3">
        <Flex direction="column" gap="1">
          <Text as="label" htmlFor="num-permutations" size="1" weight="medium">
            Permutations
          </Text>
          <TextField.Root
            id="num-permutations"
            size="2"
            inputMode="numeric"
            value={numPermutations}
            onChange={(e) => setNumPermutations(e.target.value)}
          />
        </Flex>

        <Flex direction="column" gap="1">
          <Text as="label" htmlFor="alpha" size="1" weight="medium">
            Alpha (α)
          </Text>
          <TextField.Root
            id="alpha"
            size="2"
            inputMode="decimal"
            value={alpha}
            onChange={(e) => setAlpha(e.target.value)}
          />
        </Flex>

        <Flex align="center" gap="2" asChild>
          <label>
            <Switch
              size="1"
              checked={useSeed}
              onCheckedChange={setUseSeed}
            />
            <Text size="2">Fixed seed</Text>
          </label>
        </Flex>

        {useSeed && (
          <TextField.Root
            size="2"
            inputMode="numeric"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
        )}

        <Button type="submit" disabled={disabled || isPending} size="2">
          {isPending ? "Running…" : "Run comparison"}
        </Button>
      </Flex>
    </form>
  );
}
