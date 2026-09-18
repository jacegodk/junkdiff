import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGitWorktrees, resolveGitDefaultBranch, resolveGitReviewBases } from "./worktrees";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(Buffer.from(proc.stderr).toString("utf8"));
  return Buffer.from(proc.stdout).toString("utf8").trim();
}

function commit(cwd: string, file: string, content: string, message: string, epoch: number) {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  const date = `${epoch} +0000`;
  Bun.spawnSync(["git", "-C", cwd, "commit", "-q", "-m", message], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

/** A bare "origin" with `main` as its default branch, and a clone with a `feat` branch off it. */
function createRepoWithOrigin() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hunk-worktrees-")));
  tempDirs.push(base);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  git(base, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.email", "t@t");
  git(seed, "config", "user.name", "t");
  commit(seed, "a.txt", "a\n", "root", 1_700_000_000);
  git(base, "clone", "-q", "--bare", seed, origin);
  const clone = join(base, "clone");
  git(base, "clone", "-q", origin, clone);
  git(clone, "config", "user.email", "t@t");
  git(clone, "config", "user.name", "t");
  return { base, clone, origin };
}

describe("resolveGitDefaultBranch", () => {
  test("reads origin/HEAD, falls back to develop/master/main, and gives null without any", () => {
    const { clone, base } = createRepoWithOrigin();
    expect(resolveGitDefaultBranch(clone)).toBe("main");
    git(clone, "remote", "set-head", "origin", "-d");
    expect(resolveGitDefaultBranch(clone)).toBe("main");
    const lone = join(base, "lone");
    git(base, "init", "-q", "-b", "trunk", lone);
    expect(resolveGitDefaultBranch(lone)).toBeNull();
  });
});

describe("resolveGitReviewBases", () => {
  test("merge-base with the default branch, and the upstream only when it differs from HEAD", () => {
    const { clone } = createRepoWithOrigin();
    const root = git(clone, "rev-parse", "HEAD");
    // On main, in sync with origin: base is HEAD itself, no upstream choice.
    expect(resolveGitReviewBases(clone)).toEqual({
      defaultBranch: "main",
      defaultBase: root,
      upstream: null,
    });

    git(clone, "checkout", "-q", "-b", "feat");
    commit(clone, "b.txt", "b\n", "feat 1", 1_700_000_100);
    // No upstream yet: whole-branch base is the fork point.
    expect(resolveGitReviewBases(clone)).toEqual({
      defaultBranch: "main",
      defaultBase: root,
      upstream: null,
    });

    git(clone, "push", "-q", "-u", "origin", "feat");
    expect(resolveGitReviewBases(clone).upstream).toBeNull();
    commit(clone, "c.txt", "c\n", "feat 2", 1_700_000_200);
    expect(resolveGitReviewBases(clone)).toEqual({
      defaultBranch: "main",
      defaultBase: root,
      upstream: "origin/feat",
    });
  });

  test("outside a repository everything is null", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-worktrees-nogit-"));
    tempDirs.push(dir);
    expect(resolveGitReviewBases(dir)).toEqual({
      defaultBranch: null,
      defaultBase: null,
      upstream: null,
    });
    expect(listGitWorktrees(dir)).toEqual([]);
  });
});

describe("listGitWorktrees", () => {
  test("lists every worktree with its branch, most recent activity first, uncommitted files counting", () => {
    const { clone, base } = createRepoWithOrigin();
    const linked = join(base, "linked");
    git(clone, "worktree", "add", "-q", "-b", "feat", linked);
    commit(linked, "b.txt", "b\n", "feat 1", 1_700_000_100);
    const detached = join(base, "detached");
    git(clone, "worktree", "add", "-q", "--detach", detached);

    let listed = listGitWorktrees(clone);
    expect(listed.map((w) => [w.path, w.branch])).toEqual([
      [linked, "feat"],
      [clone, "main"],
      [detached, null],
    ]);
    expect(listed[0]!.lastActivity).toBe(1_700_000_100);

    // An untracked file in the main worktree, dated far in the future, moves it to the top.
    writeFileSync(join(clone, "scratch.txt"), "x\n");
    utimesSync(join(clone, "scratch.txt"), 1_800_000_000, 1_800_000_000);
    listed = listGitWorktrees(linked);
    expect(listed[0]!.path).toBe(clone);
    expect(listed[0]!.lastActivity).toBe(1_800_000_000);
  });
});
