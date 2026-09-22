import type { DiffFile } from "../../../core/changeset/model";
import { fileBandColor } from "../../diff/rowStyle";
import { fileHeaderStats, fitFileHeaderLabel } from "../../lib/fileHeader";
import { measureTextWidth } from "../../lib/text";
import type { AppTheme } from "../../themes";

interface DiffFileHeaderRowProps {
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  theme: AppTheme;
  onSelect?: () => void;
}

/** Blocks either side of the name, so the band reads as one bar across the row. */
const BAND_GLYPH = "█";
/** Blank cells between the name and the band, so the name is not crowded. */
const NAME_PADDING = 1;

/**
 * Render one file header as the band that starts the file.
 *
 * junk: the name sits in the middle of the band rather than at the left edge, so the break
 * between two files is one bright bar carrying the file it introduces. Stats stay at the right,
 * where every file lines them up.
 */
export function DiffFileHeaderRow({
  file,
  headerLabelWidth,
  headerStatsWidth,
  theme,
  onSelect,
}: DiffFileHeaderRowProps) {
  const { additionsText, deletionsText } = fileHeaderStats(file);
  // Keep room for at least one block and one blank on each side of the name.
  const nameBudget = Math.max(0, headerLabelWidth - 2 * (NAME_PADDING + 1));
  const { filename, stateLabel } = fitFileHeaderLabel(file, nameBudget);
  const nameWidth =
    measureTextWidth(filename) + measureTextWidth(stateLabel ?? "") + 2 * NAME_PADDING;
  const fill = Math.max(0, headerLabelWidth - nameWidth);
  const leftFill = Math.floor(fill / 2);
  const band = fileBandColor(theme);
  const padding = " ".repeat(NAME_PADDING);

  return (
    <box
      style={{
        width: "100%",
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.panel,
      }}
      onMouseUp={onSelect}
    >
      {/* Clicking the file header jumps the main stream selection without collapsing to a single-file view. */}
      <box style={{ flexDirection: "row" }}>
        <text fg={band}>{`${BAND_GLYPH.repeat(leftFill)}${padding}`}</text>
        <text fg={theme.text}>{filename}</text>
        {stateLabel && <text fg={theme.muted}>{stateLabel}</text>}
        <text fg={band}>{`${padding}${BAND_GLYPH.repeat(fill - leftFill)}`}</text>
      </box>
      <box
        style={{
          width: headerStatsWidth,
          height: 1,
          flexDirection: "row",
          justifyContent: "flex-end",
        }}
      >
        <text fg={theme.badgeAdded}>{additionsText}</text>
        <text fg={theme.muted}> </text>
        <text fg={theme.badgeRemoved}>{deletionsText}</text>
        <text fg={theme.muted}> </text>
      </box>
    </box>
  );
}
