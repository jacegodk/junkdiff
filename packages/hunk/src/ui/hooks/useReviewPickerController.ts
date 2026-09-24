import { useCallback, useMemo, useRef, useState } from "react";
import { listGitReviewCommits, listGitWorktrees, resolveGitReviewBases } from "@hunk/git";
import type { GitReviewCommit } from "@hunk/git";
import type { AppBootstrap } from "../../core/bootstrap";
import type { CliInput } from "../../core/run/commandInputs";
import { resolveCanonicalPath } from "../../core/run/paths";
import type { ReloadedSessionResult, ReloadSessionOptions } from "../../session/types";
import {
  basePickerItems,
  basePickerSkipNotice,
  COMMIT_PICKER_LIMIT,
  commitPickerItems,
  commitPickerReloadInput,
  commitPickerSource,
  reviewPickerCanReload,
  reviewPickerReloadInput,
  worktreePickerItems,
  type CommitPickerSource,
  type ReviewPickerItem,
} from "../reviewPicker";

interface ReviewPickerState {
  step: "worktree" | "base" | "commit";
  items: ReviewPickerItem[];
  selectedIndex: number;
  /** The worktree chosen in the first step, or the launch root when that step was skipped. */
  worktree: string;
  /** Commit step only: the commits its rows stand for, in row order after the first row. */
  commits?: readonly GitReviewCommit[];
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
   * Reload `worktree` into `nextInput`. A soft reload (`resetApp: false`) keeps this App mounted,
   * so the notice explaining a skipped base step survives the switch.
   */
  const reloadInto = useCallback(
    (worktree: string, nextInput: CliInput, notice: string | null) => {
      setState(null);
      onReloadSession(nextInput, {
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
    [onReloadSession, onTransientNotice, root],
  );

  /** Finish the base step: review `worktree`'s working tree against `base`. */
  const finish = useCallback(
    (worktree: string, base: string | null, notice: string | null) => {
      setState(null);
      if (!reviewPickerCanReload(bootstrap.input)) return;
      reloadInto(worktree, reviewPickerReloadInput(bootstrap.input, base), notice);
    },
    [bootstrap.input, reloadInto],
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
   * Open the picker. With `onlyIfChoice` (the startup offer) a dialog opens only for more than one
   * worktree or base, and a single base reloads at once unless HEAD is on the default branch.
   * Returns whether a dialog opened.
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
        // One base still applies at startup (an unpushed branch opens against the default
        // branch), except on the default branch itself, where it would only repeat the working tree.
        const bases = resolveGitReviewBases(root);
        const items = basePickerItems(bases);
        if (items.length === 0) return false;
        if (items.length === 1 && bases.branch === bases.defaultBranch) return false;
        return openBaseStep(root);
      }
      return openBaseStep(root);
    },
    [onTransientNotice, openBaseStep, root],
  );

  /**
   * The commits of the review the picker last listed for, and the commit it opened from that
   * list. A review of one commit says nothing about where the list came from, so remembering it
   * is what lets the same key step from commit to commit and find the way back.
   */
  const commitSourceRef = useRef<CommitPickerSource | null>(null);
  const openedCommitRef = useRef<string | null>(null);

  /** Whether the current review is the single commit this picker opened. */
  const viewingOpenedCommit = useCallback(() => {
    const opened = openedCommitRef.current;
    if (opened === null) return false;
    const endpoints = (bootstrap.input as { rangeEndpoints?: { to?: string } }).rangeEndpoints;
    return endpoints?.to === opened;
  }, [bootstrap.input]);

  /**
   * Open the commit list for whatever the review currently covers: the unpushed commits of a
   * working-tree review, the branch's commits when it is compared against the default branch,
   * and the same list again while one of those commits is open.
   */
  const openCommitPicker = useCallback((): boolean => {
    if (root === null || bootstrap.input.kind !== "vcs") {
      onTransientNotice("Only a repository review has commits to pick.");
      return false;
    }
    let source = commitSourceRef.current;
    if (!source || !viewingOpenedCommit()) {
      source = commitPickerSource(bootstrap.input, resolveGitReviewBases(root));
      openedCommitRef.current = null;
    }
    if (!source) {
      onTransientNotice("No upstream or default branch to list commits against.");
      return false;
    }
    const commits = listGitReviewCommits(root, source.range, COMMIT_PICKER_LIMIT);
    if (commits.length === 0) {
      onTransientNotice(`No commits in ${source.range}`);
      return false;
    }
    commitSourceRef.current = source;
    const items = commitPickerItems(source, commits, Math.floor(Date.now() / 1000));
    // Reopening while one commit is up preselects it, so the next Enter steps to the one before.
    const openedIndex = items.findIndex((item) => item.id === openedCommitRef.current);
    setState({
      step: "commit",
      items,
      selectedIndex: openedIndex === -1 ? 1 : openedIndex,
      worktree: root,
      commits,
    });
    return true;
  }, [bootstrap.input, onTransientNotice, root, viewingOpenedCommit]);

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
      if (current.step === "commit") {
        if (bootstrap.input.kind !== "vcs") return;
        const commit = current.commits?.find((candidate) => candidate.revisionId === item.id);
        openedCommitRef.current = commit?.revisionId ?? null;
        reloadInto(
          current.worktree,
          commit
            ? commitPickerReloadInput(bootstrap.input, commit)
            : reviewPickerReloadInput(bootstrap.input, commitSourceRef.current?.base ?? null),
          null,
        );
        return;
      }
      finish(current.worktree, item.base ?? null, null);
    },
    [bootstrap.input, finish, openBaseStep, reloadInto],
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
    openCommitPicker,
    openReviewPicker,
    selectReviewPickerItem,
  };
}
