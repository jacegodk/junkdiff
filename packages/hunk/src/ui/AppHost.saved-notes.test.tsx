import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { removeTestDirectory } from "../../../../test/helpers/filesystem";
import { resolveSavedNotesPath } from "../app/savedNotesFile";

const { getBundledVcsCatalog } = await import("../app/vcsCatalog");
const { loadAppBootstrap } = await import("../core/changeset/loaders");
const { TestAppHost: AppHost } = await import("../../../../test/helpers/app-host");
const { loadStartupExtensions } = await import("../extensions/startup");

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

/** A repository on `main` with one modified tracked file. */
function createRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "junk-saved-notes-repo-")));
  execSync("git init -q -b main && git config user.email test@test && git config user.name test", {
    cwd: dir,
    stdio: "ignore",
  });
  writeFileSync(join(dir, "alpha.ts"), "export const alpha = 1;\n");
  execSync("git add . && git commit -q -m init", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "alpha.ts"), "export const alpha = 2;\nexport const add = true;\n");
  return dir;
}

let stateHome: string;
let previousStateHome: string | undefined;
beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), "junk-saved-notes-state-"));
  previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
});
afterEach(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  await removeTestDirectory(stateHome);
});

describe("saved review notes", () => {
  test("a note saved in the review lands in the worktree+branch file and is removed with the note", async () => {
    const dir = createRepo();
    const notesPath = resolveSavedNotesPath(join(stateHome, "hunk"), dir, "main");
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 24 });

    try {
      await waitForFrame(setup, (f) => f.includes("add = true"));
      await act(async () => {
        await setup.mockInput.typeText("c");
      });
      await waitForFrame(setup, (f) => f.includes("Draft note"));
      await act(async () => {
        await setup.mockInput.typeText("remember this");
      });
      await act(async () => {
        setup.mockInput.pressKey("s", { ctrl: true });
      });
      const saved = await waitForFrame(setup, (f) => f.includes("Your note"));
      expect(saved).toContain("remember this");

      expect(existsSync(notesPath)).toBe(true);
      const document = JSON.parse(readFileSync(notesPath, "utf8"));
      expect(document).toMatchObject({ version: 1, worktree: dir, branch: "main" });
      const notes = Object.values(document.notes) as Array<Record<string, unknown>>;
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ filePath: "alpha.ts", body: "remember this" });
      expect(String(notes[0]!.id)).toMatch(/^user:/);

      // Deleting the note in the review deletes it from disk; the empty file goes away.
      await act(async () => {
        await setup.mockInput.typeText("D");
      });
      let gone = false;
      for (let attempt = 0; attempt < 40 && !gone; attempt++) {
        await flush(setup);
        gone = !existsSync(notesPath);
        if (!gone) await Bun.sleep(50);
      }
      expect(gone).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("a handled note is shown with a marker, or deleted on open with delete_handled_notes", async () => {
    const dir = createRepo();
    const notesPath = resolveSavedNotesPath(join(stateHome, "hunk"), dir, "main");
    const writeNotes = () => {
      mkdirSync(dirname(notesPath), { recursive: true });
      writeFileSync(
        notesPath,
        JSON.stringify({
          version: 1,
          worktree: dir,
          branch: "main",
          notes: {
            "user:1": {
              id: "user:1",
              filePath: "alpha.ts",
              hunkIndex: 0,
              side: "new",
              line: 2,
              body: "still open",
              at: new Date().toISOString(),
            },
            "user:2": {
              id: "user:2",
              filePath: "alpha.ts",
              hunkIndex: 0,
              side: "new",
              line: 1,
              body: "already handled",
              at: new Date().toISOString(),
              handled: true,
            },
          },
        }),
      );
    };

    // Default: both come back, the handled one says so in its title.
    writeNotes();
    let bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    let setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 30 });
    try {
      let frame = await waitForFrame(setup, (f) => f.includes("already handled"));
      expect(frame).toContain("still open");
      expect(frame).toMatch(/Your note · now · handled/);
      expect(Object.keys(JSON.parse(readFileSync(notesPath, "utf8")).notes).sort()).toEqual([
        "user:1",
        "user:2",
      ]);
      // H hides the handled note only; a second H brings it back.
      await act(async () => {
        await setup.mockInput.typeText("H");
      });
      frame = await waitForFrame(setup, (f) => !f.includes("already handled"));
      expect(frame).not.toContain("already handled");
      expect(frame).toContain("still open");
      await act(async () => {
        await setup.mockInput.typeText("H");
      });
      frame = await waitForFrame(setup, (f) => f.includes("already handled"));
      expect(frame).toContain("already handled");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }

    // With the option: the handled note is deleted from the file and not shown.
    writeNotes();
    bootstrap = await loadAppBootstrap(
      {
        kind: "vcs",
        staged: false,
        options: { mode: "unified", excludeUntracked: true, deleteHandledNotes: true },
      },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 30 });
    try {
      const frame = await waitForFrame(setup, (f) => f.includes("still open"));
      expect(frame).not.toContain("already handled");
      expect(frame).toContain("deleted 1 handled note");
      expect(Object.keys(JSON.parse(readFileSync(notesPath, "utf8")).notes)).toEqual(["user:1"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("h flags the active note handled and writes the flag to the notes file, h again clears it", async () => {
    const dir = createRepo();
    const notesPath = resolveSavedNotesPath(join(stateHome, "hunk"), dir, "main");
    mkdirSync(dirname(notesPath), { recursive: true });
    writeFileSync(
      notesPath,
      JSON.stringify({
        version: 1,
        worktree: dir,
        branch: "main",
        notes: {
          "user:1": {
            id: "user:1",
            filePath: "alpha.ts",
            hunkIndex: 0,
            side: "new",
            line: 2,
            body: "flag me",
            at: new Date().toISOString(),
          },
        },
      }),
    );
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 30 });
    try {
      await waitForFrame(setup, (f) => f.includes("flag me"));
      // `}` selects the annotated hunk and makes its first note active.
      await act(async () => {
        await setup.mockInput.typeText("}");
      });
      await act(async () => {
        await setup.mockInput.typeText("h");
      });
      let frame = await waitForFrame(setup, (f) => /Your note · now · handled/.test(f));
      expect(frame).toMatch(/Your note · now · handled/);
      let saved = false;
      for (let attempt = 0; attempt < 40 && !saved; attempt++) {
        await flush(setup);
        saved = JSON.parse(readFileSync(notesPath, "utf8")).notes["user:1"]?.handled === true;
        if (!saved) await Bun.sleep(50);
      }
      expect(saved).toBe(true);

      await act(async () => {
        await setup.mockInput.typeText("h");
      });
      frame = await waitForFrame(setup, (f) => !/· handled/.test(f));
      expect(frame).not.toMatch(/· handled/);
      let cleared = false;
      for (let attempt = 0; attempt < 40 && !cleared; attempt++) {
        await flush(setup);
        cleared =
          JSON.parse(readFileSync(notesPath, "utf8")).notes["user:1"]?.handled === undefined;
        if (!cleared) await Bun.sleep(50);
      }
      expect(cleared).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("with no search running, n steps to a note and E edits it", async () => {
    const dir = createRepo();
    const notesPath = resolveSavedNotesPath(join(stateHome, "hunk"), dir, "main");
    mkdirSync(dirname(notesPath), { recursive: true });
    writeFileSync(
      notesPath,
      JSON.stringify({
        version: 1,
        worktree: dir,
        branch: "main",
        notes: {
          "user:1": {
            id: "user:1",
            filePath: "alpha.ts",
            hunkIndex: 0,
            side: "new",
            line: 2,
            body: "step to me",
            at: new Date().toISOString(),
          },
        },
      }),
    );
    const extensions = await loadStartupExtensions({
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
      cwd: dir,
      env: { XDG_CONFIG_HOME: join(stateHome, "config") } as NodeJS.ProcessEnv,
      hostOverrides: { repoRoot: undefined },
    });
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 30 });
    try {
      await waitForFrame(setup, (f) => f.includes("step to me"));
      await act(async () => {
        await setup.mockInput.typeText("n");
      });
      await act(async () => {
        await setup.mockInput.typeText("E");
      });
      const frame = await waitForFrame(setup, (f) => f.includes("Edit note"));
      expect(frame).toContain("Edit note");
      expect(frame).not.toContain("No search yet");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });

  test("notes saved earlier come back on the next open of the same worktree and branch", async () => {
    const dir = createRepo();
    const notesPath = resolveSavedNotesPath(join(stateHome, "hunk"), dir, "main");
    mkdirSync(dirname(notesPath), { recursive: true });
    writeFileSync(
      notesPath,
      JSON.stringify({
        version: 1,
        worktree: dir,
        branch: "main",
        notes: {
          "user:1": {
            id: "user:1",
            filePath: "alpha.ts",
            hunkIndex: 0,
            side: "new",
            line: 2,
            body: "from last time",
            at: new Date().toISOString(),
          },
          "user:2": {
            id: "user:2",
            filePath: "other.ts",
            hunkIndex: 0,
            side: "new",
            line: 1,
            body: "file not in this review",
            at: new Date().toISOString(),
          },
        },
      }),
    );
    const bootstrap = await loadAppBootstrap(
      { kind: "vcs", staged: false, options: { mode: "unified", excludeUntracked: true } },
      { cwd: dir, vcsCatalog: getBundledVcsCatalog() },
    );
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 120, height: 24 });

    try {
      const frame = await waitForFrame(setup, (f) => f.includes("from last time"));
      expect(frame).toContain("from last time");
      expect(frame).not.toContain("file not in this review");
      // The note for the absent file stays on disk for a review that shows that file.
      const document = JSON.parse(readFileSync(notesPath, "utf8"));
      expect(Object.keys(document.notes).sort()).toEqual(["user:1", "user:2"]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      await removeTestDirectory(dir);
    }
  });
});
