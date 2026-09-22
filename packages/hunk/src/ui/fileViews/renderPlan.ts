import type { AgentAnnotation } from "../../extension-api/types";
import type { ExtensionFileViewLayout, ExtensionFileViewRow } from "../../extension-api/types";
import { inlineNoteStableKey, lineStableKey } from "../diff/reviewRenderPlan";
import { annotationAnchor, type VisibleAgentNote } from "../lib/agentAnnotations";

/** One validated extension row or host-owned inline note in an alternate file presentation. */
export type PlannedFileViewRow =
  | {
      readonly kind: "file-view-row";
      readonly key: string;
      readonly stableKey: string;
      /** The source line this row presents, so review-stream navigation can address it. */
      readonly stableAliasKeys?: readonly string[];
      readonly row: ExtensionFileViewRow;
      readonly rowIndex: number;
    }
  | {
      readonly kind: "inline-note";
      readonly key: string;
      readonly stableKey: string;
      readonly annotation: AgentAnnotation;
      readonly anchorRowIndex: number;
      readonly anchorSide: "old" | "new";
      readonly hunkIndex: number;
      readonly note: VisibleAgentNote;
      readonly noteCount: number;
      readonly noteIndex: number;
    };

export interface FileViewRenderPlan {
  readonly rows: readonly PlannedFileViewRow[];
  /** Notes without one exact bound anchor force the file back to raw diff. */
  readonly unresolvedNoteIds: readonly string[];
}

/** Resolve the hunks owning every row in one bounded sweep; most rows have exactly one. */
function hunkOwnersByRow(layout: ExtensionFileViewLayout): readonly (readonly number[])[] {
  const starts = Array.from({ length: layout.rows.length + 1 }, () => [] as number[]);
  const ends = Array.from({ length: layout.rows.length + 1 }, () => [] as number[]);
  for (const [hunkIndex, hunkRows] of layout.hunkRows.entries()) {
    starts[hunkRows.startRow]!.push(hunkIndex);
    ends[hunkRows.endRow + 1]!.push(hunkIndex);
  }

  const active = new Set<number>();
  return layout.rows.map((_, rowIndex) => {
    for (const hunkIndex of ends[rowIndex]!) active.delete(hunkIndex);
    for (const hunkIndex of starts[rowIndex]!) active.add(hunkIndex);
    return [...active].sort((left, right) => left - right);
  });
}

/** The one hunk a row shares with the raw diff, or -1 when it has none or several. */
function soleOwner(owners: readonly number[]) {
  return owners.length === 1 ? owners[0]! : -1;
}

/**
 * The hunk a note hangs from on `owners`' row: the sole owner, or on a folded row (owned by
 * every hunk it stands for) the note's own hunk when that is one of them.
 */
function noteHunkIndex(owners: readonly number[], note: VisibleAgentNote) {
  if (owners.length === 1) return owners[0]!;
  const own = note.anchor.ownerHunkIndex;
  return own !== undefined && owners.includes(own) ? own : -1;
}

/** Build the line anchor one presentation row shares with the raw diff, if it owns exactly one hunk. */
function rowLineStableKey(row: ExtensionFileViewRow, hunkIndex: number) {
  const sourceRange = row.sourceRanges?.[0];
  return hunkIndex < 0 || !sourceRange
    ? undefined
    : lineStableKey(hunkIndex, sourceRange.side, sourceRange.range[0]);
}

/**
 * junk: the row of a presentation that folds the whole file into one, or -1 for any other shape.
 *
 * Such a row stands for every line of the file, so it hosts a note whose anchor the patch no
 * longer contains — a note written against another base, or on a line that has since moved out
 * of every hunk. Without this the file could never fold again, because placement is all-or-raw.
 */
function wholeFileRowIndex(layout: ExtensionFileViewLayout): number {
  const foldsWholeFile =
    layout.rows.length === 1 &&
    layout.hunkRows.length > 0 &&
    layout.hunkRows.every((bounds) => bounds.startRow === 0 && bounds.endRow === 0);
  return foldsWholeFile ? 0 : -1;
}

/** Find the unique validated presentation row containing one note's preferred source anchor. */
function boundRowIndex(layout: ExtensionFileViewLayout, annotation: AgentAnnotation) {
  const anchor = annotationAnchor(annotation);
  if (!anchor) return -1;

  return layout.rows.findIndex((row) =>
    (row.sourceRanges ?? []).some(
      (sourceRange) =>
        sourceRange.side === anchor.side &&
        sourceRange.range[0] <= anchor.lineNumber &&
        anchor.lineNumber <= sourceRange.range[1],
    ),
  );
}

/**
 * Insert host-owned notes into one immutable alternate-view row stream.
 *
 * Placement is all-or-raw: if any visible note lacks one exact bound anchor inside a declared hunk,
 * callers must render the raw Pierre diff rather than dropping or guessing at note placement.
 */
export function buildFileViewRenderPlan(
  layout: ExtensionFileViewLayout,
  visibleAgentNotes: readonly VisibleAgentNote[],
): FileViewRenderPlan {
  const notesByRow = new Map<
    number,
    Array<{ note: VisibleAgentNote; anchorSide: "old" | "new"; hunkIndex: number }>
  >();
  const unresolvedNoteIds: string[] = [];
  const hunkOwnerByRow = hunkOwnersByRow(layout);

  for (const note of visibleAgentNotes) {
    const anchor = annotationAnchor(note.annotation);
    const rowIndex =
      boundRowIndex(layout, note.annotation) >= 0
        ? boundRowIndex(layout, note.annotation)
        : wholeFileRowIndex(layout);
    const hunkIndex = rowIndex < 0 ? -1 : noteHunkIndex(hunkOwnerByRow[rowIndex]!, note);
    if (!anchor || rowIndex < 0 || hunkIndex < 0) {
      unresolvedNoteIds.push(note.id);
      continue;
    }
    const notes = notesByRow.get(rowIndex) ?? [];
    notes.push({ note, anchorSide: anchor.side, hunkIndex });
    notesByRow.set(rowIndex, notes);
  }

  const rows: PlannedFileViewRow[] = [];
  const claimedLineKeys = new Set<string>();
  for (const [rowIndex, row] of layout.rows.entries()) {
    const key = `file-view:${row.id}`;
    const lineKey = rowLineStableKey(row, soleOwner(hunkOwnerByRow[rowIndex]!));
    // Only the first row on a line claims it, matching how measured bounds resolve duplicates.
    const claimsLine = lineKey !== undefined && !claimedLineKeys.has(lineKey);
    if (claimsLine) {
      claimedLineKeys.add(lineKey);
    }

    rows.push({
      kind: "file-view-row",
      key,
      stableKey: key,
      ...(claimsLine ? { stableAliasKeys: [lineKey] } : {}),
      row,
      rowIndex,
    });

    const anchoredNotes = notesByRow.get(rowIndex) ?? [];
    for (const [noteIndex, placement] of anchoredNotes.entries()) {
      rows.push({
        kind: "inline-note",
        key: `inline-note:${placement.note.id}:file-view:${row.id}:${noteIndex}`,
        stableKey: inlineNoteStableKey(placement.note.id),
        annotation: placement.note.annotation,
        anchorRowIndex: rowIndex,
        anchorSide: placement.anchorSide,
        hunkIndex: placement.hunkIndex,
        note: placement.note,
        noteCount: anchoredNotes.length,
        noteIndex,
      });
    }
  }

  return {
    rows: Object.freeze(rows),
    unresolvedNoteIds: Object.freeze(unresolvedNoteIds),
  };
}
