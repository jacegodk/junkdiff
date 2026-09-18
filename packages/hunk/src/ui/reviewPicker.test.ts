import { describe, expect, test } from "bun:test";
import type { CliInput } from "../core/run/commandInputs";
import {
  basePickerItems,
  basePickerSkipNotice,
  formatAge,
  reviewPickerApplies,
  reviewPickerReloadInput,
  worktreePickerItems,
} from "./reviewPicker";

const workingTree: CliInput = { kind: "vcs", staged: false, options: {} };

describe("reviewPickerApplies", () => {
  test("only a working-tree diff with no target qualifies", () => {
    expect(reviewPickerApplies(workingTree)).toBe(true);
    expect(reviewPickerApplies({ ...workingTree, pathspecs: ["src"] })).toBe(true);
    expect(reviewPickerApplies({ kind: "vcs", staged: true, options: {} })).toBe(false);
    expect(reviewPickerApplies({ kind: "vcs", staged: false, range: "main", options: {} })).toBe(
      false,
    );
    expect(
      reviewPickerApplies({
        kind: "vcs",
        staged: false,
        rangeEndpoints: { from: "a", to: "b" },
        options: {},
      }),
    ).toBe(false);
    expect(reviewPickerApplies({ kind: "show", ref: "HEAD", options: {} })).toBe(false);
  });
});

describe("worktreePickerItems", () => {
  test("one row per worktree in the given order, branch first, detached named, age compact", () => {
    const now = 1_700_100_000;
    expect(
      worktreePickerItems(
        [
          { path: "/w/feat", branch: "feat/x", lastActivity: now - 90 },
          { path: "/w/main", branch: "main", lastActivity: now - 7_200 },
          { path: "/w/det", branch: null, lastActivity: 0 },
        ],
        now,
      ),
    ).toEqual([
      { id: "/w/feat", label: "feat/x  /w/feat", description: "1m" },
      { id: "/w/main", label: "main  /w/main", description: "2h" },
      { id: "/w/det", label: "(detached)  /w/det", description: "" },
    ]);
  });

  test("formatAge", () => {
    expect(formatAge(100, 130)).toBe("now");
    expect(formatAge(100, 100 + 59 * 60)).toBe("59m");
    expect(formatAge(100, 100 + 23 * 3_600)).toBe("23h");
    expect(formatAge(100, 100 + 40 * 86_400)).toBe("40d");
    expect(formatAge(0, 100)).toBe("");
  });
});

describe("basePickerItems", () => {
  test("upstream row first when the upstream differs, then the whole-branch row when a default base exists", () => {
    const none = {
      branch: "feat",
      defaultBranch: null,
      defaultBase: null,
      upstreamRef: null,
      upstream: null,
    };
    expect(basePickerItems(none)).toEqual([]);
    expect(
      basePickerItems({ ...none, defaultBranch: "main", defaultBase: "abcdef0123456789" }),
    ).toEqual([
      {
        id: "default",
        label: "whole branch: vs main (merge-base)",
        description: "abcdef01",
        base: "abcdef0123456789",
      },
    ]);
    expect(
      basePickerItems({
        ...none,
        defaultBranch: "main",
        defaultBase: "abcdef0123456789",
        upstreamRef: "origin/feat",
        upstream: "origin/feat",
      }).map((item) => [item.id, item.base]),
    ).toEqual([
      ["upstream", "origin/feat"],
      ["default", "abcdef0123456789"],
    ]);
  });
});

describe("basePickerSkipNotice", () => {
  const base = {
    branch: "feat",
    defaultBranch: "main",
    defaultBase: "abc",
    upstreamRef: null,
    upstream: null,
  };
  test("explains a skipped base step; null when both choices exist", () => {
    expect(
      basePickerSkipNotice({ ...base, upstreamRef: "origin/feat", upstream: "origin/feat" }),
    ).toBeNull();
    expect(basePickerSkipNotice({ ...base, upstreamRef: "origin/feat" })).toBe(
      "feat is in sync with origin/feat: showing the whole branch vs main",
    );
    expect(basePickerSkipNotice(base)).toBe(
      "feat has no upstream: showing the whole branch vs main",
    );
    expect(basePickerSkipNotice({ ...base, defaultBranch: null, defaultBase: null })).toBe(
      "feat has no upstream: showing the working tree",
    );
    expect(
      basePickerSkipNotice({
        ...base,
        defaultBranch: null,
        defaultBase: null,
        upstreamRef: "origin/feat",
        upstream: "origin/feat",
      }),
    ).toBe("feat has no default branch to compare with: showing unpushed vs origin/feat");
    expect(basePickerSkipNotice({ ...base, branch: null })).toBe(
      "detached HEAD has no upstream: showing the whole branch vs main",
    );
  });
});

describe("reviewPickerReloadInput", () => {
  test("sets the range to the base, keeps options and pathspecs, and null means the plain working tree", () => {
    const input: CliInput = {
      kind: "vcs",
      staged: false,
      pathspecs: ["src"],
      options: { mode: "split" },
    };
    expect(reviewPickerReloadInput(input as never, "abc")).toEqual({
      kind: "vcs",
      staged: false,
      pathspecs: ["src"],
      range: "abc",
      options: { mode: "split" },
    });
    expect(reviewPickerReloadInput(input as never, null)).toEqual(input);
  });
});
