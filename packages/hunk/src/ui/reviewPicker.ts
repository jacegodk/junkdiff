import type { GitReviewBases, GitWorktree } from "@hunk/git";
import { hasExplicitDiffTarget } from "@hunk/vcs/diff-target";
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
