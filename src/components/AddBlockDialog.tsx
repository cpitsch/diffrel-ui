import {
  Button,
  Checkbox,
  Dialog,
  Flex,
  RadioGroup,
  ScrollArea,
  SegmentedControl,
  Text,
} from "@radix-ui/themes";
import { useState } from "react";
import { getDimensions } from "../tauriCommands";
import type { FollowsMode, LogSummary, MixedBlock, RelationMode } from "../types";

interface AddBlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  log1Summary: LogSummary;
  log2Summary: LogSummary;
  existingBlocks: MixedBlock[];
  availableObjectTypes: string[];
  /** Object types allowed to mediate E2E pairing (shared across all E2E blocks). */
  allowedObjectTypes: Set<string>;
  onAllowedObjectTypesChange: (s: Set<string>) => void;
  /** Only affects dimension-fetching for E2E blocks. */
  followsMode: FollowsMode;
  onAdd: (
    mode: RelationMode,
    groupKey: string,
    targetTypes: string[] | null,
    dimensions: [string, string][],
  ) => void;
}

function groupTypesForMode(summary: LogSummary, mode: RelationMode): string[] {
  return mode === "O2O" || mode === "O2E" ? summary.objectTypes : summary.eventTypes;
}

export function AddBlockDialog({
  open,
  onOpenChange,
  log1Summary,
  log2Summary,
  existingBlocks,
  availableObjectTypes,
  allowedObjectTypes,
  onAllowedObjectTypesChange,
  followsMode,
  onAdd,
}: AddBlockDialogProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mode, setMode] = useState<RelationMode>("E2O");
  const [groupKey, setGroupKey] = useState<string>("");
  // Dimensions from getDimensions for the selected (mode, groupKey)
  const [allDims, setAllDims] = useState<[string, string][]>([]);
  // Unique target types derived from allDims
  const [targetTypeOptions, setTargetTypeOptions] = useState<string[]>([]);
  const [selectedTargetTypes, setSelectedTargetTypes] = useState<Set<string>>(new Set());
  const [loadingDims, setLoadingDims] = useState(false);

  function handleClose() {
    onOpenChange(false);
    setTimeout(() => {
      setStep(1);
      setMode("E2O");
      setGroupKey("");
      setAllDims([]);
      setTargetTypeOptions([]);
      setSelectedTargetTypes(new Set());
    }, 200);
  }

  // Step 2: available group keys — intersection of both logs minus already-added ones
  const groupKeys = (() => {
    const list1 = groupTypesForMode(log1Summary, mode);
    const list2 = new Set(groupTypesForMode(log2Summary, mode));
    const used = new Set(
      existingBlocks.filter((b) => b.mode === mode).map((b) => b.groupKey),
    );
    return list1.filter((t) => list2.has(t) && !used.has(t));
  })();

  async function handleGroupKeyNext() {
    if (!groupKey) return;
    setLoadingDims(true);
    const allowedParam =
      allowedObjectTypes.size === availableObjectTypes.length
        ? null
        : [...allowedObjectTypes];
    // No UI control for this — must match ComparisonSettings.tsx's fixed qualifierMode.
    const dims = await getDimensions(mode, groupKey, allowedParam, followsMode, "Single");
    setAllDims(dims);
    // Derive unique target types from actual data
    const opts = [...new Set(dims.map(([, t]) => t))].sort();
    setTargetTypeOptions(opts);
    setSelectedTargetTypes(new Set(opts));
    setLoadingDims(false);
    setStep(3);
  }

  function handleAdd() {
    const filteredDims = allDims.filter(([, t]) => selectedTargetTypes.has(t));
    const allSelected = selectedTargetTypes.size === targetTypeOptions.length;
    onAdd(mode, groupKey, allSelected ? null : [...selectedTargetTypes], filteredDims);
    handleClose();
  }

  function toggleTarget(t: string) {
    setSelectedTargetTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function toggleAllowedObjectType(t: string) {
    const next = new Set(allowedObjectTypes);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onAllowedObjectTypesChange(next);
  }

  const stepTitle =
    step === 1 ? "Choose relation type" :
    step === 2 ? "Choose group key" :
    "Choose target types";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>{stepTitle}</Dialog.Title>
        <Text size="1" color="gray" style={{ display: "block", marginBottom: "1rem" }}>
          Step {step} of 3
        </Text>

        {step === 1 && (
          <Flex direction="column" gap="4">
            <SegmentedControl.Root
              value={mode}
              onValueChange={(v) => setMode(v as RelationMode)}
              size="2"
            >
              <SegmentedControl.Item value="E2O" title="Event to Object">E2O</SegmentedControl.Item>
              <SegmentedControl.Item value="O2O" title="Object to Object">O2O</SegmentedControl.Item>
              <SegmentedControl.Item value="O2E" title="Object to Event">O2E</SegmentedControl.Item>
              <SegmentedControl.Item value="E2E" title="Event to Event">E2E</SegmentedControl.Item>
            </SegmentedControl.Root>

            {mode === "E2E" && (
              <Flex direction="column" gap="2">
                <Flex justify="between" align="center">
                  <Text size="1" weight="medium">Object types</Text>
                  <Flex gap="2">
                    <Button
                      size="1"
                      variant="soft"
                      onClick={() =>
                        onAllowedObjectTypesChange(new Set(availableObjectTypes))
                      }
                    >
                      Select all
                    </Button>
                    <Button
                      size="1"
                      variant="soft"
                      onClick={() => onAllowedObjectTypesChange(new Set())}
                    >
                      Clear
                    </Button>
                  </Flex>
                </Flex>
                <ScrollArea style={{ maxHeight: 160 }}>
                  <Flex direction="column" gap="1" pr="2">
                    {availableObjectTypes.map((t) => (
                      <label
                        key={t}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "4px 6px",
                          borderRadius: 4,
                          cursor: "pointer",
                          fontSize: "0.85rem",
                        }}
                      >
                        <Checkbox
                          checked={allowedObjectTypes.has(t)}
                          onCheckedChange={() => toggleAllowedObjectType(t)}
                        />
                        {t}
                      </label>
                    ))}
                  </Flex>
                </ScrollArea>
              </Flex>
            )}

            <Flex gap="2" justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray">Cancel</Button>
              </Dialog.Close>
              <Button onClick={() => setStep(2)}>Next</Button>
            </Flex>
          </Flex>
        )}

        {step === 2 && (
          <Flex direction="column" gap="4">
            {groupKeys.length === 0 ? (
              <Text size="2" color="gray">
                No available group keys for {mode} — all already added or no intersection between logs.
              </Text>
            ) : (
              <ScrollArea style={{ maxHeight: 260 }}>
                <RadioGroup.Root value={groupKey} onValueChange={setGroupKey}>
                  <Flex direction="column" gap="1" pr="2">
                    {groupKeys.map((k) => (
                      <label
                        key={k}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "4px 6px",
                          borderRadius: 4,
                          cursor: "pointer",
                          background: groupKey === k ? "#e0e7ff" : "transparent",
                          fontSize: "0.85rem",
                        }}
                      >
                        <RadioGroup.Item value={k} />
                        {k}
                      </label>
                    ))}
                  </Flex>
                </RadioGroup.Root>
              </ScrollArea>
            )}
            <Flex gap="2" justify="end">
              <Button variant="soft" color="gray" onClick={() => setStep(1)}>Back</Button>
              <Button
                onClick={handleGroupKeyNext}
                disabled={!groupKey || groupKeys.length === 0 || loadingDims}
                loading={loadingDims}
              >
                Next
              </Button>
            </Flex>
          </Flex>
        )}

        {step === 3 && (
          <Flex direction="column" gap="4">
            {targetTypeOptions.length === 0 ? (
              <Text size="2" color="gray">
                No {mode} relationships found for "{groupKey}" in the data. Try a different group key.
              </Text>
            ) : (
              <>
                <Flex justify="between" align="center">
                  <Text size="1" color="gray">
                    {selectedTargetTypes.size} / {targetTypeOptions.length} selected
                  </Text>
                  <Flex gap="2">
                    <Button
                      size="1"
                      variant="soft"
                      onClick={() => setSelectedTargetTypes(new Set(targetTypeOptions))}
                    >
                      Select all
                    </Button>
                    <Button
                      size="1"
                      variant="soft"
                      onClick={() => setSelectedTargetTypes(new Set())}
                    >
                      Clear
                    </Button>
                  </Flex>
                </Flex>
                <ScrollArea style={{ maxHeight: 260 }}>
                  <Flex direction="column" gap="1" pr="2">
                    {targetTypeOptions.map((t) => (
                      <label
                        key={t}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "4px 6px",
                          borderRadius: 4,
                          cursor: "pointer",
                          fontSize: "0.85rem",
                        }}
                      >
                        <Checkbox
                          checked={selectedTargetTypes.has(t)}
                          onCheckedChange={() => toggleTarget(t)}
                        />
                        {t}
                      </label>
                    ))}
                  </Flex>
                </ScrollArea>
              </>
            )}
            <Flex gap="2" justify="end">
              <Button variant="soft" color="gray" onClick={() => setStep(2)}>Back</Button>
              <Button
                onClick={handleAdd}
                disabled={selectedTargetTypes.size === 0 || targetTypeOptions.length === 0}
              >
                Add
              </Button>
            </Flex>
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
