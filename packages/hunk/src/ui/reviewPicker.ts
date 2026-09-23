import type { GitReviewBases, GitReviewCommit, GitWorktree } from "@hunk/git";
import { describeDiffRange, hasExplicitDiffTarget } from "@hunk/vcs/diff-target";
import type { CliInput, VcsDiffCommandInput } from "../core/run/commandInputs";

/** One row of the review picker: a worktree or a base to diff against. */
export interface ReviewPickerItem {
  id: string;
  label: string;
  description: string;
  /** For a base row: the revision to diff the working tree against; null keeps the plain working-tree diff. */
  base?: string | null;
}

/** The picker applies to a working-tree review with no explicit target: `junk diff` and nothing else. */
export function reviewPickerApplies(input: CliInput): input is VcsDiffCommandInput {
  return input.kind === "vcs" && !input.staged && !hasExplicitDiffTarget(input);
}

/**
 * Whether a picked worktree or base can replace this review.
 *
 * Wider than `reviewPickerApplies`, which decides whether to offer the picker at startup: a
 * review already narrowed to one base, or to one commit, is exactly the one a reviewer reopens
 * the picker from, and picking there must still reload.
 */
export function reviewPickerCanReload(input: CliInput): input is VcsDiffCommandInput {
  return input.kind === "vcs" && !input.staged;
}

/** Compact "3m", "2h", "5d" age for a unix time; "now" under a minute, "" for an unknown time. */
export function formatAge(unixSeconds: number, nowSeconds: number): string {
  if (unixSeconds <= 0) return "";
  const seconds = Math.max(0, nowSeconds - unixSeconds);
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Worktree rows in the order given (callers pass them most recently active first). */
export function worktreePickerItems(
  worktrees: readonly GitWorktree[],
  nowSeconds: number,
): ReviewPickerItem[] {
  return worktrees.map((worktree) => ({
    id: worktree.path,
    label: `${worktree.branch ?? "(detached)"}  ${worktree.path}`,
    description: formatAge(worktree.lastActivity, nowSeconds),
  }));
}

/**
 * Base rows for one worktree: the unpushed part against the upstream when that differs from HEAD
 * (first, and so preselected: the usual question is "what have I not pushed yet"), then the whole
 * branch against the default branch's merge-base. Zero rows means "plain working-tree diff"; one
 * row needs no dialog.
 */
export function basePickerItems(bases: GitReviewBases): ReviewPickerItem[] {
  const items: ReviewPickerItem[] = [];
  if (bases.upstream) {
    items.push({
      id: "upstream",
      label: `unpushed only: vs ${bases.upstream}`,
      description: "",
      base: bases.upstream,
    });
  }
  if (bases.defaultBranch && bases.defaultBase) {
    items.push({
      id: "default",
      label: `whole branch: vs ${bases.defaultBranch} (merge-base)`,
      description: bases.defaultBase.slice(0, 8),
      base: bases.defaultBase,
    });
  }
  return items;
}

/**
 * What to tell the user when the base step is skipped because it has one answer: why there was
 * no "unpushed only" choice, and what is shown instead. Null when a dialog was shown.
 */
export function basePickerSkipNotice(bases: GitReviewBases): string | null {
  if (basePickerItems(bases).length > 1) return null;
  const branch = bases.branch ?? "detached HEAD";
  if (bases.upstream)
    return `${branch} has no default branch to compare with: showing unpushed vs ${bases.upstream}`;
  const shown = bases.defaultBase
    ? `showing the whole branch vs ${bases.defaultBranch}`
    : "showing the working tree";
  if (bases.upstreamRef) return `${branch} is in sync with ${bases.upstreamRef}: ${shown}`;
  return `${branch} has no upstream: ${shown}`;
}

/** The working-tree review of `input` against `base`, or the plain working tree when base is null. */
export function reviewPickerReloadInput(input: VcsDiffCommandInput, base: string | null): CliInput {
  const {
    range: _range,
    rangeEndpoints: _endpoints,
    ...rest
  } = input as VcsDiffCommandInput & {
    range?: string;
    rangeEndpoints?: unknown;
  };
  return base === null ? (rest as CliInput) : ({ ...rest, range: base } as CliInput);
}

/** How many commits the commit picker lists at most. */
export const COMMIT_PICKER_LIMIT = 200;

/** Which commits one review covers, and what it goes back to once a single commit was opened. */
export interface CommitPickerSource {
  /** Revision range to list, in Git's `base..head` spelling. */
  range: string;
  /** The base this review compared against, so leaving a commit restores it; null is the working tree. */
  base: string | null;
  /** How the review reads in the dialog's first row. */
  label: string;
}

/**
 * The commits the current review covers.
 *
 * A plain working-tree review covers the commits it has not pushed, falling back to the whole
 * branch when there is no upstream to compare with; a review against one of those bases covers
 * exactly that base's commits; an explicit range covers its own. Null when the review has no
 * branch history behind it, such as a repository with no upstream and no default branch.
 */
export function commitPickerSource(
  input: VcsDiffCommandInput,
  bases: GitReviewBases,
): CommitPickerSource | null {
  const range = describeDiffRange(input);
  if (range === undefined) {
    const base = bases.upstream ?? bases.defaultBase;
    if (!base) return null;
    return {
      range: `${base}..HEAD`,
      base: null,
      label: "working tree",
    };
  }
  if (range.includes("..")) return { range, base: range, label: `range ${range}` };
  return { range: `${range}..HEAD`, base: range, label: `working tree vs ${range}` };
}

/** Rows for the commits of one review, newest first, after the row that leaves a single commit. */
export function commitPickerItems(
  source: CommitPickerSource,
  commits: readonly GitReviewCommit[],
  nowSeconds: number,
): ReviewPickerItem[] {
  return [
    {
      id: "review",
      label: `← back to the ${source.label}`,
      description: "",
    },
    ...commits.map((commit) => ({
      id: commit.revisionId,
      label: `${commit.displayId}  ${commit.subject}`,
      description: formatAge(commit.authoredAt, nowSeconds),
    })),
  ];
}

/** The review of one commit alone: its own parent against itself, keeping every other option. */
export function commitPickerReloadInput(
  input: VcsDiffCommandInput,
  commit: GitReviewCommit,
): CliInput {
  const {
    range: _range,
    rangeEndpoints: _endpoints,
    ...rest
  } = input as VcsDiffCommandInput & {
    range?: string;
    rangeEndpoints?: unknown;
  };
  return {
    ...rest,
    rangeEndpoints: { from: commit.parentRevisionId, to: commit.revisionId },
  } as CliInput;
}
