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
      const restored = restoreSavedNotes(saved, document);
      store.dispatch({ type: "notes/replace-user", notes: restored });
      persistedRef.current = {
        key,
        notes: restored
          .map((entry) => savedNoteFromStored(entry, store.getSnapshot().document))
          .filter((note): note is SavedNote => note !== null),
      };
      if (restored.length > 0) {
        onNotice(`Restored ${restored.length} saved note${restored.length === 1 ? "" : "s"}`);
      }
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
  }, [documentGeneration, identity, log, onNotice, stateDir, store]);
}
