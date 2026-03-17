import { useState } from "react";
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
  const [numPermutations, setNumPermutations] = useState("999");
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
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div>
        <label style={{ fontSize: "0.8rem", display: "block", marginBottom: "2px" }}>
          Permutations
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={numPermutations}
          onChange={(e) => setNumPermutations(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <label style={{ fontSize: "0.8rem", display: "block", marginBottom: "2px" }}>
          Alpha (α)
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={alpha}
          onChange={(e) => setAlpha(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>

      <div>
        <label style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "6px" }}>
          <input
            type="checkbox"
            checked={useSeed}
            onChange={(e) => setUseSeed(e.target.checked)}
          />
          Fixed seed
        </label>
        {useSeed && (
          <input
            type="text"
            inputMode="numeric"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            style={{ width: "100%", marginTop: "4px" }}
          />
        )}
      </div>

      <button type="submit" disabled={disabled || isPending}>
        {isPending ? "Running…" : "Run comparison"}
      </button>
    </form>
  );
}
