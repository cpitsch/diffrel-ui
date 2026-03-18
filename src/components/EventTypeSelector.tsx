import { Box, Button, Checkbox, Flex, ScrollArea, Text } from "@radix-ui/themes";

interface EventTypeSelectorProps {
  /** Event types present in both logs — these can be selected for testing. */
  bothLogTypes: string[];
  /** Event types only in one log — shown but not selectable. */
  onlyInLog1: string[];
  onlyInLog2: string[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}

export function EventTypeSelector({
  bothLogTypes,
  onlyInLog1,
  onlyInLog2,
  selected,
  onChange,
}: EventTypeSelectorProps) {
  function toggle(eventType: string) {
    const next = new Set(selected);
    if (next.has(eventType)) {
      next.delete(eventType);
    } else {
      next.add(eventType);
    }
    onChange(next);
  }

  return (
    <Box mb="3">
      <Flex justify="between" align="center" mb="2">
        <Text size="2" weight="medium">Event types to test</Text>
        <Flex gap="2">
          <Button size="1" variant="soft" onClick={() => onChange(new Set(bothLogTypes))}>
            Select All
          </Button>
          <Button size="1" variant="soft" onClick={() => onChange(new Set())}>
            Clear
          </Button>
        </Flex>
      </Flex>

      <ScrollArea style={{ maxHeight: "180px" }}>
        <Flex direction="column" gap="1" pr="2">
          {bothLogTypes.map((et) => (
            <Text as="label" key={et} size="2" style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
              <Checkbox
                checked={selected.has(et)}
                onCheckedChange={() => toggle(et)}
              />
              {et}
            </Text>
          ))}

          {[...onlyInLog1.map((et) => ({ et, label: "log 1 only" })), ...onlyInLog2.map((et) => ({ et, label: "log 2 only" }))].map(({ et, label }) => (
            <Text as="label" key={et} size="2" color="gray" style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "default" }}>
              <Checkbox checked={false} disabled />
              {et} <em>({label})</em>
            </Text>
          ))}
        </Flex>
      </ScrollArea>
    </Box>
  );
}
