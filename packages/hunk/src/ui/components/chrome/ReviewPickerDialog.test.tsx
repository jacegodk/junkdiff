import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { ReactNode } from "react";
import { resolveTheme } from "../../themes";
import { REVIEW_PICKER_MAX_ROWS, ReviewPickerDialog, scrollbarThumb } from "./ReviewPickerDialog";

async function captureFrame(node: ReactNode, width = 120, height = 40) {
  const setup = await testRender(node, { width, height });
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    return setup.captureCharFrame();
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

const theme = resolveTheme("github-dark-default", null);
const items = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `w${index}`,
    label: `branch-${index}  /work/w${index}`,
    description: `${index}h`,
  }));

/** Rows of the frame between its top and bottom border. */
function frameRows(frame: string) {
  const lines = frame.split("\n");
  const top = lines.findIndex((line) => line.includes("┌"));
  const bottom = lines.findIndex((line) => line.includes("└"));
  return { top, bottom, inner: bottom - top - 1 };
}

describe("ReviewPickerDialog", () => {
  test("the frame grows with the list: three rows give a short dialog with no scrollbar", async () => {
    const frame = await captureFrame(
      <ReviewPickerDialog
        items={items(3)}
        selectedIndex={0}
        step="worktree"
        terminalHeight={40}
        terminalWidth={120}
        theme={theme}
        onAcceptItem={() => {}}
        onClose={() => {}}
        onSelectItem={() => {}}
      />,
    );
    // title, top padding, hint, blank, three rows, bottom padding: 8 inner rows.
    expect(frameRows(frame).inner).toBe(8);
    expect(frame).toContain("› branch-0");
    expect(frame).toContain("branch-2");
    expect(frame).not.toContain("│ ");
    expect(frame).not.toContain("█");
  });

  test("more than ten rows: ten are shown, a scrollbar appears, and the window follows the selection", async () => {
    const many = items(25);
    const top = await captureFrame(
      <ReviewPickerDialog
        items={many}
        selectedIndex={0}
        step="worktree"
        terminalHeight={40}
        terminalWidth={120}
        theme={theme}
        onAcceptItem={() => {}}
        onClose={() => {}}
        onSelectItem={() => {}}
      />,
    );
    expect(frameRows(top).inner).toBe(REVIEW_PICKER_MAX_ROWS + 5);
    expect(top).toContain("branch-9 ");
    expect(top).not.toContain("branch-10 ");
    expect(top).toContain("█");

    const bottom = await captureFrame(
      <ReviewPickerDialog
        items={many}
        selectedIndex={24}
        step="worktree"
        terminalHeight={40}
        terminalWidth={120}
        theme={theme}
        onAcceptItem={() => {}}
        onClose={() => {}}
        onSelectItem={() => {}}
      />,
    );
    expect(bottom).toContain("› branch-24");
    expect(bottom).toContain("branch-15 ");
    expect(bottom).not.toContain("branch-14 ");
  });

  test("scrollbarThumb spans the window's share of the list and reaches both ends", () => {
    expect(scrollbarThumb(0, 10, 25)).toEqual({ start: 0, end: 4 });
    expect(scrollbarThumb(15, 10, 25)).toEqual({ start: 6, end: 10 });
    expect(scrollbarThumb(0, 3, 3)).toEqual({ start: 0, end: 3 });
    expect(scrollbarThumb(0, 10, 1000)).toEqual({ start: 0, end: 1 });
  });

  test("a short terminal clamps the rows below the maximum", async () => {
    const frame = await captureFrame(
      <ReviewPickerDialog
        items={items(25)}
        selectedIndex={0}
        step="base"
        terminalHeight={14}
        terminalWidth={80}
        theme={theme}
        onAcceptItem={() => {}}
        onClose={() => {}}
        onSelectItem={() => {}}
      />,
      80,
      14,
    );
    expect(frame).toContain("Diff against");
    expect(frame.split("\n").every((line) => line.length <= 80)).toBe(true);
    expect(frameRows(frame).inner).toBeLessThan(REVIEW_PICKER_MAX_ROWS + 5);
  });
});
