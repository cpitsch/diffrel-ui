import { Box, Button, Flex, Text } from "@radix-ui/themes";
import type { LogSummary } from "../types";

interface LogLoaderProps {
  logNumber: 1 | 2;
  summary: LogSummary | null;
  filePath: string | null;
  isPending: boolean;
  onLoad: () => void;
  disabled: boolean;
}

export function LogLoader({
  logNumber,
  summary,
  filePath,
  isPending,
  onLoad,
  disabled,
}: LogLoaderProps) {
  const fileName = filePath ? filePath.split(/[\\/]/).pop() : null;

  return (
    <Box mb="3">
      <Button
        onClick={onLoad}
        disabled={disabled || isPending}
        variant="outline"
        size="2"
        style={{ width: "100%" }}
      >
        {isPending ? "Loading…" : `Load Log ${logNumber}`}
      </Button>
      {summary && fileName && (
        <Flex direction="column" gap="1" mt="1">
          <Text size="1" weight="medium" style={{ wordBreak: "break-all" }}>
            {fileName}
          </Text>
          <Text size="1" color="gray">
            {summary.eventCount.toLocaleString()} events ·{" "}
            {summary.eventTypeCount} event types · {summary.objectTypeCount}{" "}
            object types · {summary.e2oRelationTypeCount} relation types
          </Text>
        </Flex>
      )}
    </Box>
  );
}
