import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestReviewDocument,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import {
  SAVED_NOTES_TTL_MS,
  diffSavedNotes,
  mergeSavedNotes,
  readSavedNotes,
  resolveNotesStateDir,
  resolveSavedNotesPath,
  restoreSavedNotes,
  savedNoteFromStored,
  type SavedNote,
} from "./savedNotes";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "junk-saved-notes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const now = new Date("2026-09-18T12:00:00.000Z");
const saved = (id: string, extra: Partial<SavedNote> = {}): SavedNote => ({
  id,
  filePath: "alpha.ts",
  hunkIndex: 0,
  side: "new",
  line: 1,
  body: `body ${id}`,
  at: now.toISOString(),
  ...extra,
});

describe("paths", () => {
  test("state dir follows XDG_STATE_HOME, LOCALAPPDATA on Windows, else ~/.local/state", () => {
    expect(resolveNotesStateDir({ XDG_STATE_HOME: "/x/state" }, "linux", "/home/u")).toBe(
      "/x/state/hunk",
    );
    expect(resolveNotesStateDir({ XDG_STATE_HOME: "relative" }, "linux", "/home/u")).toBe(
      "/home/u/.local/state/hunk",
    );
    expect(resolveNotesStateDir({ LOCALAPPDATA: "C:\\U\\Local" }, "win32", "C:\\U")).toBe(
      join("C:\\U\\Local", "hunk"),
    );
  });

  test("one file per worktree hash and url-encoded branch, matching the hunk-viewed layout", () => {
    const path = resolveSavedNotesPath("/s/hunk", "/home/u/work/repo", "feat/x");
    expect(path.endsWith("/feat%2Fx.json")).toBe(true);
    expect(path.split("/").at(-2)).toMatch(/^[0-9a-f]{16}$/);
    expect(resolveSavedNotesPath("/s/hunk", "/home/u/work/repo", "main").split("/").at(-2)).toBe(
      path.split("/").at(-2),
    );
  });
});

describe("mergeSavedNotes / readSavedNotes", () => {
  test("upserts merge into what is on disk, removes delete one id, an empty file is removed", () => {
    const path = join(dir, "notes", "h", "main.json");
    mergeSavedNotes(path, "/repo", "main", [{ upsert: saved("user:1") }], now);
    mergeSavedNotes(path, "/repo", "main", [{ upsert: saved("user:2") }], now);
    expect(
      readSavedNotes(path)
        .map((note) => note.id)
        .sort(),
    ).toEqual(["user:1", "user:2"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 1,
      worktree: "/repo",
      branch: "main",
    });
    mergeSavedNotes(path, "/repo", "main", [{ remove: "user:1" }], now);
    expect(readSavedNotes(path).map((note) => note.id)).toEqual(["user:2"]);
    mergeSavedNotes(path, "/repo", "main", [{ remove: "user:2" }], now);
    expect(existsSync(path)).toBe(false);
  });

  test("prunes stored notes past the TTL on write; an unusable file reads as empty with a log", () => {
    const path = join(dir, "main.json");
    const then = new Date(now.getTime() - SAVED_NOTES_TTL_MS - 1);
    mergeSavedNotes(
      path,
      "/repo",
      "main",
      [{ upsert: saved("user:1", { at: then.toISOString() }) }],
      then,
    );
    mergeSavedNotes(path, "/repo", "main", [{ upsert: saved("user:2") }], now);
    expect(readSavedNotes(path).map((note) => note.id)).toEqual(["user:2"]);

    writeFileSync(path, "{nope");
    const logs: string[] = [];
    expect(readSavedNotes(path, (m) => logs.push(m))).toEqual([]);
    expect(logs).toHaveLength(1);
  });
});

describe("savedNoteFromStored / restoreSavedNotes", () => {
  const document = createTestReviewDocument([
    { key: "file:alpha", path: "alpha.ts", hunkCount: 2 },
    { key: "file:beta", path: "beta.ts" },
  ]);

  test("a stored note round-trips through its saved form and back onto the same file and line", () => {
    const stored = createTestStoredNote({
      id: "user:1",
      fileKey: "file:alpha",
      hunkIndex: 1,
      line: 11,
      source: "user",
      summary: "look here",
      createdAt: now.toISOString(),
    });
    const onDisk = savedNoteFromStored(stored, document);
    expect(onDisk).toEqual({
      id: "user:1",
      filePath: "alpha.ts",
      hunkIndex: 1,
      side: "new",
      line: 11,
      body: "look here",
      at: now.toISOString(),
    });

    const [restored] = restoreSavedNotes([onDisk!], document);
    expect(restored!.note).toMatchObject({
      id: "user:1",
      source: "user",
      fileKey: "file:alpha",
      summary: "look here",
      editable: true,
      author: "user",
    });
    expect(restored!.note.anchor.preferred).toEqual({ side: "new", line: 11 });
    expect(restored!.note.anchor.ownerHunkIndex).toBe(1);
    expect(restored!.resolution).toBe("active");
  });

  test("a handled flag survives the round trip as the handled tag, and counts as a change", () => {
    const [restored] = restoreSavedNotes([saved("user:1", { handled: true })], document);
    expect(restored!.note.tags).toEqual(["handled"]);
    const back = savedNoteFromStored(restored!, document);
    expect(back?.handled).toBe(true);
    const [plain] = restoreSavedNotes([saved("user:2")], document);
    expect(plain!.note.tags).toBeUndefined();
    expect(savedNoteFromStored(plain!, document)?.handled).toBeUndefined();
    expect(diffSavedNotes([saved("a")], [saved("a", { handled: true })])).toEqual([
      { upsert: saved("a", { handled: true }) },
    ]);
  });

  test("a note whose file is absent from the document is neither saved nor restored", () => {
    const stored = createTestStoredNote({ id: "user:9", fileKey: "file:gone", source: "user" });
    expect(savedNoteFromStored(stored, document)).toBeNull();
    expect(restoreSavedNotes([saved("user:9", { filePath: "gone.ts" })], document)).toEqual([]);
  });

  test("replies restore after their parent and share its anchor; an orphan reply is dropped", () => {
    const parent = saved("user:1", { at: "2026-09-18T12:00:01.000Z" });
    const reply = saved("user:2", {
      parentId: "user:1",
      at: "2026-09-18T12:00:00.000Z",
      body: "reply",
    });
    const orphan = saved("user:3", { parentId: "user:missing" });
    const restored = restoreSavedNotes([reply, orphan, parent], document);
    expect(restored.map((entry) => entry.note.id)).toEqual(["user:1", "user:2"]);
    expect(restored[1]!.note.parentId).toBe("user:1");
    expect(restored[1]!.note.anchor).toEqual(restored[0]!.note.anchor);
  });
});

describe("diffSavedNotes", () => {
  test("new and changed notes become upserts, missing ones removes, unchanged nothing", () => {
    const a = saved("a");
    const b = saved("b");
    expect(diffSavedNotes([a, b], [a, b])).toEqual([]);
    expect(diffSavedNotes([a], [a, b])).toEqual([{ upsert: b }]);
    expect(diffSavedNotes([a, b], [a])).toEqual([{ remove: "b" }]);
    const edited = { ...a, body: "edited" };
    expect(diffSavedNotes([a], [edited])).toEqual([{ upsert: edited }]);
  });
});
