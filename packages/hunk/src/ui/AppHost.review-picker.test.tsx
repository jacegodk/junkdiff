import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";

const { getBundledVcsCatalog } = await import("../app/vcsCatalog");
const { loadAppBootstrap } = await import("../core/changeset/loaders");
const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Poll frames until `predicate` holds, or return the last frame after the attempts run out. */
async function waitForFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
  attempts = 40,
) {
  let frame = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    await flush(setup);
    frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    await Bun.sleep(50);
  }
  return frame;
}

/**
 * A repository with two worktrees: `main` (the launch root, a change in main.txt) and a linked
 * `feat` worktree whose change lives in feat.txt. Commit times make `feat` the most recent.
 */
function createTwoWorktreeRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hunk-review-picker-")));
  const main = join(base, "main");
  const feat = join(base, "feat");
  const git = (cwd: string, cmd: string, env: Record<string, string> = {}) =>
    execSync(cmd, { cwd, stdio: "ignore", env: { ...process.env, ...env } });
  execSync(`git init -q -b main ${JSON.stringify(main)}`, { stdio: "ignore" });
  git(main, "git config user.email test@test && git config user.name test");
  writeFileSync(join(main, "main.txt"), "main line\n");
  writeFileSync(join(main, "feat.txt"), "feat line\n");
  git(main, "git add . && git commit -q -m init", {
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_DATE: "1700000000 +0000",
  });
  git(main, `git worktree add -q -b feat ${JSON.stringify(feat)}`);
  writeFileSync(join(feat, "feat.txt"), "feat line\nfeat change\n");
  git(feat, "git add . && git commit -q -m feat", {
    GIT_AUTHOR_DATE: "1700000100 +0000",
    GIT_COMMITTER_DATE: "1700000100 +0000",
  });
  // Uncommitted work in both, so each worktree has a working-tree diff to show; main's change is
  // back-dated so feat, with a fresh edit, is the most recently active worktree.
  writeFileSync(join(main, "main.txt"), "main line\nmain change\n");
  utimesSync(join(main, "main.txt"), 1_700_000_050, 1_700_000_050);
  writeFileSync(join(feat, "feat.txt"), "feat line\nfeat change\nfeat uncommitted\n");
  return { base, main, feat };
}

describe("review picker", () => {
  test("offers the worktrees on startup and switches the review to the chosen one", async () => {
    const repo = createTwoWorktreeRepo();
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: repo.main, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 140, height: 24 });

    try {
      // The picker opens over the launch worktree's review, most recent worktree first.
      let frame = await waitForFrame(setup, (f) => f.includes("Pick a worktree"));
      expect(frame).toContain("Pick a worktree");
      const featRow = frame.split("\n").findIndex((line) => line.includes("feat  "));
      const mainRow = frame.split("\n").findIndex((line) => line.includes("main  "));
      expect(featRow).toBeGreaterThanOrEqual(0);
      expect(featRow).toBeLessThan(mainRow);
      expect(frame).toContain("› feat");

      // Enter on the preselected top row: no upstream, one base at most, so it reloads at once.
      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      frame = await waitForFrame(setup, (f) => f.includes("feat uncommitted"));
      expect(frame).toContain("feat uncommitted");
      expect(frame).not.toContain("main change");
      expect(frame).not.toContain("Pick a worktree");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(repo.base);
    }
  });

  test("Esc keeps the launch worktree, and P reopens the picker", async () => {
    const repo = createTwoWorktreeRepo();
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: repo.main, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 140, height: 24 });

    try {
      let frame = await waitForFrame(setup, (f) => f.includes("Pick a worktree"));
      expect(frame).toContain("Pick a worktree");
      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      frame = await waitForFrame(setup, (f) => !f.includes("Pick a worktree"));
      expect(frame).not.toContain("Pick a worktree");
      expect(frame).toContain("main change");

      await act(async () => {
        await setup.mockInput.typeText("P");
      });
      frame = await waitForFrame(setup, (f) => f.includes("Pick a worktree"));
      expect(frame).toContain("Pick a worktree");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(repo.base);
    }
  });

  test("does not open when the repository has one worktree and no upstream", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-review-picker-single-")));
    execSync(
      "git init -q -b main && git config user.email test@test && git config user.name test",
      {
        cwd: dir,
        stdio: "ignore",
      },
    );
    writeFileSync(join(dir, "a.txt"), "a\n");
    execSync("git add . && git commit -q -m init", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "a.txt"), "a\nb\n");
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 20 });

    try {
      const frame = await waitForFrame(setup, (f) => f.includes("+b") || f.includes("b"), 10);
      expect(frame).not.toContain("Pick a worktree");
      expect(frame).not.toContain("Diff against");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});
