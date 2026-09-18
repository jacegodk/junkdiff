import type {
  ExtensionDiffFile,
  ExtensionFileViewLayout,
  ExtensionFileViewSourceRange,
} from "../../../../extension-api";

/** Id of the folded presentation, qualified by hunk as `hunk-viewed:viewed`. */
export const FOLDED_VIEW_ID = "viewed";

/**
 * Build the one-row "folded" presentation for a viewed file: a green check, the word viewed,
 * the hunk count, and the line stats. Every hunk maps to that row so hunk navigation still
 * stops at the file. A file without hunks folds to its header alone.
 *
 * The row binds every hunk's line span on each side named in `readable`, so a note on any line
 * of the file still resolves to this row and the file stays folded; hunk verifies those bindings
 * against the source, so an unreadable side (a piped patch) is left unbound.
 */
export function buildFoldedLayout(
  file: ExtensionDiffFile,
  readable: { old: boolean; new: boolean } = { old: false, new: false },
): ExtensionFileViewLayout {
  const hunks = file.hunks ?? [];
  if (hunks.length === 0) return { rows: [], hunkRows: [] };
  const plus = `+${file.stats.additions}${file.statsTruncated ? "+" : ""}`;
  const minus = `-${file.stats.deletions}`;
  const sourceRanges: ExtensionFileViewSourceRange[] = [];
  for (const hunk of hunks) {
    if (readable.old && hunk.oldRange) sourceRanges.push({ side: "old", range: hunk.oldRange });
    if (readable.new && hunk.newRange) sourceRanges.push({ side: "new", range: hunk.newRange });
  }
  return {
    rows: [
      {
        id: "folded",
        spans: [
          { text: "✓ ", tone: "added" },
          { text: "viewed", tone: "muted" },
          {
            text: `  ${hunks.length} ${hunks.length === 1 ? "hunk" : "hunks"}  ${plus} ${minus}`,
            tone: "muted",
          },
        ],
        ...(sourceRanges.length > 0 ? { sourceRanges } : {}),
      },
    ],
    hunkRows: hunks.map(() => ({ startRow: 0, endRow: 0 })),
  };
}
