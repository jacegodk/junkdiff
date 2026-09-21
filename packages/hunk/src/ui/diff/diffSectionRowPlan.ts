import type { ReviewGapReveal } from "../../core/review/expansion";
import { reviewExpansionSide } from "../../core/review/expansion";
import { normalizedReviewSourceLines } from "../../core/review/geometry";
import { DEFAULT_TAB_WIDTH } from "../../core/run/tabWidth";
import { DEFAULT_HUNK_GAP } from "../../core/run/reviewGap";
import type { DiffFile } from "../../core/changeset/model";
import type { LayoutMode } from "../../core/run/commandInputs";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import type { AppTheme } from "../themes";
import { findMaxLineNumber, findMaxLineNumberInRows } from "./codeColumns";
import { expandCollapsedRows, type FileSourceStatus } from "./expandCollapsedRows";
import {
  buildSplitRows,
  buildUnifiedRows,
  type HighlightedDiffCode,
  type RenderSpan,
} from "./diffRows";
import { buildReviewRenderPlan, type PlannedReviewRow } from "./reviewRenderPlan";

const EMPTY_EXPANDED_GAP_KEYS: ReadonlySet<string> = new Set();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

export interface DiffSectionRowPlan {
  lineNumberDigits: number;
  plannedRows: PlannedReviewRow[];
}

export interface BuildDiffSectionRowPlanOptions {
  expandedKeys?: ReadonlySet<string>;
  /** junk: gaps showing only some of their lines. */
  revealedGaps?: ReadonlyMap<string, ReviewGapReveal>;
  file: DiffFile | undefined;
  highlightedDiff?: HighlightedDiffCode | null;
  layout: Exclude<LayoutMode, "auto">;
  showHunkHeaders: boolean;
  sourceLineSpans?: (line: string | undefined, sourceLineNumber: number) => RenderSpan[];
  sourceStatus?: FileSourceStatus | undefined;
  tabWidth?: number;
  hunkGap?: number;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
}

/** Build Pierre rows for one file using the selected terminal diff layout. */
function buildBaseRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  highlightedDiff: HighlightedDiffCode | null | undefined,
  theme: AppTheme,
  tabWidth: number,
  sourceTotalLines: number | undefined,
) {
  return layout === "split"
    ? buildSplitRows(file, highlightedDiff ?? null, theme, tabWidth, sourceTotalLines)
    : buildUnifiedRows(file, highlightedDiff ?? null, theme, tabWidth, sourceTotalLines);
}

/** Build the shared file-level diff plan consumed by rendering and geometry measurement. */
export function buildDiffSectionRowPlan({
  expandedKeys = EMPTY_EXPANDED_GAP_KEYS,
  revealedGaps,
  file,
  highlightedDiff = null,
  layout,
  showHunkHeaders,
  sourceLineSpans,
  sourceStatus,
  tabWidth = DEFAULT_TAB_WIDTH,
  hunkGap = DEFAULT_HUNK_GAP,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
}: BuildDiffSectionRowPlanOptions): DiffSectionRowPlan {
  if (!file) {
    return {
      lineNumberDigits: 1,
      plannedRows: [],
    };
  }

  // junk: the loaded source's length is what gives a partial patch its trailing gap.
  const sourceTotalLines =
    sourceStatus?.kind === "loaded"
      ? normalizedReviewSourceLines(sourceStatus.text).length
      : undefined;
  const baseRows = buildBaseRows(file, layout, highlightedDiff, theme, tabWidth, sourceTotalLines);
  const rows = expandCollapsedRows(baseRows, {
    layout,
    expandedKeys,
    revealedGaps,
    sourceLineSpans,
    sourceStatus,
    tabWidth,
    side: reviewExpansionSide(file.metadata.type),
  });

  return {
    lineNumberDigits: String(findMaxLineNumberInRows(rows, findMaxLineNumber(file))).length,
    plannedRows: buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders,
      visibleAgentNotes,
      hunkGap,
    }),
  };
}
