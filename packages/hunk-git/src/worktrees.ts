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
  /** Checked-out branch, or null when HEAD is detached. */
  branch: string | null;
  /** Default branch name (from `origin/HEAD`, else the first of develop/master/main that exists), or null. */
  defaultBranch: string | null;
  /** Merge-base of HEAD with the default branch: the whole branch, like a merge request. */
  defaultBase: string | null;
  /** Remote-tracking branch of HEAD, whether or not it differs from HEAD. */
  upstreamRef: string | null;
  /** `upstreamRef` when it differs from HEAD: only the unpushed part; null when in sync or untracked. */
  upstream: string | null;
}

/** One commit of the reviewed range, as the commit picker lists it. */
export interface GitReviewCommit {
  /** Full object id: the head of this commit's own diff. */
  revisionId: string;
  /** Abbreviated object id, for display. */
  displayId: string;
  /** First parent, the base of this commit's own diff; the empty tree for a root commit. */
  parentRevisionId: string;
  subject: string;
  authorName: string;
  /** Author time as a unix time in seconds. */
  authoredAt: number;
}

/** Raw stdout of a git command, or null when it fails; porcelain status lines start with a space, so no trim. */
function gitRaw(cwd: string, ...args: string[]): string | null {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  } catch {
    // No git on PATH at all reads the same as a command that failed: nothing to offer.
    return null;
  }
  if (proc.exitCode !== 0 || !proc.stdout) return null;
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
/** Checked-out branch of `cwd`, or null when HEAD is detached or `cwd` is no repository. */
export function resolveGitBranch(cwd: string): string | null {
  return git(cwd, "symbolic-ref", "--short", "-q", "HEAD");
}

/** Whether `cwd` is inside a git working tree; false for a missing path or a bare repository. */
export function isGitWorktree(cwd: string): boolean {
  return git(cwd, "rev-parse", "--is-inside-work-tree") === "true";
}

/** Refuse a revision Git could read as an option; every range here comes from Git itself. */
function isSafeRevision(revision: string): boolean {
  return revision.length > 0 && !revision.startsWith("-");
}

/**
 * The empty tree's object id, which is the base a root commit's diff compares against.
 *
 * Asking Git for it rather than hardcoding the well-known SHA-1 digest keeps the SHA-256
 * repositories right, where the empty tree has a different id.
 */
function emptyTreeId(cwd: string): string | null {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["git", "-C", cwd, "hash-object", "-t", "tree", "--stdin"], {
      stdin: new Uint8Array(),
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  if (proc.exitCode !== 0 || !proc.stdout) return null;
  return Buffer.from(proc.stdout).toString("utf8").trim() || null;
}

/**
 * Commits in `range` (`origin/main..HEAD`, say), newest first and bounded by `limit`.
 *
 * Empty outside a repository, for an unreadable range, and for a range with no commits. A root
 * commit is listed only when Git can name the empty tree, since without a base there is no diff
 * to open.
 */
export function listGitReviewCommits(cwd: string, range: string, limit = 200): GitReviewCommit[] {
  if (!isSafeRevision(range)) return [];
  const listing = gitRaw(
    cwd,
    "log",
    `--max-count=${Math.max(1, Math.floor(limit))}`,
    "--no-show-signature",
    "--no-color",
    "--abbrev=8",
    "-z",
    "--format=%H%x00%h%x00%P%x00%an%x00%ct%x00%s",
    range,
  );
  if (listing === null) return [];
  const fields = listing.split("\0");
  // `-z` ends every record with a NUL, so the split leaves one trailing empty field.
  if (fields.at(-1) === "") fields.pop();
  const commits: GitReviewCommit[] = [];
  let emptyTree: string | null | undefined;
  for (let offset = 0; offset + 6 <= fields.length; offset += 6) {
    const revisionId = fields[offset]!;
    const displayId = fields[offset + 1]!;
    const parents = fields[offset + 2]!.split(" ").filter(Boolean);
    const authorName = fields[offset + 3]!;
    const authoredAt = Number(fields[offset + 4]) || 0;
    const subject = fields[offset + 5]!;
    if (!revisionId || !displayId) continue;
    let parentRevisionId = parents[0];
    if (parentRevisionId === undefined) {
      emptyTree ??= emptyTreeId(cwd);
      if (emptyTree === null) continue;
      parentRevisionId = emptyTree;
    }
    commits.push({
      revisionId,
      displayId,
      parentRevisionId,
      subject: subject || "(no commit message)",
      authorName: authorName || "Unknown author",
      authoredAt,
    });
  }
  return commits;
}

export function resolveGitReviewBases(cwd: string): GitReviewBases {
  const branch = resolveGitBranch(cwd);
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
  return { branch, defaultBranch, defaultBase, upstreamRef, upstream };
}
