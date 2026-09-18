import { homedir } from "node:os";
import { useEffect, useRef } from "react";
import type { ReviewStore } from "../../core/review/store";
import {
  diffSavedNotes,
  mergeSavedNotes,
  readSavedNotes,
  resolveNotesStateDir,
  resolveSavedNotesPath,
  restoreSavedNotes,
  savedNoteFromStored,
  type SavedNote,
} from "../../core/review/savedNotes";

export interface UseSavedReviewNotesOptions {
  /** The review store whose user notes are mirrored; restored notes are installed into it. */
  store: ReviewStore;
  /** Canonical worktree path and checked-out branch the review is about; null disables the mirror. */
  identity: { worktree: string; branch: string } | null;
  /** Bumps when the store's document was rebuilt (a reload), so a restore can re-key notes. */
  documentGeneration: string;
  /** `delete_handled_notes`: drop notes flagged handled from the file on open instead of restoring them. */
  deleteHandledNotes?: boolean;
  onNotice: (text: string) => void;
  log?: (message: string) => void;
}

/**
 * Keep the reviewer's notes across sessions. When the worktree+branch identity is first seen
 * (mount, or a reload that moved the review elsewhere), the saved notes for it replace the
 * store's user notes. Afterwards every store change is diffed against what was last written
 * and merged into the file, so two windows on one branch keep each other's notes.
 */
export function useSavedReviewNotes({
  store,
  identity,
  documentGeneration,
  deleteHandledNotes = false,
  onNotice,
  log = () => {},
}: UseSavedReviewNotesOptions) {
  const persistedRef = useRef<{ key: string; notes: SavedNote[] } | null>(null);
  const failedRef = useRef(false);
  const stateDir = resolveNotesStateDir(process.env, process.platform, homedir());

  useEffect(() => {
    if (!identity) return;
    const key = `${identity.worktree}\n${identity.branch}`;
    const filePath = resolveSavedNotesPath(stateDir, identity.worktree, identity.branch);
    const document = store.getSnapshot().document;

    if (persistedRef.current?.key !== key) {
      // A new identity: the file is the truth, whatever the store held for the previous one.
      const saved = readSavedNotes(filePath, log);
      const handled = deleteHandledNotes ? saved.filter((note) => note.handled) : [];
      if (handled.length > 0) {
        try {
          mergeSavedNotes(
            filePath,
            identity.worktree,
            identity.branch,
            handled.map((note) => ({ remove: note.id })),
            new Date(),
            log,
          );
        } catch (error) {
          log(
            `junk: could not delete handled notes in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const handledIds = new Set(handled.map((note) => note.id));
      const restored = restoreSavedNotes(
        saved.filter((note) => !handledIds.has(note.id)),
        document,
      );
      store.dispatch({ type: "notes/replace-user", notes: restored });
      persistedRef.current = {
        key,
        notes: restored
          .map((entry) => savedNoteFromStored(entry, store.getSnapshot().document))
          .filter((note): note is SavedNote => note !== null),
      };
      const parts: string[] = [];
      if (restored.length > 0) {
        parts.push(`restored ${restored.length} saved note${restored.length === 1 ? "" : "s"}`);
      }
      if (handled.length > 0) {
        parts.push(`deleted ${handled.length} handled note${handled.length === 1 ? "" : "s"}`);
      }
      if (parts.length > 0) onNotice(parts.join(", ").replace(/^./, (c) => c.toUpperCase()));
    }

    const persist = () => {
      const snapshot = store.getSnapshot();
      const current = snapshot.userNotes
        .map((entry) => savedNoteFromStored(entry, snapshot.document))
        .filter((note): note is SavedNote => note !== null);
      const previous = persistedRef.current?.notes ?? [];
      const changes = diffSavedNotes(previous, current);
      if (changes.length === 0) return;
      try {
        mergeSavedNotes(filePath, identity.worktree, identity.branch, changes, new Date(), log);
        persistedRef.current = { key, notes: current };
        failedRef.current = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`junk: could not save notes to ${filePath}: ${message}`);
        if (!failedRef.current) {
          failedRef.current = true;
          onNotice(`Could not save notes: ${message}`);
        }
      }
    };
    persist();
    return store.subscribe(persist);
  }, [deleteHandledNotes, documentGeneration, identity, log, onNotice, stateDir, store]);
}
