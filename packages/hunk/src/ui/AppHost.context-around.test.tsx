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

async function waitForFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
  attempts = 60,
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
 * A repository whose one tracked file has 60 lines and changes on lines 20 and 50. A git patch
 * has no file totals, so hunk offers no trailing gap; the gap between the hunks stands in for
 * the context below the first hunk.
 */
function createRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "junk-context-around-")));
  execSync("git init -q -b main && git config user.email test@test && git config user.name test", {
    cwd: dir,
    stdio: "ignore",
  });
  const lines = Array.from(
    { length: 60 },
    (_, i) => `const line${String(i + 1).padStart(2, "0")} = ${i + 1};`,
  );
  writeFileSync(join(dir, "alpha.ts"), `${lines.join("\n")}\n`);
  execSync("git add . && git commit -q -m init", { cwd: dir, stdio: "ignore" });
  lines[19] = "const line20 = 2000;";
  lines[49] = "const line50 = 5000;";
  writeFileSync(join(dir, "alpha.ts"), `${lines.join("\n")}\n`);
  return dir;
}

describe("junk: context around the selected hunk", () => {
  test("x shows 10 more unchanged lines on both sides of the hunk, X hides them again", async () => {
    const dir = createRepo();
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 60 });
    try {
      // Default context is 3 lines: hunk 1 shows 17-23, hunk 2 shows 47-53.
      let frame = await waitForFrame(setup, (f) => f.includes("16 unchanged lines"));
      expect(frame).toContain("16 unchanged lines");
      expect(frame).toContain("23 unchanged lines");
      expect(frame).not.toContain("line07 = 7;");
      // Each collapsed row offers the same reveal by mouse: ▼ opens it from the top, ▲ from
      // the bottom.
      expect(frame).toContain("▼");
      expect(frame).toContain("▲");

      await act(async () => {
        await setup.mockInput.typeText("x");
      });
      frame = await waitForFrame(setup, (f) => f.includes("line07 = 7;"));
      // Above hunk 1: lines 7-16 next to the hunk, six lines still folded at the file start.
      expect(frame).toContain("line07 = 7;");
      expect(frame).toContain("line16 = 16;");
      expect(frame).not.toContain("line06 = 6;");
      expect(frame).toContain("6 unchanged lines");
      // Below hunk 1: lines 24-33 next to it, the rest of the gap to hunk 2 still folded.
      expect(frame).toContain("line24 = 24;");
      expect(frame).toContain("line33 = 33;");
      expect(frame).not.toContain("line34 = 34;");
      expect(frame).toContain("13 unchanged lines");

      await act(async () => {
        await setup.mockInput.typeText("X");
      });
      frame = await waitForFrame(setup, (f) => f.includes("16 unchanged lines"));
      expect(frame).toContain("16 unchanged lines");
      expect(frame).toContain("23 unchanged lines");
      expect(frame).not.toContain("line07 = 7;");
      expect(frame).not.toContain("line24 = 24;");

      // Below the last hunk of a Git diff there is no gap until the file's source has been
      // read: the press records what it wants and the row appears with those lines shown.
      await act(async () => {
        await setup.mockInput.typeText("]");
      });
      await act(async () => {
        await setup.mockInput.typeText("x");
      });
      frame = await waitForFrame(setup, (f) => f.includes("line54 = 54;"));
      expect(frame).toContain("line54 = 54;");
      expect(frame).toContain("line57 = 57;");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});
