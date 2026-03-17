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

  function selectAll() {
    onChange(new Set(bothLogTypes));
  }

  function selectNone() {
    onChange(new Set());
  }

  return (
    <div style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.4rem",
        }}
      >
        <strong style={{ fontSize: "0.85rem" }}>Event types to test</strong>
        <span style={{ fontSize: "0.75rem" }}>
          <button
            style={{ padding: "1px 6px", fontSize: "0.75rem" }}
            onClick={selectAll}
          >
            all
          </button>{" "}
          <button
            style={{ padding: "1px 6px", fontSize: "0.75rem" }}
            onClick={selectNone}
          >
            none
          </button>
        </span>
      </div>

      <div style={{ maxHeight: "180px", overflowY: "auto", fontSize: "0.8rem" }}>
        {bothLogTypes.map((et) => (
          <label
            key={et}
            style={{ display: "flex", alignItems: "center", gap: "6px", padding: "2px 0" }}
          >
            <input
              type="checkbox"
              checked={selected.has(et)}
              onChange={() => toggle(et)}
            />
            {et}
          </label>
        ))}

        {onlyInLog1.map((et) => (
          <div
            key={et}
            style={{ padding: "2px 0", color: "#9ca3af", paddingLeft: "22px" }}
          >
            {et} <em>(log 1 only)</em>
          </div>
        ))}

        {onlyInLog2.map((et) => (
          <div
            key={et}
            style={{ padding: "2px 0", color: "#9ca3af", paddingLeft: "22px" }}
          >
            {et} <em>(log 2 only)</em>
          </div>
        ))}
      </div>
    </div>
  );
}
