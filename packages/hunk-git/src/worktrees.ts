import { statSync } from "node:fs";
import { resolve } from "node:path";

/** One worktree of a Git repository, as the review picker lists it. */
export interface GitWorktree {
  /** Canonical absolute path of the worktree root. */
  path: string;
  /** Checked-out branch, or null when HEAD is detached. */
  branch: string | null;
  /** Newest of the HEAD commit time and any uncommitted or untracked file, as a unix time in seconds. */
  lastActivity: number;
}

/** The bases the picker can compare a worktree against. */
export interface GitReviewBases {
  /** Default branch name (from `origin/HEAD`, else the first of develop/master/main that exists), or null. */
  defaultBranch: string | null;
  /** Merge-base of HEAD with the default branch: the whole branch, like a merge request. */
  defaultBase: string | null;
  /** Remote-tracking branch of HEAD when it exists and differs from HEAD: only the unpushed part. */
  upstream: string | null;
}

/** Raw stdout of a git command, or null when it fails; porcelain status lines start with a space, so no trim. */
function gitRaw(cwd: string, ...args: string[]): string | null {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  if (proc.exitCode !== 0) return null;
  return Buffer.from(proc.stdout).toString("utf8");
}

function git(cwd: string, ...args: string[]): string | null {
  return gitRaw(cwd, ...args)?.trim() ?? null;
}

/** Every worktree of the repository at `cwd`, most recently active first; empty outside a repository. */
export function listGitWorktrees(cwd: string): GitWorktree[] {
  const listing = git(cwd, "worktree", "list", "--porcelain");
  if (listing === null) return [];
  const worktrees: GitWorktree[] = [];
  for (const block of listing.split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    worktrees.push({ path, branch, lastActivity: worktreeActivity(path) });
  }
  return worktrees.sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Newest of the HEAD commit time and the mtime of any changed or untracked file. */
function worktreeActivity(path: string): number {
  let latest = Number(git(path, "log", "-1", "--format=%ct") ?? 0) || 0;
  const status = gitRaw(path, "status", "--porcelain", "-z", "--untracked-files=all");
  for (const entry of status?.split("\0") ?? []) {
    if (entry.length < 4) continue;
    try {
      const mtime = Math.floor(statSync(resolve(path, entry.slice(3))).mtimeMs / 1000);
      if (mtime > latest) latest = mtime;
    } catch {
      // Deleted or unreadable: the status entry itself is the change, its time is unknown.
    }
  }
  return latest;
}

function refExists(cwd: string, ref: string): boolean {
  return git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`) !== null;
}

/** Default branch name: `origin/HEAD`, else the first of develop/master/main that exists remotely or locally. */
export function resolveGitDefaultBranch(cwd: string): string | null {
  const head = git(cwd, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD");
  if (head) return head.replace(/^origin\//, "");
  for (const candidate of ["develop", "master", "main"]) {
    if (refExists(cwd, `origin/${candidate}`) || refExists(cwd, candidate)) return candidate;
  }
  return null;
}

/**
 * Bases for the worktree at `cwd`: the merge-base with the default branch (remote-tracking ref
 * preferred, a local default may be stale), and the upstream ref when it differs from HEAD.
 */
export function resolveGitReviewBases(cwd: string): GitReviewBases {
  const defaultBranch = resolveGitDefaultBranch(cwd);
  let defaultBase: string | null = null;
  if (defaultBranch) {
    const ref = refExists(cwd, `origin/${defaultBranch}`)
      ? `origin/${defaultBranch}`
      : defaultBranch;
    defaultBase = git(cwd, "merge-base", ref, "HEAD") ?? ref;
  }
  const upstreamRef = git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  const upstream =
    upstreamRef && git(cwd, "rev-parse", upstreamRef) !== git(cwd, "rev-parse", "HEAD")
      ? upstreamRef
      : null;
  return { defaultBranch, defaultBase, upstream };
}
