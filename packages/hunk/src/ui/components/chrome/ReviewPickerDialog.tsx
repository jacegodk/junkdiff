import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import { listWindowStart } from "../../lib/listWindow";
import { MODAL_FRAME_CHROME_ROWS } from "../../lib/modalGeometry";
import { fitText, padText } from "../../lib/text";
import type { AppTheme } from "../../themes";
import type { ReviewPickerItem } from "../../reviewPicker";
import { ModalFrame } from "./ModalFrame";

/** Rows the picker shows before it scrolls. */
export const REVIEW_PICKER_MAX_ROWS = 10;
/** Hint row and the blank row under it, inside the frame's body. */
const PICKER_HEADER_ROWS = 2;

/** Which rows of a one-column scrollbar the thumb covers for the current window. */
export function scrollbarThumb(windowStart: number, visibleRows: number, itemCount: number) {
  const size = Math.max(1, Math.round((visibleRows * visibleRows) / itemCount));
  const travel = visibleRows - size;
  const start =
    itemCount <= visibleRows ? 0 : Math.round((windowStart * travel) / (itemCount - visibleRows));
  return { start, end: start + size };
}

/**
 * The two-step picker: which worktree to review, then which base to diff against. The frame
 * grows with the list up to REVIEW_PICKER_MAX_ROWS rows, then the list scrolls behind a scrollbar.
 */
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
  const chromeRows = MODAL_FRAME_CHROME_ROWS + PICKER_HEADER_ROWS;
  const visibleRows = Math.max(
    1,
    Math.min(items.length, REVIEW_PICKER_MAX_ROWS, terminalHeight - 2 - chromeRows),
  );
  const modalHeight = visibleRows + chromeRows;
  const bodyWidth = Math.max(1, width - 4);
  const scrolls = items.length > visibleRows;
  const windowStart = listWindowStart(selectedIndex, items.length, visibleRows);
  const visibleItems = items.slice(windowStart, windowStart + visibleRows);
  const thumb = scrollbarThumb(windowStart, visibleRows, items.length);
  const markerWidth = Math.min(2, bodyWidth);
  const scrollbarWidth = scrolls ? 2 : 0;
  const descriptionWidth = bodyWidth >= 40 ? 10 : 0;
  const labelWidth = Math.max(
    0,
    bodyWidth - markerWidth - scrollbarWidth - descriptionWidth - (descriptionWidth ? 2 : 0),
  );
  const title = step === "worktree" ? "Pick a worktree (latest activity first)" : "Diff against";
  const hint =
    step === "worktree"
      ? "Enter/click open  Esc keep this one"
      : "Enter/click compare  Esc keep the working tree";
  const select = (index: number) => onSelectItem(Math.max(0, Math.min(items.length - 1, index)));

  return (
    <ModalFrame
      height={modalHeight}
      terminalHeight={terminalHeight}
      terminalWidth={terminalWidth}
      theme={theme}
      title={title}
      width={width}
      onClose={onClose}
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction;
        if (direction === "up") select(selectedIndex - 1);
        else if (direction === "down") select(selectedIndex + 1);
      }}
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
        const onThumb = offset >= thumb.start && offset < thumb.end;
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
            {scrolls ? (
              <text fg={onThumb ? theme.accent : theme.muted}>{onThumb ? " █" : " │"}</text>
            ) : null}
          </box>
        );
      })}
    </ModalFrame>
  );
}
