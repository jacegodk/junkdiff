import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "../../../../extension-api";
import { buildFoldedLayout } from "./foldedView";

function file(hunkCount: number, additions = 11, deletions = 0): ExtensionDiffFile {
  return {
    id: "1",
    path: "src/a.ts",
    patch: "",
    stats: { additions, deletions },
    metadata: {},
    agent: null,
    hunks: Array.from({ length: hunkCount }, (_, index) => ({
      index,
      header: `@@ ${index} @@`,
      oldRange: [index * 10 + 1, index * 10 + 3],
      newRange: [index * 10 + 2, index * 10 + 5],
    })) as ExtensionDiffFile["hunks"],
  };
}

describe("buildFoldedLayout", () => {
  test("folds a file with hunks to one row that every hunk maps to", () => {
    const layout = buildFoldedLayout(file(3));
    expect(layout.rows.length).toBe(1);
    expect(layout.hunkRows).toEqual([
      { startRow: 0, endRow: 0 },
      { startRow: 0, endRow: 0 },
      { startRow: 0, endRow: 0 },
    ]);
    const text = layout.rows[0]!.spans.map((span) => span.text).join("");
    expect(text).toBe("✓ viewed  3 hunks  +11 -0");
    expect(layout.rows[0]!.spans[0]).toEqual({ text: "✓ ", tone: "added" });
    expect(layout.rows[0]!.spans.slice(1).every((span) => span.tone === "muted")).toBe(true);
    // Nothing readable: no bindings, so a note on the file makes hunk show the raw diff.
    expect(layout.rows[0]!.sourceRanges).toBeUndefined();
  });

  test("binds every hunk's line span on each readable side, so a note keeps the file folded", () => {
    const both = buildFoldedLayout(file(2), { old: true, new: true });
    expect(both.rows[0]!.sourceRanges).toEqual([
      { side: "old", range: [1, 3] },
      { side: "new", range: [2, 5] },
      { side: "old", range: [11, 13] },
      { side: "new", range: [12, 15] },
    ]);
    const newOnly = buildFoldedLayout(file(2), { old: false, new: true });
    expect(newOnly.rows[0]!.sourceRanges!.every((range) => range.side === "new")).toBe(true);
  });

  test("uses singular hunk and shows truncated stats", () => {
    const layout = buildFoldedLayout({ ...file(1, 3, 2), statsTruncated: true });
    expect(layout.rows[0]!.spans.map((span) => span.text).join("")).toBe(
      "✓ viewed  1 hunk  +3+ -2",
    );
  });

  test("folds a file without hunks to nothing", () => {
    expect(buildFoldedLayout(file(0))).toEqual({ rows: [], hunkRows: [] });
  });
});
