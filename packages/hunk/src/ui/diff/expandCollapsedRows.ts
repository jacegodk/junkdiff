import {
  clampReviewGapReveal,
  reviewGapId,
  type ReviewGapReveal,
} from "../../core/review/expansion";
import { normalizedReviewSourceLines } from "../../core/review/geometry";
import { DEFAULT_TAB_WIDTH } from "../../core/run/tabWidth";
import { sanitizeTerminalLine, sanitizeTerminalSpans } from "../../lib/terminalText";
import { expandDiffTabs } from "./codeColumns";
import type {
  CollapsedGapPosition,
  DiffRow,
  RenderSpan,
  SplitLineCell,
  UnifiedLineCell,
} from "./diffRows";

export type ExpansionLayout = "split" | "unified";

/** Per-file load status for the source text used to fill expanded gaps. */
export type FileSourceStatus =
  | { kind: "loading" }
  | { kind: "loaded"; text: string }
  | { kind: "error"; reason?: "too-large" };

export interface ExpandCollapsedRowsOptions {
  layout: ExpansionLayout;
  expandedKeys: ReadonlySet<string>;
  /** junk: gaps that show only `head` lines from their start and `tail` lines from their end. */
  revealedGaps?: ReadonlyMap<string, ReviewGapReveal>;
  sourceStatus: FileSourceStatus | undefined;
  tabWidth?: number;
  /** Optional syntax-aware span resolver for a zero-based source line. */
  sourceLineSpans?: (line: string | undefined, sourceLineNumber: number) => RenderSpan[];
  // Whose side's line indices in the source text. Defaults to "new".
  // For deleted files (no new side) callers should pass "old" instead.
  side?: "old" | "new";
}

function expandedRowText(lineCount: number) {
  return `Hide ${lineCount} unchanged ${lineCount === 1 ? "line" : "lines"}`;
}

function loadingRowText(lineCount: number) {
  return `Loading ${lineCount} unchanged ${lineCount === 1 ? "line" : "lines"}…`;
}

function errorRowText(lineCount: number, reason?: "too-large") {
  if (reason === "too-large") {
    return `Source too large to expand ${lineCount} unchanged ${lineCount === 1 ? "line" : "lines"}`;
  }

  return `Could not load ${lineCount} unchanged ${lineCount === 1 ? "line" : "lines"}`;
}

function spansFor(line: string | undefined, tabWidth: number): RenderSpan[] {
  const text = expandDiffTabs(sanitizeTerminalLine(line ?? ""), tabWidth);
  return text.length > 0 ? [{ text }] : [];
}

function buildSplitContextRow(
  fileId: string,
  hunkIndex: number,
  position: CollapsedGapPosition,
  index: number,
  oldLineNumber: number,
  newLineNumber: number,
  spans: RenderSpan[],
): Extract<DiffRow, { type: "split-line" }> {
  const cell = (lineNumber: number): SplitLineCell => ({
    kind: "context",
    sign: " ",
    lineNumber,
    spans,
  });

  return {
    type: "split-line",
    key: `${fileId}:expanded:${position}:${hunkIndex}:${index}`,
    fileId,
    hunkIndex,
    left: cell(oldLineNumber),
    right: cell(newLineNumber),
    isExpansionRow: true,
    expandedGapKey: reviewGapId(position, hunkIndex),
  };
}

function buildUnifiedContextRow(
  fileId: string,
  hunkIndex: number,
  position: CollapsedGapPosition,
  index: number,
  oldLineNumber: number,
  newLineNumber: number,
  spans: RenderSpan[],
): Extract<DiffRow, { type: "unified-line" }> {
  const cell: UnifiedLineCell = {
    kind: "context",
    sign: " ",
    oldLineNumber,
    newLineNumber,
    spans,
  };

  return {
    type: "unified-line",
    key: `${fileId}:expanded:${position}:${hunkIndex}:${index}`,
    fileId,
    hunkIndex,
    cell,
    isExpansionRow: true,
    expandedGapKey: reviewGapId(position, hunkIndex),
  };
}

/**
 * Replace each expanded collapsed row with the actual unchanged file lines it
 * represents. The original collapsed row stays in place as a status row, and
 * synthesized context rows follow it when source has loaded. When source is
 * still loading or failed, only the row label changes so the user sees the
 * state of the request.
 */
export function expandCollapsedRows(
  rows: DiffRow[],
  options: ExpandCollapsedRowsOptions,
): DiffRow[] {
  const {
    layout,
    expandedKeys,
    revealedGaps,
    sourceLineSpans,
    sourceStatus,
    tabWidth = DEFAULT_TAB_WIDTH,
    side = "new",
  } = options;

  if (expandedKeys.size === 0 && (revealedGaps?.size ?? 0) === 0) {
    return rows;
  }

  const sourceLines =
    sourceStatus?.kind === "loaded" ? normalizedReviewSourceLines(sourceStatus.text) : [];
  const result: DiffRow[] = [];

  for (const row of rows) {
    if (row.type !== "collapsed") {
      result.push(row);
      continue;
    }

    const key = reviewGapId(row.position, row.hunkIndex);
    const reveal = expandedKeys.has(key) ? undefined : revealedGaps?.get(key);
    if (!expandedKeys.has(key) && reveal === undefined) {
      result.push(row);
      continue;
    }

    const range = side === "old" ? row.oldRange : row.newRange;
    const lineCount = Math.max(0, range[1] - range[0] + 1);

    if (sourceStatus?.kind === "loading") {
      result.push({ ...row, text: loadingRowText(lineCount) });
      continue;
    }

    if (sourceStatus?.kind === "error") {
      result.push({ ...row, text: errorRowText(lineCount, sourceStatus.reason) });
      continue;
    }

    if (sourceStatus === undefined) {
      // expandedKeys can briefly contain a key before the controller's load
      // status is committed; keep the original label until status arrives.
      result.push(row);
      continue;
    }

    const sourceStartIndex = range[0] - 1;
    const sourceEndIndex = range[1] - 1;
    if (
      lineCount > 0 &&
      (sourceStartIndex < 0 ||
        sourceEndIndex < sourceStartIndex ||
        sourceEndIndex >= sourceLines.length)
    ) {
      result.push({ ...row, text: errorRowText(lineCount) });
      continue;
    }

    const contextRow = (offset: number) => {
      const oldLineNumber = row.oldRange[0] + offset;
      const newLineNumber = row.newRange[0] + offset;
      const sourceLineNumber = (side === "old" ? oldLineNumber : newLineNumber) - 1;
      if (sourceLineNumber < 0 || sourceLineNumber >= sourceLines.length) {
        return undefined;
      }

      const text = sourceLines[sourceLineNumber];
      const spans = sourceLineSpans
        ? sanitizeTerminalSpans(sourceLineSpans(text, sourceLineNumber))
        : spansFor(text, tabWidth);

      return layout === "split"
        ? buildSplitContextRow(
            row.fileId,
            row.hunkIndex,
            row.position,
            offset,
            oldLineNumber,
            newLineNumber,
            spans,
          )
        : buildUnifiedContextRow(
            row.fileId,
            row.hunkIndex,
            row.position,
            offset,
            oldLineNumber,
            newLineNumber,
            spans,
          );
    };

    if (reveal !== undefined) {
      // junk: a partly revealed gap shows its head lines, then the collapsed row for what is
      // still hidden, then its tail lines, so the shown lines sit next to the hunks around it.
      const { head, tail } = clampReviewGapReveal(reveal, lineCount);
      const hidden = lineCount - head - tail;
      for (let offset = 0; offset < head; offset += 1) {
        const contextLine = contextRow(offset);
        if (!contextLine) break;
        result.push(contextLine);
      }
      if (hidden > 0) {
        result.push({
          ...row,
          text: `${hidden} unchanged ${hidden === 1 ? "line" : "lines"}`,
          oldRange: [row.oldRange[0] + head, row.oldRange[1] - tail],
          newRange: [row.newRange[0] + head, row.newRange[1] - tail],
        });
      }
      for (let offset = lineCount - tail; offset < lineCount; offset += 1) {
        const contextLine = contextRow(offset);
        if (!contextLine) break;
        result.push(contextLine);
      }
      continue;
    }

    result.push({
      ...row,
      text: expandedRowText(lineCount),
    });

    for (let offset = 0; offset < lineCount; offset += 1) {
      const contextLine = contextRow(offset);
      if (!contextLine) break;
      result.push(contextLine);
    }
  }

  return result;
}
