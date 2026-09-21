import { useCallback, useMemo, useRef, useState } from "react";
import { listGitWorktrees, resolveGitReviewBases } from "@hunk/git";
import type { AppBootstrap } from "../../core/bootstrap";
import type { CliInput } from "../../core/run/commandInputs";
import { resolveCanonicalPath } from "../../core/run/paths";
import type { ReloadedSessionResult, ReloadSessionOptions } from "../../session/types";
import {
  basePickerItems,
  basePickerSkipNotice,
  reviewPickerApplies,
  reviewPickerReloadInput,
  worktreePickerItems,
  type ReviewPickerItem,
} from "../reviewPicker";

interface ReviewPickerState {
  step: "worktree" | "base";
  items: ReviewPickerItem[];
  selectedIndex: number;
  /** The worktree chosen in the first step, or the launch root when that step was skipped. */
  worktree: string;
}

export interface UseReviewPickerControllerOptions {
  bootstrap: AppBootstrap;
  onReloadSession: (
    nextInput: CliInput,
    options?: ReloadSessionOptions,
  ) => Promise<ReloadedSessionResult>;
  onTransientNotice: (text: string) => void;
}

/**
 * Drive the review picker: which worktree of the repository to review, then which base to diff
 * its working tree against. Each step is skipped when it has one answer, and accepting reloads
 * the session in the chosen worktree, which may be a sibling of the launch root.
 */
export function useReviewPickerController({
  bootstrap,
  onReloadSession,
  onTransientNotice,
}: UseReviewPickerControllerOptions) {
  const [state, setState] = useState<ReviewPickerState | null>(null);
  // Only a review backed by a real repository root has worktrees and bases to choose from; a
  // fixture or a piped patch names none, and must not pick from the process's own directory.
  const root = useMemo(
    () =>
      bootstrap.reloadContext.repoRoot === undefined
        ? null
        : resolveCanonicalPath(bootstrap.reloadContext.repoRoot),
    [bootstrap.reloadContext.repoRoot],
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Reload into `worktree` against `base`. A soft reload (`resetApp: false`) keeps this App
   * mounted, so the notice explaining a skipped base step survives the switch.
   */
  const finish = useCallback(
    (worktree: string, base: string | null, notice: string | null) => {
      setState(null);
      if (!reviewPickerApplies(bootstrap.input)) return;
      onReloadSession(reviewPickerReloadInput(bootstrap.input, base), {
        resetApp: false,
        reason: "manual",
        sourcePath: worktree,
        allowSiblingWorktree: worktree !== root,
      }).then(
        () => {
          if (notice) onTransientNotice(notice);
        },
        (error: unknown) => {
          onTransientNotice(
            `Could not open ${worktree}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    },
    [bootstrap.input, onReloadSession, onTransientNotice, root],
  );

  /** Second step for `worktree`: offer the bases, or finish at once (saying why) when there is nothing to choose. */
  const openBaseStep = useCallback(
    (worktree: string): boolean => {
      const bases = resolveGitReviewBases(worktree);
      const items = basePickerItems(bases);
      if (items.length > 1) {
        setState({ step: "base", items, selectedIndex: 0, worktree });
        return true;
      }
      finish(worktree, items[0]?.base ?? null, basePickerSkipNotice(bases));
      return false;
    },
    [finish],
  );

  /**
   * Open the picker. With `onlyIfChoice` (the startup offer) nothing opens, and nothing reloads,
   * unless there is more than one worktree or more than one base. Returns whether a dialog opened.
   */
  const openReviewPicker = useCallback(
    (options: { onlyIfChoice?: boolean } = {}): boolean => {
      if (root === null) {
        if (!options.onlyIfChoice) onTransientNotice("No repository to pick a worktree from.");
        return false;
      }
      const worktrees = listGitWorktrees(root);
      if (worktrees.length > 1) {
        setState({
          step: "worktree",
          items: worktreePickerItems(worktrees, Math.floor(Date.now() / 1000)),
          selectedIndex: 0,
          worktree: root,
        });
        return true;
      }
      if (options.onlyIfChoice) {
        return basePickerItems(resolveGitReviewBases(root)).length > 1 && openBaseStep(root);
      }
      return openBaseStep(root);
    },
    [onTransientNotice, openBaseStep, root],
  );

  const closeReviewPicker = useCallback(() => setState(null), []);

  const moveReviewPicker = useCallback((delta: number) => {
    setState((current) => {
      if (!current || current.items.length === 0) return current;
      const count = current.items.length;
      return {
        ...current,
        selectedIndex: (((current.selectedIndex + delta) % count) + count) % count,
      };
    });
  }, []);

  const selectReviewPickerItem = useCallback((index: number) => {
    setState((current) =>
      current && index >= 0 && index < current.items.length && index !== current.selectedIndex
        ? { ...current, selectedIndex: index }
        : current,
    );
  }, []);

  const acceptReviewPickerItem = useCallback(
    (index?: number) => {
      const current = stateRef.current;
      if (!current) return;
      const item = current.items[index ?? current.selectedIndex];
      if (!item) return;
      if (current.step === "worktree") {
        openBaseStep(item.id);
        return;
      }
      finish(current.worktree, item.base ?? null, null);
    },
    [finish, openBaseStep],
  );

  return {
    reviewPickerOpen: state !== null,
    reviewPickerStep: state?.step ?? null,
    reviewPickerItems: state?.items ?? [],
    reviewPickerSelectedIndex: state?.selectedIndex ?? 0,
    acceptReviewPicker: () => acceptReviewPickerItem(),
    acceptReviewPickerItem,
    closeReviewPicker,
    moveReviewPicker,
    openReviewPicker,
    selectReviewPickerItem,
  };
}
