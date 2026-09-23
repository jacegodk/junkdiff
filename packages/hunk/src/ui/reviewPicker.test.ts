import { describe, expect, test } from "bun:test";
import type { CliInput } from "../core/run/commandInputs";
import {
  basePickerItems,
  basePickerSkipNotice,
  commitPickerItems,
  commitPickerReloadInput,
  commitPickerSource,
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

describe("commitPickerSource", () => {
  const bases = {
    branch: "feat",
    defaultBranch: "main",
    defaultBase: "base-sha",
    upstreamRef: "origin/feat",
    upstream: "origin/feat",
  };

  test("a working-tree review covers what it has not pushed, or the whole branch without an upstream", () => {
    expect(commitPickerSource(workingTree as never, bases)).toEqual({
      range: "origin/feat..HEAD",
      base: null,
      label: "working tree",
    });
    expect(commitPickerSource(workingTree as never, { ...bases, upstream: null })).toEqual({
      range: "base-sha..HEAD",
      base: null,
      label: "working tree",
    });
  });

  test("a review against a base covers that base's commits, and goes back to that base", () => {
    const input = { ...workingTree, range: "origin/feat" };
    expect(commitPickerSource(input as never, bases)).toEqual({
      range: "origin/feat..HEAD",
      base: "origin/feat",
      label: "working tree vs origin/feat",
    });
  });

  test("an explicit range covers its own commits", () => {
    const input = { ...workingTree, range: "v1..v2" };
    expect(commitPickerSource(input as never, bases)).toEqual({
      range: "v1..v2",
      base: "v1..v2",
      label: "range v1..v2",
    });
  });

  test("null when the branch has neither an upstream nor a default branch behind it", () => {
    expect(
      commitPickerSource(workingTree as never, {
        ...bases,
        defaultBase: null,
        upstream: null,
      }),
    ).toBeNull();
  });
});

describe("commitPickerItems", () => {
  const source = { range: "origin/feat..HEAD", base: null, label: "working tree" };
  const commit = {
    revisionId: "a".repeat(40),
    displayId: "aaaaaaaa",
    parentRevisionId: "b".repeat(40),
    subject: "first subject",
    authorName: "t",
    authoredAt: 1_700_000_000,
  };

  test("the row that leaves a commit comes first, then one row per commit with its age", () => {
    expect(commitPickerItems(source, [commit], 1_700_003_600)).toEqual([
      { id: "review", label: "← back to the working tree", description: "" },
      { id: "a".repeat(40), label: "aaaaaaaa  first subject", description: "1h" },
    ]);
  });
});

describe("commitPickerReloadInput", () => {
  test("reviews the commit against its own parent, keeping options and dropping the old range", () => {
    const input = {
      kind: "vcs",
      staged: false,
      range: "origin/feat",
      pathspecs: ["src"],
      options: { mode: "split" },
    };
    expect(
      commitPickerReloadInput(input as never, {
        revisionId: "a".repeat(40),
        displayId: "aaaaaaaa",
        parentRevisionId: "b".repeat(40),
        subject: "s",
        authorName: "t",
        authoredAt: 1,
      }),
    ).toEqual({
      kind: "vcs",
      staged: false,
      pathspecs: ["src"],
      rangeEndpoints: { from: "b".repeat(40), to: "a".repeat(40) },
      options: { mode: "split" },
    });
  });
});
