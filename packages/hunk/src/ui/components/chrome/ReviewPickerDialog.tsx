import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { listWindowStart } from "../../lib/listWindow";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import type { ReviewPickerItem } from "../../reviewPicker";
import { ModalFrame } from "./ModalFrame";

/** The two-step picker: which worktree to review, then which base to diff against. */
export function ReviewPickerDialog({
  items,
  selectedIndex,
  step,
  terminalHeight,
  terminalWidth,
  theme,
  onAcceptItem,
  onClose,
  onSelectItem,
}: {
  items: ReviewPickerItem[];
  selectedIndex: number;
  step: "worktree" | "base";
  terminalHeight: number;
  terminalWidth: number;
  theme: AppTheme;
  onAcceptItem: (index: number) => void;
  onClose: () => void;
  onSelectItem: (index: number) => void;
}) {
  const width = Math.max(1, Math.min(110, Math.max(56, terminalWidth - 8), terminalWidth - 2));
  const modalHeight = Math.max(
    1,
    Math.min(Math.max(7, items.length + 6), Math.max(8, terminalHeight - 4), terminalHeight - 2),
  );
  const bodyWidth = Math.max(1, width - 4);
  const visibleRows = Math.max(1, modalHeight - 6);
  const windowStart = listWindowStart(selectedIndex, items.length, visibleRows);
  const visibleItems = items.slice(windowStart, windowStart + visibleRows);
  const markerWidth = Math.min(2, bodyWidth);
  const descriptionWidth = bodyWidth >= 40 ? 10 : 0;
  const labelWidth = Math.max(
    0,
    bodyWidth - markerWidth - descriptionWidth - (descriptionWidth ? 2 : 0),
  );
  const title = step === "worktree" ? "Pick a worktree (latest activity first)" : "Diff against";
  const hint =
    step === "worktree"
      ? "Enter/click open  Esc keep this one"
      : "Enter/click compare  Esc keep the working tree";

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={title}
      width={width}
      onClose={onClose}
    >
      <box style={{ width: "100%", height: 1 }}>
        <text fg={theme.muted}>{fitText(hint, bodyWidth)}</text>
      </box>
      <box style={{ width: "100%", height: 1 }} />
      {visibleItems.map((item, offset) => {
        const index = windowStart + offset;
        const selected = index === selectedIndex;
        const bg = selected ? theme.accentMuted : theme.panel;
        const fg = selected ? theme.text : theme.muted;
        return (
          <box
            key={item.id}
            style={{ width: "100%", height: 1, flexDirection: "row", backgroundColor: bg }}
            onMouseOver={() => onSelectItem(index)}
            onMouseUp={(event: TuiMouseEvent) => {
              event.stopPropagation();
              onAcceptItem(index);
            }}
          >
            <text fg={fg}>{padText(selected ? "›" : " ", markerWidth)}</text>
            <text fg={fg}>{padText(fitText(item.label, labelWidth), labelWidth)}</text>
            {descriptionWidth ? (
              <text fg={theme.muted}>{padText(`  ${item.description}`, descriptionWidth + 2)}</text>
            ) : null}
          </box>
        );
      })}
      {windowStart + visibleRows < items.length ? (
        <box style={{ width: "100%", height: 1 }}>
          <text fg={theme.muted}>
            {fitText(`… ${items.length - windowStart - visibleRows} more`, bodyWidth)}
          </text>
        </box>
      ) : null}
    </ModalFrame>
  );
}
