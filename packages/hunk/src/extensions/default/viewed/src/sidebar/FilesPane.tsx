/**
 * Replacement files pane: a title row with viewed progress, then the tree or flat file list
 * with viewed marks. Files and selection come from the host props; marks and the mode flag
 * come from the extension stores. Adapted from hunk's bundled sidebar (MIT, Modem Labs Inc.)
 * without row windowing.
 */
import { basename } from "node:path/posix";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExtensionPaneProps } from "../../../../../extension-api";
import { useReviewMirror } from "../reviewMirror";
import { setSingleFilePending, useSingleFileState } from "../singleFile";
import { isViewed, useViewedState } from "../viewedStore";
import {
  buildFlatSidebarEntries,
  buildTreeSidebarEntries,
  collapseTreeSidebarEntries,
  expandCollapsedDirectoryPaths,
  resolveFileSidebarMode,
  sidebarDirectoryPaths,
  sidebarEntryStatsWidth,
  toggleCollapsedDirectoryPath,
} from "./entries";
import { resolvePaneSource } from "./paneSource";
import { DirectoryRow, FileRow, GroupHeader, fileRowId } from "./rows";
import { padText } from "./text";

/** Render the hunk-viewed files pane. */
export function FilesPane({
  files,
  selectedFileId,
  theme,
  width,
  actions,
}: ExtensionPaneProps): ReactNode {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const viewed = useViewedState();
  const single = useSingleFileState();
  const mirror = useReviewMirror();
  // Single-file mode shows one file out of the full changeset; the host-filtered `files` prop
  // only ever contains that one file while it is active, so list from the untransformed mirror.
  const { listFiles, highlightedId } = resolvePaneSource(
    single,
    mirror.allFiles,
    files,
    selectedFileId,
  );
  // One column of selection stripe plus one of row padding, as in the bundled pane.
  const textWidth = Math.max(8, width - 2);
  const mode = resolveFileSidebarMode(textWidth);
  const paddingLeft = mode === "tree" ? 0 : 1;

  // Directories the reviewer closed, by the path their row stands for.
  const [collapsedDirectoryPaths, setCollapsedDirectoryPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const entries = useMemo(
    () =>
      mode === "tree"
        ? collapseTreeSidebarEntries(buildTreeSidebarEntries(listFiles), collapsedDirectoryPaths)
        : buildFlatSidebarEntries(listFiles),
    [collapsedDirectoryPaths, listFiles, mode],
  );
  const toggleDirectory = useCallback((path: string) => {
    setCollapsedDirectoryPaths((current) => toggleCollapsedDirectoryPath(current, path));
  }, []);
  const viewedByFileId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const file of listFiles) map.set(file.id, isViewed(viewed, file));
    return map;
  }, [listFiles, viewed]);
  const viewedCount = useMemo(
    () => [...viewedByFileId.values()].filter(Boolean).length,
    [viewedByFileId],
  );
  const statsWidth = useMemo(
    () =>
      entries.reduce(
        (max, entry) => Math.max(max, entry.kind === "file" ? sidebarEntryStatsWidth(entry) : 0),
        0,
      ),
    [entries],
  );

  // Selecting a file inside a closed branch opens the branch rather than hiding the selection.
  useEffect(() => {
    if (!highlightedId) return;
    const selected = listFiles.find((file) => file.id === highlightedId);
    if (!selected) return;
    setCollapsedDirectoryPaths((current) =>
      expandCollapsedDirectoryPaths(current, sidebarDirectoryPaths(selected.path)),
    );
  }, [highlightedId, listFiles]);

  useEffect(() => {
    if (!highlightedId) return;
    scrollRef.current?.scrollChildIntoView(fileRowId(highlightedId));
  }, [listFiles, mode, highlightedId, entries]);

  /** Route a row click: normal selection, or record a pending single-file target. */
  const onSelectFile = (fileId: string) => {
    if (!single.active) {
      actions.selectFile(fileId);
      return;
    }
    const file = listFiles.find((entry) => entry.id === fileId);
    if (!file) return;
    setSingleFilePending(file.path);
    actions.notify(`Enter loads ${basename(file.path)}`, "info");
  };

  const title = padText(` Files  ${viewedCount}/${listFiles.length} viewed`, Math.max(1, width));

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.panel,
      }}
    >
      <box style={{ width: "100%", height: 1, backgroundColor: theme.panel }}>
        <text fg={theme.muted}>{title}</text>
      </box>
      <scrollbox
        ref={scrollRef}
        width="100%"
        flexGrow={1}
        focused={false}
        scrollY={true}
        viewportCulling={true}
        rootOptions={{ backgroundColor: theme.panel }}
        wrapperOptions={{ backgroundColor: theme.panel }}
        viewportOptions={{ backgroundColor: theme.panel }}
        contentOptions={{ backgroundColor: theme.panel }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <box style={{ width: "100%", flexDirection: "column" }}>
          {entries.map((entry) => {
            if (entry.kind === "group") {
              return (
                <GroupHeader
                  key={entry.id}
                  entry={entry}
                  paddingLeft={paddingLeft}
                  textWidth={textWidth}
                  theme={theme}
                />
              );
            }
            if (entry.kind === "directory") {
              return (
                <DirectoryRow
                  key={entry.id}
                  collapsed={collapsedDirectoryPaths.has(entry.path)}
                  onToggleDirectory={toggleDirectory}
                  entry={entry}
                  paddingLeft={paddingLeft}
                  statsWidth={statsWidth}
                  textWidth={textWidth}
                  theme={theme}
                />
              );
            }
            return (
              <FileRow
                key={entry.id}
                entry={entry}
                viewed={viewedByFileId.get(entry.id) ?? false}
                paddingLeft={paddingLeft}
                selected={entry.id === highlightedId}
                statsWidth={statsWidth}
                textWidth={textWidth}
                theme={theme}
                onSelectFile={onSelectFile}
              />
            );
          })}
        </box>
      </scrollbox>
    </box>
  );
}
