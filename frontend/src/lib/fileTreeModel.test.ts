import { describe, expect, it } from "vitest";

import { filterTree, matchesFilter, sortDirEntries, type DirEntry } from "./fileTreeModel";

function entry(name: string, isDir = false): DirEntry {
  return { name, relPath: name, isDir };
}

describe("sortDirEntries", () => {
  it("sorts directories first, then files, both case-insensitively", () => {
    const sorted = sortDirEntries([
      entry("zebra.txt"),
      entry("src", true),
      entry("Apple.md"),
      entry("Crates", true),
      entry("beta.rs"),
    ]);
    expect(sorted.map((e) => e.name)).toEqual([
      "Crates",
      "src",
      "Apple.md",
      "beta.rs",
      "zebra.txt",
    ]);
  });

  it("orders numbered files naturally", () => {
    const sorted = sortDirEntries([entry("file10.txt"), entry("file2.txt"), entry("file1.txt")]);
    expect(sorted.map((e) => e.name)).toEqual(["file1.txt", "file2.txt", "file10.txt"]);
  });

  it("defensively drops .git even if the backend leaks it", () => {
    const sorted = sortDirEntries([entry(".git", true), entry("a.txt")]);
    expect(sorted.map((e) => e.name)).toEqual(["a.txt"]);
  });
});

/** Build a cache entry: `child("src", "components", true)` → src/components. */
function child(parent: string, name: string, isDir = false): DirEntry {
  return { name, relPath: parent ? `${parent}/${name}` : name, isDir };
}

/**
 * ""            → src/, README.md
 * "src"         → components/, main.ts
 * "src/components" → button.tsx
 */
const CACHE = new Map<string, DirEntry[]>([
  ["", [child("", "src", true), child("", "README.md")]],
  ["src", [child("src", "components", true), child("src", "main.ts")]],
  ["src/components", [child("src/components", "button.tsx")]],
]);

describe("matchesFilter", () => {
  it("matches case-insensitively on a substring", () => {
    expect(matchesFilter("Button.tsx", "butt")).toBe(true);
    expect(matchesFilter("Button.tsx", "xyz")).toBe(false);
  });

  it("treats an empty filter as matching everything", () => {
    expect(matchesFilter("anything", "")).toBe(true);
  });
});

describe("filterTree", () => {
  it("returns empty sets for an empty filter (caller renders the full tree)", () => {
    const { visible, autoExpand } = filterTree(CACHE, "");
    expect(visible.size).toBe(0);
    expect(autoExpand.size).toBe(0);
  });

  it("keeps a matching file's ancestors and auto-expands them", () => {
    const { visible, autoExpand } = filterTree(CACHE, "button");
    expect([...visible].sort()).toEqual(["src", "src/components", "src/components/button.tsx"]);
    expect([...autoExpand].sort()).toEqual(["src", "src/components"]);
  });

  it("shows a matching directory's whole loaded subtree without forcing it open", () => {
    const { visible, autoExpand } = filterTree(CACHE, "components");
    expect([...visible].sort()).toEqual(["src", "src/components", "src/components/button.tsx"]);
    // `src` opens because a descendant matched; `src/components` matched itself,
    // so the user decides whether to look inside.
    expect([...autoExpand]).toEqual(["src"]);
  });

  it("yields nothing when no loaded entry matches", () => {
    const { visible, autoExpand } = filterTree(CACHE, "nothing-here");
    expect(visible.size).toBe(0);
    expect(autoExpand.size).toBe(0);
  });

  it("does not let a colon in a directory name suppress another subtree", () => {
    // Colons are legal in POSIX filenames; a `sub:`-prefixed bookkeeping key
    // would collide with the directory literally named `sub:tmp`.
    const cache = new Map<string, DirEntry[]>([
      ["", [child("", "sub:tmp", true), child("", "tmp", true)]],
      ["sub:tmp", [child("sub:tmp", "a.txt")]],
      ["tmp", [child("tmp", "b.txt")]],
    ]);
    const { visible } = filterTree(cache, "tmp");
    expect(visible.has("tmp/b.txt")).toBe(true);
  });

  it("ignores directories that haven't been loaded yet", () => {
    const partial = new Map<string, DirEntry[]>([["", [child("", "src", true)]]]);
    expect(filterTree(partial, "button").visible.size).toBe(0);
  });

  it("counts name-matched files only, not subtree entries dragged in by a matched dir", () => {
    const cache = new Map<string, DirEntry[]>([
      ["", [child("", "components", true), child("", "components.md")]],
      ["components", [child("components", "button.tsx"), child("components", "input.tsx")]],
    ]);
    const result = filterTree(cache, "components");
    // The dir match pulls button.tsx/input.tsx into `visible`, but only the
    // file whose NAME matches counts as a hit.
    expect(result.visible.has("components/button.tsx")).toBe(true);
    expect(result.fileMatchCount).toBe(1);
    // And a file-name filter counts every named hit across levels.
    expect(filterTree(cache, ".tsx").fileMatchCount).toBe(2);
    expect(filterTree(cache, "").fileMatchCount).toBe(0);
  });
});
