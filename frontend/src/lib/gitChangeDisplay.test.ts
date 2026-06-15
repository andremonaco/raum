import { describe, expect, it } from "vitest";

import type { FileChange, FileChangeKind } from "../stores/worktreeStore";
import { STATUS_LETTER, changesByPath, splitChanges, splitPath } from "./gitChangeDisplay";

function change(partial: Partial<FileChange> & { path: string }): FileChange {
  return {
    origPath: null,
    kind: "modified",
    staged: false,
    insertions: null,
    deletions: null,
    ...partial,
  };
}

describe("STATUS_LETTER", () => {
  it("covers every change kind with a single-letter badge", () => {
    const kinds: FileChangeKind[] = [
      "modified",
      "added",
      "deleted",
      "renamed",
      "untracked",
      "conflicted",
      "typeChange",
    ];
    for (const kind of kinds) {
      expect(STATUS_LETTER[kind].letter).toHaveLength(1);
      expect(STATUS_LETTER[kind].colorClass).toMatch(/^text-/);
    }
    expect(STATUS_LETTER.modified.letter).toBe("M");
    expect(STATUS_LETTER.added.letter).toBe("A");
    expect(STATUS_LETTER.deleted.letter).toBe("D");
    expect(STATUS_LETTER.renamed.letter).toBe("R");
    expect(STATUS_LETTER.untracked.letter).toBe("U");
    expect(STATUS_LETTER.conflicted.letter).toBe("C");
    expect(STATUS_LETTER.typeChange.letter).toBe("T");
  });
});

describe("splitChanges", () => {
  it("partitions while preserving order, double-entries land in both buckets", () => {
    const changes = [
      change({ path: "a.rs", staged: false }),
      change({ path: "b.rs", staged: true }),
      change({ path: "both.rs", staged: true }),
      change({ path: "both.rs", staged: false }),
      change({ path: "c.txt", kind: "untracked", staged: false }),
    ];
    const { staged, unstaged } = splitChanges(changes);
    expect(staged.map((c) => c.path)).toEqual(["b.rs", "both.rs"]);
    expect(unstaged.map((c) => c.path)).toEqual(["a.rs", "both.rs", "c.txt"]);
  });

  it("handles empty input", () => {
    expect(splitChanges([])).toEqual({ staged: [], unstaged: [] });
  });
});

describe("splitPath", () => {
  it("splits nested paths", () => {
    expect(splitPath("src/lib/util.ts")).toEqual({ dir: "src/lib", name: "util.ts" });
  });

  it("root-level files get an empty dir", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("changesByPath", () => {
  it("prefers the unstaged entry on staged/unstaged collisions", () => {
    const staged = change({ path: "both.rs", staged: true, insertions: 1 });
    const unstaged = change({ path: "both.rs", staged: false, insertions: 2 });
    expect(changesByPath([staged, unstaged]).get("both.rs")).toBe(unstaged);
    // Order-independent.
    expect(changesByPath([unstaged, staged]).get("both.rs")).toBe(unstaged);
  });

  it("keys renames by the new path", () => {
    const rename = change({
      path: "new.rs",
      origPath: "old.rs",
      kind: "renamed",
      staged: true,
    });
    const map = changesByPath([rename]);
    expect(map.get("new.rs")).toBe(rename);
    expect(map.has("old.rs")).toBe(false);
  });
});
