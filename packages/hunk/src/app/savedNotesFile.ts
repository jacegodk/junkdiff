/**
 * junk: the notes file behind `core/review/savedNotes`. The review model stays platform-neutral;
 * this module owns the path scheme and the atomic read-merge-write on disk.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  SAVED_NOTES_TTL_MS,
  type SavedNote,
  type SavedNoteChange,
  type SavedNotesDocument,
} from "../core/review/savedNotes";

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
