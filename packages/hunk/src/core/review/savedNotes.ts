import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { reviewLineAnchor } from "./anchors";
import type { ReviewStoredNote } from "./state";
import type { ReviewDocumentV1, ReviewNoteV1, ReviewSide } from "./types";

/**
 * Saved user notes: hunk keeps a reviewer's inline notes only in the running session. junk
 * mirrors them to disk per worktree and branch and restores them when that pair is opened again.
 *
 * On disk a note is addressed by file path and line, never by `fileKey`, because the key folds in
 * the review source and would not survive `hunk diff` vs `hunk diff origin/main`. The layout and
 * location match what the hunk-viewed extension wrote, so notes taken with it carry over:
 * `$XDG_STATE_HOME/hunk/notes/<sha256(worktree)[:16]>/<url-encoded branch>.json`.
 */
export interface SavedNote {
  id: string;
  parentId?: string;
  filePath: string;
  hunkIndex: number;
  side: ReviewSide;
  line: number;
  body: string;
  /** ISO time of the last save; entries older than SAVED_NOTES_TTL_MS are dropped on write. */
  at: string;
}

export interface SavedNotesDocument {
  version: 1;
  worktree: string;
  branch: string;
  notes: Record<string, SavedNote>;
}

export const SAVED_NOTES_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `$XDG_STATE_HOME/hunk`, `%LOCALAPPDATA%\hunk` on Windows, else `~/.local/state/hunk`. */
export function resolveNotesStateDir(
  env: NodeJS.ProcessEnv,
  platform: string,
  homeDir: string,
): string {
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME, "hunk");
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "hunk");
  return join(homeDir, ".local", "state", "hunk");
}

/** The one file holding the notes of `worktree` on `branch`. */
export function resolveSavedNotesPath(stateDir: string, worktree: string, branch: string): string {
  const worktreeHash = createHash("sha256").update(worktree).digest("hex").slice(0, 16);
  return join(stateDir, "notes", worktreeHash, `${encodeURIComponent(branch)}.json`);
}

/** Parse a notes file; missing or unusable files read as empty. */
export function readSavedNotes(
  filePath: string,
  log: (message: string) => void = () => {},
): SavedNote[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<SavedNotesDocument>;
    if (parsed.version !== 1 || typeof parsed.notes !== "object" || parsed.notes === null) {
      log(`junk: ignoring ${filePath}: unsupported format`);
      return [];
    }
    return Object.values(parsed.notes);
  } catch (error) {
    log(`junk: ignoring ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export type SavedNoteChange = { upsert: SavedNote } | { remove: string };

/**
 * Apply `changes` to the notes file: reread it, apply each upsert or delete, prune expired
 * entries, and write atomically. Rereading first means another window on the same branch keeps
 * its notes. A file left without notes is removed.
 */
export function mergeSavedNotes(
  filePath: string,
  worktree: string,
  branch: string,
  changes: readonly SavedNoteChange[],
  now: Date,
  log: (message: string) => void = () => {},
): void {
  if (changes.length === 0) return;
  const cutoff = now.getTime() - SAVED_NOTES_TTL_MS;
  const notes: Record<string, SavedNote> = {};
  for (const note of readSavedNotes(filePath, log)) {
    if (Date.parse(note.at) >= cutoff) notes[note.id] = note;
  }
  for (const change of changes) {
    if ("upsert" in change) notes[change.upsert.id] = change.upsert;
    else delete notes[change.remove];
  }
  if (Object.keys(notes).length === 0) {
    rmSync(filePath, { force: true });
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const document: SavedNotesDocument = { version: 1, worktree, branch, notes };
  const staged = `${filePath}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(staged, filePath);
  } catch (error) {
    if (process.platform === "win32" && existsSync(filePath)) {
      rmSync(filePath, { force: true });
      renameSync(staged, filePath);
      return;
    }
    rmSync(staged, { force: true });
    throw error;
  }
}

/** The line a stored note hangs from: its preferred line, else the start of its range. */
function noteLine(note: ReviewNoteV1): { side: ReviewSide; line: number } | null {
  if (note.anchor.preferred) return note.anchor.preferred;
  if (note.anchor.newRange) return { side: "new", line: note.anchor.newRange[0] };
  if (note.anchor.oldRange) return { side: "old", line: note.anchor.oldRange[0] };
  return null;
}

/** The on-disk form of one stored user note, or null when its file is not in the document. */
export function savedNoteFromStored(
  entry: ReviewStoredNote,
  document: ReviewDocumentV1,
): SavedNote | null {
  const { note } = entry;
  const file = document.files.find((candidate) => candidate.key === note.fileKey);
  const at = noteLine(note);
  if (!file || !at) return null;
  return {
    id: note.id,
    ...(note.parentId ? { parentId: note.parentId } : {}),
    filePath: file.path,
    hunkIndex: note.anchor.ownerHunkIndex ?? 0,
    side: at.side,
    line: at.line,
    body: note.summary,
    at: note.updatedAt ?? note.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Rebuild stored user notes from disk for the current document: each note is re-keyed to the
 * file that now has its path and re-anchored to that file's hunks; a reply hangs where its
 * parent does. Notes whose file is absent from this review are skipped, not lost: they stay in
 * the file for a review that shows the file again.
 */
export function restoreSavedNotes(
  saved: readonly SavedNote[],
  document: ReviewDocumentV1,
): ReviewStoredNote[] {
  const ordered = [...saved].sort((a, b) => a.at.localeCompare(b.at));
  const restored = new Map<string, ReviewStoredNote>();
  const pending = new Map(ordered.map((note) => [note.id, note]));
  // Parents before replies, whatever the timestamps say.
  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const note of ordered) {
      if (!pending.has(note.id)) continue;
      const parent = note.parentId ? restored.get(note.parentId) : undefined;
      if (note.parentId && !parent) {
        if (pending.has(note.parentId)) continue;
        pending.delete(note.id);
        progressed = true;
        continue;
      }
      pending.delete(note.id);
      progressed = true;
      const file = document.files.find(
        (candidate) => candidate.path === note.filePath || candidate.previousPath === note.filePath,
      );
      if (!file) continue;
      restored.set(note.id, {
        note: {
          id: note.id,
          ...(parent ? { parentId: parent.note.id } : {}),
          source: "user",
          originalSource: "user",
          fileKey: file.key,
          anchor: parent
            ? parent.note.anchor
            : reviewLineAnchor(file.hunks, {
                hunkIndex: note.hunkIndex,
                side: note.side,
                line: note.line,
              }),
          summary: note.body,
          author: "user",
          createdAt: note.at,
          editable: true,
        },
        resolution: parent?.resolution ?? "active",
      });
    }
  }
  return [...restored.values()];
}

/** What changed between the last persisted set and the current one, as file changes. */
export function diffSavedNotes(
  previous: readonly SavedNote[],
  next: readonly SavedNote[],
): SavedNoteChange[] {
  const before = new Map(previous.map((note) => [note.id, note]));
  const changes: SavedNoteChange[] = [];
  for (const note of next) {
    const old = before.get(note.id);
    before.delete(note.id);
    if (
      !old ||
      old.body !== note.body ||
      old.filePath !== note.filePath ||
      old.side !== note.side ||
      old.line !== note.line ||
      old.parentId !== note.parentId
    ) {
      changes.push({ upsert: note });
    }
  }
  for (const id of before.keys()) changes.push({ remove: id });
  return changes;
}
