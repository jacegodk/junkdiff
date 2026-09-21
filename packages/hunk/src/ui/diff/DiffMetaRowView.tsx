/** Renders collapsed gaps and hunk headers without introducing code-row geometry policy. */
import type { UserNoteLineTarget } from "../../core/liveComments";
import { reviewGapId } from "../../core/review/expansion";
import type { AppTheme } from "../themes";
import { CODE_ROW_ADD_NOTE_BADGE_TEXT } from "./codeRowAffordance";
import type { PlannedDiffMetaReviewRow } from "./reviewRenderPlan";
import { fitText } from "./plannedRowText";
import { diffRailMarker, dimRailColor, neutralRailColor } from "./rowStyle";
import { markNestedRowMouseAction } from "./rowMouseActions";

export interface DiffMetaRowViewProps {
  plannedRow: PlannedDiffMetaReviewRow;
  width: number;
  theme: AppTheme;
  selected: boolean;
  showHunkHeaders: boolean;
  showAddNoteBadge?: boolean;
  onHoverRow?: (rowKey: string) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  onToggleGap?: (gapKey: string) => void;
  /** junk: reveal `lines` more of this gap, from its start (head) or its end (tail). */
  onRevealGap?: (gapKey: string, side: "head" | "tail", lines: number) => void;
}

/** junk: unchanged lines one click on a gap row's arrow reveals. */
const GAP_ARROW_STEP = 10;

/** Build the rendered label text for one collapsed gap row. */
function collapsedRowLabel(text: string, expandable: boolean) {
  if (!expandable) {
    return `··· ${text} ···`;
  }

  // The leading chevron hints that the row is interactive on terminals that
  // render Unicode glyphs. The label still reads naturally on plain VT100.
  return `▾ ${text}`;
}

/** Render one collapsed gap or hunk header with its nested row controls. */
export function DiffMetaRowView({
  plannedRow,
  width,
  theme,
  selected,
  showHunkHeaders,
  showAddNoteBadge = false,
  onHoverRow,
  onStartUserNoteAtHunk,
  onToggleGap,
  onRevealGap,
}: DiffMetaRowViewProps) {
  const { anchorId, row } = plannedRow;
  if (row.type === "hunk-header" && !showHunkHeaders) {
    return null;
  }

  // junk: a collapsed gap can be opened from either end without opening all of it. The arrow
  // pointing down extends the code above, the one pointing up extends the code below.
  const gapKey = row.type === "collapsed" ? reviewGapId(row.position, row.hunkIndex) : null;
  const gapArrows =
    gapKey && onRevealGap
      ? [
          {
            key: "reveal-head",
            text: "▼",
            quiet: true,
            onClick: () => onRevealGap(gapKey, "head", GAP_ARROW_STEP),
          },
          {
            key: "reveal-tail",
            text: "▲",
            quiet: true,
            onClick: () => onRevealGap(gapKey, "tail", GAP_ARROW_STEP),
          },
        ]
      : [];
  const badges = [
    ...gapArrows,
    showAddNoteBadge
      ? {
          key: "user-note",
          text: CODE_ROW_ADD_NOTE_BADGE_TEXT,
          onClick: () => onStartUserNoteAtHunk?.(row.hunkIndex),
        }
      : null,
  ].filter((badge): badge is { key: string; text: string; quiet?: boolean; onClick: () => void } =>
    Boolean(badge),
  );
  const badgeWidth = badges.reduce((total, badge) => total + badge.text.length + 1, 0);
  const collapsedExpandable = row.type === "collapsed" && Boolean(onToggleGap);
  const labelText =
    row.type === "collapsed" ? collapsedRowLabel(row.text, collapsedExpandable) : row.text;
  const label = fitText(labelText, Math.max(0, width - 1 - badgeWidth));
  const handleCollapsedClick =
    row.type === "collapsed" && onToggleGap
      ? () => onToggleGap(reviewGapId(row.position, row.hunkIndex))
      : undefined;

  if (badges.length === 0) {
    return (
      <box
        id={anchorId}
        style={{
          width,
          height: 1,
          backgroundColor: theme.panelAlt,
        }}
        onMouseMove={() => onHoverRow?.(row.key)}
        onMouseOver={() => onHoverRow?.(row.key)}
        onMouseUp={handleCollapsedClick}
      >
        <text>
          <span
            fg={selected ? neutralRailColor(theme) : dimRailColor(neutralRailColor(theme), theme)}
            bg={theme.panelAlt}
          >
            {diffRailMarker()}
          </span>
          <span
            fg={row.type === "collapsed" ? theme.muted : theme.badgeNeutral}
            bg={theme.panelAlt}
          >
            {label}
          </span>
        </text>
      </box>
    );
  }

  return (
    <box
      id={anchorId}
      style={{
        width,
        height: 1,
        flexDirection: "row",
        backgroundColor: theme.panelAlt,
      }}
      onMouseMove={() => onHoverRow?.(row.key)}
      onMouseOver={() => onHoverRow?.(row.key)}
    >
      <box
        style={{ width: Math.max(0, width - badgeWidth), height: 1 }}
        onMouseUp={handleCollapsedClick}
      >
        <text>
          <span
            fg={selected ? neutralRailColor(theme) : dimRailColor(neutralRailColor(theme), theme)}
            bg={theme.panelAlt}
          >
            {diffRailMarker()}
          </span>
          <span
            fg={row.type === "collapsed" ? theme.muted : theme.badgeNeutral}
            bg={theme.panelAlt}
          >
            {label}
          </span>
        </text>
      </box>
      {badges.map((badge) => (
        <box
          key={badge.key}
          style={{ width: badge.text.length + 1, height: 1 }}
          onMouseUp={(event) => {
            markNestedRowMouseAction(event);
            badge.onClick();
          }}
        >
          <text
            fg={badge.quiet ? theme.badgeNeutral : theme.noteTitleText}
            bg={badge.quiet ? theme.panelAlt : theme.noteTitleBackground}
          >{` ${badge.text}`}</text>
        </box>
      ))}
    </box>
  );
}
