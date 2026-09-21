/**
 * Collapsed-gap addressing: which file lines an expandable gap covers.
 *
 * A gap is addressed by a stable id (`before:<hunkIndex>` / `trailing:<hunkIndex>`) and
 * resolves to one inclusive line range per side. Renderers draw those ranges, expansion
 * slices source text with them, and note validation accepts or rejects a line against
 * them — so all three must resolve the same address (`docs/browser-review-seam-audit.md`,
 * A1/A2/A5).
 *
 * The input is the parsed diff geometry rather than a projected `ReviewFileV1`, so the
 * terminal's row builder can resolve an address without projecting a document first;
 * `reviewGapSourceForFile` adapts a semantic file onto the same shape.
 */
import type { ReviewHunkSpan } from "./geometry";
import type { ReviewFileChangeKind, ReviewFileV1, ReviewLineRange, ReviewSide } from "./types";

export type ReviewGapPosition = "before" | "trailing";

export interface ReviewGapHunk extends ReviewHunkSpan {
  collapsedBefore: number;
  additionLineIndex: number;
  deletionLineIndex: number;
}

/**
 * The parsed facts gap addressing needs.
 *
 * `additionLines` / `deletionLines` are the patch's per-side line arrays; their lengths
 * are the file's line totals only when the patch is complete, which is why a partial
 * patch has no trailing gap.
 */
export interface ReviewGapSource {
  hunks: readonly ReviewGapHunk[];
  additionLines: readonly string[];
  deletionLines: readonly string[];
  isPartial: boolean;
  /**
   * junk: the expansion side's full line count, once that source has been read. A partial
   * patch — every ordinary Git diff — carries no file length, so without this there is no
   * trailing gap and nothing below the last hunk can be revealed.
   */
  totalLines?: number;
}

export interface ReviewGapAddress {
  position: ReviewGapPosition;
  hunkIndex: number;
  oldRange: ReviewLineRange;
  newRange: ReviewLineRange;
  /** Rows the gap renders; both sides always span exactly this many lines. */
  lineCount: number;
}

/**
 * junk: how much of a collapsed gap is revealed without opening it fully. `head` lines are
 * shown from the gap's start (next to the hunk above, or the file start), `tail` lines from
 * its end (next to the hunk below, or the file end); the rest stays a collapsed row between.
 */
export interface ReviewGapReveal {
  head: number;
  tail: number;
}

/** Clamp a reveal to the gap so head and tail never overlap; both zero means nothing shown. */
export function clampReviewGapReveal(reveal: ReviewGapReveal, lineCount: number): ReviewGapReveal {
  const head = Math.max(0, Math.min(reveal.head, lineCount));
  const tail = Math.max(0, Math.min(reveal.tail, lineCount - head));
  return { head, tail };
}

/** Build the stable id of one collapsed gap inside a single file. */
export function reviewGapId(position: ReviewGapPosition, hunkIndex: number) {
  return `${position}:${hunkIndex}`;
}

/** Parse one gap id back into its position and hunk index, or undefined when malformed. */
export function parseReviewGapId(gapId: string) {
  const match = /^(before|trailing):(\d+)$/.exec(gapId);
  if (!match) {
    return undefined;
  }
  const hunkIndex = Number(match[2]);
  return Number.isSafeInteger(hunkIndex)
    ? { position: match[1] as ReviewGapPosition, hunkIndex }
    : undefined;
}

/**
 * Adapt one projected semantic file onto the geometry gap addressing reads.
 *
 * junk: `totalLines` is the expansion side's length from the file's loaded source, which is
 * what gives a partial patch a trailing gap. Callers that have not read the source pass
 * nothing and see the same geometry as before.
 */
export function reviewGapSourceForFile(file: ReviewFileV1, totalLines?: number): ReviewGapSource {
  return {
    hunks: file.hunks,
    additionLines: file.additionLines,
    deletionLines: file.deletionLines,
    isPartial: file.flags.partial,
    ...(totalLines === undefined ? {} : { totalLines }),
  };
}

/**
 * The gap of unchanged lines the patch omitted before one hunk.
 *
 * Each side's gap ends at the last line before the hunk's own content. A side with rows
 * ends one line before its start; a side with none — the old side of a pure insertion,
 * the new side of a pure deletion — is positioned *at* that last line, so the gap ends
 * there. Getting this wrong shifts every expanded line label on that side by one, which
 * is exactly what the terminal's own copy did (A1).
 *
 * The gap's length is the parser's `collapsedBefore`. Returns undefined when there is no
 * gap, or when its start would fall outside the file.
 */
export function reviewLeadingGap(
  source: ReviewGapSource,
  hunkIndex: number,
): ReviewGapAddress | undefined {
  const hunk = source.hunks[hunkIndex];
  if (!hunk || hunk.collapsedBefore <= 0) {
    return undefined;
  }

  const oldEnd = hunk.deletionStart - (hunk.deletionCount > 0 ? 1 : 0);
  const newEnd = hunk.additionStart - (hunk.additionCount > 0 ? 1 : 0);
  const oldStart = oldEnd - hunk.collapsedBefore + 1;
  const newStart = newEnd - hunk.collapsedBefore + 1;
  if (oldStart <= 0 || newStart <= 0) {
    return undefined;
  }

  return {
    position: "before",
    hunkIndex,
    oldRange: [oldStart, oldEnd],
    newRange: [newStart, newEnd],
    lineCount: hunk.collapsedBefore,
  };
}

/**
 * The gap of unchanged lines after the file's last hunk.
 *
 * Length comes from what each side's line array has left over once the last hunk is
 * consumed, and the two leftovers must agree because the gap renders as paired rows. A
 * partial patch has no authoritative totals, so it has no trailing gap.
 *
 * Known limitation (A2): a last hunk with a zero-count side leaves the two leftovers one
 * apart, so no trailing gap is offered even though the file has unchanged lines after
 * the hunk. Every consumer agrees on hiding it — correcting the count changes what the
 * terminal renders and is staged as its own change.
 *
 * junk: a partial patch has a trailing gap once `totalLines` names the expansion side's
 * length. Everything after the last hunk is unchanged context, so both sides run equally
 * long and the old side's length follows from the new side's.
 */
export function reviewTrailingGap(source: ReviewGapSource): ReviewGapAddress | undefined {
  const hunkIndex = source.hunks.length - 1;
  const hunk = source.hunks[hunkIndex];
  if (!hunk) {
    return undefined;
  }

  if (source.isPartial) {
    // Both sides must have rows for their end lines to be comparable; the zero-count shape
    // is the A2 limitation above and stays hidden.
    if (source.totalLines === undefined || hunk.additionCount <= 0 || hunk.deletionCount <= 0) {
      return undefined;
    }
    const newEnd = hunk.additionStart + hunk.additionCount - 1;
    const count = source.totalLines - newEnd;
    if (count <= 0) {
      return undefined;
    }
    const partialOldStart = hunk.deletionStart + hunk.deletionCount;
    return {
      position: "trailing",
      hunkIndex,
      oldRange: [partialOldStart, partialOldStart + count - 1],
      newRange: [newEnd + 1, newEnd + count],
      lineCount: count,
    };
  }

  const oldCount = source.deletionLines.length - (hunk.deletionLineIndex + hunk.deletionCount);
  const newCount = source.additionLines.length - (hunk.additionLineIndex + hunk.additionCount);
  if (oldCount !== newCount || oldCount <= 0) {
    return undefined;
  }

  const oldStart = hunk.deletionStart + hunk.deletionCount;
  const newStart = hunk.additionStart + hunk.additionCount;
  return {
    position: "trailing",
    hunkIndex,
    oldRange: [oldStart, oldStart + oldCount - 1],
    newRange: [newStart, newStart + newCount - 1],
    lineCount: oldCount,
  };
}

/** Resolve one gap id against the current geometry, or undefined when it addresses nothing. */
export function reviewGapAddress(
  source: ReviewGapSource,
  gapId: string,
): ReviewGapAddress | undefined {
  const parsed = parseReviewGapId(gapId);
  if (!parsed) {
    return undefined;
  }
  if (parsed.position === "before") {
    return reviewLeadingGap(source, parsed.hunkIndex);
  }
  const trailing = reviewTrailingGap(source);
  return trailing?.hunkIndex === parsed.hunkIndex ? trailing : undefined;
}

/**
 * A caller's claim that one line it is addressing came from an expanded gap.
 *
 * A line inside a gap is not in the patch at all, so nothing about the file proves it
 * exists: a surface that expanded a gap and then addressed a line in it has to say which
 * gap, and which content it was reading. The identity is what makes the claim checkable
 * across a reload — the same gap over different source text is a different set of lines.
 */
export interface ReviewExpandedLineClaim {
  gapId: string;
  side: ReviewSide;
  line: number;
  /** Identity of the source the caller expanded; must still be the file's own. */
  sourceIdentity: string;
}

/**
 * Resolve one expanded-line claim against the file's current geometry.
 *
 * Returns the gap the line belongs to, or undefined when the claim does not hold — the
 * gap is gone, the line falls outside it, or the source behind it has been replaced. The
 * gap's `hunkIndex` is what an anchor uses as the owning hunk, so a note on an expanded
 * line stays attached to the hunk the reviewer was reading (`docs/browser-review-seam-
 * audit.md`, B10/D3).
 */
export function resolveReviewExpandedLine(
  file: ReviewFileV1,
  claim: ReviewExpandedLineClaim,
): ReviewGapAddress | undefined {
  if (file.sourceIdentity === undefined || file.sourceIdentity !== claim.sourceIdentity) {
    return undefined;
  }
  const address = reviewGapAddress(reviewGapSourceForFile(file), claim.gapId);
  if (!address) {
    return undefined;
  }
  const [start, end] = claim.side === "old" ? address.oldRange : address.newRange;
  return claim.line >= start && claim.line <= end ? address : undefined;
}

/**
 * Which side's full source text fills this file's expanded gaps.
 *
 * A deleted file has no new side to read, so its gaps come from the old one. Both ranges
 * of a gap stay addressable either way; this only decides where the text is read from.
 */
export function reviewExpansionSide(changeKind: ReviewFileChangeKind): ReviewSide {
  return changeKind === "deleted" ? "old" : "new";
}
