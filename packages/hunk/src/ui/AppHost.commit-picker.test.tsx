import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
 * A repository on `feat`, two commits ahead of `main`, with an uncommitted change on top. One
 * worktree and no upstream, so the startup picker never opens over these tests.
 */
function createBranchRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-commit-picker-")));
  const git = (cmd: string, epoch?: number) =>
    execSync(cmd, {
      cwd: dir,
      stdio: "ignore",
      env: epoch
        ? {
            ...process.env,
            GIT_AUTHOR_DATE: `${epoch} +0000`,
            GIT_COMMITTER_DATE: `${epoch} +0000`,
          }
        : process.env,
    });
  git("git init -q -b main");
  git("git config user.email test@test && git config user.name test");
  writeFileSync(join(dir, "a.txt"), "root line\n");
  git("git add . && git commit -q -m root", 1_700_000_000);
  git("git checkout -q -b feat");
  writeFileSync(join(dir, "a.txt"), "root line\nfirst commit line\n");
  git("git add . && git commit -q -m 'first subject'", 1_700_000_100);
  writeFileSync(join(dir, "a.txt"), "root line\nfirst commit line\nsecond commit line\n");
  git("git add . && git commit -q -m 'second subject'", 1_700_000_200);
  writeFileSync(join(dir, "a.txt"), "root line\nfirst commit line\nsecond commit line\nworking\n");
  return dir;
}

async function launch(dir: string) {
  const bootstrap = await loadAppBootstrap(
    { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
    { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
  );
  // The chord needs the Kitty keyboard protocol, which is what tells ctrl+shift+P from ctrl+P.
  return await testRender(<AppHost bootstrap={bootstrap} />, {
    width: 140,
    height: 24,
    kittyKeyboard: true,
  });
}

describe("commit picker", () => {
  test("lists the branch's commits, reviews one alone, and steps back to the working tree", async () => {
    const dir = createBranchRepo();
    const setup = await launch(dir);

    try {
      let frame = await waitForFrame(setup, (f) => f.includes("working"));
      expect(frame).toContain("working");
      expect(frame).not.toContain("Pick a commit");

      await act(async () => {
        setup.mockInput.pressKey("p", { ctrl: true, shift: true });
      });
      frame = await waitForFrame(setup, (f) => f.includes("Pick a commit"));
      // Newest first, under the row that leaves a commit again.
      const rows = frame.split("\n").map((line) => line.trim());
      const back = rows.findIndex((line) => line.includes("back to the working tree"));
      const second = rows.findIndex((line) => line.includes("second subject"));
      const first = rows.findIndex((line) => line.includes("first subject"));
      expect(back).toBeGreaterThanOrEqual(0);
      expect(back).toBeLessThan(second);
      expect(second).toBeLessThan(first);
      // The newest commit is preselected, so Enter reviews it without moving first.
      expect(rows[second]).toMatch(/›\s+\w+\s+second subject/);

      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      // That commit's own diff: its line is the change, and the uncommitted line is not in it.
      frame = await waitForFrame(setup, (f) => !f.includes("working tree"));
      expect(frame).toContain("+  second commit line");
      expect(frame).not.toContain("working");
      expect(frame).not.toContain("Pick a commit");

      // The same chord reopens the same list while one commit is up.
      await act(async () => {
        setup.mockInput.pressKey("p", { ctrl: true, shift: true });
      });
      frame = await waitForFrame(setup, (f) => f.includes("Pick a commit"));
      expect(frame).toContain("first subject");
      // Preselected on the commit being reviewed, so the list reads as where you are.
      expect(
        frame.split("\n").some((line) => line.includes("›") && line.includes("second subject")),
      ).toBe(true);

      // One row up from the open commit is the row back to the working tree.
      await act(async () => {
        await setup.mockInput.pressArrow("up");
      });
      frame = await waitForFrame(setup, (f) =>
        f.split("\n").some((line) => line.includes("›") && line.includes("back to the")),
      );
      expect(frame).toMatch(/›\s+← back to the working tree/);
      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      frame = await waitForFrame(setup, (f) => f.includes("working tree"));
      expect(frame).toContain("+  working");
      expect(frame).not.toContain("Pick a commit");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("says so when the branch has no commits of its own", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-commit-picker-empty-")));
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
    const setup = await launch(dir);

    try {
      await waitForFrame(setup, (f) => f.includes("+b"));
      await act(async () => {
        setup.mockInput.pressKey("p", { ctrl: true, shift: true });
      });
      const frame = await waitForFrame(setup, (f) => f.includes("No commits in"));
      expect(frame).toMatch(/No commits in \S+\.\.HEAD/);
      expect(frame).not.toContain("Pick a commit");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});
